/**
 * 采集器 · 滚动统计（纯函数）：
 * 把探测样本汇总成面板要的字段：速率曲线、TTFT 分位、可用率、token 用量与成本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStats } from '../collector/stats.js';

const ok = (t, tokPerSec, ttftMs, inTok = 10, outTok = 20) => ({ t, ok: true, tokPerSec, ttftMs, promptTokens: inTok, completionTokens: outTok });
const bad = (t) => ({ t, ok: false });

test('速率曲线：只保留窗口内的成功样本，最多 60 点', () => {
  const s = createStats({ windowMs: 60000 });
  for (let i = 0; i < 80; i++) s.add(ok(i * 1000, 100 + i));
  const snap = s.snapshot(80000);
  assert.equal(snap.history.length, 60, '窗口上限 60 点');
  assert.equal(snap.history.at(-1), 179);
  assert.equal(snap.tokPerSec, 179, '当前速率取最新成功样本');
});

test('超出时间窗口的样本被丢弃（"最近 60 秒"是时间不是点数）', () => {
  const s = createStats({ windowMs: 60000 });
  s.add(ok(0, 100));
  s.add(ok(30000, 200));
  const snap = s.snapshot(65000);              // 65s 时，窗口下限是 5s，0s 的样本已过期
  assert.equal(snap.history.includes(100), false);
  assert.equal(snap.history.at(-1), 200);
});

test('分位数：TTFT 与速率各给 P50/P95', () => {
  const s = createStats({ windowMs: 60000 });
  for (let i = 1; i <= 100; i++) s.add(ok(i, i, i));
  const snap = s.snapshot(1000);
  assert.equal(snap.ttftP50, 50);
  assert.equal(snap.ttftP95, 95);
  assert.equal(snap.rateP50, 50);
  assert.equal(snap.rateP95, 95);
});

test('可用率与失败计数：窗口内成功/失败比例', () => {
  const s = createStats({ windowMs: 60000 });
  for (let i = 0; i < 8; i++) s.add(ok(i, 100, 100));
  for (let i = 8; i < 10; i++) s.add(bad(i));
  const snap = s.snapshot(1000);
  assert.equal(snap.probeCount, 10);
  assert.equal(snap.failCount, 2);
  assert.equal(snap.successRate, 0.8);
  assert.equal(snap.available, false, '有失败就不算全可用');
});

test('token 用量与成本：按百万 token 单价累计', () => {
  const s = createStats({ windowMs: 60000, pricing: { inPerM: 2, outPerM: 8 } });
  s.add(ok(1, 100, 100, 1_000_000, 500_000));
  const snap = s.snapshot(2000);
  assert.equal(snap.tokensIn, 1_000_000);
  assert.equal(snap.tokensOut, 500_000);
  assert.equal(snap.cost, 2 + 4, '1M 输入 × $2 + 0.5M 输出 × $8 = $6');
});

test('空统计：所有分位数与速率都是 0，不产生 NaN', () => {
  const s = createStats({ windowMs: 60000 });
  const snap = s.snapshot(0);
  for (const k of ['tokPerSec', 'ttftP50', 'ttftP95', 'rateP50', 'rateP95', 'tokensIn', 'tokensOut', 'cost']) {
    assert.equal(Number.isFinite(snap[k]), true, k + ' 必须是有限数');
  }
  assert.equal(snap.successRate, null, '没有样本时可用率未知');
  assert.deepEqual(snap.history, []);
});
