/**
 * 单文件构建（实施计划 Task 10）：把全部 ESM 模块与 styles.css 内联进一个 HTML，
 * 产物可以 file:// 双击离线打开——普通 <script>（非 module），import/export 已剥离。
 *
 * 用法：
 *   node build.js                       # 写出仓库根 llm-monitor.html，打印字节数与内联模块数
 *   import { build } from './build.js'  # 返回同一份 HTML 字符串（测试用）
 *
 * 零第三方依赖。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（本文件所在目录）。 */
const ROOT = dirname(fileURLToPath(import.meta.url));

/** 产物文件名（写在仓库根）。 */
export const OUT_FILE = 'llm-monitor.html';

/**
 * 拼接顺序：依赖在前；新增模块必须同步加进 MODULES，否则产物里会留下未定义引用。
 * 顺序即依赖拓扑（format/charts/units/store 是底座，app 是入口，必须最后执行）。
 */
export const MODULES = [
  'src/format.js',
  'src/charts.js',
  'src/units.js',
  'src/store.js',
  'src/sources/vllm-metrics.js',
  'src/sources/mock.js',
  'src/sources/http.js',
  'src/sources/client.js',
  'src/render.js',
  'src/scheduler.js',
  'src/app.js',
];

/** 读取仓库内文件；缺失时抛出可读错误，绝不静默跳过。 */
function readRepoFile(rel) {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch (err) {
    throw new Error('缺少必需文件 ' + rel + '：' + err.message);
  }
}

/** 只匹整行的静态 import：`import ... from '...';` 与副作用式 `import '...';`。 */
const IMPORT_LINE = /^\s*import\s+(?:[^;'"]*?\sfrom\s*)?['"][^'"]+['"]\s*;?\s*$/;

/**
 * 把 ESM 模块改写成可内联的普通脚本片段：
 * 1) 整行删除 import 语句；
 * 2) 去掉行首的 `export `（保留缩进，其余内容逐字保留，含字符串与模板字面量）；
 * 行内出现的 import/export 关键字（例如字符串里）不受影响。
 */
export function stripModule(code) {
  return code
    .split('\n')
    .filter((line) => !IMPORT_LINE.test(line))
    .map((line) => line.replace(/^(\s*)export\s+/, '$1'))
    .join('\n');
}

/**
 * 按 MODULES 顺序拼接模块；每个模块前插一行锚点注释，
 * 供人工排查与构建测试统计内联模块数。
 */
export function bundle() {
  return MODULES.map((rel) => {
    const body = stripModule(readRepoFile(rel)).replace(/\s*$/, '');
    return '/* ===== ' + rel + ' ===== */\n' + body;
  }).join('\n\n');
}

/** 生成完整单文件 HTML（纯函数，只读仓库，不落盘）。 */
export function build() {
  const css = readRepoFile('styles.css').replace(/\s*$/, '');
  const script = bundle();
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="dark">',
    '<title>LLM 状态监控</title>',
    '<style>',
    css,
    '</style>',
    '</head>',
    '<body>',
    '<main class="panel" id="panel"></main>',
    '<pre id="probe" hidden></pre>',
    '<script>',
    "(function () {\n  'use strict';",
    script,
    '})();',
    '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** 判断是否被 `node build.js` 直接执行（Windows 盘符大小写不敏感，统一小写比较）。 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(entry) === norm(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  try {
    const html = build();
    writeFileSync(join(ROOT, OUT_FILE), html, 'utf8');
    const bytes = Buffer.byteLength(html, 'utf8');
    console.log(
      '已写出 ' + OUT_FILE + '：' + bytes + ' 字节（' + (bytes / 1024).toFixed(1) + ' KB），内联模块 ' + MODULES.length + ' 个',
    );
  } catch (err) {
    console.error('构建失败：' + err.message);
    process.exit(1);
  }
}
