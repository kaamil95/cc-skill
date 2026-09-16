// 打包清单自检：electron-builder 的 build.files 必须覆盖 main.js 依赖图上的每个本地模块。
// 漏一个的后果是「开发时一切正常，打出来的 exe 起不来」——只有真的打包+启动才会暴露，
// 所以这里用静态检查提前拦住。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../../src/paths');

const pkg = require('../../package.json');

/** 把 electron-builder 的 files 通配条目（形如 src 下递归全部）转成正则 */
function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + esc.replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*') + '$');
}

const isPackaged = (rel) => pkg.build.files.some((g) => globToRe(g).test(rel.replace(/\\/g, '/')));

/** 从入口出发，沿本地 require 收集所有模块（不含 node_modules） */
function collectLocalRequires(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      let dep = path.join(path.dirname(file), m[1]).replace(/\\/g, '/');
      if (!dep.endsWith('.js')) dep += '.js';
      queue.push(dep);
    }
  }
  return [...seen];
}

test('package.json 的入口文件存在且会被打包', () => {
  assert.ok(fs.existsSync(path.join(ROOT, pkg.main)), `入口不存在: ${pkg.main}`);
  assert.ok(isPackaged(pkg.main), `入口没被 build.files 覆盖: ${pkg.main}`);
});

test('main.js 依赖图上的每个本地模块都会被打包', () => {
  const modules = collectLocalRequires('main.js');
  const missing = modules.filter((m) => !isPackaged(m));
  assert.deepEqual(missing, [], `这些模块不会被放进安装包: ${missing.join(', ')}`);
  assert.ok(modules.length >= 6, '应当收集到 src/ 下的各个模块');
});

test('preload.js 依赖图上的每个本地模块都会被打包', () => {
  const missing = collectLocalRequires('preload.js').filter((m) => !isPackaged(m));
  assert.deepEqual(missing, [], `这些模块不会被放进安装包: ${missing.join(', ')}`);
});

test('渲染层文件都会被打包', () => {
  for (const rel of ['renderer/index.html', 'renderer/app.js', 'renderer/i18n.js', 'renderer/styles.css']) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `缺少文件: ${rel}`);
    assert.ok(isPackaged(rel), `没被 build.files 覆盖: ${rel}`);
  }
});

test('测试与工具链配置不会被打进安装包', () => {
  for (const rel of ['test/unit/paths.test.js', 'eslint.config.js', '.prettierrc.json']) {
    assert.ok(!isPackaged(rel), `不该进安装包: ${rel}`);
  }
});
