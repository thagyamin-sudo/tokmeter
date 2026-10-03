/**
 * 设置浮层的纯逻辑（DOM/交互由 tools/probe.js 的端到端断言覆盖）：
 * 端点推导、提交补丁构造、无采集器时的提示文案，以及单文件产物确实带着设置入口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_COLLECTOR_HINT, configBaseFromEndpoint, buildConfigPatch } from '../src/settings.js';

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
