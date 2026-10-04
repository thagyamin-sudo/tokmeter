/**
 * 采集器 · HTTP 服务：对外只暴露面板需要的东西。
 *
 *   GET  /snapshot      → 客户端视图的数据（不含 apiKey）+ probe 估算块
 *   GET  /health        → 存活探针
 *   GET  /config        → 当前配置（apiKey 已脱敏，只留末 4 位）+ probe 估算块
 *   POST /config        → 改配置（部分字段）→ 写回文件 → 热重启探测，不用重启进程
 *   POST /config/test   → 用提交的 baseUrl/apiKey/model 试发一次最小流式请求（不写配置）
 *   POST /probe         → {enabled} 立即启停主动探测（运行时暂停，不写配置文件）
 *   POST /v1/*          → 可选：OpenAI 兼容转发（被动统计真实流量），key 由本进程注入
 *
 * 主动探测：每 probeEveryMs 发一次小流式请求，量 TTFT / tok/s / 成功失败。
 * 串行执行（永不并发探测），避免把"排队等待"算成"模型慢"。
 * 总开关 probe:false = 只被动统计，一次额外调用都不发（定时器根本不挂）。
 *
 * 安全约定：apiKey 只在本进程内使用；日志、响应、探针数据里都不允许出现它。
 */
import { createServer } from 'node:http';
import { createStats } from './stats.js';
import { measureOpenAiStream } from './openai-probe.js';
import { isApiKeyUnchanged, maskApiKey, patchConfig, probeBudget, publicConfig, writeConfig } from './config.js';

/** 请求体上限：配置就是几个字段，超过这个量级一定是发错了。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 把 fetch 的响应体按行拆成 async 迭代器。 */
async function* bodyLines(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      yield line;
    }
  }
  if (buf.trim() !== '') yield buf;
}

/** 从报错链里挖 errno：undici 会把真实原因塞进 cause / cause.errors[]。 */
function errorCode(err) {
  const seen = new Set();
  const walk = (e, depth) => {
    if (!e || typeof e !== 'object' || depth > 3 || seen.has(e)) return '';
    seen.add(e);
    if (typeof e.code === 'string' && e.code) return e.code;
    if (Array.isArray(e.errors)) {
      for (const sub of e.errors) {
        const hit = walk(sub, depth + 1);
        if (hit) return hit;
      }
    }
    return walk(e.cause, depth + 1);
  };
  return walk(err, 0);
}

/** 网络类错误的可读化：fetch failed 单独看毫无信息量，把 errno 与下一步建议带出来。 */
function describeFetchError(err, timeoutMs) {
  const msg = err && err.message ? err.message : String(err);
  const code = errorCode(err);
  if (err && (err.name === 'TimeoutError' || /timeout/i.test(msg))) {
    return '请求超时（超过 ' + timeoutMs + 'ms）：' + msg;
  }
  if (code === 'ECONNREFUSED') return '连不上上游（ECONNREFUSED）：检查 baseUrl 是否正确、服务是否在运行';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败（' + code + '）：检查 baseUrl 的主机名';
  if (/bad port/i.test(msg)) return '端口不合法（浏览器/fetch 规范禁止访问该端口）：检查 baseUrl 的端口';
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'TLS 证书校验失败（' + code + '）';
  return code ? msg + '（' + code + '）' : msg + '：检查 baseUrl 与网络';
}

export function createCollector({ config, fetchImpl = fetch, now = () => Date.now(), log = () => {}, configPath = null }) {
  const stats = createStats({ windowMs: 60000, pricing: config.pricing });
  let timer = null;
  let running = false;
  let probePaused = false;      // 临时暂停（POST /probe、桌面壳隐藏到托盘），不写配置文件
  let inFlight = 0;
  let lastError = null;
  let status = 'connecting';
  let lastPromptTokens = null;  // 最近一次成功探测的 promptTokens：面板「每天约多少 token」的估算口径
  const controller = new AbortController();

  /** 当前是否真的在探测：进程 start() 过 + 总开关没关 + 没被临时暂停。 */
  function probeEnabled() {
    return running && config.probe !== false && !probePaused;
  }

  /**
   * 让定时器与 probeEnabled() 对齐。没挂定时器 = 一次额外调用都不会发。
   * restart：间隔/开关变了要换定时器；immediate：挂上后立刻探一次（换配置后马上有数）。
   */
  function syncTimer({ restart = false, immediate = true } = {}) {
    const want = probeEnabled();
    if (timer !== null && (restart || !want)) {
      clearInterval(timer);
      timer = null;
    }
    if (want && timer === null) {
      timer = setInterval(() => probeOnce(), config.probeEveryMs);
      if (immediate) void probeOnce();
    }
  }

  /** 面板 / 桌面壳要的探测状态与成本估算（enabled 是运行时真实状态，不是配置里的字面值）。 */
  function probeInfo() {
    return probeBudget(config, { promptTokens: lastPromptTokens, enabled: probeEnabled() });
  }

  /** 立即启停探测：只动运行时，不写配置文件（页脚 ⏻、托盘「隐藏时暂停探测」都走这里）。 */
  function setProbeEnabled(enabled) {
    probePaused = enabled !== true;
    if (!probePaused) {
      status = 'connecting';   // 恢复后第一帧必须是"没有新样本"，不能沿用暂停前的 live
      lastError = null;
    }
    syncTimer();
    return probeInfo();
  }

  /** 一次主动探测：只发一个小请求，量完就丢。 */
  async function probeOnce() {
    if (inFlight > 0) return;                 // 串行：上一轮没回来就跳过
    inFlight = 1;
    const started = now();
    try {
      const res = await fetchImpl(config.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + config.apiKey,
        },
        body: JSON.stringify({
          model: config.model,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: config.probeMaxTokens,
          messages: [{ role: 'user', content: config.probePrompt }],
        }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(config.timeoutMs) : undefined,
      });
      if (!res.ok) throw new Error('上游 HTTP ' + res.status);
      const measured = await measureOpenAiStream(bodyLines(res), now, started);
      // 记录最近一次**成功**探测的真实 prompt token 数，供「每天约多少 token」估算使用
      if (Number.isFinite(measured.promptTokens) && measured.promptTokens > 0) lastPromptTokens = measured.promptTokens;
      stats.add({ t: started, ok: true, ...measured });
      status = 'live';
      lastError = null;
    } catch (err) {
      stats.add({ t: started, ok: false });
      status = stats.snapshot(now()).failCount >= 5 ? 'error' : stats.snapshot(now()).failCount >= 3 ? 'stale' : 'live';
      lastError = err && err.message ? err.message : String(err);
      log('探测失败：' + lastError);
    } finally {
      inFlight = 0;
    }
  }

  /** 面板契约：客户端视图字段 + 复用 Snapshot 的外层形状。 */
  function snapshotPayload() {
    const s = stats.snapshot(now());
    return {
      view: 'client',
      status,
      clock: new Date(now()).toTimeString().slice(0, 8),
      updatedAt: now(),
      model: { name: config.model, engine: 'OpenAI 兼容', nodes: 'API', link: status === 'error' ? 'down' : 'up' },
      output: { tokPerSec: s.tokPerSec, history: s.history },
      input: { tokPerSec: s.ttftP50 > 0 ? (s.tokensIn / Math.max(1, s.ttftP50)) * 1000 : 0, prefillAvgMs: s.ttftLast },
      requests: { active: inFlight, queued: 0, capacity: 1 },
      client: {
        ttftP50: s.ttftP50,
        ttftP95: s.ttftP95,
        ttftLast: s.ttftLast,
        rateP50: s.rateP50,
        rateP95: s.rateP95,
        probeCount: s.probeCount,
        failCount: s.failCount,
        successRate: s.successRate,
        available: s.available,
        tokensIn: s.tokensIn,
        tokensOut: s.tokensOut,
        cost: s.cost,
        lastError,
      },
      // 探测状态与成本估算：面板据此显示「每天多少次、约多少 token」，并渲染开关文案
      probe: probeInfo(),
    };
  }

  function sendJson(res, code, body) {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // 面板常以 file:// 或别的端口打开，必须放行跨域（只读接口、只监听本机、不含任何密钥）
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    res.end(text);
  }

  const fail = (res, code, message) => sendJson(res, code, { ok: false, error: { message } });

  /** 读并解析 JSON 请求体；空体 = {}；超限/坏 JSON 抛出可读错误。 */
  async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY_BYTES) throw new Error('请求体过大（上限 ' + MAX_BODY_BYTES + ' 字节）');
      chunks.push(c);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text === '') return {};
    try {
      const json = JSON.parse(text);
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('必须是 JSON 对象');
      return json;
    } catch (err) {
      throw new Error('请求体不是合法 JSON：' + (err && err.message ? err.message : String(err)));
    }
  }

  /** 当前配置的面板视图（apiKey 已脱敏），probe 块带运行时的启停状态。 */
  function configView() {
    return publicConfig(config, { configPath, probe: probeInfo() });
  }

  /**
   * 就地生效新配置。
   * 必须原地改（而不是整体替换 config）：stats 捕获的是 config.pricing 这个**对象引用**，
   * 换对象会让成本单价悄悄失效。
   */
  function applyConfig(next) {
    if (!config.pricing || typeof config.pricing !== 'object') config.pricing = { inPerM: 0, outPerM: 0 };
    config.pricing.inPerM = next.pricing.inPerM;
    config.pricing.outPerM = next.pricing.outPerM;
    for (const k of ['baseUrl', 'apiKey', 'model', 'probe', 'probeEveryMs', 'probeMaxTokens', 'probePrompt', 'proxy', 'timeoutMs', 'port']) {
      config[k] = next[k];
    }
  }

  /**
   * 热重启探测：换间隔、立刻按新配置探一次（不用重启进程）。
   * resetProbe=true 只在**总开关真的变了**时传：那次是用户明确表态，要清掉临时暂停；
   * 只改 model/baseUrl 时不碰临时暂停，免得把页脚 ⏻ 的暂停悄悄解掉。
   */
  function restartProbing({ resetProbe = false } = {}) {
    if (resetProbe) probePaused = false;
    status = 'connecting';
    lastError = null;
    syncTimer({ restart: true });
  }

  /**
   * 用提交的 baseUrl/apiKey/model 试发一次最小流式请求。
   * 不写配置、不计入滚动统计（这是"能不能用"的体检，不是生产探测）。
   */
  async function testUpstream(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    // 显式给了字段就按给的算（空串 = 用户清空了输入框 → 报错，而不是偷偷沿用旧值）
    const pick = (key, fallback) =>
      Object.prototype.hasOwnProperty.call(p, key) ? String(p[key] === null || p[key] === undefined ? '' : p[key]).trim() : String(fallback || '').trim();
    const baseUrl = pick('baseUrl', config.baseUrl).replace(/\/+$/, '');
    const model = pick('model', config.model);
    const apiKey = isApiKeyUnchanged(p.apiKey) ? config.apiKey : p.apiKey;
    if (!/^https?:\/\//.test(baseUrl)) {
      return { code: 400, body: { ok: false, error: { message: 'baseUrl 必须以 http:// 或 https:// 开头' } } };
    }
    if (!model) return { code: 400, body: { ok: false, error: { message: 'model 不能为空' } } };

    const started = now();
    try {
      const res = await fetchImpl(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: config.probeMaxTokens,
          messages: [{ role: 'user', content: config.probePrompt }],
        }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(config.timeoutMs) : undefined,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const hint = res.status === 401 || res.status === 403 ? '（apiKey 不对或没权限）' : res.status === 404 ? '（baseUrl 或 model 不对）' : '';
        return {
          code: 200,
          body: {
            ok: false, model, ttftMs: null, tokPerSec: 0,
            error: '上游 HTTP ' + res.status + hint + (detail ? '：' + detail.slice(0, 200) : ''),
          },
        };
      }
      const measured = await measureOpenAiStream(bodyLines(res), now, started);
      return {
        code: 200,
        body: {
          ok: true,
          model,
          ttftMs: Number.isFinite(measured.ttftMs) ? measured.ttftMs : null,
          tokPerSec: Number.isFinite(measured.tokPerSec) ? Math.round(measured.tokPerSec * 100) / 100 : 0,
          totalMs: measured.totalMs,
          promptTokens: measured.promptTokens,
          completionTokens: measured.completionTokens,
          error: null,
        },
      };
    } catch (err) {
      return { code: 200, body: { ok: false, model, ttftMs: null, tokPerSec: 0, error: describeFetchError(err, config.timeoutMs) } };
    }
  }

  /** POST /config：校验 → 写文件 → 生效 → 热重启。日志里绝不出现 apiKey。 */
  async function updateConfig(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return fail(res, 400, err.message);
    }
    let next;
    try {
      next = patchConfig(config, body);
    } catch (err) {
      return fail(res, 400, err && err.message ? err.message : String(err));
    }
    const keyChanged = next.apiKey !== config.apiKey;
    const probeChanged = next.probe !== config.probe;
    if (!configPath) {
      return fail(res, 500, '采集器启动时没有配置文件路径，改不了配置：请用 node collector.js <配置文件> 启动');
    }
    try {
      writeConfig(configPath, next);
    } catch (err) {
      return fail(res, 500, '写配置文件失败（' + configPath + '）：' + (err && err.message ? err.message : String(err)));
    }
    applyConfig(next);
    restartProbing({ resetProbe: probeChanged });
    const probe = probeInfo();
    log(
      (probe.enabled ? '配置已更新并热重启探测' : '配置已更新（主动探测当前关闭，不发任何额外调用）') +
      '：model=' + config.model + ' baseUrl=' + config.baseUrl +
      ' probeEveryMs=' + config.probeEveryMs + ' probe=' + (config.probe ? '开' : '关') + ' proxy=' + config.proxy +
      ' apiKey=' + (keyChanged ? '已更新' : '未改动（' + maskApiKey(config.apiKey) + '）')
    );
    return sendJson(res, 200, { ok: true, restarted: probe.enabled, config: configView() });
  }

  /** 可选：OpenAI 兼容转发。key 只在服务端注入，客户端拿不到。 */
  async function proxy(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const started = now();
    const isStream = body.length > 0 && /"stream"\s*:\s*true/.test(body.toString('utf8'));
    try {
      const upstream = await fetchImpl(config.baseUrl + req.url.replace(/^\/v1/, ''), {
        method: req.method,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.apiKey },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      if (!upstream.ok || !upstream.body) {
        res.end(await upstream.text().catch(() => ''));
        stats.add({ t: started, ok: false });
        return;
      }
      if (isStream) {
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const passthrough = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
          buf += decoder.decode(value, { stream: true });
          passthrough.push(buf);
          buf = '';
        }
        res.end();
        // 复用同一套测量逻辑：把已转发的文本重新按行喂进去
        stats.add({ t: started, ok: true, ...(await measureOpenAiStream(passthrough.join('').split('\n'), now, started)) });
      } else {
        const text = await upstream.text();
        res.end(text);
        try {
          const json = JSON.parse(text);
          stats.add({
            t: started,
            ok: true,
            ttftMs: now() - started,
            tokPerSec: 0,
            promptTokens: json.usage ? json.usage.prompt_tokens : 0,
            completionTokens: json.usage ? json.usage.completion_tokens : 0,
          });
        } catch {
          stats.add({ t: started, ok: false });
        }
      }
    } catch (err) {
      stats.add({ t: started, ok: false });
      lastError = err && err.message ? err.message : String(err);
      sendJson(res, 502, { error: { message: '转发失败：' + lastError } });
    }
  }

  const handler = (req, res) => {
    const path = String(req.url || '').split('?')[0];
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    if (path === '/snapshot' || path === '/') return sendJson(res, 200, snapshotPayload());
    if (path === '/health') return sendJson(res, 200, { ok: true, status });
    if (path === '/config') {
      if (req.method === 'GET') return sendJson(res, 200, { ok: true, config: configView() });
      if (req.method === 'POST') return void updateConfig(req, res);
      return fail(res, 405, '只支持 GET / POST');
    }
    if (path === '/probe') {
      if (req.method !== 'POST') return fail(res, 405, '只支持 POST');
      return void (async () => {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return fail(res, 400, err.message);
        }
        if (typeof body.enabled !== 'boolean') return fail(res, 400, 'enabled 必须是布尔值（true 或 false）');
        const probe = setProbeEnabled(body.enabled);
        log(
          '主动探测' + (probe.enabled ? '已恢复' : '已暂停') +
          '（每 ' + probe.everyMs + 'ms 一次 ≈ ' + probe.probesPerDay + ' 次/天、约 ' + probe.tokensPerDayEstimate + ' token/天，估算）'
        );
        return sendJson(res, 200, { ok: true, probe });
      })();
    }
    if (path === '/config/test') {
      if (req.method !== 'POST') return fail(res, 405, '只支持 POST');
      return void (async () => {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return fail(res, 400, err.message);
        }
        const result = await testUpstream(body);
        return sendJson(res, result.code, result.body);
      })();
    }
    if (config.proxy && path.startsWith('/v1/')) return void proxy(req, res);
    sendJson(res, 404, { error: { message: 'not found' } });
  };

  return {
    handler,
    snapshotPayload,
    configView,
    testUpstream,
    probeOnce,
    probeInfo,
    setProbeEnabled,
    isProbing: probeEnabled,
    get status() {
      return status;
    },
    start() {
      if (running) return;
      running = true;
      // 总开关关闭（probe:false）：定时器根本不挂 —— 只被动统计，零额外调用
      if (config.probe === false) {
        log('主动探测已关闭（probe: false）：只被动统计经过本机的流量，不发任何探测请求');
        return;
      }
      syncTimer();
    },
    stop() {
      running = false;
      probePaused = false;
      syncTimer();
      controller.abort();
    },
  };
}
