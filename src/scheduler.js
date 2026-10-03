/**
 * 渲染节流：把"每来一帧数据就重绘"合并为"每个动画帧最多重绘一次"。
 * 调度函数由调用方注入（浏览器传 requestAnimationFrame，测试传同步执行），
 * 于是合并逻辑不依赖浏览器时序，可以用单测钉死。
 */
export function createScheduler(render, schedule) {
  let pending = null;
  let queued = false;
  let hasPending = false;

  function flush() {
    queued = false;
    if (!hasPending) return;
    const value = pending;
    pending = null;
    hasPending = false;
    render(value);
  }

  return {
    push(value) {
      pending = value;
      hasPending = true;
      if (queued) return;
      queued = true;
      schedule(flush);
    },
    get hasPending() {
      return hasPending;
    },
  };
}
