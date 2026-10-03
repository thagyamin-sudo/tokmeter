/**
 * 采集器配置：默认值 + 校验。
 * API key 只从这里读（本地文件），绝不写进面板页面，也绝不出现在 /snapshot 里。
 */
import { readFileSync } from 'node:fs';

export const DEFAULT_CONFIG = {
  port: 8787,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  probeEveryMs: 15000,      // 主动探测间隔（越小越费钱，最小 5 秒）
  probeMaxTokens: 24,
  probePrompt: '用一句话说明什么是缓存。',
  proxy: false,             // 是否开启 OpenAI 兼容转发（被动统计真实流量）
  pricing: { inPerM: 0, outPerM: 0 },   // 每百万 token 单价（美元），用于估算成本
  timeoutMs: 30000,
};

/** 归一化并校验；出错抛带可读信息的 Error，调用方直接打印即可。 */
export function normalizeConfig(raw) {
  const merged = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  const cfg = {
    port: Number(merged.port),
    baseUrl: String(merged.baseUrl || '').replace(/\/+$/, ''),
    apiKey: typeof merged.apiKey === 'string' ? merged.apiKey : '',
    model: String(merged.model || ''),
    probeEveryMs: Number(merged.probeEveryMs),
    probeMaxTokens: Number(merged.probeMaxTokens),
    probePrompt: String(merged.probePrompt || DEFAULT_CONFIG.probePrompt),
    proxy: merged.proxy === true,
    pricing: {
      inPerM: Number(merged.pricing && merged.pricing.inPerM) || 0,
      outPerM: Number(merged.pricing && merged.pricing.outPerM) || 0,
    },
    timeoutMs: Number(merged.timeoutMs),
  };

  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error('port 必须是 1~65535 的整数');
  if (!/^https?:\/\//.test(cfg.baseUrl)) throw new Error('baseUrl 必须以 http:// 或 https:// 开头（例：https://api.deepseek.com/v1）');
  if (!cfg.model) throw new Error('model 不能为空（例：deepseek-chat）');
  if (!(cfg.probeEveryMs >= 5000)) throw new Error('probeEveryMs 不得小于 5000（避免烧钱）');
  if (!(cfg.probeMaxTokens >= 1 && cfg.probeMaxTokens <= 512)) throw new Error('probeMaxTokens 必须在 1~512');
  if (!(cfg.timeoutMs >= 1000)) throw new Error('timeoutMs 不得小于 1000');
  return cfg;
}

/** 读配置文件；文件不存在时给出可操作的提示。 */
export function readConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error('读不到配置文件 ' + path + '：请先复制 collector.config.example.json 为 collector.config.json 并填写 baseUrl / apiKey / model');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error('配置文件不是合法 JSON：' + err.message);
  }
  return normalizeConfig(raw);
}
