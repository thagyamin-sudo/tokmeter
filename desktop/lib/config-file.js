/**
 * 采集器配置文件：%APPDATA%\\Tokmeter\\collector.config.json
 * 首次运行自动从模板生成（安装包内 collector.config.example.json，开发时取仓库根目录那份）。
 * 注意：只保证「存在」，不改写用户已经改过的内容。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { configPath, configTemplateCandidates, userDir } from './paths.js';

/** 模板都找不到时的兜底内容（与仓库 collector.config.example.json 同构）。 */
export const FALLBACK_TEMPLATE = [
  '{',
  '  "baseUrl": "https://api.deepseek.com/v1",',
  '  "apiKey": "在这里填你的 key（这个文件请勿提交/外发）",',
  '  "model": "deepseek-chat",',
  '  "port": 8787,',
  '  "probeEveryMs": 15000,',
  '  "probeMaxTokens": 24,',
  '  "probePrompt": "用一句话说明什么是缓存。",',
  '  "proxy": false,',
  '  "pricing": { "inPerM": 0.27, "outPerM": 1.1 }',
  '}',
  '',
].join('\n');

/** 确保配置文件存在；返回 { path, created, from }。 */
export function ensureConfigFile() {
  mkdirSync(userDir, { recursive: true });
  if (existsSync(configPath)) return { path: configPath, created: false, from: null };
  const template = configTemplateCandidates().find((p) => existsSync(p));
  let text = FALLBACK_TEMPLATE;
  if (template) {
    try {
      text = readFileSync(template, 'utf8');
    } catch {
      text = FALLBACK_TEMPLATE;
    }
  }
  writeFileSync(configPath, text, 'utf8');
  return { path: configPath, created: true, from: template || 'builtin' };
}
