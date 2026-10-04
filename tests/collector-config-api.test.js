/**
 * 采集器 · 配置接口测试（GET /config、POST /config、POST /config/test）。
 *
 * 这里守的是四条硬约定：
 *  1) apiKey 只以脱敏形式出网（只留末 4 位），且绝不进日志；
 *  2) 面板把脱敏值/空串回传 = 不改动（否则一次保存就把真 key 写成 "sk-***1234"）；
 *  3) 非法值返回 400 + 可读中文，且**不落盘**；
 *  4) 保存后热重启探测，不用重启进程。
 *
 * 每个用例都用 t.after 收摊：断言失败会直接抛出，漏掉 close() 时 keep-alive 连接
 * 会把测试进程吊住（实测：跑完不退出，一路挂到超时）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollector } from '../collector/server.js';
import { normalizeConfig } from '../collector/config.js';

/**
 * 测试用的**假 key**（不是任何人的真 key）。
 * 尾部固定为 CdA3：下面要断言脱敏结果恰好是 `sk-***CdA3`。
 * ！！绝对不要把真的 apiKey 抄进这个文件——仓库是公开的，历史里也删不掉。
 */
const SECRET = 'sk-FIXTURE000000000000000000000000000000000000CdA3';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立：探测是异步的，别拿一个魔法数字的 sleep 赌它跑完。 */
async function waitFor(cond, { timeoutMs = 2000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(stepMs);
  }
}

/** 收摊：先断连接再 close，否则 keep-alive 会让进程不退出。 */
function closeServer(t, server) {
  t.after(() => {
    try { server.closeAllConnections?.(); } catch { /* 忽略 */ }
    try { server.close(); } catch { /* 忽略 */ }
  });
  return server;
}

/** 假上游：成功时吐真 SSE；fail=true 时回 500。 */
async function startUpstream(t, { fail = false, chunks = ['你', '好', '呀'] } = {}) {
  const server = createServer(async (req, res) => {
    if (fail) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"boom"}}');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const sse = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    await new Promise((r) => setTimeout(r, 5));   // 让 TTFT 真的 > 0
    for (const c of chunks) sse({ choices: [{ delta: { content: c } }] });
    sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: chunks.length } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  closeServer(t, server);
  return { server, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1' };
}

/** 起一个采集器 + 真 HTTP 服务，配置写在临时文件里。 */
async function setup(t, { baseUrl = 'https://api.example.com/v1', extra = {}, raw = null, fetchImpl = fetch } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tokmeter-cfg-'));
  const configPath = join(dir, 'collector.config.json');
  const initial = raw || { baseUrl, apiKey: SECRET, model: 'test-model', port: 8787, probeEveryMs: 15000, ...extra };
  writeFileSync(configPath, JSON.stringify(initial, null, 2) + '\n', 'utf8');
  const config = normalizeConfig(initial);
  const logs = [];
  // 记上游调用次数：探测"到底发没发请求"只能数这个，probeCount 是采样后的结果
  const calls = { n: 0 };
  const countedFetch = (url, init) => { calls.n += 1; return fetchImpl(url, init); };
  const col = createCollector({ config, configPath, log: (m) => logs.push(m), fetchImpl: countedFetch });
  const server = closeServer(t, createServer(col.handler));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => col.stop());
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    col, config, configPath, logs, server, base,
    fetchCalls: () => calls.n,
    readFile: () => JSON.parse(readFileSync(configPath, 'utf8')),
    readText: () => readFileSync(configPath, 'utf8'),
    get: (p) => fetch(base + p),
    post: (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  };
}

test('GET /config：apiKey 脱敏成 sk-***+末4位，带 CORS 头', async (t) => {
  const s = await setup(t);
  const res = await s.get('/config');
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(body.ok, true);
  assert.equal(body.config.apiKey, 'sk-***CdA3');
  assert.equal(body.config.apiKeySet, true);
  assert.equal(body.config.baseUrl, 'https://api.example.com/v1');
  assert.equal(body.config.model, 'test-model');
  assert.equal(body.config.writable, true);
  // 脱敏值不得包含中间的 key 片段，也不得出现完整 key
  const text = JSON.stringify(body);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes('FIXTURE0000000000000000000000000000000'), false);
});

test('GET /config：没填 key 时返回空串（不是 ***）', async (t) => {
  const s = await setup(t, { raw: { baseUrl: 'https://api.example.com/v1', apiKey: '', model: 'm' } });
  const body = await (await s.get('/config')).json();
  assert.equal(body.config.apiKey, '');
  assert.equal(body.config.apiKeySet, false);
});

test('POST /config：apiKey 传空串或 *** 都不覆盖磁盘上的真 key', async (t) => {
  const s = await setup(t);
  for (const sent of ['', '***']) {
    const res = await s.post('/config', { apiKey: sent, model: 'changed-model' });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(s.readFile().apiKey, SECRET, '传 ' + JSON.stringify(sent) + ' 时不得覆盖 key');
    assert.equal(s.config.apiKey, SECRET);
    assert.equal(s.readFile().model, 'changed-model');
    assert.equal(body.config.apiKey, 'sk-***CdA3');
  }
});

test('POST /config：把 GET 回来的脱敏值原样回传，也不会覆盖真 key', async (t) => {
  const s = await setup(t);
  const view = (await (await s.get('/config')).json()).config;
  const res = await s.post('/config', { ...view, pricing: { inPerM: 0.27, outPerM: 1.1 } });
  const body = await res.json();

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(s.readFile().apiKey, SECRET, '脱敏值绝不能被写回配置');
  assert.equal(s.config.apiKey, SECRET);
  assert.deepEqual(s.readFile().pricing, { inPerM: 0.27, outPerM: 1.1 });
});

test('POST /config：真 key 会写回文件，且日志里不出现 key', async (t) => {
  const s = await setup(t);
  const next = 'sk-NEWKEY0000000000000000000000000000000000abcd';
  const res = await s.post('/config', { apiKey: next });
  assert.equal(res.status, 200);
  assert.equal(s.readFile().apiKey, next);
  assert.equal(s.config.apiKey, next);
  const logText = s.logs.join('\n');
  assert.equal(logText.includes(next), false);
  assert.equal(logText.includes(SECRET), false);
  assert.match(logText, /apiKey=已更新/);
});

test('POST /config：非法值返回 400 + 可读中文，且不落盘', async (t) => {
  const s = await setup(t);
  const cases = [
    [{ baseUrl: 'ftp://x' }, /baseUrl/],
    [{ baseUrl: '' }, /baseUrl/],
    [{ model: '' }, /model/],
    [{ probeEveryMs: 100 }, /probeEveryMs/],
    [{ probeMaxTokens: 9999 }, /probeMaxTokens/],
  ];
  for (const [patch, re] of cases) {
    const before = s.readText();
    const res = await s.post('/config', patch);
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(patch) + ' 应该 400，实际 ' + res.status);
    assert.match(body.error.message, re);
    assert.match(body.error.message, /[\u4e00-\u9fa5]/, '错误信息必须是中文');
    assert.equal(s.readText(), before, JSON.stringify(patch) + ' 校验失败时文件必须原封不动');
  }
});

test('POST /config：坏 JSON → 400，不是 500', async (t) => {
  const s = await setup(t);
  const res = await fetch(s.base + '/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error.message, /JSON/);
});

test('POST /config：保存后热重启探测（换间隔 + 立刻按新配置探一次）', async (t) => {
  const up = await startUpstream(t, { chunks: ['a', 'b'] });
  const s = await setup(t, { baseUrl: 'https://never-used.example/v1' });
  s.config.baseUrl = up.baseUrl;                 // 直接改内存配置，避免第一次探测打真网
  s.col.start();
  const res = await s.post('/config', { baseUrl: up.baseUrl, probeEveryMs: 6000, proxy: true });
  const body = await res.json();
  await new Promise((r) => setTimeout(r, 120));  // 等热重启触发的那次探测回来

  assert.equal(res.status, 200);
  assert.equal(body.restarted, true);
  assert.equal(s.config.probeEveryMs, 6000);
  assert.equal(s.config.proxy, true);
  assert.equal(s.readFile().probeEveryMs, 6000);
  assert.equal(s.readFile().proxy, true);
  assert.ok(s.col.snapshotPayload().client.probeCount >= 1, '热重启要立刻按新配置探一次');
});

test('POST /config/test：对假上游成功 → ok + TTFT/tok/s/model，且不写配置', async (t) => {
  const up = await startUpstream(t, { chunks: ['一', '二', '三', '四'] });
  const s = await setup(t);
  const res = await s.post('/config/test', { baseUrl: up.baseUrl, apiKey: 'sk-probe-only', model: 'probe-model' });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(body.model, 'probe-model');
  assert.ok(body.ttftMs > 0, 'TTFT 必须为正：' + body.ttftMs);
  assert.ok(body.tokPerSec > 0, 'tok/s 必须为正：' + body.tokPerSec);
  assert.equal(body.error, null);
  assert.equal(s.readFile().model, 'test-model', '测试连接不得写配置');
});

test('POST /config/test：假上游 500 → ok:false + 可读错误，不写配置', async (t) => {
  const up = await startUpstream(t, { fail: true });
  const s = await setup(t);
  const res = await s.post('/config/test', { baseUrl: up.baseUrl, apiKey: 'sk-x', model: 'm' });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, false);
  assert.match(body.error, /上游 HTTP 500/);
  assert.equal(body.ttftMs, null);
  assert.equal(s.readFile().model, 'test-model');
});

test('POST /config/test：连不上 → ok:false + 可读错误；缺 baseUrl/model → 400', async (t) => {
  const s = await setup(t);
  // 先占一个端口再放掉，保证这个端口在本机确实没人监听、而且不是 fetch 规范禁止的端口
  // （端口 1/9 等在禁止列表里，undici 会直接抛 "bad port"，压根测不到"连不上"那条路径）
  const probeSrv = createServer(() => {});
  await new Promise((ok) => probeSrv.listen(0, '127.0.0.1', ok));
  const deadPort = probeSrv.address().port;
  await new Promise((ok) => probeSrv.close(ok));

  const refused = await (await s.post('/config/test', { baseUrl: 'http://127.0.0.1:' + deadPort + '/v1', apiKey: 'sk-x', model: 'm' })).json();
  assert.equal(refused.ok, false);
  assert.match(refused.error, /连不上|ECONNREFUSED|端口/);

  const badUrl = await s.post('/config/test', { baseUrl: 'ftp://x', model: 'm' });
  const badUrlBody = await badUrl.json();
  const badModel = await s.post('/config/test', { baseUrl: 'https://x', model: '' });
  const badModelBody = await badModel.json();

  assert.equal(badUrl.status, 400);
  assert.match(badUrlBody.error.message, /baseUrl/);
  assert.equal(badModel.status, 400);
  assert.match(badModelBody.error.message, /model/);
});

test('POST /config/test：apiKey 传脱敏值时沿用配置里的真 key', async (t) => {
  const seen = [];
  const up = await startUpstream(t);
  const spyFetch = (url, init) => { seen.push(init.headers.authorization); return fetch(url, init); };
  const s = await setup(t);
  s.col.stop();
  // 换一个带探针 fetch 的采集器，复用同一个配置文件
  const col = createCollector({ config: s.config, fetchImpl: spyFetch, configPath: s.configPath, log: (m) => s.logs.push(m) });
  t.after(() => col.stop());
  const server = closeServer(t, createServer(col.handler));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + server.address().port;

  const res = await fetch(base + '/config/test', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: up.baseUrl, apiKey: 'sk-***CdA3', model: 'm' }),
  });
  const body = await res.json();

  assert.equal(body.ok, true, JSON.stringify(body));
  assert.equal(seen[0], 'Bearer ' + SECRET, '脱敏值必须被替换成真 key，绝不能发给上游');
  assert.equal(s.logs.join('\n').includes(SECRET), false);
});

test('POST /config：没有配置文件路径时给出可读错误（不是静默成功）', async (t) => {
  const col = createCollector({ config: normalizeConfig({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }), configPath: null });
  t.after(() => col.stop());
  const server = closeServer(t, createServer(col.handler));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const res = await fetch('http://127.0.0.1:' + server.address().port + '/config', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'n' }),
  });
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.match(body.error.message, /配置文件/);
});

// ---------- v0.2.1：主动探测总开关 / 暂停恢复 / 每天成本估算 ----------

test('normalizeConfig：probe 只认布尔 false，其余一律按默认 true；默认间隔改成 60 秒', () => {
  const base = { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' };
  assert.equal(normalizeConfig(base).probe, true);
  assert.equal(normalizeConfig({ ...base, probe: true }).probe, true);
  assert.equal(normalizeConfig({ ...base, probe: false }).probe, false);
  // 非布尔（字符串 "false" / 0 / null）都不是"关"，一律回默认 true —— 半懂不懂的写法不会静默烧钱
  assert.equal(normalizeConfig({ ...base, probe: 'false' }).probe, true);
  assert.equal(normalizeConfig({ ...base, probe: 0 }).probe, true);
  assert.equal(normalizeConfig({ ...base, probe: null }).probe, true);
  // 15 秒一次 = 5760 次/天（用户抱怨的那条），默认必须已经是 60 秒
  assert.equal(normalizeConfig(base).probeEveryMs, 60000);
});

test('probe=false：启动后不挂定时器 —— 一次上游请求都不发，probeCount 不增长', async (t) => {
  const up = await startUpstream(t);
  const s = await setup(t, { baseUrl: up.baseUrl, extra: { probe: false, probeEveryMs: 5000 } });
  s.col.start();
  await sleep(250);
  assert.equal(s.fetchCalls(), 0, 'probe:false 时不得发任何探测请求');
  const snap = s.col.snapshotPayload();
  assert.equal(snap.client.probeCount, 0);
  assert.equal(snap.probe.enabled, false);
  assert.equal(snap.probe.everyMs, 5000);
  assert.equal(snap.probe.probesPerDay, 0);
  assert.equal(snap.probe.tokensPerDayEstimate, 0);
  assert.equal(s.readFile().probe, false, '总开关要原样留在配置文件里');

  const view = (await (await s.get('/config')).json()).config;
  assert.equal(view.probe.enabled, false);
  assert.equal(view.probe.probesPerDay, 0);
  assert.equal(view.probe.tokensPerDayEstimate, 0);
});

test('POST /probe：暂停后不再增长、恢复后继续增长，且运行时暂停不写配置文件', async (t) => {
  const up = await startUpstream(t);
  const s = await setup(t, { baseUrl: up.baseUrl, extra: { probeEveryMs: 5000 } });
  s.col.start();
  assert.ok(await waitFor(() => s.col.snapshotPayload().client.probeCount >= 1), '首次探测没回来');
  const afterStart = s.fetchCalls();

  const off = await s.post('/probe', { enabled: false });
  const offBody = await off.json();
  assert.equal(off.status, 200);
  assert.equal(off.headers.get('access-control-allow-origin'), '*');
  assert.equal(offBody.ok, true);
  assert.equal(offBody.probe.enabled, false);
  assert.equal(offBody.probe.probesPerDay, 0);
  assert.equal(offBody.probe.tokensPerDayEstimate, 0);

  const pausedCount = s.col.snapshotPayload().client.probeCount;
  await sleep(200);
  assert.equal(s.fetchCalls(), afterStart, '暂停后不得再发探测请求');
  assert.equal(s.col.snapshotPayload().client.probeCount, pausedCount, '暂停后 probeCount 不得增长');
  // 配置文件里本来就没有 probe 键（setup 写的原始配置没这个字段）→ 它必须仍然是"没被碰过"
  assert.equal('probe' in s.readFile(), false, '/probe 是临时暂停，不得往配置文件里写 probe');
  assert.equal(s.col.snapshotPayload().probe.enabled, false);

  const on = await s.post('/probe', { enabled: true });
  const onBody = await on.json();
  assert.equal(on.status, 200);
  assert.equal(onBody.probe.enabled, true);
  assert.equal(onBody.probe.probesPerDay, Math.round(86400000 / 5000));
  assert.ok(await waitFor(() => s.col.snapshotPayload().client.probeCount > pausedCount), '恢复后没有继续探测');
  assert.ok(s.fetchCalls() > afterStart, '恢复后必须真的又发请求');

  // 非法 body 必须是 400 + 中文，而不是静默当成 false
  const bad = await s.post('/probe', { enabled: 'yes' });
  const badBody = await bad.json();
  assert.equal(bad.status, 400);
  assert.match(badBody.error.message, /enabled/);
  assert.equal(s.col.snapshotPayload().probe.enabled, true, '非法请求不得改状态');
  const wrongMethod = await s.get('/probe');
  assert.equal(wrongMethod.status, 405);
});

test('probe 块：按已知 everyMs 与最近一次成功探测的 promptTokens 算 probesPerDay / tokensPerDayEstimate', async (t) => {
  // 假上游的 usage 固定 prompt_tokens = 7
  const up = await startUpstream(t);
  const s = await setup(t, { baseUrl: up.baseUrl, extra: { probeEveryMs: 60000, probeMaxTokens: 24 } });
  s.col.start();
  assert.ok(await waitFor(() => s.col.snapshotPayload().probe.promptTokensEstimate === 7), '没等到成功样本的 promptTokens');

  const probe = s.col.snapshotPayload().probe;
  assert.equal(probe.enabled, true);
  assert.equal(probe.everyMs, 60000);
  assert.equal(probe.probesPerDay, 1440);                          // round(86400000 / 60000)
  assert.equal(probe.promptTokensEstimate, 7);                     // 最近一次成功探测的真实值
  assert.equal(probe.probeMaxTokens, 24);
  assert.equal(probe.tokensPerDayEstimate, 1440 * (7 + 24));       // 44640
  // 字段名必须自带「这是估算」的标记，不能长得像账单
  assert.equal('tokensPerDay' in probe, false);
  assert.equal('tokensPerDayEstimate' in probe, true);

  const view = (await (await s.get('/config')).json()).config;
  assert.deepEqual(view.probe, probe, '/config 的 probe 块必须与 /snapshot 一致');
});

test('probe 块：没有成功样本时 prompt 侧用 24 占位（估算口径写在字段名里）', async (t) => {
  const up = await startUpstream(t, { fail: true });     // 探测全失败 → 没有 promptTokens 可用
  const s = await setup(t, { baseUrl: up.baseUrl, extra: { probeEveryMs: 120000, probeMaxTokens: 24 } });
  s.col.start();
  assert.ok(await waitFor(() => s.col.snapshotPayload().client.probeCount >= 1), '失败样本也没记上');

  const probe = s.col.snapshotPayload().probe;
  assert.equal(probe.enabled, true);
  assert.equal(probe.probesPerDay, 720);                    // round(86400000 / 120000)
  assert.equal(probe.promptTokensEstimate, 24);             // 占位值
  assert.equal(probe.tokensPerDayEstimate, 720 * (24 + 24)); // 34560
});

test('POST /config：probe 变化热生效（false 立刻停、true 立刻起），只改 model 不动总开关', async (t) => {
  const up = await startUpstream(t);
  const s = await setup(t, { baseUrl: up.baseUrl, extra: { probeEveryMs: 5000 } });
  s.col.start();
  assert.ok(await waitFor(() => s.col.snapshotPayload().client.probeCount >= 1), '首次探测没回来');

  const off = await s.post('/config', { probe: false });
  const offBody = await off.json();
  assert.equal(off.status, 200);
  assert.equal(offBody.config.probe.enabled, false);
  assert.equal(offBody.restarted, false, '总开关关掉时没有"重启探测"可言');
  assert.equal(s.readFile().probe, false);
  const stopped = s.fetchCalls();
  await sleep(200);
  assert.equal(s.fetchCalls(), stopped, '关掉总开关后不得再探测');

  // 只改 model：总开关必须保持关闭（不能被热重启顺手打开）
  const keep = await (await s.post('/config', { model: 'test-model-2' })).json();
  assert.equal(keep.config.probe.enabled, false);
  assert.equal(s.readFile().probe, false);
  await sleep(150);
  assert.equal(s.fetchCalls(), stopped, '只改 model 不得恢复探测');

  const on = await s.post('/config', { probe: true });
  const onBody = await on.json();
  assert.equal(onBody.config.probe.enabled, true);
  assert.equal(onBody.restarted, true);
  assert.equal(s.readFile().probe, true);
  assert.ok(await waitFor(() => s.col.snapshotPayload().client.probeCount >= 2), '打开总开关后没有恢复探测');
});

