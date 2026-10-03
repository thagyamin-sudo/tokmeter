/**
 * 采集器 · HTTP 服务：对外只暴露面板需要的东西。
 *
 *   GET /snapshot   → 客户端视图的数据（不含 apiKey）
 *   GET /health     → 存活探针
 *   POST /v1/*      → 可选：OpenAI 兼容转发（被动统计真实流量），key 由本进程注入
 *
 * 主动探测：每 probeEveryMs 发一次小流式请求，量 TTFT / tok/s / 成功失败。
 * 串行执行（永不并发探测），避免把"排队等待"算成"模型慢"。
 */
import { createServer } from 'node:http';
import { createStats } from './stats.js';
import { measureOpenAiStream } from './openai-probe.js';

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

export function createCollector({ config, fetchImpl = fetch, now = () => Date.now(), log = () => {} }) {
  const stats = createStats({ windowMs: 60000, pricing: config.pricing });
  let timer = null;
  let running = false;
  let inFlight = 0;
  let lastError = null;
  let status = 'connecting';
  const controller = new AbortController();

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
    });
    res.end(text);
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
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      return res.end();
    }
    if (req.url === '/snapshot' || req.url === '/') return sendJson(res, 200, snapshotPayload());
    if (req.url === '/health') return sendJson(res, 200, { ok: true, status });
    if (config.proxy && req.url.startsWith('/v1/')) return void proxy(req, res);
    sendJson(res, 404, { error: { message: 'not found' } });
  };

  return {
    handler,
    snapshotPayload,
    probeOnce,
    get status() {
      return status;
    },
    start() {
      if (running) return;
      running = true;
      probeOnce();
      timer = setInterval(() => probeOnce(), config.probeEveryMs);
    },
    stop() {
      running = false;
      if (timer !== null) clearInterval(timer);
      timer = null;
      controller.abort();
    },
  };
}
