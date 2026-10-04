/**
 * Tokmeter（词元表）· 主进程
 *
 * 一个无边框透明悬浮窗 + 托盘图标 + 内置采集器：
 *   - 窗口内容就是仓库的 llm-monitor.html（file:// + query），不复制、不改动仓库前端；
 *   - 采集器在主进程内直接 import collector/server.js，客户端视图无需另开进程；
 *   - 配置在 %APPDATA%\\Tokmeter\\collector.config.json（首启生成模板）；
 *   - 窗口位置/置顶/视图存在 %APPDATA%\\Tokmeter\\state.json（手写 JSON，零第三方依赖）。
 *
 * 调试开关：
 *   --selftest            跑一遍自检（路径 / 采集器 / 窗口 / 托盘 / 截图）后退出
 *   --shot=<png 路径>      把面板画面截图存盘
 *   --shot-delay=<ms>     截图前等待时间（默认 2500）
 *   --shot-exit           截图后立刻退出
 */
import { existsSync, writeFileSync } from 'node:fs';
import { app, dialog, shell } from 'electron';

import {
  collectorEntry,
  configPath,
  panelPath,
  trayIconPath,
} from './lib/paths.js';
import { ensureConfigFile } from './lib/config-file.js';
import { getState, loadState, saveState } from './lib/state.js';
import { importCollectorModules, startCollector } from './lib/collector-host.js';
import { applyAlwaysOnTop, applyWidgetCss, buildPanelUrl, createWidgetWindow } from './lib/widget-window.js';
import { createTray, buildTemplate } from './lib/tray.js';
import { createProbePolicy } from './lib/probe-policy.js';

// ---------- 启动参数 ----------
const ARGV = process.argv.slice(1);
const hasFlag = (name) => ARGV.indexOf('--' + name) >= 0;
const optValue = (name) => {
  const prefix = '--' + name + '=';
  const hit = ARGV.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};
const SELFTEST = hasFlag('selftest');
/** 诊断用：--login-item=on|off|status，直接改/读开机自启并退出（不动窗口） */
const LOGIN_ITEM = optValue('login-item');
const SHOT_PATH = optValue('shot');
const SHOT_DELAY = Number(optValue('shot-delay') || 2500);
const SHOT_EXIT = hasFlag('shot-exit');

// 名字要在 requestSingleInstanceLock / getPath('userData') 之前定下来，
// 这样开发运行和安装后运行用的是同一份 %APPDATA%\\Tokmeter。
app.setName('Tokmeter');
if (process.platform === 'win32') app.setAppUserModelId('com.tokmeter.app');

// ---------- 全局上下文 ----------
const ctx = {
  win: null,
  trayApi: null,
  state: null,
  quitting: false,
  collector: { ok: false, port: 8787, instance: null, message: null, stage: null },
};

const log = (msg) => console.log('[tokmeter] ' + msg);

/**
 * 隐藏到托盘就停掉主动探测（省 token），重新显示再恢复。
 * 策略本身的开关在 state.json 的 pauseProbeWhenHidden（默认 true），托盘菜单可勾选。
 */
const probePolicy = createProbePolicy({ getCollector: () => ctx.collector.instance, log });

// ---------- 开机自启 ----------
function autoStartArgs() {
  // 开发运行时 electron.exe 需要带上应用目录；打包后不带参数
  return app.isPackaged ? [] : [app.getAppPath()];
}

function getAutoStart() {
  try {
    const opts = app.isPackaged ? undefined : { path: process.execPath, args: autoStartArgs() };
    return !!app.getLoginItemSettings(opts).openAtLogin;
  } catch (err) {
    log('读取开机自启状态失败：' + (err && err.message ? err.message : err));
    return false;
  }
}

function setAutoStart(enabled) {
  try {
    const opts = { openAtLogin: !!enabled, path: process.execPath, args: autoStartArgs() };
    app.setLoginItemSettings(opts);
    log('开机自启 -> ' + (enabled ? '开' : '关') + '（当前注册表状态：' + getAutoStart() + '）');
  } catch (err) {
    log('设置开机自启失败：' + (err && err.message ? err.message : err));
  }
  refreshTray();
}

// ---------- 托盘辅助 ----------
function collectorStatusText() {
  const c = ctx.collector;
  if (!c.ok) return '采集器：未启动（' + (c.stage === 'listen' ? '端口 ' + c.port + ' 被占用' : '配置有误') + '）';
  const status = c.instance && c.instance.status ? c.instance.status : 'connecting';
  // 探测停着这件事必须看得见：状态栏是唯一常驻的显示面
  const probing = c.instance && typeof c.instance.isProbing === 'function' ? c.instance.isProbing() : true;
  return '采集器：127.0.0.1:' + c.port + ' · ' + status + (probing ? '' : ' · 探测已暂停');
}

/** 把「窗口可见性 + pauseProbeWhenHidden」落到采集器上；返回策略结果便于日志/自检。 */
function syncProbeWithVisibility() {
  probePolicy.setEnabled(getState().pauseProbeWhenHidden !== false);
  const out = probePolicy.apply(windowVisible());
  if (out.changed) refreshTray();
  return out;
}

function setPauseProbeWhenHidden(flag) {
  ctx.state = saveState({ pauseProbeWhenHidden: !!flag });
  const out = syncProbeWithVisibility();
  log('隐藏时暂停探测 -> ' + (flag ? '开' : '关') + '（' + out.reason + '）');
  refreshTray();
}

function refreshTray() {
  if (ctx.trayApi) {
    ctx.trayApi.refresh();
    ctx.trayApi.setToolTip('Tokmeter（词元表）\n' + collectorStatusText());
  }
}

// ---------- 窗口 ----------
function windowVisible() {
  return !!(ctx.win && !ctx.win.isDestroyed() && ctx.win.isVisible());
}

function showWindow() {
  if (!ctx.win || ctx.win.isDestroyed()) return;
  if (ctx.win.isMinimized()) ctx.win.restore();
  ctx.win.show();
  ctx.win.focus();
  refreshTray();
}

function hideWindow() {
  if (!ctx.win || ctx.win.isDestroyed()) return;
  ctx.win.hide();
  refreshTray();
}

function toggleWindow() {
  if (windowVisible()) hideWindow();
  else showWindow();
}

let boundsTimer = null;
function persistBounds() {
  if (!ctx.win || ctx.win.isDestroyed()) return;
  const b = ctx.win.getBounds();
  saveState({ bounds: { x: b.x, y: b.y, width: b.width, height: b.height } });
}

function onBoundsChange() {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    persistBounds();
  }, 400);
}

function setAlwaysOnTop(flag) {
  ctx.state = saveState({ alwaysOnTop: !!flag });
  const actual = applyAlwaysOnTop(ctx.win, !!flag);
  log('始终置顶 -> ' + (flag ? '开' : '关') + '（生效：' + actual + '）');
  refreshTray();
}

async function setView(view) {
  const next = view === 'server' ? 'server' : 'client';
  ctx.state = saveState({ view: next });
  if (ctx.win && !ctx.win.isDestroyed()) {
    try {
      await ctx.win.loadURL(buildPanelUrl({ view: next, port: ctx.collector.port }));
    } catch (err) {
      log('切换视图失败：' + (err && err.message ? err.message : err));
    }
  }
  log('视图 -> ' + next);
  refreshTray();
}

async function openConfig() {
  const { path: file } = ensureConfigFile();
  const err = await shell.openPath(file);
  if (err) {
    // 没有 .json 关联程序时，退一步在资源管理器里选中它
    log('打开配置文件失败（' + err + '），改为在资源管理器中显示');
    shell.showItemInFolder(file);
  }
  return file;
}

/** 托盘「设置…」：显示悬浮窗，再让面板把设置浮层打开（不碰 shell.openPath）。 */
async function openSettings() {
  ensureConfigFile();
  showWindow();
  if (!ctx.win || ctx.win.isDestroyed()) return false;
  try {
    const opened = await ctx.win.webContents.executeJavaScript(
      'window.__tokmeterOpenSettings ? (window.__tokmeterOpenSettings(), true) : false'
    );
    log('托盘 → 设置浮层：' + (opened ? '已打开' : '面板还没挂上设置入口（页面可能仍在加载）'));
    return !!opened;
  } catch (err) {
    log('打开设置浮层失败：' + (err && err.message ? err.message : err));
    return false;
  }
}

/** 托盘「打开配置文件所在目录」：在资源管理器里选中配置文件。 */
function revealConfig() {
  const { path: file } = ensureConfigFile();
  shell.showItemInFolder(file);
  log('在资源管理器中显示配置文件：' + file);
  return file;
}

function notify(title, content) {
  if (ctx.trayApi) ctx.trayApi.balloon({ title, content });
}

async function reportCollectorProblem() {
  const c = ctx.collector;
  const title = c.stage === 'listen' ? 'Tokmeter：采集器端口被占用' : 'Tokmeter：采集器没能启动';
  const detail = c.message || '未知错误';
  notify(title, detail.split('\n')[0]);
  log(title + '：' + detail.replace(/\n/g, ' | '));
  try {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title,
      message: title,
      detail,
      buttons: ['打开配置文件', '知道了'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) await openConfig();
  } catch (err) {
    log('弹窗失败：' + (err && err.message ? err.message : err));
  }
}

// ---------- 启动流程 ----------
async function bootCollector() {
  const cfg = ensureConfigFile();
  log('配置文件：' + cfg.path + (cfg.created ? '（首次运行，已生成模板' + (cfg.from ? ' ← ' + cfg.from : '') + '）' : '（已存在）'));
  if (cfg.replacedKey) log('模板里的 apiKey 是中文占位（HTTP 头放不下非 ASCII），已换成 ' + 'PUT-YOUR-KEY-HERE，请填写真实 key');

  const started = await startCollector({
    configFile: configPath,
    autostart: true,
    log: (m) => log(m),
  });

  if (started.ok) {
    ctx.collector = { ok: true, port: started.port, instance: started.collector, message: null, stage: null };
    log('采集器就绪，端口 ' + started.port);
  } else {
    ctx.collector = {
      ok: false,
      port: (started.config && started.config.port) || 8787,
      instance: null,
      message: started.message,
      stage: started.stage,
    };
    await reportCollectorProblem();
  }
  return started;
}

function createWindow() {
  const url = buildPanelUrl({ view: getState().view, port: ctx.collector.port });
  const win = createWidgetWindow({
    bounds: getState().bounds,
    alwaysOnTop: getState().alwaysOnTop,
    onBoundsChange,
    onLoaded: (w) => log('页面加载完成：' + w.webContents.getURL()),
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith('file://')) {
      event.preventDefault();
      log('拦截外部导航：' + target);
    }
  });

  win.on('show', () => {
    const b = win.getBounds();
    log('窗口显示中 bounds=' + JSON.stringify(b) + ' 置顶=' + win.isAlwaysOnTop() + ' 可见=' + win.isVisible());
    syncProbeWithVisibility();
    refreshTray();
  });
  win.on('hide', () => {
    persistBounds();
    syncProbeWithVisibility();
    refreshTray();
  });
  // 关窗 = 收进托盘（真正退出走托盘菜单的「退出 Tokmeter」）
  win.on('close', (event) => {
    if (ctx.quitting) return;
    event.preventDefault();
    persistBounds();
    win.hide();
    notify('Tokmeter 仍在后台运行', '左键单击托盘图标可以再打开悬浮窗；右键菜单里有「退出 Tokmeter」。');
  });

  ctx.win = win;
  win.loadURL(url).catch((err) => log('加载面板失败：' + (err && err.message ? err.message : err)));
  log('面板地址：' + url);
  return win;
}

function createTrayUI() {
  const trayCtx = {
    windowVisible,
    toggleWindow,
    alwaysOnTop: () => !!getState().alwaysOnTop,
    setAlwaysOnTop,
    view: () => getState().view,
    setView: (v) => { void setView(v); },
    autoStart: getAutoStart,
    setAutoStart,
    pauseProbeWhenHidden: () => getState().pauseProbeWhenHidden !== false,
    setPauseProbeWhenHidden,
    openConfig: () => { void openConfig(); },
    openSettings: () => { void openSettings(); },
    revealConfig: () => { revealConfig(); },
    quit: () => {
      ctx.quitting = true;
      app.quit();
    },
    statusText: collectorStatusText,
  };

  ctx.trayApi = createTray(trayIconPath(), trayCtx);
  const b = ctx.trayApi.tray.getBounds();
  log('托盘已创建 bounds=' + JSON.stringify(b) + ' 图标=' + trayIconPath());
  return ctx.trayApi;
}

async function boot() {
  ctx.state = loadState();
  log('状态文件：' + JSON.stringify(ctx.state));
  await bootCollector();
  createWindow();
  createTrayUI();
  // 采集器状态会变（connecting → live/stale/error），托盘提示定期跟上
  setInterval(() => {
    if (ctx.collector.ok) refreshTray();
  }, 5000).unref?.();
}

// ---------- 开机自启诊断（--login-item=on|off|status） ----------
function runLoginItemCommand(mode) {
  const before = getAutoStart();
  if (mode === 'on' || mode === 'off') setAutoStart(mode === 'on');
  const after = getAutoStart();
  const payload = {
    mode,
    before,
    after,
    packaged: app.isPackaged,
    execPath: process.execPath,
    args: autoStartArgs(),
  };
  log('开机自启：' + before + ' -> ' + after + '（' + JSON.stringify(payload) + '）');
  console.log('LOGIN_ITEM_RESULT ' + JSON.stringify(payload));
  return mode === 'status' ? true : before !== after || mode === 'status';
}

// ---------- 自检（--selftest） ----------
async function runSelfTest() {
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
    return !!ok;
  };

  add('llm-monitor.html 存在', existsSync(panelPath()), panelPath());
  add('collector/server.js 存在', existsSync(collectorEntry()), collectorEntry());
  add('托盘图标存在', existsSync(trayIconPath()), trayIconPath());

  const cfg = ensureConfigFile();
  add('配置文件就绪', existsSync(configPath), configPath + (cfg.created ? '（本次新建，模板来自 ' + cfg.from + '）' : '（已存在）'));

  let mods = null;
  try {
    mods = await importCollectorModules();
    add('import collector/server.js（ESM）', typeof mods.createCollector === 'function', mods.entry);
  } catch (err) {
    add('import collector/server.js（ESM）', false, err.message);
  }

  const started = await startCollector({ configFile: configPath, autostart: false, log: (m) => log(m) });
  if (started.ok) {
    add('采集器监听配置端口', true, 'http://127.0.0.1:' + started.port);
    try {
      const res = await fetch('http://127.0.0.1:' + started.port + '/snapshot');
      const json = await res.json();
      add('GET /snapshot 契约', res.status === 200 && json.view === 'client' && !!json.client,
        'HTTP ' + res.status + ' view=' + json.view + ' status=' + json.status);
      const health = await fetch('http://127.0.0.1:' + started.port + '/health');
      add('GET /health', health.status === 200, 'HTTP ' + health.status);
    } catch (err) {
      add('GET /snapshot 契约', false, err.message);
    }
    // 故意不 stop()：下面还要验证渲染进程能不能拉到它（进程退出时端口自然释放）
  } else {
    add('采集器监听配置端口', false, '[' + started.stage + (started.code ? '/' + started.code : '') + '] ' + started.message);
  }

  ctx.state = loadState();
  const win = createWidgetWindow({
    bounds: getState().bounds,
    alwaysOnTop: getState().alwaysOnTop,
    onBoundsChange: () => {},
    onLoaded: () => {},
  });
  ctx.win = win;

  const url = buildPanelUrl({ view: getState().view, port: started.ok ? started.port : ctx.collector.port });
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('加载超时（10s）')), 10000);
    win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    win.webContents.once('did-fail-load', (_e, code, desc) => { clearTimeout(timer); reject(new Error('did-fail-load ' + code + ' ' + desc)); });
  });
  try {
    await win.loadURL(url);
    await loaded;
    add('窗口加载面板', true, url);
  } catch (err) {
    add('窗口加载面板', false, err.message);
  }

  const cssKey = await applyWidgetCss(win).catch((err) => 'ERR ' + err.message);
  add('注入拖拽/透明样式', typeof cssKey === 'string' && !cssKey.startsWith('ERR'), 'insertCSS key=' + cssKey);

  const injected = await win.webContents.executeJavaScript(
    '(function(){' +
    'var hdr=document.querySelector(".hdr"), ftr=document.querySelector(".ftr-actions"), panel=document.querySelector(".panel");' +
    'return {' +
    'panel:!!panel, hdr:!!hdr, ftrActions:!!ftr,' +
    'drag:hdr?getComputedStyle(hdr).webkitAppRegion:null,' +
    'noDrag:ftr?getComputedStyle(ftr).webkitAppRegion:null,' +
    'pageBg:getComputedStyle(document.body).backgroundColor,' +
    'view:panel?panel.dataset.view:null,' +
    'panelH:panel?Math.round(panel.getBoundingClientRect().height):null,' +
    'innerH:innerHeight' +
    '};})()'
  ).catch((err) => ({ error: err.message }));
  add('面板 DOM 渲染', injected && injected.panel && injected.hdr && injected.ftrActions, JSON.stringify(injected));
  const settingsUi = await win.webContents.executeJavaScript(
    '(function(){' +
    'var gear=document.getElementById("btn-settings"), box=document.getElementById("settings-overlay");' +
    'if(!gear||!box) return {gear:!!gear, overlay:!!box, defaultHidden:box?!!box.hidden:null};' +
    'gear.click();' +
    'return {gear:true, overlay:true, defaultHidden:false, opened:!box.hidden};' +
    '})()'
  ).catch((err) => ({ error: err.message }));
  add('页脚齿轮 → 面板内设置浮层', settingsUi && settingsUi.opened === true, JSON.stringify(settingsUi));
  const traySettings = await openSettings().catch((err) => 'ERR ' + err.message);
  add('托盘「设置…」→ 打开设置浮层', traySettings === true, 'openSettings=' + JSON.stringify(traySettings));
  add('拖拽区生效（.hdr = drag / .ftr-actions = no-drag）',
    injected && injected.drag === 'drag' && injected.noDrag === 'no-drag', JSON.stringify(injected));

  if (started.ok) {
    // 面板走的就是这条链路：file:// 页面 fetch http://127.0.0.1:<port>
    const probe = await win.webContents
      .executeJavaScript(
        'fetch("http://127.0.0.1:' + started.port + '/snapshot",{cache:"no-store"})' +
        '.then(function(r){return r.status;})' +
        '.catch(function(e){return "ERR "+e.message;})'
      )
      .catch((err) => 'ERR ' + err.message);
    add('渲染进程拉取采集器（file:// → http://127.0.0.1）', probe === 200, '结果=' + probe);
  }

  try {
    createTrayUI();
    const tb = ctx.trayApi.tray.getBounds();
    add('托盘创建', !ctx.trayApi.tray.isDestroyed(), 'bounds=' + JSON.stringify(tb));
  } catch (err) {
    add('托盘创建', false, err.message);
  }

  add('开机自启读取（未写入注册表）', true, 'openAtLogin=' + getAutoStart());

  // 隐藏到托盘暂停探测：菜单项 + 状态机（用假采集器，不发任何网络请求）
  add('state.pauseProbeWhenHidden 是布尔值（默认 true）', typeof getState().pauseProbeWhenHidden === 'boolean',
    'pauseProbeWhenHidden=' + getState().pauseProbeWhenHidden);
  try {
    const items = buildTemplate({
      statusText: () => '采集器：test',
      windowVisible: () => true,
      toggleWindow: () => {},
      alwaysOnTop: () => true,
      setAlwaysOnTop: () => {},
      view: () => 'client',
      setView: () => {},
      autoStart: () => false,
      setAutoStart: () => {},
      pauseProbeWhenHidden: () => true,
      setPauseProbeWhenHidden: () => {},
      openConfig: () => {},
      openSettings: () => {},
      revealConfig: () => {},
      quit: () => {},
    });
    const item = items.find((i) => i && i.label === '隐藏时暂停探测');
    add('托盘菜单含「隐藏时暂停探测」（可勾选、默认勾上）',
      !!item && item.type === 'checkbox' && item.checked === true,
      JSON.stringify(item ? { label: item.label, type: item.type, checked: item.checked } : null));
  } catch (err) {
    add('托盘菜单含「隐藏时暂停探测」', false, err.message);
  }
  try {
    const fake = { on: true, setProbeEnabled(v) { this.on = v === true; return {}; }, isProbing() { return this.on; } };
    const policy = createProbePolicy({ getCollector: () => fake, log: () => {} });
    const hidden = policy.apply(false);
    const offAfterHide = fake.on;
    const shown = policy.apply(true);
    add('隐藏 → 暂停探测 / 重新显示 → 恢复',
      hidden.changed === true && hidden.paused === true && offAfterHide === false && shown.changed === true && fake.on === true,
      '隐藏 ' + JSON.stringify(hidden) + ' 暂停后 isProbing=' + offAfterHide + ' 显示 ' + JSON.stringify(shown) + ' 恢复后 isProbing=' + fake.on);
  } catch (err) {
    add('隐藏 → 暂停探测 / 重新显示 → 恢复', false, err.message);
  }

  if (SHOT_PATH) {
    try {
      await new Promise((r) => setTimeout(r, Math.max(0, SHOT_DELAY)));
      const img = await win.webContents.capturePage();
      const size = img.getSize();
      writeFileSync(SHOT_PATH, img.toPNG());
      add('面板截图', size.width > 0 && size.height > 0, SHOT_PATH + ' ' + size.width + 'x' + size.height + ' ' + img.toPNG().length + ' bytes');
    } catch (err) {
      add('面板截图', false, err.message);
    }
  }

  const ok = checks.every((c) => c.ok);
  for (const c of checks) log((c.ok ? '  [OK] ' : '  [!!] ') + c.name + ' — ' + (c.detail === null ? '' : c.detail));
  console.log('SELFTEST_RESULT ' + JSON.stringify({ ok, checks }));
  return ok;
}

// ---------- 入口 ----------
if (!app.requestSingleInstanceLock()) {
  // 已有实例：让那个实例把窗口亮出来，然后自己退出
  console.log('[tokmeter] 已有实例在运行，本进程退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('收到第二次启动请求 → 显示已有窗口');
    if (ctx.win && !ctx.win.isDestroyed()) {
      if (ctx.win.isMinimized()) ctx.win.restore();
      ctx.win.show();
      ctx.win.focus();
    } else if (!SELFTEST) {
      createWindow();
    }
    refreshTray();
  });

  app.on('window-all-closed', () => {
    // 托盘应用：窗口关了也继续活着
  });

  app.on('before-quit', () => {
    ctx.quitting = true;
    persistBounds();
    if (ctx.collector.instance) {
      try { ctx.collector.instance.stop(); } catch { /* 忽略 */ }
    }
  });

  // ！主进程 ESM 入口里禁止顶层 await：Electron 要等模块图求值完才发 ready，
  // 顶层 `await app.whenReady()` 会自己把自己锁死（实测 Electron 37.10.3 必现），所以走 .then()。
  app
    .whenReady()
    .then(async () => {
      if (LOGIN_ITEM) {
        const ok = runLoginItemCommand(LOGIN_ITEM);
        app.exit(ok ? 0 : 1);
        return;
      }
      if (SELFTEST) {
        const ok = await runSelfTest();
        app.exit(ok ? 0 : 1);
        return;
      }
      await boot();
      if (SHOT_PATH) {
        setTimeout(async () => {
          try {
            const img = await ctx.win.webContents.capturePage();
            writeFileSync(SHOT_PATH, img.toPNG());
            const size = img.getSize();
            log('截图已保存 ' + SHOT_PATH + ' ' + size.width + 'x' + size.height);
          } catch (err) {
            log('截图失败：' + (err && err.message ? err.message : err));
          }
          if (SHOT_EXIT) {
            ctx.quitting = true;
            app.quit();
          }
        }, Math.max(0, SHOT_DELAY));
      }
    })
    .catch((err) => {
      console.error('[tokmeter] 启动失败：' + (err && err.stack ? err.stack : err));
      app.exit(1);
    });
}
