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
};

let cache = null;

function coerce(raw) {
  const merged = Object.assign({}, DEFAULT_STATE, raw && typeof raw === 'object' ? raw : {});
  const b = merged.bounds && typeof merged.bounds === 'object' ? merged.bounds : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  return {
    bounds: {
      x: num(b.x),
      y: num(b.y),
      width: num(b.width) || DEFAULT_STATE.bounds.width,
      height: num(b.height) || DEFAULT_STATE.bounds.height,
    },
    alwaysOnTop: merged.alwaysOnTop !== false,
    view: merged.view === 'server' ? 'server' : 'client',
  };
}

/** 读状态；文件不存在/损坏时回落到默认值（不抛错，坏文件留原样不影响启动）。 */
export function loadState() {
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(statePath, 'utf8'));
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
