/**
 * 「悬浮窗隐藏到托盘时暂停主动探测」的纯逻辑（刻意不 import electron，node --test 可直接跑）。
 *
 * 为什么单独一个模块：这条行为是用户抱怨的核心（"隐藏到托盘后探测还在跑，走我的真实计费"），
 * 但它埋在 Electron 主进程里，没有 GUI 就测不到。把"什么时候该停、什么时候该恢复"抽成
 * 无依赖的状态机，主进程只负责把它接到窗口的 show/hide 上。
 *
 * 约定：
 *  - 只有在**我们**暂停过的时候才恢复：用户自己在设置里关掉了总开关 / 用页脚 ⏻ 暂停过，
 *    显示窗口不该把它偷偷打开；
 *  - 策略关掉（托盘菜单取消勾选）时如果正被我们暂停着，立刻恢复；
 *  - 采集器没起来（端口被占用等）时不报错、不抛异常，只回一个 reason。
 */

const NOOP = (visible, reason) => ({ changed: false, paused: false, visible: !!visible, reason });

/**
 * @param {{getCollector?:Function, enabled?:boolean, log?:Function}} opts
 *   getCollector 每次调用都重新取（采集器可能在启动后才就绪）
 */
export function createProbePolicy({ getCollector = () => null, enabled = true, log = () => {} } = {}) {
  let policy = enabled !== false;
  let pausedByHide = false;

  function collector() {
    const c = getCollector();
    return c && typeof c.setProbeEnabled === 'function' ? c : null;
  }

  /**
   * 窗口可见性变化 / 策略变化后调用一次。
   * @returns {{changed:boolean, paused:boolean, visible:boolean, reason:string}}
   */
  function apply(visible) {
    const col = collector();
    if (!col) return NOOP(visible, 'no-collector');
    const shouldPause = !visible && policy;
    if (shouldPause && !pausedByHide) {
      const was = typeof col.isProbing === 'function' ? col.isProbing() : true;
      if (!was) return NOOP(visible, 'already-off');   // 本来就停着（总开关关闭等）：不记成我们暂停的
      col.setProbeEnabled(false);
      pausedByHide = true;
      log('窗口隐藏到托盘 → 暂停主动探测（重新显示时恢复）');
      return { changed: true, paused: true, visible: !!visible, reason: 'hidden' };
    }
    if (!shouldPause && pausedByHide) {
      col.setProbeEnabled(true);
      pausedByHide = false;
      log('窗口重新显示 → 恢复主动探测');
      return { changed: true, paused: false, visible: !!visible, reason: 'shown' };
    }
    return NOOP(visible, shouldPause ? 'already-paused' : 'noop');
  }

  return {
    apply,
    setEnabled(flag) {
      policy = flag !== false;
      return policy;
    },
    get enabled() {
      return policy;
    },
    get pausedByHide() {
      return pausedByHide;
    },
    /** 采集器被替换/退出时清状态，避免下次误恢复 */
    reset() {
      pausedByHide = false;
    },
  };
}
