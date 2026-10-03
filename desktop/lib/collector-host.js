/**
 * 内置采集器：主进程里直接 import 仓库的 collector/server.js 并监听 127.0.0.1。
 * 客户端视图因此不需要用户另外开一个 node 进程。
 *
 * 配置来自 %APPDATA%\\Tokmeter\\collector.config.json（端口默认 8787），
 * 端口被占用等失败一律转成「人话」提示，不抛裸异常。
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { configPath, collectorConfigModule, collectorEntry } from './paths.js';

/** 动态 import 采集器模块（开发=仓库路径，安装后=resources 路径）。 */
export async function importCollectorModules() {
  const entry = collectorEntry();
  const cfgMod = collectorConfigModule();
  let server;
  let config;
  try {
    server = await import(pathToFileURL(entry).href);
    config = await import(pathToFileURL(cfgMod).href);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error('加载采集器模块失败（' + entry + '）：' + msg);
  }
  if (typeof server.createCollector !== 'function') {
    throw new Error('采集器模块没有导出 createCollector：' + entry);
  }
  if (typeof config.readConfig !== 'function') {
    throw new Error('采集器配置模块没有导出 readConfig：' + cfgMod);
  }
  return { entry, createCollector: server.createCollector, readConfig: config.readConfig };
}

/** 把 listen 阶段的各种 errno 翻译成可读提示。 */
export function describeListenError(err, port) {
  const code = err && err.code ? err.code : '';
  if (code === 'EADDRINUSE') {
    return [
      '端口 ' + port + ' 已被占用，内置采集器没能启动。',
      '· 改端口：托盘菜单 →「打开配置文件」，把 "port" 改成别的（例如 ' + (port + 1) + '）后重启 Tokmeter；',
      '· 或找出占用者：netstat -ano | findstr :' + port,
      '面板仍会打开，客户端视图会显示连接失败。',
    ].join('\n');
  }
  if (code === 'EACCES') return '没有权限监听端口 ' + port + '（可能被系统保留或需要管理员）。';
  return '采集器监听 127.0.0.1:' + port + ' 失败：' + (err && err.message ? err.message : String(err));
}

/**
 * 启动采集器。
 * @returns {Promise<{ok:boolean, stage?:string, message?:string, config?:object, port?:number, collector?:object, server?:object, stop?:Function}>}
 */
export async function startCollector({ configFile = configPath, autostart = true, log = () => {} } = {}) {
  let mods;
  try {
    mods = await importCollectorModules();
  } catch (err) {
    return { ok: false, stage: 'import', message: err.message };
  }

  let config;
  try {
    config = mods.readConfig(configFile);
  } catch (err) {
    return { ok: false, stage: 'config', message: err.message };
  }

  // configFile 一并交给采集器：设置浮层的 POST /config 要写回同一个文件
  const collector = mods.createCollector({ config, log, configPath: configFile });
  const server = createServer(collector.handler);

  const listened = await new Promise((resolve) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      resolve({ ok: false, err });
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve({ ok: true });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // 只监听本机回环，不对外暴露
    server.listen(config.port, '127.0.0.1');
  });

  if (!listened.ok) {
    try { server.close(); } catch { /* 已经失败，忽略 */ }
    return {
      ok: false,
      stage: 'listen',
      code: listened.err && listened.err.code,
      config,
      port: config.port,
      message: describeListenError(listened.err, config.port),
    };
  }

  if (autostart) collector.start();
  log('采集器已启动：http://127.0.0.1:' + config.port + '/snapshot（' + config.model + ' @ ' + config.baseUrl + '）');

  const stop = () => {
    try { collector.stop(); } catch { /* 忽略 */ }
    try { server.close(); } catch { /* 忽略 */ }
  };
  // 进程退出前收摊，避免端口残留
  process.once('exit', stop);

  return { ok: true, config, port: config.port, collector, server, stop, entry: mods.entry };
}
