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

/**
 * 仓库示例里的 apiKey 是中文占位（"在这里填你的 key…"）。
 * HTTP 头只能是 Latin-1，采集器拿它发请求会直接抛
 * "Cannot convert argument to a ByteString"，报错信息对用户毫无意义。
 * 所以首次生成时把它换成 ASCII 占位：一样是「请填这里」，但报错会变成干净的 401。
 */
const ASCII_KEY_PLACEHOLDER = 'PUT-YOUR-KEY-HERE';

function sanitizeTemplate(text) {
  try {
    const raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (typeof raw.apiKey === 'string' && /[^\x00-\x7F]/.test(raw.apiKey)) {
      raw.apiKey = ASCII_KEY_PLACEHOLDER;
      return { text: JSON.stringify(raw, null, 2) + '\n', replacedKey: true };
    }
  } catch {
    // 模板不是合法 JSON：原样落盘，让用户在编辑器里改
  }
  return { text, replacedKey: false };
}

/** 确保配置文件存在；返回 { path, created, from, replacedKey }。 */
export function ensureConfigFile() {
  mkdirSync(userDir, { recursive: true });
  if (existsSync(configPath)) return { path: configPath, created: false, from: null, replacedKey: false };
  const template = configTemplateCandidates().find((p) => existsSync(p));
  let text = FALLBACK_TEMPLATE;
  if (template) {
    try {
      text = readFileSync(template, 'utf8');
    } catch {
      text = FALLBACK_TEMPLATE;
    }
  }
  const clean = sanitizeTemplate(text);
  writeFileSync(configPath, clean.text, 'utf8');
  return { path: configPath, created: true, from: template || 'builtin', replacedKey: clean.replacedKey };
}
