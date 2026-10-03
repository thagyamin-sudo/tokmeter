/**
 * 资源路径解析：同一份代码同时服务「开发运行」(electron .) 与「安装后运行」。
 *
 *  - 开发：资源就在仓库里（../llm-monitor.html、../collector、../icons）
 *  - 安装后：electron-builder 的 extraResources 把它们放进 process.resourcesPath
 * 用户数据（配置 / 窗口状态）永远在 %APPDATA%/Tokmeter/，与安装位置无关。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';

const libDir = path.dirname(fileURLToPath(import.meta.url));

/** desktop/ 目录 */
export const desktopDir = path.resolve(libDir, '..');
/** 仓库根目录（desktop/ 的上一级） */
export const repoRoot = path.resolve(desktopDir, '..');

/** 打包后取 resources/，开发时取仓库根目录。 */
export function resourcePath(...parts) {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...parts)
    : path.join(repoRoot, ...parts);
}

/** 面板单文件产物 llm-monitor.html */
export function panelPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'llm-monitor.html')
    : path.join(repoRoot, 'llm-monitor.html');
}

/** 采集器入口：collector/server.js */
export function collectorEntry() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'collector', 'server.js')
    : path.join(repoRoot, 'collector', 'server.js');
}

/** 采集器配置模块：collector/config.js（复用它的 readConfig 做校验） */
export function collectorConfigModule() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'collector', 'config.js')
    : path.join(repoRoot, 'collector', 'config.js');
}

/** 托盘图标（Windows 的 Tray 直接吃 PNG） */
export function trayIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icons', 'icon-192.png')
    : path.join(repoRoot, 'icons', 'icon-192.png');
}

/** 窗口图标 */
export function windowIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icons', 'icon-512.png')
    : path.join(repoRoot, 'icons', 'icon-512.png');
}

/** 配置模板候选（安装包内 / 仓库根），按顺序取第一个存在的。 */
export function configTemplateCandidates() {
  return [
    resourcePath('collector.config.example.json'),
    path.join(repoRoot, 'collector.config.example.json'),
  ].filter((p, i, all) => all.indexOf(p) === i);
}

/** 用户数据目录：%APPDATA%\\Tokmeter */
export const userDir = path.join(app.getPath('appData'), 'Tokmeter');
/** 采集器配置文件：%APPDATA%\\Tokmeter\\collector.config.json */
export const configPath = path.join(userDir, 'collector.config.json');
/** 窗口状态：%APPDATA%\\Tokmeter\\state.json */
export const statePath = path.join(userDir, 'state.json');
