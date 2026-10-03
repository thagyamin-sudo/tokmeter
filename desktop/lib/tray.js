/**
 * 状态栏（托盘）图标与右键菜单。
 * 左键单击：显示/隐藏悬浮窗；右键：菜单。
 * 图标用仓库里的 icons/icon-192.png（Windows 的 Tray 直接接受 PNG）。
 */
import { Menu, Tray, nativeImage } from 'electron';

/** 图标缺失时的兜底：16×16 纯色方块（BGRA），保证托盘一定能建起来。 */
function fallbackIcon() {
  const w = 16;
  const h = 16;
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    buf[i * 4] = 0x2e;      // B
    buf[i * 4 + 1] = 0xe6;  // G
    buf[i * 4 + 2] = 0xb8;  // R
    buf[i * 4 + 3] = 0xff;  // A
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
}

export function loadTrayIcon(iconPath) {
  let img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) {
    console.warn('[tokmeter] 托盘图标读不到，用兜底图标：' + iconPath);
    return fallbackIcon();
  }
  const size = img.getSize();
  if (size.width > 32) img = img.resize({ width: 32, height: 32, quality: 'best' });
  return img;
}

/**
 * 菜单模板。ctx 由主进程提供：
 *   windowVisible() / toggleWindow() / alwaysOnTop() / setAlwaysOnTop(v) /
 *   view() / setView(v) / autoStart() / setAutoStart(v) / openConfig() / quit() / statusText()
 */
function buildTemplate(ctx) {
  const visible = ctx.windowVisible();
  return [
    { label: ctx.statusText(), enabled: false },
    { type: 'separator' },
    { label: visible ? '隐藏悬浮窗' : '显示悬浮窗', click: () => ctx.toggleWindow() },
    { type: 'separator' },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: !!ctx.alwaysOnTop(),
      click: (item) => ctx.setAlwaysOnTop(item.checked),
    },
    {
      label: '切换视图',
      submenu: [
        {
          label: '服务端（本地 vLLM / 模拟）',
          type: 'radio',
          checked: ctx.view() === 'server',
          click: () => ctx.setView('server'),
        },
        {
          label: '客户端（云 API，走内置采集器）',
          type: 'radio',
          checked: ctx.view() === 'client',
          click: () => ctx.setView('client'),
        },
      ],
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!ctx.autoStart(),
      click: (item) => ctx.setAutoStart(item.checked),
    },
    { label: '打开配置文件', click: () => ctx.openConfig() },
    { type: 'separator' },
    { label: '退出 Tokmeter', click: () => ctx.quit() },
  ];
}

/**
 * 建托盘。返回 { tray, refresh, destroy }。
 * refresh() 在勾选状态/视图/可见性变化后调用，菜单才会跟着变。
 */
export function createTray(iconPath, ctx) {
  const tray = new Tray(loadTrayIcon(iconPath));
  tray.setToolTip('Tokmeter（词元表）');
  tray.setContextMenu(Menu.buildFromTemplate(buildTemplate(ctx)));

  // 左键单击：显示/隐藏悬浮窗
  tray.on('click', () => ctx.toggleWindow());
  // 双击在部分 Windows 版本上更好点，顺手也接上
  tray.on('double-click', () => ctx.toggleWindow());

  const refresh = () => {
    if (tray.isDestroyed()) return;
    tray.setContextMenu(Menu.buildFromTemplate(buildTemplate(ctx)));
  };

  return {
    tray,
    refresh,
    destroy: () => {
      if (!tray.isDestroyed()) tray.destroy();
    },
    setToolTip: (text) => {
      if (!tray.isDestroyed()) tray.setToolTip(text);
    },
    balloon: (opts) => {
      try {
        if (!tray.isDestroyed()) tray.displayBalloon(opts);
      } catch (err) {
        console.warn('[tokmeter] 气泡提示失败：' + (err && err.message ? err.message : err));
      }
    },
  };
}
