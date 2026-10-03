import test from 'node:test';
import assert from 'node:assert/strict';
import { sparklinePath, ringGeometry, barRects } from '../src/charts.js';

test('sparklinePath 边界', () => {
  assert.equal(sparklinePath([], 100, 50, 4), '');
  assert.equal(sparklinePath([5], 100, 50, 4), 'M 0 25');            // 单点在垂直中点
  assert.equal(sparklinePath([0, 10], 100, 50, 0), 'M 0 50 L 100 0'); // 满量程铺满
  assert.match(sparklinePath([1, 2, 3], 100, 50, 4), /^M .+ L .+ L .+$/);
  assert.equal(sparklinePath([7, 7, 7], 100, 50, 0), 'M 0 25 L 50 25 L 100 25'); // 等值居中
  // 坏点用相邻有效值顶上；只有整条都无效才不画（见 tests/regressions.test.js 的 M3 用例）
  assert.equal(sparklinePath([NaN, 1], 100, 50, 0), 'M 0 25 L 100 25');
  assert.equal(sparklinePath([NaN, null], 100, 50, 0), '');
});

test('ringGeometry 比例到 dasharray', () => {
  const full = ringGeometry(1, 31, 9);
  assert.equal(full.r, 31);
  assert.ok(Math.abs(full.circumference - 2 * Math.PI * 31) < 1e-9);
  assert.equal(full.dasharray, full.circumference + ' ' + full.circumference);
  assert.equal(ringGeometry(0, 31, 9).dasharray, '0 ' + full.circumference);
  // dasharray 已经表达了弧长，dashoffset 必须为 0；否则偏移与 dash 叠加，弧长会变成 (1-ratio)
  const p = ringGeometry(0.69, 31, 9);
  assert.equal(p.dashoffset, 0);
  assert.equal(p.dasharray, full.circumference * 0.69 + ' ' + full.circumference);
  assert.equal(ringGeometry(NaN, 31, 9).dasharray, '0 ' + full.circumference);
});

test('barRects 等宽带间隙且右端贴合', () => {
  const rects = barRects([0.2, 0.6, 1], { x: 0, y: 0, w: 100, h: 50 }, 0.35);
  assert.equal(rects.length, 3);
  assert.equal(rects[0].rx, rects[0].w / 2);
  assert.ok(rects[2].x + rects[2].w <= 100.0001);
  assert.ok(Math.abs(rects[2].h - 50) < 1e-9);
});
