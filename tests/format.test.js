import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRate, formatClock, formatPercent, formatMemPair, formatFreeLabel, formatTar } from '../src/format.js';

test('formatRate 覆盖量级突变与异常值', () => {
  assert.equal(formatRate(257), '257');
  assert.equal(formatRate(999), '999');
  assert.equal(formatRate(1000), '1.0K');
  assert.equal(formatRate(1700), '1.7K');
  assert.equal(formatRate(2340000), '2.3M');
  assert.equal(formatRate(-5), '0');
  assert.equal(formatRate(NaN), '--');
  assert.equal(formatRate(undefined), '--');
});

test('formatClock 补零且支持跨零点', () => {
  assert.equal(formatClock(new Date(2026, 9, 3, 23, 48, 30)), '23:48:30');
  assert.equal(formatClock(new Date(2026, 9, 4, 0, 0, 0)), '00:00:00');
  assert.equal(formatClock(new Date(2026, 9, 4, 7, 5, 9)), '07:05:09');
});

test('百分比/内存/TAR', () => {
  assert.equal(formatPercent(0.16), '16%');
  assert.equal(formatPercent(0.935), '94%');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(NaN), '--');
  assert.equal(formatMemPair(105, 128), '105/128G');
  assert.equal(formatFreeLabel(23), '23G');
  assert.equal(formatTar(1.99), '1.99');
  assert.equal(formatTar(NaN), '--');
});
