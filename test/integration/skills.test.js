// SKILL 的扫描与文件操作：create / read / write / files / compare / copy / trash
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { startApp } = require('../helpers/harness');
const { writeSkill, writeFlatSkill, makeConfig, tmpDir } = require('../helpers/fixtures');
const { LINK_TYPE } = require('../../src/paths');

let app;
let root;
let agentDir;
let otherDir;

before(async () => {
  root = tmpDir('cc-skill-skills-');
  agentDir = path.join(root, 'skills');
  otherDir = path.join(root, 'other-skills');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  writeSkill(agentDir, 'alpha');
  writeFlatSkill(agentDir, 'flat-one');
  app = await startApp({ config: makeConfig({ agentDirs: [agentDir] }) });
});

after(() => {
  app.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

test('scan 能同时发现文件夹型与单文件型 SKILL，并读出 frontmatter', async () => {
  const r = await app.invoke('scan');
  const names = r.skills.map((s) => s.name).sort();
  assert.deepEqual(names, ['alpha', 'flat-one']);
  const alpha = r.skills.find((s) => s.name === 'alpha');
  assert.equal(alpha.type, 'folder');
  assert.equal(alpha.description, 'alpha 的描述');
  assert.equal(alpha.project, undefined);
  const flat = r.skills.find((s) => s.name === 'flat-one');
  assert.equal(flat.type, 'file');
});

test('scan 会报告缺失的技能目录', async () => {
  const gone = path.join(root, 'not-exist');
  const cfg = app.readConfig();
  cfg.agents[0].dirs = [gone];
  fs.writeFileSync(app.configPath, JSON.stringify(cfg), 'utf8');
  await app.invoke('config:set', { agents: cfg.agents });
  const r = await app.invoke('scan');
  assert.equal(r.missingDirs.length, 1);
  assert.equal(r.missingDirs[0].dir, gone);
  // 还原
  await app.invoke('config:set', { agents: [{ id: 'claude-code', name: 'Claude Code', color: '#e07a4f', dirs: [agentDir] }] });
});

test('skill:read 返回原文与解析后的 meta', async () => {
  const r = await app.invoke('skill:read', { path: path.join(agentDir, 'alpha', 'SKILL.md') });
  assert.equal(r.ok, true);
  assert.equal(r.meta.name, 'alpha');
  assert.match(r.content, /^---/);
  assert.ok(r.body.includes('# alpha'));
});

test('skill:write 能改回磁盘', async () => {
  const md = path.join(agentDir, 'alpha', 'SKILL.md');
  const before = fs.readFileSync(md, 'utf8');
  await app.invoke('skill:write', { path: md, content: before + '\n追加一行。\n' });
  const after = fs.readFileSync(md, 'utf8');
  assert.equal(after, before + '\n追加一行。\n');
  fs.writeFileSync(md, before, 'utf8');
});

test('skill:files 列出目录内容且文件夹在前', async () => {
  writeSkill(agentDir, 'withfiles', { files: { 'ref/a.md': 'A', 'b.txt': 'B' } });
  const dir = path.join(agentDir, 'withfiles');
  const r = await app.invoke('skill:files', { dir, type: 'folder' });
  assert.equal(r.ok, true);
  // 排序是「文件夹优先，其余按 localeCompare」——大小写不敏感，所以 b.txt 排在 SKILL.md 前
  assert.deepEqual(
    r.files.map((f) => f.name),
    ['ref', 'b.txt', 'SKILL.md']
  );
  assert.equal(r.files[0].isDir, true);
  assert.equal(r.files.find((f) => f.name === 'b.txt').size, 1);
});

test('skill:files 对单文件型 SKILL 返回空列表', async () => {
  const r = await app.invoke('skill:files', { dir: agentDir, type: 'file' });
  assert.deepEqual(r.files, []);
});

test('skill:compare 判断两份副本的 SKILL.md 是否一致', async () => {
  // 同一份内容放进两个目录（frontmatter 里的 name 不同会算作不一致，所以直接写同样的内容）
  const a = writeSkill(otherDir, 'dup-a');
  const b = writeSkill(otherDir, 'dup-b');
  const c = writeSkill(otherDir, 'dup-c');
  const md = fs.readFileSync(path.join(a, 'SKILL.md'));
  fs.writeFileSync(path.join(b, 'SKILL.md'), md);

  assert.equal((await app.invoke('skill:compare', { pathA: a, pathB: b })).same, true);
  assert.equal((await app.invoke('skill:compare', { pathA: a, pathB: c })).same, false);

  const missing = await app.invoke('skill:compare', { pathA: a, pathB: path.join(otherDir, 'nope') });
  assert.equal(missing.same, false);
  assert.equal(missing.bHas, false);
  assert.equal(missing.aHas, true);
});

test('skill:create 建目录 + 模板 SKILL.md，重名则拒绝', async () => {
  const r = await app.invoke('skill:create', { destDir: otherDir, folder: 'brand-new', name: 'brand-new', description: '新技能' });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(r.skillMdPath));
  assert.match(fs.readFileSync(r.skillMdPath, 'utf8'), /description: "新技能"/);
  const again = await app.invoke('skill:create', { destDir: otherDir, folder: 'brand-new', name: 'x', description: 'y' });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'exists');
});

test('skill:copy 复制模式：已存在时按 exists / rename / overwrite 处理', async () => {
  const src = writeSkill(otherDir, 'copy-src');
  const exists = await app.invoke('skill:copy', { srcPath: src, type: 'folder', destDir: otherDir, folderName: 'copy-src' });
  assert.equal(exists.ok, false);
  assert.equal(exists.reason, 'exists');

  const renamed = await app.invoke('skill:copy', {
    srcPath: src,
    type: 'folder',
    destDir: otherDir,
    folderName: 'copy-src',
    onConflict: 'rename',
  });
  assert.equal(renamed.ok, true);
  assert.ok(renamed.dest.endsWith('copy-src-2'));

  const overwritten = await app.invoke('skill:copy', {
    srcPath: src,
    type: 'folder',
    destDir: otherDir,
    folderName: 'copy-src-2',
    onConflict: 'overwrite',
  });
  assert.equal(overwritten.ok, true);
  assert.ok(fs.existsSync(path.join(overwritten.dest, 'SKILL.md')));
});

test('skill:copy 覆盖安装到一条链接上：只替换链接，链接指向的唯一副本不受影响', async () => {
  // 真机踩过：覆盖安装用 rmSync({recursive:true}) 清目标，而它在 Electron 的 Node 上
  // 会顺着 junction 进到目标里去删 —— 一份被多个 Agent 共用的唯一副本就这样被清空了
  const canonical = writeSkill(otherDir, 'overwrite-target');
  const linkPath = path.join(agentDir, 'overwrite-target');
  fs.symlinkSync(canonical, linkPath, LINK_TYPE);
  const src = writeSkill(otherDir, 'overwrite-src');

  const r = await app.invoke('skill:copy', {
    srcPath: src,
    type: 'folder',
    destDir: agentDir,
    folderName: 'overwrite-target',
    onConflict: 'overwrite',
  });
  assert.equal(r.ok, true);
  assert.equal(fs.lstatSync(r.dest).isSymbolicLink(), false, '覆盖后应当是一份真实副本，而不是链接');
  assert.ok(fs.existsSync(path.join(r.dest, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(canonical, 'SKILL.md')), '链接原先指向的唯一副本必须完好');
  assert.match(fs.readFileSync(path.join(canonical, 'SKILL.md'), 'utf8'), /overwrite-target/);
});

test('skill:copy 链接模式：建链接、scan 标记 linked、删链接不动源', async () => {
  // 源与链接都放在被扫描的目录里，这样 scan 能同时看到「唯一副本」和「链接」
  const src = writeSkill(agentDir, 'link-src');
  const r = await app.invoke('skill:copy', { srcPath: src, type: 'folder', destDir: agentDir, folderName: 'link-copy', mode: 'link' });
  assert.equal(r.ok, true);
  assert.equal(r.linked, true);

  const scanned = await app.invoke('scan');
  const linked = scanned.skills.find((s) => s.folder === 'link-copy');
  assert.ok(linked && linked.linked, 'scan 应把它识别为链接');
  assert.equal(linked.dangling, undefined);

  // 唯一副本被 1 个链接引用
  const canonical = scanned.skills.find((s) => s.folder === 'link-src');
  assert.equal(canonical.linked, undefined, '唯一副本本身不是链接');
  assert.equal(canonical.linkCount, 1);

  const trashed = await app.invoke('skill:trash', { path: r.dest });
  assert.equal(trashed.ok, true);
  assert.equal(trashed.linkRemoved, true);
  assert.ok(fs.existsSync(src), '删链接绝不能动源 SKILL');
  assert.ok(!fs.existsSync(r.dest));
});

test('skill:copy 链接模式对单文件型 SKILL 拒绝', async () => {
  const flat = writeFlatSkill(otherDir, 'flat-src');
  const r = await app.invoke('skill:copy', { srcPath: flat, type: 'file', destDir: agentDir, folderName: 'flat-src', mode: 'link' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-link');
});

test('skill:trash 把实体目录移走', async () => {
  const dir = writeSkill(otherDir, 'to-trash');
  const r = await app.invoke('skill:trash', { path: dir });
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(dir));
});

test('skill:trash 对不存在的路径返回错误而不是抛异常', async () => {
  const r = await app.invoke('skill:trash', { path: path.join(otherDir, 'nope-nope') });
  assert.equal(r.ok, false);
  assert.match(r.error, /路径不存在/);
});
