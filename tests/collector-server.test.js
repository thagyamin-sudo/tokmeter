/**
 * 采集器 · 集成测试：用本地假上游（真 HTTP + 真 SSE）跑完整链路，
 * 断言面板要的字段、失败降级、以及"apiKey 绝不出现在 /snapshot 里"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createCollector } from '../collector/server.js';
import { normalizeConfig } from '../collector/config.js';

/** 假上游：按 OpenAI 的 SSE 格式吐 chunk；fail=true 时返回 500。 */
async function startUpstream({ fail = false, chunks = ['你', '好', '呀'], includeUsage = true } = {}) {
  const server = createServer(async (req, res) => {
    if (fail) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"boom"}}');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const sse = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    // 首个 chunk 前留一点真实延迟：本地回环太快时 TTFT 会是 0ms，使"必须为正"变成偶发失败
    await new Promise((r) => setTimeout(r, 5));
    for (const c of chunks) sse({ choices: [{ delta: { content: c } }] });
    if (includeUsage) sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 11, completion_tokens: chunks.length } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { server, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' };
}

const cfg = (baseUrl, extra = {}) => normalizeConfig({ baseUrl, apiKey: 'sk-test-SECRET', model: 'test-model', probeEveryMs: 5000, ...extra });

test('探测成功：/snapshot 给出速率、TTFT、用量与可用率', async () => {
  const up = await startUpstream({ chunks: ['a', 'b', 'c', 'd'] });
  const col = createCollector({ config: cfg(up.baseUrl) });
  await col.probeOnce();
  const snap = col.snapshotPayload();
  up.server.close();

  assert.equal(snap.status, 'live');
  assert.equal(snap.view, 'client');
  assert.equal(snap.client.probeCount, 1);
  assert.equal(snap.client.failCount, 0);
  assert.equal(snap.client.successRate, 1);
  assert.equal(snap.client.available, true);
  assert.equal(snap.client.tokensIn, 11);
  assert.equal(snap.client.tokensOut, 4);
  assert.ok(snap.client.ttftP50 > 0, 'TTFT 必须为正');
  assert.ok(snap.output.tokPerSec > 0, '速率必须为正');
  assert.equal(snap.output.history.length, 1, '一次探测一个曲线点');
  assert.match(snap.clock, /^\d{2}:\d{2}:\d{2}$/);
});

test('上游 500：失败计数增长、状态降级，但面板仍有可渲染的数据', async () => {
  const up = await startUpstream({ fail: true });
  const col = createCollector({ config: cfg(up.baseUrl) });
  for (let i = 0; i < 5; i++) await col.probeOnce();
  const snap = col.snapshotPayload();
  up.server.close();

  assert.equal(snap.status, 'error', '连续 5 次失败必须进入 error');
  assert.equal(snap.client.probeCount, 5);
  assert.equal(snap.client.failCount, 5);
  assert.equal(snap.client.successRate, 0);
  assert.equal(snap.client.available, false);
  assert.deepEqual(snap.output.history, [], '没有成功样本就没有曲线点');
  assert.equal(Number.isFinite(snap.output.tokPerSec), true);
  assert.ok(typeof snap.client.lastError === 'string' && snap.client.lastError.length > 0, '要带上最后一次错误原因');
});

test('安全：/snapshot 与探测结果里绝不出现 apiKey', async () => {
  const up = await startUpstream();
  const col = createCollector({ config: cfg(up.baseUrl) });
  await col.probeOnce();
  const text = JSON.stringify(col.snapshotPayload());
  up.server.close();
  assert.equal(text.includes('sk-test-SECRET'), false);
  assert.equal(/apiKey|authorization|bearer/i.test(text), false);
});

test('配置校验：非法值给出可读错误', () => {
  assert.throws(() => normalizeConfig({ baseUrl: 'ftp://x', model: 'm' }), /baseUrl/);
  assert.throws(() => normalizeConfig({ baseUrl: 'https://x', model: '' }), /model/);
  assert.throws(() => normalizeConfig({ baseUrl: 'https://x', model: 'm', port: 0 }), /port/);
  assert.throws(() => normalizeConfig({ baseUrl: 'https://x', model: 'm', probeEveryMs: 100 }), /probeEveryMs/);
});

test('HTTP 入口：/health 与 /snapshot 可访问，未知路径 404', async () => {
  const up = await startUpstream();
  const col = createCollector({ config: cfg(up.baseUrl) });
  const server = createServer(col.handler);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + server.address().port;
  await col.probeOnce();

  const health = await fetch(base + '/health').then((r) => r.json());
  const snapRes = await fetch(base + '/snapshot');
  const snap = await snapRes.json();
  const cors = snapRes.headers.get('access-control-allow-origin');
  const missing = await fetch(base + '/nope');
  server.close();
  up.server.close();

  assert.equal(health.ok, true);
  assert.equal(snap.view, 'client');
  assert.equal(missing.status, 404);
  // 面板常以 file:// 或别的端口打开：只读接口必须放行跨域
  assert.equal(cors, '*');
});
