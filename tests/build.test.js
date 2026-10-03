/**
 * 单文件构建测试（TDD）：先于 build.js 写，用真实文件系统与产物文本做端到端断言。
 * 运行：node --test tests/build.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build } from '../build.js';

/** 拼接顺序（依赖在前）；写死在测试里，避免用实现导出的常量做自证。 */
const EXPECTED_MODULES = [
  'src/format.js',
  'src/charts.js',
  'src/units.js',
  'src/store.js',
  'src/sources/vllm-metrics.js',
  'src/sources/mock.js',
  'src/sources/http.js',
  'src/sources/client.js',
  'src/render.js',
  'src/scheduler.js',
  'src/app.js',
];

/** 构建一次，供各用例复用（纯函数，无副作用）。 */
const html = build();

test('产物不含行首的 import / export 语句', () => {
  assert.equal(/^\s*(import|export)\s/m.test(html), false, '仍存在行首 import/export，说明剥离不完整');
});

test('产物含内联 <style> 与 #panel / #probe 容器', () => {
  assert.match(html, /<style>/, '缺少内联 <style>');
  assert.match(html, /id="panel"/, '缺少 id="panel"');
  assert.match(html, /id="probe"/, '缺少 id="probe"');
});

test('产物体积小于 150KB', () => {
  const bytes = Buffer.byteLength(html, 'utf8');
  assert.ok(bytes < 150 * 1024, '产物体积 ' + bytes + ' 字节，超过 150KB 上限');
});

test('内联脚本是普通 <script>（非 module）且只有一段', () => {
  const tags = html.match(/<script/g) || [];
  assert.equal(tags.length, 1, '内联 <script> 数量应为 1，实际 ' + tags.length);
  assert.equal(/type="module"/.test(html), false, '产物不应含 type="module"');
});

test('把内联脚本抽成 .js 后 node --check 通过', () => {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, '未找到可抽取的内联脚本');

  const dir = mkdtempSync(join(tmpdir(), 'llm-build-test-'));
  const jsFile = join(dir, 'bundle.js');
  const logFile = join(dir, 'check.log');
  try {
    writeFileSync(jsFile, match[1], 'utf8');
    // 子进程输出重定向到文件：本环境长时间管道捕获会卡死，文件重定向最稳。
    const fd = openSync(logFile, 'w');
    let result;
    try {
      result = spawnSync(process.execPath, ['--check', jsFile], {
        timeout: 30000,
        stdio: ['ignore', fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    const log = readFileSync(logFile, 'utf8');
    assert.equal(result.error, undefined, 'node --check 执行失败：' + (result.error && result.error.message));
    assert.equal(result.signal, null, 'node --check 被信号中断：' + result.signal);
    assert.equal(result.status, 0, 'node --check 退出码 ' + result.status + '，stderr：' + log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('内联模块数为 11 且顺序为依赖在前', () => {
  const found = [...html.matchAll(/^\/\* ===== (src\/[^\s]+?\.js) ===== \*\/$/gm)].map((m) => m[1]);
  assert.equal(found.length, 11, '内联模块数应为 11，实际 ' + found.length);
  assert.deepEqual(found, EXPECTED_MODULES);
});
