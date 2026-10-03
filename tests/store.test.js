import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, pushRing, emptySnapshot } from '../src/store.js';

test('订阅/取消订阅/浅合并', () => {
  const store = createStore(emptySnapshot(0));
  const seen = [];
  const off = store.subscribe((s) => seen.push(s.requests.active));
  store.update({ requests: { active: 3, queued: 1, capacity: 12 } });
  store.update((prev) => ({ requests: { ...prev.requests, active: 4 } }));
  off();
  store.update({ requests: { active: 9, queued: 0, capacity: 12 } });
  assert.deepEqual(seen, [3, 4]);
  assert.equal(store.get().requests.active, 9);
  assert.equal(store.get().model.name, 'Qwen3.8-Flash');
});

test('pushRing 保持窗口长度且丢弃最旧值', () => {
  let h = [];
  for (let i = 1; i <= 65; i++) h = pushRing(h, i, 60);
  assert.equal(h.length, 60);
  assert.equal(h[0], 6);
  assert.equal(h[59], 65);
});

test('emptySnapshot 字段齐全且为有限数', () => {
  const s = emptySnapshot(0);
  for (const k of ['output', 'requests', 'input', 'kvCache', 'mtp', 'memory', 'gpu']) assert.ok(s[k]);
  assert.equal(s.status, 'connecting');
  assert.equal(s.clock, '00:00:00');
  assert.deepEqual(s.output.history, []);
});
