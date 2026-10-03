import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/scheduler.js';

test('同帧内多次 push 只渲染一次，且渲染最后一帧', () => {
  const rendered = [];
  const queue = [];
  const s = createScheduler((v) => rendered.push(v), (cb) => queue.push(cb));
  s.push(1);
  s.push(2);
  s.push(3);
  assert.deepEqual(rendered, [], '帧回调触发前不应渲染');
  assert.equal(queue.length, 1, '三次 push 只排一次帧');
  queue.shift()();
  assert.deepEqual(rendered, [3], '只渲染最后一帧');
  s.push(4);
  assert.equal(queue.length, 1, '下一帧重新排队');
  queue.shift()();
  assert.deepEqual(rendered, [3, 4]);
});

test('同步调度器（测试模式）下每次 push 立即渲染', () => {
  const rendered = [];
  const s = createScheduler((v) => rendered.push(v), (cb) => cb());
  s.push(1);
  s.push(2);
  assert.deepEqual(rendered, [1, 2]);
});
