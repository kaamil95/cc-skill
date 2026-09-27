// skill:readRef 的端到端契约：渲染层点开 SKILL.md 里的相对链接时走的就是这条通道。
// 关键点是「按 skill 目录解析」和「越界一律拒绝」——前者是白屏的修复，后者是安全边界。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { startApp } = require('../helpers/harness');
const { tmpDir, makeConfig, writeSkill } = require('../helpers/fixtures');

let app;
let root;
let skillDir;

before(async () => {
  root = tmpDir('cc-skill-refs-');
  skillDir = writeSkill(root, 'diagram-design', {
    files: { 'references/type-x.md': '---\ntitle: x\n---\n\n# 引用正文\n\n正文。\n' },
  });
  app = await startApp({ config: makeConfig({ agentDirs: [root] }) });
});
after(() => {
  app.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

test('按 skill 目录解析相对引用，并读出原文与正文', async () => {
  const r = await app.invoke('skill:readRef', { baseDir: skillDir, href: 'references/type-x.md' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'text');
  assert.equal(r.path, path.join(skillDir, 'references', 'type-x.md'));
  assert.match(r.body, /引用正文/);
  assert.match(r.content, /^---\ntitle: x/, '原文（含 frontmatter）要一并回传，编辑/查看都靠它');
});

test('越界引用返回 outside，且不读任何文件', async () => {
  const r = await app.invoke('skill:readRef', { baseDir: skillDir, href: '../../../SKILL.md' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'outside');
});

test('不存在的引用返回 missing，并带出解析后的路径供界面提示', async () => {
  const r = await app.invoke('skill:readRef', { baseDir: skillDir, href: 'references/nope.md' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing');
  assert.equal(r.path, path.join(skillDir, 'references', 'nope.md'));
});

test('外链不读文件，原样交回渲染层去开浏览器', async () => {
  const r = await app.invoke('skill:readRef', { baseDir: skillDir, href: 'https://example.com/x' });
  assert.equal(r.kind, 'external');
  assert.equal(r.url, 'https://example.com/x');
});

test('shell:openUrl 只放行 http/https/mailto', async () => {
  assert.equal((await app.invoke('shell:openUrl', { url: 'https://example.com/x' })).ok, true);
  assert.deepEqual(app.openExternalCalls(), ['https://example.com/x']);

  const bad = await app.invoke('shell:openUrl', { url: 'file:///etc/passwd' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'scheme');
  assert.deepEqual(app.openExternalCalls(), ['https://example.com/x']);
});
