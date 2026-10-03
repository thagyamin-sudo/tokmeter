import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, initialSnapshot, stepSnapshot } from '../src/sources/mock.js';

test('同种子序列可复现，不同种子不同', () => {
  const a = mulberry32(7), b = mulberry32(7), c = mulberry32(8);
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, [c(), c(), c()]);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});

test('1000 步后所有数值仍在值域内且有限', () => {
  const rnd = mulberry32(42);
  let s = initialSnapshot(0);
  for (let i = 0; i < 1000; i++) s = stepSnapshot(s, rnd, i * 1000);
  assert.ok(s.output.tokPerSec >= 0 && s.output.tokPerSec <= 1200);
  assert.ok(s.requests.active >= 0 && s.requests.active <= s.requests.capacity);
  assert.ok(s.requests.queued >= 0 && s.requests.queued <= 6);
  assert.ok(s.kvCache.usage >= 0 && s.kvCache.usage <= 1);
  assert.ok(s.kvCache.hitRate >= 0.85 && s.kvCache.hitRate <= 0.97);
  assert.ok(s.mtp.ratio >= 0.5 && s.mtp.ratio <= 0.85);
  assert.ok(s.mtp.tar >= 1.3 && s.mtp.tar <= 2.6);
  assert.ok(s.memory.usedGB >= 0 && s.memory.usedGB <= s.memory.totalGB);
  assert.ok(s.gpu.utilization >= 0 && s.gpu.utilization <= 1);
  assert.equal(s.output.history.length, 60);
  assert.equal(s.gpu.history.length, 15);
  for (const v of [...s.output.history, ...s.gpu.history, s.input.tokPerSec]) assert.ok(Number.isFinite(v));
  assert.equal(s.status, 'live');
});
