// 导航与引用解析——纯函数。
// 这两条判定是「点 SKILL.md 里的链接不再白屏」的核心：只有应用自己的页面放行，
// 其余一律拦截或转交系统，绝不把窗口导航走。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { fileURLToPath, pathToFileURL } = require('url');
const { classifyNavigation, resolveRef } = require('../../src/nav');
const { IS_WIN } = require('../../src/paths');
const { tmpDir } = require('../helpers/fixtures');

// 用 pathToFileURL 生成而不是硬编码 file:///app/...：Windows 的 file URL 必须带盘符，
// 硬编码的 POSIX 形式在 fileURLToPath 里会直接抛 ERR_INVALID_FILE_URL_PATH
const APP_PATH = path.resolve('app', 'renderer', 'index.html');
const APP = pathToFileURL(APP_PATH).href;
const REF_PATH = path.resolve('app', 'renderer', 'references', 'type-dp-security-matrix.md');
const REF = pathToFileURL(REF_PATH).href;

// ------------------------------ classifyNavigation --------------------------
test('放行应用自己的页面（含锚点与查询串）', () => {
  assert.deepEqual(classifyNavigation(APP, { appUrl: APP }), { action: 'allow' });
  assert.deepEqual(classifyNavigation(APP + '#tab', { appUrl: APP }), { action: 'allow' });
  assert.deepEqual(classifyNavigation(APP + '?a=1', { appUrl: APP }), { action: 'allow' });
});

test('http / https / mailto 转交系统浏览器', () => {
  assert.deepEqual(classifyNavigation('https://example.com/a?b=1', { appUrl: APP }), {
    action: 'openExternal',
    url: 'https://example.com/a?b=1',
  });
  assert.equal(classifyNavigation('mailto:a@b.c', { appUrl: APP }).action, 'openExternal');
});

test('file:// 指向非应用页面时判为 openLocal（正是白屏那一步的输入）', () => {
  const r = classifyNavigation(REF, { appUrl: APP });
  assert.equal(r.action, 'openLocal');
  assert.equal(r.path, REF_PATH);
  assert.equal(fileURLToPath(REF), REF_PATH);
});

test('大小写不同仍认作同一页面（Windows 上 E: 与 e: 是一回事）', { skip: !IS_WIN }, () => {
  assert.equal(classifyNavigation(APP.toUpperCase(), { appUrl: APP }).action, 'allow');
});

test('javascript: / data: 一律拦截', () => {
  assert.equal(classifyNavigation('javascript:alert(1)', { appUrl: APP }).action, 'block');
  assert.equal(classifyNavigation('data:text/html,<h1>x</h1>', { appUrl: APP }).action, 'block');
  assert.equal(classifyNavigation('', { appUrl: APP }).action, 'block');
});

// ------------------------------ resolveRef ---------------------------------
let root;
let skillDir;

before(() => {
  root = tmpDir('cc-skill-nav-');
  skillDir = path.join(root, 'diagram-design');
  fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# skill\n', 'utf8');
  fs.writeFileSync(path.join(skillDir, 'references', 'type-x.md'), '# 引用正文\n', 'utf8');
  fs.writeFileSync(path.join(skillDir, 'references', '中文名.md'), '# 中文\n', 'utf8');
  fs.mkdirSync(path.join(skillDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'assets', 'pic.png'), 'x', 'utf8');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('相对引用按 baseDir 解析，而不是按页面目录', () => {
  const r = resolveRef(skillDir, 'references/type-x.md');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'text');
  assert.equal(r.path, path.join(skillDir, 'references', 'type-x.md'));
  assert.equal(r.ext, '.md');
});

test('?query 与 #hash 会被剥掉', () => {
  const r = resolveRef(skillDir, 'references/type-x.md?v=2#section');
  assert.equal(r.ok, true);
  assert.equal(r.path, path.join(skillDir, 'references', 'type-x.md'));
});

test('URL 编码的路径会被解码', () => {
  const r = resolveRef(skillDir, 'references/' + encodeURIComponent('中文名') + '.md');
  assert.equal(r.ok, true);
  assert.equal(r.path, path.join(skillDir, 'references', '中文名.md'));
});

test('反斜杠写法与正斜杠等价', () => {
  const r = resolveRef(skillDir, 'references\\type-x.md');
  assert.equal(r.ok, true);
  assert.equal(r.path, path.join(skillDir, 'references', 'type-x.md'));
});

test('越界的相对路径返回 outside（不允许走出 SKILL 目录）', () => {
  assert.equal(resolveRef(skillDir, '../../outside.md').reason, 'outside');
  assert.equal(resolveRef(skillDir, 'references/../../outside.md').reason, 'outside');
});

test('绝对路径与盘符路径返回 outside', () => {
  const abs = path.join(root, 'elsewhere.md');
  assert.equal(resolveRef(skillDir, abs).reason, 'outside');
  assert.equal(resolveRef(skillDir, 'C:\\Windows\\win.ini').reason, 'outside');
  assert.equal(resolveRef(skillDir, '/etc/hosts').reason, 'outside');
});

test('外链原样回传，交给上层开浏览器', () => {
  const r = resolveRef(skillDir, 'https://example.com/doc');
  assert.equal(r.kind, 'external');
  assert.equal(r.url, 'https://example.com/doc');
});

test('外链的 ?query 与 #anchor 必须原样保留（切掉就是打开另一个地址）', () => {
  // 踩过：先 stripTail 再判 scheme，把 https://x/a?b=1#c 截成了 https://x/a
  const r = resolveRef(skillDir, 'https://example.com/a?b=1#c');
  assert.equal(r.kind, 'external');
  assert.equal(r.url, 'https://example.com/a?b=1#c');
});

test('非 http(s) 的 scheme 被拒绝', () => {
  assert.equal(resolveRef(skillDir, 'javascript:alert(1)').reason, 'scheme');
  assert.equal(resolveRef(skillDir, 'file:///etc/passwd').reason, 'scheme');
});

test('不存在的引用返回 missing，并带出解析后的绝对路径', () => {
  const r = resolveRef(skillDir, 'references/nope.md');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing');
  assert.equal(r.path, path.join(skillDir, 'references', 'nope.md'));
});

test('目录、非文本类型分别返回 directory / other', () => {
  assert.equal(resolveRef(skillDir, 'references').reason, 'directory');
  const pic = resolveRef(skillDir, 'assets/pic.png');
  assert.equal(pic.ok, true);
  assert.equal(pic.kind, 'other');
});

test('纯锚点不碰文件系统', () => {
  const r = resolveRef(skillDir, '#install');
  assert.deepEqual(r, { ok: true, kind: 'anchor', anchor: 'install' });
});

test('baseDir 缺失时拒绝相对引用，而不是退回当前工作目录', () => {
  assert.equal(resolveRef('', 'references/type-x.md').reason, 'outside');
});
