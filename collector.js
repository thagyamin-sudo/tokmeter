#!/usr/bin/env node
/**
 * 采集器入口：node collector.js [配置文件路径]
 * 默认读同目录的 collector.config.json（已 gitignore，key 只存在你本机）。
 */
import { createServer } from 'node:http';
import { readConfig } from './collector/config.js';
import { createCollector } from './collector/server.js';

const path = process.argv[2] || 'collector.config.json';
let config;
try {
  config = readConfig(path);
} catch (err) {
  console.error('启动失败：' + err.message);
  process.exit(1);
}

const log = (m) => console.log('[' + new Date().toLocaleTimeString() + '] ' + m);
const collector = createCollector({ config, log });
const server = createServer(collector.handler);

server.listen(config.port, '127.0.0.1', () => {
  console.log('采集器已启动：http://127.0.0.1:' + config.port + '/snapshot');
  console.log('目标 ' + config.model + ' @ ' + config.baseUrl + '，每 ' + config.probeEveryMs + 'ms 主动探测一次');
  console.log('打开面板：llm-monitor.html?view=client （或 index.html?view=client）');
  if (config.proxy) console.log('转发已开启：把应用的 base_url 指到 http://127.0.0.1:' + config.port + '/v1 即可统计真实流量');
  collector.start();
});

const shutdown = () => {
  collector.stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
