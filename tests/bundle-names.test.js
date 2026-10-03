/**
 * 单文件构建的隐性前提：src 下所有模块的顶层标识符不能重名。
 * 一旦重名，拼接后的产物会以 "Identifier 'X' has already been declared" 直接跑不起来
 * —— 这个坑真实发生过（mock.js 与 client.js 都叫 GPU_WINDOW），所以用测试钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 递归收集 src 下所有模块文件。 */
function moduleFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...moduleFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 取行首的顶层声明名（export const/let/function/class）。 */
function topLevelNames(source) {
  const names = [];
  for (const line of source.split('\n')) {
    const m = /^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

test('src 各模块的顶层标识符互不重名（单文件拼接的前提）', () => {
  const seen = new Map();
  const clashes = [];
  for (const file of moduleFiles(join(ROOT, 'src'))) {
    for (const name of topLevelNames(readFileSync(file, 'utf8'))) {
      const owner = file.slice(ROOT.length + 1);
      if (seen.has(name) && seen.get(name) !== owner) {
        clashes.push(name + '：' + seen.get(name) + ' ↔ ' + owner);
      } else {
        seen.set(name, owner);
      }
    }
  }
  assert.deepEqual(clashes, [], '顶层重名会在拼接产物里变成 SyntaxError：\n' + clashes.join('\n'));
});
