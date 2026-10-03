import test from 'node:test';
import assert from 'node:assert/strict';
import { unitPx } from '../src/units.js';

test('unitPx 返回面板宽度的百分之一', () => {
  assert.equal(unitPx(390), 3.9);
  assert.equal(unitPx(420), 4.2);
  assert.equal(unitPx(0), 0);
});
