/**
 * 设置浮层的纯逻辑（DOM/交互由 tools/probe.js 的端到端断言覆盖）：
 * 端点推导、提交补丁构造、无采集器时的提示文案，以及单文件产物确实带着设置入口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_COLLECTOR_HINT,
  PROBE_HINT_FALLBACK,
  PROBE_OFF_HINT,
  configBaseFromEndpoint,
  buildConfigPatch,
  formatProbeTokens,
  probeHintText,
} from '../src/settings.js';

test('设置端点：从 snapshot 端点推出采集器根地址', () => {
  assert.equal(configBaseFromEndpoint('http://127.0.0.1:8787/snapshot'), 'http://127.0.0.1:8787');
  assert.equal(configBaseFromEndpoint('http://127.0.0.1:9999/snapshot?x=1'), 'http://127.0.0.1:9999');
  assert.equal(configBaseFromEndpoint(' https://example.com/snapshot '), 'https://example.com');
});

test('设置端点：缺省或非法值时回退到本机默认端口', () => {
  assert.equal(configBaseFromEndpoint(''), 'http://127.0.0.1:8787');
  assert.equal(configBaseFromEndpoint(undefined), 'http://127.0.0.1:8787');
  assert.equal(configBaseFromEndpoint(null), 'http://127.0.0.1:8787');
  assert.equal(configBaseFromEndpoint('not a url'), 'http://127.0.0.1:8787');
  assert.equal(configBaseFromEndpoint('', 'http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
});

test('提交补丁：只带用户真正填了的字段（空字段不覆盖既有配置）', () => {
  const patch = buildConfigPatch({
    baseUrl: ' https://api.deepseek.com/v1 ',
    model: '',
    probeEveryMs: '',
    proxy: false,
    apiKey: '',
    inPerM: '',
    outPerM: '',
  });
  assert.deepEqual(patch, { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', proxy: false });
  assert.equal('model' in patch, false);
  assert.equal('probeEveryMs' in patch, false);
  assert.equal('pricing' in patch, false);
});

test('提交补丁：数字转数字、proxy 归一成布尔、脱敏 key 原样回传', () => {
  const patch = buildConfigPatch({
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'qwen3',
    probeEveryMs: '20000',
    proxy: true,
    apiKey: 'sk-***c3a3',
    inPerM: '0.27',
    outPerM: '1.1',
  });
  assert.equal(patch.probeEveryMs, 20000);
  assert.equal(patch.proxy, true);
  assert.deepEqual(patch.pricing, { inPerM: 0.27, outPerM: 1.1 });
  // 采集器把「纯星号」当不改动，所以页面可以直接回传脱敏值
  assert.equal(patch.apiKey, 'sk-***c3a3');
});

test('成本提示：开着时给"每天多少次 / 约多少 token"，关着时明说不产生额外调用', () => {
  const on = probeHintText({ enabled: true, everyMs: 60000, probeMaxTokens: 24, promptTokensEstimate: 24 });
  assert.equal(on, '每 60 秒 1 次 ≈ 每天 1440 次调用、约 7 万 token（会消耗你的 token，走你的计费）');
  assert.match(on, /每天/);
  assert.match(on, /会消耗你的 token/);

  const off = probeHintText({ enabled: false, everyMs: 60000, probeMaxTokens: 24, promptTokensEstimate: 24 });
  assert.equal(off, PROBE_OFF_HINT);
  assert.equal(off, '已关闭主动探测：只统计经过本机的流量，不产生额外调用');

  // 间隔/单价一改，文案里的数字必须跟着重算（30 秒 = 2880 次/天）
  assert.match(probeHintText({ enabled: true, everyMs: 30000, probeMaxTokens: 24, promptTokensEstimate: 100 }),
    /每天 2880 次调用、约 36 万 token/);
  // 没读到采集器的 probe 块：给默认口径的兜底，不编造属于这台机器的数字
  assert.equal(probeHintText(null), PROBE_HINT_FALLBACK);
  assert.match(PROBE_HINT_FALLBACK, /每天/);
  assert.match(PROBE_HINT_FALLBACK, /会消耗你的 token/);
});

test('token 估算的显示口径：上万折成"万"，小数值给原数', () => {
  assert.equal(formatProbeTokens(69120), '7 万');
  assert.equal(formatProbeTokens(357120), '36 万');
  assert.equal(formatProbeTokens(500), '500');
  assert.equal(formatProbeTokens(0), '0');
  assert.equal(formatProbeTokens(NaN), '0');
});

test('提交补丁：probe 只在明确给了布尔值时才提交（不提 = 不改动）', () => {
  assert.equal('probe' in buildConfigPatch({ baseUrl: 'https://x/v1', apiKey: '', proxy: false }), false);
  assert.equal(buildConfigPatch({ probe: true }).probe, true);
  assert.equal(buildConfigPatch({ probe: false }).probe, false);
  assert.equal('probe' in buildConfigPatch({ probe: 'false' }), false, '字符串不是布尔意图，不能被当成"打开/关闭"');
});

test('没有采集器时的提示文案是给用户看的可操作那句话', () => {
  assert.equal(NO_COLLECTOR_HINT, '设置需要本机采集器（node collector.js 或桌面版）');
});

test('单文件产物里带着设置入口：齿轮按钮 + 浮层 + 无采集器提示', async () => {
  const { build } = await import('../build.js');
  const html = build();
  assert.match(html, /id="btn-settings"/, '产物缺少页脚齿轮按钮');
  // 浮层容器由 src/settings.js 在运行时创建，产物里出现的是这段赋值
  assert.match(html, /'settings-overlay'/, '产物缺少设置浮层容器');
  assert.match(html, /settings-overlay/, '产物缺少设置浮层容器');
  assert.match(html, /设置需要本机采集器（node collector\.js 或桌面版）/, '产物缺少无采集器提示');
  assert.match(html, /window\.__tokmeterOpenSettings/, '产物缺少桌面壳用的打开钩子');
});
