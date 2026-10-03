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
  const dir = join(tmpdir(), 'llm-probe');
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
  return new Promise((done) => {
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

async function main() {
  let url = '';
  let server = null;
  if (target) {
    url = pathToFileURL(resolve(ROOT, target)).href + (query ? '?' + query : '');
  } else {
    server = await startServer();
    url = 'http://127.0.0.1:' + server.address().port + '/tools/frame.html?q=' + encodeURIComponent(query);
  }

  const dom = await dumpDom(url);
  const m = dom.match(/PROBE_JSON:(\{[\s\S]*?\})<\/pre>/);
  if (!m) {
    console.error('探针输出缺失。DOM 片段：\n' + dom.slice(0, 800));
    if (server) server.close();
    process.exit(1);
  }
  const p = JSON.parse(m[1]);
  checkShell(p);
  checkCards(p);

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log((c.ok ? '  ok   ' : '  FAIL ') + c.label + (c.ok ? '' : '  → ' + c.detail));
  console.log('\n探针：' + (checks.length - failed.length) + '/' + checks.length + ' 通过；视口 ' +
    p.viewport.w + 'x' + p.viewport.h + '，面板 ' + p.panel.w + 'x' + p.panel.h);
  if (server) server.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
