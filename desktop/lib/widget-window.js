/**
 * 悬浮窗：无边框 + 透明 + 圆角，内容就是 llm-monitor.html（带 query）。
 *
 * 拖拽用 webContents.insertCSS() 注入 -webkit-app-region，绝不改仓库里的 styles.css。
 * insertCSS 只对当前文档生效，所以每次 did-finish-load 都要重新注入。
 */
import { BrowserWindow, screen } from 'electron';
import { pathToFileURL } from 'node:url';
import { panelPath, windowIconPath } from './paths.js';

export const DEFAULT_SIZE = { width: 380, height: 620 };
export const MIN_SIZE = { width: 300, height: 360 };

/** 注入样式：整页透明（露出面板自己的圆角）+ 拖拽区/非拖拽区。 */
export const WIDGET_CSS = [
  '/* Tokmeter 悬浮窗注入样式（不改仓库 CSS 文件） */',
  'html, body { background: transparent !important; }',
  'body { -webkit-app-region: drag; }',
  '.panel, .hdr { -webkit-app-region: drag; }',
  '.ftr-actions, .ftr-actions *, .ftr-icon, .ftr-clock,',
  // 标题栏右侧的连接状态区 = 设置入口：必须是 no-drag，否则拖拽区吃掉 click
  '.hdr-link, .hdr-link *, .overlay, .overlay * { -webkit-app-region: no-drag; }',
  'a, button, input, select, textarea, [role="button"] { -webkit-app-region: no-drag; }',
  '::-webkit-scrollbar { width: 0; height: 0; }',
].join('\n');

/**
 * 面板 URL：file:// + query（file:// 下 query 可用，采集器已放行 CORS）。
 * client 视图连本机采集器；server 视图用内置模拟引擎。
 */
export function buildPanelUrl({ view = 'client', port = 8787 } = {}) {
  const url = new URL(pathToFileURL(panelPath()).href);
  // 设置浮层要连的就是内置采集器：显式给出根地址，两种视图下齿轮都能用
  url.searchParams.set('config', 'http://127.0.0.1:' + port);
  if (view === 'client') {
    url.searchParams.set('view', 'client');
    url.searchParams.set('endpoint', 'http://127.0.0.1:' + port + '/snapshot');
  } else {
    url.searchParams.set('view', 'server');
  }
  return url.href;
}

/**
 * 置顶开关。
 *
 * 实测（Electron 37.10.3 / Windows 11，透明无边框窗）：
 *   ctor { alwaysOnTop: true }      → isAlwaysOnTop() === false   ✗
 *   setAlwaysOnTop(true)            → false（默认 level 'floating' 在 Win 上是空操作）✗
 *   setAlwaysOnTop(true, 'floating')→ false                        ✗
 *   setAlwaysOnTop(true, 'screen-saver') → true                    ✓
 * 所以这里必须显式传 level，别改回单参数版本。
 */
export function applyAlwaysOnTop(win, flag) {
  if (!win || win.isDestroyed()) return false;
  win.setAlwaysOnTop(!!flag, flag ? 'screen-saver' : 'normal');
  return win.isAlwaysOnTop();
}

/** 注入拖拽/透明样式；返回 insertCSS 的 key（便于排查）。 */
export function applyWidgetCss(win) {
  return win.webContents.insertCSS(WIDGET_CSS);
}

/** 位置校验：记住的位置如果已经不在任何显示器可见区域内，就回到默认（居中）。 */
export function sanitizeBounds(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const clamp = (v, min, max, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const width = clamp(src.width, MIN_SIZE.width, 2000, DEFAULT_SIZE.width);
  const height = clamp(src.height, MIN_SIZE.height, 2000, DEFAULT_SIZE.height);
  const hasPos =
    src.x !== null && src.x !== undefined && src.x !== '' &&
    src.y !== null && src.y !== undefined && src.y !== '' &&
    Number.isFinite(Number(src.x)) && Number.isFinite(Number(src.y));
  // 没记过位置就居中（Chromium 默认会把窗口丢到左上角，很难看）
  if (!hasPos) {
    const area = screen.getPrimaryDisplay().workArea;
    return {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    };
  }
  const x = Math.round(Number(src.x));
  const y = Math.round(Number(src.y));
  const area = screen.getDisplayMatching({ x, y, width, height }).workArea;
  const overlaps =
    x + width > area.x + 60 &&
    x < area.x + area.width - 60 &&
    y + 40 > area.y &&
    y < area.y + area.height - 40;
  return overlaps ? { x, y, width, height } : { width, height };
}

/**
 * 创建悬浮窗。
 * @param {{bounds:object, alwaysOnTop:boolean, onBoundsChange:Function, onLoaded:Function}} opts
 */
export function createWidgetWindow({ bounds, alwaysOnTop = true, onBoundsChange = () => {}, onLoaded = () => {} } = {}) {
  const win = new BrowserWindow({
    ...sanitizeBounds(bounds),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    frame: false,
    transparent: true,
    resizable: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: false,
    alwaysOnTop: !!alwaysOnTop,
    skipTaskbar: false,
    title: 'Tokmeter',
    icon: windowIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // 窗口隐藏/失焦时面板继续采样
      spellcheck: false,
    },
  });

  applyAlwaysOnTop(win, alwaysOnTop);

  // 每次导航后重新注入（insertCSS 不跨文档保留）
  win.webContents.on('did-finish-load', () => {
    applyWidgetCss(win).catch((err) => {
      console.error('[tokmeter] 注入拖拽样式失败：' + (err && err.message ? err.message : err));
    });
    onLoaded(win);
  });

  win.on('ready-to-show', () => win.show());
  win.on('resize', onBoundsChange);
  win.on('move', onBoundsChange);

  return win;
}
