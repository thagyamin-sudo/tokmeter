#!/usr/bin/env node
/**
 * E2E 探针：用无头 Edge 打开被测页面，抓取页面内 #probe 的真实几何与文本，逐条断言。
 *
 *   node tools/probe.js                                  # http + iframe harness（真实 390x844 视口）
 *   node tools/probe.js --target=llm-monitor.html        # 直接加载单文件产物（file://）
 *   node tools/probe.js --query="test=1&seed=7&freeze=23:48:30"
 *
 * 两个环境坑（都踩过，别再踩）：
 * 1) 无头 Edge 有最小窗口宽度（实测内视口被钳到 481），只有固定尺寸的 iframe 才能得到手机尺寸真实视口；
 * 2) 静态服务器与浏览器必须并发运行：spawnSync 会阻塞事件循环，把同进程的服务器一起冻住，
 *    Edge 永远等不到页面（表现为 ETIMEDOUT）。因此这里用异步 spawn + 文件重定向。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const target = flag('target', '');
const query = flag('query', 'test=1&seed=7&freeze=23:48:30');

/** 只读静态服务器：探针自带，避免依赖外部 python -m http.server。 */
function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname);
    const file = normalize(join(ROOT, rel === '/' ? '/index.html' : rel));
    if (!file.startsWith(ROOT)) {
      res.statusCode = 403;
      return res.end('forbidden');
    }
    try {
      const buf = await readFile(file);
      res.setHeader('content-type', MIME[extname(file)] || 'application/octet-stream');
      res.end(buf);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

/** 异步跑一次 Edge 并把 DOM 落到文件；await 期间事件循环继续服务 HTTP 请求。 */
function dumpDom(url) {
  // 每次运行用独立目录：同时跑两次探针（两个人 / 两个 CI 步骤）时，
  // 共用 dom.html 与浏览器 profile 会互相踩——实测会抓到半截 DOM，报"探针输出缺失"。
  const dir = join(tmpdir(), 'llm-probe-' + process.pid);
  mkdirSync(dir, { recursive: true });
  const outFile = join(dir, 'dom.html');
  const script = join(dir, 'run-edge.cmd');
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--user-data-dir=' + join(dir, 'profile'), '--window-size=520,900',
    '--virtual-time-budget=4000', '--dump-dom', url,
  ];
  // 写进 .cmd 的每个 % 都要翻倍：批处理会把 %3D 当成 %3 参数展开吃掉（实测 '=' → 'D'）。
  writeFileSync(
    script,
    '@echo off\r\n"' + EDGE + '" ' +
      args.map((a) => '"' + a.replace(/%/g, '%%') + '"').join(' ') +
      ' > "' + outFile + '" 2>nul\r\n',
    'utf8'
  );
  const attempt = () => new Promise((done) => {
    const child = spawn('cmd.exe', ['/d', '/c', script], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      console.error('edge 超时（120s）');
      done('');
    }, 120000);
    child.on('error', (err) => {
      clearTimeout(timer);
      console.error('edge 启动失败：' + err.message);
      done('');
    });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        done(readFileSync(outFile, 'utf8'));
      } catch {
        done('');
      }
    });
  });
  // Edge 偶发地"启动即退出"（Windows 上上一个无头实例还没释放 user-data-dir，
  // 而 .cmd 的重定向已经把 dom.html 截断成空文件）——一次抖动不该把整轮门禁判死，重试一次。
  return attempt().then(async (text) => {
    if (text.includes('PROBE_JSON')) return text;
    await new Promise((r) => setTimeout(r, 1500));
    const again = await attempt();
    return again.includes('PROBE_JSON') ? again : (again || text);
  });
}

const checks = [];
const add = (label, ok, detail) => checks.push({ label, ok, detail });
const eq = (label, actual, expected) =>
  add(label, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
const near = (label, actual, expected, tol) =>
  add(label, Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
    'expected ' + expected + ' ±' + tol + ', got ' + actual);
const within = (label, actual, lo, hi) =>
  add(label, Number.isFinite(actual) && actual >= lo && actual <= hi,
    'expected in [' + lo + ', ' + hi + '], got ' + actual);

/** 任务 6：标题栏 / Hero / 底部栏。 */
function checkShell(p) {
  eq('标题：模型名', p.texts.title, 'Qwen3.8-Flash');
  eq('标题：引擎与节点', p.texts.engine, 'vLLM · Dual DGX Spark');
  eq('标题：连接状态', p.texts.link, 'NAS 已连接');
  eq('Hero：标签', p.texts.heroLabel, '实时输出 Token');
  eq('Hero：脚注', p.texts.heroFoot, '最近 60 秒');
  eq('Hero：数值', p.texts.rate, '257');
  eq('Hero：单位', p.texts.unit, 'tok/s');
  eq('底部：时钟', p.texts.clock, '23:48:30');
  eq('Hero：折线点数', p.spark.points, 60);
  within('Hero 高 / 面板宽', p.hero.ratio, 0.255, 0.281);
  near('面板宽 = min(92vw,420)', p.panel.w, Math.min(0.92 * p.viewport.w, 420), 1.5);
  eq('灵动岛：默认不出现', p.island.present, false);
  eq('默认视图：server（与参考截图一致）', p.view, 'server');
  // 第 4 个齿轮不能破坏默认视图：浮层默认必须收起，按钮几何逐个量（见 checkFooterGeometry）
  eq('设置：默认视图不出现浮层', !!(p.settings && p.settings.open), false);
  checkFooterGeometry(p);
}

/** 任务 7：六张数据卡。 */
function checkCards(p) {
  const c = p.cards;
  if (!c) {
    add('卡片数据', false, 'p.cards 缺失（卡片尚未实现）');
    return;
  }
  eq('请求状态：卡标题', c.requests.title, '请求状态');
  eq('请求状态：活动数', c.requests.active, '8');
  eq('请求状态：排队数', c.requests.queued, '1');
  near('请求状态：绿色段占比', c.requests.run / c.requests.total, 0.8, 0.03);
  near('请求状态：排队段占比', c.requests.queue / c.requests.total, 0.1, 0.03);
  eq('输入 Token：卡标题', c.input.title, '输入 Token');
  eq('输入 Token：数值', c.input.rate, '1.7K');
  eq('输入 Token：单位', c.input.unit, 'tok/s');
  eq('输入 Token：脚注', c.input.foot, 'Prefill 均值');
  eq('KV Cache：卡标题', c.kv.title, 'KV Cache');
  eq('KV Cache：中心值', c.kv.value, '16%');
  eq('KV Cache：余量文案', c.kv.headroom, '余量充足');
  eq('KV Cache：命中率', c.kv.hit, 'Cache Hit 93%');
  add('KV Cache：命中率文案不得被省略号截断（需要 ' + c.kv.need + 'px / 可用 ' + c.kv.avail + 'px）', c.kv.clipped === false, '文案被省略号截断');
  near('KV Cache：弧比例', c.kv.ratio, 0.16, 0.01);
  eq('MTP：中心值', c.mtp.value, '69%');
  near('MTP：弧比例', c.mtp.ratio, 0.69, 0.01);
  eq('MTP：TAR', c.mtp.tar, '1.99');
  eq('统一内存：中心值', c.mem.value, '82%');
  near('统一内存：弧比例', c.mem.ratio, 0.82, 0.01);
  eq('统一内存：节点', c.mem.node, 'S1');
  eq('统一内存：容量', c.mem.pair, '105/128G');
  eq('统一内存：可用', c.mem.free, '23G');
  eq('GPU：卡标题', c.gpu.title, 'GPU 活跃度');
  eq('GPU：数值', c.gpu.value, '93%');
  eq('GPU：状态', c.gpu.state, '计算中');
  eq('GPU：柱条数', c.gpu.bars, 15);
  within('卡片高 / 面板宽', c.heightRatio, 0.25, 0.31);
}

/** 任务 8：采样步进与 rAF 合并渲染。 */
function checkRealtime(p) {
  if (!p.samples) {
    add('实时模式数据', false, 'p.samples 缺失（产物早于实时刷新实现）');
    return;
  }
  eq('采样：步进帧数', p.samples.count, 3);
  add('采样：数值随步进变化', p.samples.rate !== p.samples.firstRate,
    'firstRate=' + p.samples.firstRate + ', rate=' + p.samples.rate);
  // tick=3 表示模拟 3 秒：冻结基点 23:48:30 前进 2 秒
  eq('采样：时钟随步进前进', p.texts.clock, '23:48:32');
  // 3 帧步进 + 1 帧量级注入
  eq('渲染：同步模式每帧都画', p.paintCount, 4);
  eq('渲染：更新计数', p.updateCount, 4);
  // Review Focus 2：数值量级突变不得挤坏 Hero 卡
  eq('量级：2.3M 渲染', p.texts.rate, '2.3M');
  // 真正要守的边界是「数字 + tok/s 不得侵入右侧折线区」，而不是某个固定的宽度配额
  eq('量级：数字与单位不侵入折线区', p.hero.valueRight <= p.hero.chartLeft + 0.5, true);
  within('量级：大数字宽度 / 面板宽', (p.hero.numW / p.panel.w) * 100, 0, 36);
  eq('量级：无横向溢出', p.overflow.doc <= p.viewport.w + 1, true);
}

/** Review Focus 1：极窄视口下比例与溢出。 */
function checkNarrow(p, width) {
  near('窄屏：面板宽 = min(92vw,420)', p.panel.w, Math.min(0.92 * width, 420), 1.5);
  eq('窄屏：无横向溢出', p.overflow.doc <= p.viewport.w + 1, true);
  eq('窄屏：折线仍为 60 点', p.spark.points, 60);
  within('窄屏：卡片高 / 面板宽', p.cards.heightRatio, 0.25, 0.31);
  // C5：真实模型名（如 meta-llama/Llama-3.3-70B-Instruct）换行会把标题区撑进 Hero 卡
  eq('窄屏：长模型名不撑破标题区', p.hdr.bottom <= p.hdr.heroTop + 0.5, true);
  within('窄屏：标题区高度不变', p.hdr.h / p.panel.w, 0, 0.115);
}

/** 任务 9/12：数据源不可达时的降级渲染（布局不塌陷、曲线保留最后一帧）。 */
function checkDegrade(p, live) {
  eq('降级：连接状态文案', p.texts.link, '未连接');
  eq('降级：状态字段', p.status, 'error');
  near('降级：面板宽度不变', p.panel.w, live.panel.w, 0.01);
  near('降级：面板高度不变', p.panel.h, live.panel.h, 0.01);
  eq('降级：曲线保留最后一帧', p.spark.d, live.spark.d);
  // C3：stale 必须可见（只有 error 才提示 = 安静地显示过期数据）
  eq('降级：stale 文案可见', p.degrade.staleLink, '连接异常');
  eq('降级：stale 数据区压暗', p.degrade.staleDim, true);
  eq('降级：error 数据区压暗', p.dim, true);
  eq('灵动岛：?island=1 时渲染', p.island.present, true);
  eq('灵动岛：显示 tok/s', p.island.rate, '257');
}

/**
 * 页脚第 4 个齿轮的几何：尺寸必须与其余三个一致，间距一致，且在最右。
 *
 * 关于「其余三个位置没变」：。ftr-actions 是**右对齐**的按钮组，在最右再加一格，
 * 组内前三个必然整体左移一格（4.4u 按钮 + 3.4u 间隙 = 7.8u）——除非把它们挤出面板外，
 * 否则没有别的排布方式。所以这里断言的是"尺寸、间距、顺序一律不变，只多占一格"，
 * 而不是假装绝对坐标没动。
 */
function checkFooterGeometry(p) {
  const g = p.controls && p.controls.geometry;
  if (!g || !g.unit) {
    add('页脚几何数据', false, 'p.controls.geometry 缺失（页面早于齿轮按钮实现）');
    return;
  }
  const u = g.unit;
  const keys = ['refresh', 'copy', 'power', 'settings'];
  for (const k of keys) {
    if (!g[k]) {
      add('页脚几何：' + k + ' 存在', false, '量不到 #btn-' + k);
      return;
    }
  }
  for (const k of keys) {
    near('页脚：' + k + ' 宽 = 4.4u（与 v0.1.0 规格一致）', g[k].w / u, 4.4, 0.06);
    near('页脚：' + k + ' 高 = 4.4u', g[k].h / u, 4.4, 0.06);
  }
  near('页脚：四按钮同尺寸（齿轮不挤小其余三个）', g.settings.w, g.refresh.w, 0.5);
  eq('页脚：顺序仍是 刷新→复制→电源→齿轮', g.refresh.x < g.copy.x && g.copy.x < g.power.x && g.power.x < g.settings.x, true);
  // 槽距 = 按钮 4.4u + 间隙 3.4u；四个按钮两两相邻都必须一样，说明只是多了一格，没有挤压/换行
  const pitch = (a, b) => (b.x - a.x) / u;
  near('页脚：刷新→复制 槽距 7.8u', pitch(g.refresh, g.copy), 7.8, 0.06);
  near('页脚：复制→电源 槽距 7.8u', pitch(g.copy, g.power), 7.8, 0.06);
  near('页脚：电源→齿轮 槽距 7.8u（新齿轮与前三个同间距）', pitch(g.power, g.settings), 7.8, 0.06);
  near('页脚：齿轮在最右且贴齐页脚右边缘', (g.footerRight - g.settings.right) / u, 0, 0.06);
  // v0.1.0 里 power.right 就贴在页脚右边缘；v0.2.0 起整组左移一格，这是新增按钮的唯一代价
  near('页脚：原三按钮相对 v0.1.0 只整体左移一格（7.8u），尺寸与间距不变',
    (g.footerRight - g.power.right) / u, 7.8, 0.06);
  eq('页脚：没有把按钮挤出页脚左边界', g.refresh.x >= g.footerLeft - 0.5, true);
}

/** 设置浮层：点页脚齿轮后必须在面板内出现，字段齐全，且不改变面板尺寸。 */
function checkSettings(p, live) {
  const s = p.settings;
  if (!s) {
    add('设置浮层数据', false, 'p.settings 缺失（页面早于设置浮层实现）');
    return;
  }
  eq('设置：浮层节点存在', s.present, true);
  eq('设置：标题', s.title, '设置');
  eq('设置：点齿轮后打开', s.open, true);
  eq('设置：齿轮点击记进 press', p.controls.press.settings.open, true);
  // 字段与按钮必须齐全：baseUrl / apiKey / model / probeEveryMs / proxy / pricing 两项 + 测试/保存/关闭
  eq('设置：baseUrl 字段', s.fields.baseUrl, true);
  eq('设置：apiKey 字段存在且是密码框', s.fields.apiKey && s.fields.apiKeyPassword, true);
  eq('设置：model 字段', s.fields.model, true);
  eq('设置：probeEveryMs 字段', s.fields.probeEveryMs, true);
  eq('设置：proxy 开关', s.fields.proxy, true);
  eq('设置：pricing 输入单价字段', s.fields.priceIn, true);
  eq('设置：pricing 输出单价字段', s.fields.priceOut, true);
  eq('设置：测试连接按钮', s.buttons.test, true);
  eq('设置：保存按钮', s.buttons.save, true);
  eq('设置：关闭按钮', s.buttons.close, true);
  if (live) near('设置：打开浮层不改变面板高度', p.panel.h, live.panel.h, 0.01);
}

/** 采集器不在时：浮层照常打开，但必须给出一句可操作的提示，而不是静默失败。 */
function checkSettingsOffline(p) {
  const s = p.settings || {};
  eq('设置（无采集器）：浮层仍能打开', s.open, true);
  eq('设置（无采集器）：提示文案', s.notice, '设置需要本机采集器（node collector.js 或桌面版）');
  eq('设置（无采集器）：提示可见', s.noticeHidden, false);
  eq('设置（无采集器）：读配置失败有可读错误', String(s.error || '').indexOf('读不到采集器配置') === 0, true);
  eq('设置（无采集器）：测试/保存按钮禁用（点不坏）', s.disabled.test === true && s.disabled.save === true, true);
  eq('设置（无采集器）：字段齐全但只读', s.fields.baseUrl && s.fields.apiKey && s.fields.proxy, true);
}

/** 关闭按钮：点一下必须真的收起浮层，且面板尺寸不变。 */
function checkSettingsClosed(p, live) {
  const s = p.settings || {};
  eq('设置：关闭按钮收起浮层', s.hidden, true);
  eq('设置：关闭后不再处于打开态', s.open, false);
  if (live) {
    near('设置：关闭后面板高度不变', p.panel.h, live.panel.h, 0.01);
    near('设置：关闭后面板宽度不变', p.panel.w, live.panel.w, 0.01);
  }
}

/** 客户端视图：卡片语义必须是"云 API 真能给的量"。 */
function checkClientView(p) {
  eq('客户端视图：视图标记', p.view, 'client');
  eq('客户端视图：连接状态', p.texts.link, 'API 已连接');
  eq('客户端视图：探测状态标题', p.cards.requests.title, '探测状态');
  eq('客户端视图：成功数', p.cards.requests.active, '40');
  eq('客户端视图：失败数', p.cards.requests.queued, '2');
  near('客户端视图：成功率进度条', p.cards.requests.run / p.cards.requests.total, 0.95, 0.02);
  eq('客户端视图：响应延迟标题', p.cards.kv.title, '响应延迟');
  eq('客户端视图：P50 延迟', p.cards.kv.value, '320ms');
  eq('客户端视图：P95 延迟', p.cards.kv.headroom, 'P95 900ms');
  near('客户端视图：延迟环得分', p.cards.kv.ratio, 0.84, 0.01);
  eq('客户端视图：吞吐标题', p.cards.mtp.title, '吞吐分位');
  eq('客户端视图：P95 吞吐', p.cards.mtp.tar, '88');
  near('客户端视图：吞吐环得分（100 tok/s 记满分）', p.cards.mtp.ratio, 0.62, 0.01);
  eq('客户端视图：用量标题', p.cards.mem.title, '今日用量');
  eq('客户端视图：输入用量', p.cards.mem.pair, '输入 1.0M');
  eq('客户端视图：成本', p.cards.mem.free, '$6.00');
  eq('客户端视图：可用率', p.cards.gpu.value, '95%');
  eq('客户端视图：可用率副文案', p.cards.gpu.state, '部分失败');
  // 页脚按钮：必须存在，且点击后真的有效果
  eq('按钮：刷新存在', p.controls.refresh, true);
  eq('按钮：复制存在', p.controls.copy, true);
  eq('按钮：电源存在', p.controls.power, true);
  eq('按钮：设置齿轮存在（第 4 个）', p.controls.settings, true);
  eq('按钮：电源点击后进入暂停', p.controls.press.power.paused, true);
  eq('按钮：电源进入暂停有视觉状态', p.controls.press.power.isOff, true);
  eq('按钮：复制内容以 Tokmeter 开头', String(p.controls.press.copy.text || '').startsWith('Tokmeter'), true);
  eq('按钮：复制内容含真实模型名', String(p.controls.press.copy.text || '').includes('deepseek-chat'), true);
  eq('客户端视图：输入卡脚注带标签', p.cards.input.foot, 'TTFT 320ms');
  eq('客户端视图：折线仍是 60 点', p.spark.points, 60);
  eq('客户端视图：柱条 15 根', p.cards.gpu.bars, 15);
  // 云 API 不可能提供的服务端内部量：必须保持未知，不能编造 0
  eq('客户端视图：KV 占用保持未知', p.raw.kvCacheUsage, null);
  eq('客户端视图：MTP TAR 保持未知', p.raw.mtpTar, null);
  eq('客户端视图：显存保持未知', p.raw.memoryUsedGB, null);
  eq('客户端视图：GPU 利用率保持未知', p.raw.gpuUtil, null);
}

async function main() {
  let server = null;
  let base = '';
  if (target) {
    base = pathToFileURL(resolve(ROOT, target)).href;
  } else {
    server = await startServer();
    base = 'http://127.0.0.1:' + server.address().port + '/tools/frame.html?q=';
  }
  // 追加参数必须拼进被测页面自己的 query：
  // http 模式下页面在 iframe 里，参数要进 q= 里面，拼到外壳 URL 上页面收不到。
  const makeUrl = (extra) => {
    const q = extra ? query + '&' + extra : query;
    if (target) return base + (q ? '?' + q : '');
    return base + encodeURIComponent(q);
  };

  const dom = await dumpDom(makeUrl(''));
  const m = dom.match(/PROBE_JSON:(\{[\s\S]*?\})<\/pre>/);
  if (!m) {
    console.error('探针输出缺失。DOM 片段：\n' + dom.slice(0, 800));
    if (server) server.close();
    process.exit(1);
  }
  const p = JSON.parse(m[1]);
  checkShell(p);
  checkCards(p);

  // 第二次运行：3 帧步进 + rAF 合并路径
  const dom2 = await dumpDom(makeUrl('tick=3&inject=rate:2340000'));
  const m2 = dom2.match(/PROBE_JSON:(\{[\s\S]*?\})<\/pre>/);
  if (!m2) {
    add('实时模式探针', false, '第二次运行没有拿到探针输出');
  } else {
    checkRealtime(JSON.parse(m2[1]));
  }

  // 第三次运行：降级路径
  // 第四次运行：极窄视口（320x700）。需要 iframe 才能设视口，file:// 直开模式显式跳过。
  const narrowW = 320;
  const narrowH = 700;
  let narrowSkipped = false;
  if (server) {
    const longName = 'Qwen3.8-Flash-Extended-Reasoning-32B-Instruct-2026';
    const narrowUrl = 'http://127.0.0.1:' + server.address().port + '/tools/frame.html?w=' + narrowW +
      '&h=' + narrowH + '&q=' + encodeURIComponent(query + '&name=' + longName);
    const dom4 = await dumpDom(narrowUrl);
    const m4 = dom4.match(/PROBE_JSON:(\{[\s\S]*?\})<\/pre>/);
    if (!m4) {
      add('窄屏探针', false, '极窄视口运行没有拿到探针输出');
    } else {
      checkNarrow(JSON.parse(m4[1]), narrowW);
    }
  } else {
    narrowSkipped = true;
  }

  const dom3 = await dumpDom(makeUrl('fail=both&island=1'));
  const m3 = dom3.match(/PROBE_JSON:(\{[\s\S]*?\})<\/pre>/);
  if (!m3) {
    add('降级模式探针', false, '第三次运行没有拿到探针输出');
  } else {
    checkDegrade(JSON.parse(m3[1]), p);
  }

  // 第五次运行：客户端视图（云 API 观测）+ 页脚按钮点击回归
  let clientProbe = null;
  const dom5 = await dumpDom(makeUrl('view=client&press=power,copy'));
  const m5 = dom5.match(/PROBE_JSON:(\{[\s\S]*?\})<\/pre>/);
  if (!m5) {
    add('客户端视图探针', false, '客户端视图运行没有拿到探针输出');
  } else {
    clientProbe = JSON.parse(m5[1]);
    checkClientView(clientProbe);
  }

  // 第六次运行：齿轮 → 面板内设置浮层（默认必须隐藏，点开不能把面板撑大；字段/按钮齐全）
  const dom6 = await dumpDom(makeUrl('view=client&press=settings'));
  const m6 = dom6.match(/PROBE_JSON:(\{[\s\S]*?\})<\/pre>/);
  if (!m6) {
    add('设置浮层探针', false, '设置浮层运行没有拿到探针输出');
  } else {
    checkSettings(JSON.parse(m6[1]), clientProbe);
  }

  // 第七次运行：采集器不在时（显式指向一个刚放掉的空端口）必须给出可操作的提示，而不是静默失败。
  // 用死端口而不是"本机恰好没开采集器"，这条断言才不会随开发机状态飘。
  const deadPort = await new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => ok(port));
    });
  });
  const dom7 = await dumpDom(makeUrl('view=client&press=settings&endpoint=http://127.0.0.1:' + deadPort + '/snapshot'));
  const m7 = dom7.match(/PROBE_JSON:(\{[\s\S]*?\})<\/pre>/);
  if (!m7) {
    add('无采集器探针', false, '无采集器运行没有拿到探针输出');
  } else {
    checkSettingsOffline(JSON.parse(m7[1]));
  }

  // 第八次运行：关闭按钮必须真的把浮层收起来（press=settings,close 点 #btn-settings 再点 #set-close）
  const dom8 = await dumpDom(makeUrl('view=client&press=settings,close'));
  const m8 = dom8.match(/PROBE_JSON:(\{[\s\S]*?\})<\/pre>/);
  if (!m8) {
    add('关闭浮层探针', false, '关闭运行没有拿到探针输出');
  } else {
    checkSettingsClosed(JSON.parse(m8[1]), clientProbe);
  }

  const failed = checks.filter((c) => !c.ok);
  if (narrowSkipped) {
    console.log('  skip  窄屏（320x700）：离线产物模式没有 iframe 承载，无法设视口 —— 由 http 模式覆盖');
  }
  for (const c of checks) console.log((c.ok ? '  ok   ' : '  FAIL ') + c.label + (c.ok ? '' : '  → ' + c.detail));
  console.log('\n探针：' + (checks.length - failed.length) + '/' + checks.length + ' 通过；视口 ' +
    p.viewport.w + 'x' + p.viewport.h + '，面板 ' + p.panel.w + 'x' + p.panel.h);
  if (server) server.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main();