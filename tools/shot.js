#!/usr/bin/env node
/**
 * 截图脚本：无头 Edge 打开被测页面并落盘 PNG，用于和 ref/ 参考照片并排比对。
 *
 *   node tools/shot.js                          # 默认输出 .superpowers/shot.png
 *   node tools/shot.js --out=ref/mine.png
 *   node tools/shot.js --query="test=1&seed=7&freeze=23:48:30" --scale=2
 *
 * 与 probe.js 同源两个环境坑：无头 Edge 有最小窗口宽度（用固定 390x844 的 iframe 拿真实视口），
 * 且 Node 直接管道捕获 Edge 输出会卡死（改由 cmd.exe 重定向，异步等待）。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const out = resolve(ROOT, flag('out', '.superpowers/shot.png'));
const query = flag('query', 'test=1&seed=7&freeze=23:48:30');
const scale = flag('scale', '2');

function startServer() {
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const file = normalize(join(ROOT, rel === '/' ? '/index.html' : rel));
    if (!file.startsWith(ROOT)) {
      res.statusCode = 403;
      return res.end();
    }
    try {
      const buf = await readFile(file);
      res.setHeader('content-type', MIME[extname(file)] || 'application/octet-stream');
      res.end(buf);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

function shoot(urlStr) {
  const dir = join(tmpdir(), 'llm-shot');
  mkdirSync(dir, { recursive: true });
  // 截图不需要捕获 Edge 的 stdout，因此直接 spawn（不经 cmd 中转）：
  // 经 .cmd 时命令行是 UTF-8 而 cmd 按 OEM 码页解析，中文输出路径会被弄坏导致静默不落盘。
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--user-data-dir=' + join(dir, 'profile'), '--window-size=520,900',
    '--force-device-scale-factor=' + scale, '--virtual-time-budget=3000',
    '--screenshot=' + out, urlStr,
  ];
  return new Promise((done) => {
    const child = spawn(EDGE, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      done('timeout');
    }, 120000);
    child.on('exit', () => {
      clearTimeout(timer);
      done('ok');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      done(err.message);
    });
  });
}

const server = await startServer();
const port = server.address().port;
const url = 'http://127.0.0.1:' + port + '/tools/frame.html?q=' + encodeURIComponent(query);
const result = await shoot(url);
server.close();
// Edge 正常退出不代表文件真的落盘（实测出现过静默不生成），必须自己确认
const wrote = existsSync(out) && statSync(out).size > 0;
if (result !== 'ok' || !wrote) {
  console.error('截图失败：' + (result === 'ok' ? '进程正常退出但未生成 ' + out : result));
  process.exit(1);
}
console.log('已写出 ' + out + '（' + statSync(out).size + ' 字节）');
process.exit(0);
