/**
 * 窗口状态持久化（自己写 JSON，不引第三方存储库）。
 * 文件：%APPDATA%\\Tokmeter\\state.json
 * 内容：窗口位置/大小、是否置顶、当前视图。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { statePath, userDir } from './paths.js';

export const DEFAULT_STATE = {
  bounds: { x: null, y: null, width: 380, height: 620 },
  alwaysOnTop: true,
  view: 'client',
  pauseProbeWhenHidden: true,   // 悬浮窗收进托盘时暂停主动探测（重新显示时恢复）
};

let cache = null;

function coerce(raw) {
  const merged = Object.assign({}, DEFAULT_STATE, raw && typeof raw === 'object' ? raw : {});
  const b = merged.bounds && typeof merged.bounds === 'object' ? merged.bounds : {};
  // 注意：Number(null) === 0，必须先把 null/undefined/'' 挡掉，否则「没记过位置」会变成 (0,0)
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    return Number.isFinite(Number(v)) ? Math.round(Number(v)) : null;
  };
  return {
    bounds: {
      x: num(b.x),
      y: num(b.y),
      width: num(b.width) || DEFAULT_STATE.bounds.width,
      height: num(b.height) || DEFAULT_STATE.bounds.height,
    },
    alwaysOnTop: merged.alwaysOnTop !== false,
    view: merged.view === 'server' ? 'server' : 'client',
    // 只有显式的 false 才是关：老 state.json 里没这个字段 → 按默认 true（省 token 是默认行为）
    pauseProbeWhenHidden: merged.pauseProbeWhenHidden !== false,
  };
}

/** 读状态；文件不存在/损坏时回落到默认值（不抛错，坏文件留原样不影响启动）。 */
export function loadState() {
  let raw = null;
  try {
    // 去掉可能的 UTF-8 BOM：记事本/部分编辑器保存时会加，JSON.parse 会被它噎住
    raw = JSON.parse(readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    raw = null;
  }
  cache = coerce(raw);
  return cache;
}

/** 合并写回（先写临时文件再改名，避免半截 JSON）。 */
export function saveState(patch) {
  cache = coerce(Object.assign({}, cache || DEFAULT_STATE, patch || {}));
  try {
    mkdirSync(userDir, { recursive: true });
    const tmp = statePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    renameSync(tmp, statePath);
  } catch (err) {
    // 状态存不下来不该拖垮应用，只记一行日志
    console.error('[tokmeter] 保存状态失败：' + (err && err.message ? err.message : err));
  }
  return cache;
}

export function getState() {
  return cache || loadState();
}
