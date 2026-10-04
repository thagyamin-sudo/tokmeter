/**
 * 桌面壳「隐藏到托盘暂停探测」的状态机（纯逻辑，不需要 Electron 也不需要 GUI）。
 *
 * 这条是用户抱怨的核心路径：窗口收进托盘后探测还在跑、走真实计费。
 * 主进程 desktop/main.js 只负责把它接到 win 的 show/hide 上。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProbePolicy } from '../desktop/lib/probe-policy.js';

function fakeCollector({ probing = true } = {}) {
  return {
    probing,
    calls: [],
    setProbeEnabled(v) {
      this.calls.push(v === true);
      this.probing = v === true;
      return { enabled: this.probing };
    },
    isProbing() {
      return this.probing;
    },
  };
}

test('隐藏 → 暂停探测；重新显示 → 恢复（默认策略开着）', () => {
  const col = fakeCollector();
  const p = createProbePolicy({ getCollector: () => col });
  const hidden = p.apply(false);
  assert.equal(hidden.changed, true);
  assert.equal(hidden.paused, true);
  assert.equal(col.isProbing(), false);
  assert.deepEqual(col.calls, [false]);

  const shown = p.apply(true);
  assert.equal(shown.changed, true);
  assert.equal(col.isProbing(), true);
  assert.deepEqual(col.calls, [false, true]);

  // 已经显示着再来一次：不得重复下发
  assert.equal(p.apply(true).changed, false);
  assert.deepEqual(col.calls, [false, true]);
});

test('策略关掉（托盘菜单取消勾选）：隐藏也不停；藏着时取消勾选会立刻恢复', () => {
  const col = fakeCollector();
  const p = createProbePolicy({ getCollector: () => col, enabled: false });
  p.apply(false);
  assert.equal(col.isProbing(), true, '策略关闭时隐藏不得暂停探测');
  assert.deepEqual(col.calls, []);

  p.setEnabled(true);
  p.apply(false);
  assert.equal(col.isProbing(), false);

  p.setEnabled(false);
  const back = p.apply(false);   // 还藏着，但策略被关掉了
  assert.equal(back.changed, true);
  assert.equal(col.isProbing(), true, '取消勾选必须立刻恢复探测');
});

test('本来就是停着的（总开关关闭 / 用户自己暂停）：显示窗口时不得擅自打开', () => {
  const col = fakeCollector({ probing: false });
  const p = createProbePolicy({ getCollector: () => col });
  const hidden = p.apply(false);
  assert.equal(hidden.changed, false);
  assert.equal(hidden.reason, 'already-off');
  assert.deepEqual(col.calls, []);

  p.apply(true);
  assert.deepEqual(col.calls, [], '我们没暂停过，就不该由我们来恢复');
  assert.equal(col.isProbing(), false);
});

test('采集器没起来（端口被占用等）时不抛异常，只回 no-collector', () => {
  const p = createProbePolicy({ getCollector: () => null });
  const out = p.apply(false);
  assert.equal(out.changed, false);
  assert.equal(out.reason, 'no-collector');
  assert.equal(p.pausedByHide, false);
});

test('reset()：采集器被换掉后不再误恢复', () => {
  const col = fakeCollector();
  const p = createProbePolicy({ getCollector: () => col });
  p.apply(false);
  assert.equal(p.pausedByHide, true);
  p.reset();
  p.apply(true);
  assert.deepEqual(col.calls, [false], 'reset 之后显示窗口不该再下发恢复');
});
