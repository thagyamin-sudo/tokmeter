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
import { mkdirSync, writeFileSync } from 'node:fs';
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
  const script = join(dir, 'shot.cmd');
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--user-data-dir=' + join(dir, 'profile'), '--window-size=520,900',
    '--force-device-scale-factor=' + scale, '--virtual-time-budget=3000',
    '--screenshot=' + out, urlStr,
  ];
  // .cmd 里的 % 必须翻倍，否则 %3D 之类会被批处理当参数展开吃掉
  writeFileSync(
    script,
    '@echo off\r\n"' + EDGE + '" ' + args.map((a) => '"' + a.replace(/%/g, '%%') + '"').join(' ') + ' >nul 2>nul\r\n',
    'utf8'
  );
  return new Promise((done) => {
    const child = spawn('cmd.exe', ['/d', '/c', script], { stdio: 'ignore', windowsHide: true });
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
console.log(result === 'ok' ? '已写出 ' + out : '截图失败：' + result);
process.exit(result === 'ok' ? 0 : 1);
