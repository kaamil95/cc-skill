// SKILL 本体迁移：moveSkill / skill:move —— 同卷移动、单文件、冲突、入站链接重指向、原位留链接
// 走真实 IPC 路径（harness 黑盒），与 skills.test.js 同一夹具模式
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { startApp } = require('../helpers/harness');
const { writeSkill, writeFlatSkill, makeConfig, tmpDir } = require('../helpers/fixtures');
const { LINK_TYPE } = require('../../src/paths');

let app;
let root;
let dirA; // claude-code 的目录（实体常驻）
let dirB; // zcode 的目录
let dirC; // 迁移目的地

before(async () => {
  root = tmpDir('cc-skill-move-');
  dirA = path.join(root, 'a');
  dirB = path.join(root, 'b');
  dirC = path.join(root, 'c');
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  fs.mkdirSync(dirC);
  app = await startApp({
    config: makeConfig({
      agents: [
        { id: 'claude-code', name: 'Claude Code', color: '#e07a4f', dirs: [dirA] },
        { id: 'zcode', name: 'ZCode', color: '#19b39a', dirs: [dirB, dirC] },
      ],
    }),
    // 本文件所有 skill:move 都是同卷 rename（不碰回收站）；唯一例外是下面的
    // 「跨卷 + 原件被锁定」测试，靠它让 trashItem 恒失败
    trashItem: async () => false,
  });
});

after(() => {
  app.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

const normP = (p) =>
  String(p || '')
    .replace(/[\\/]+/g, '/')
    .toLowerCase();
// 按名字 + Agent 从 scan 结果里找条目
const find = (r, name, agentId) => r.skills.find((s) => s.folder === name && (!agentId || s.agentIds.includes(agentId)));

test('同卷移动文件夹型 SKILL：旧路径消失，新路径出现且内容一致', async () => {
  writeSkill(dirA, 'm-alpha');
  const r = await app.invoke('skill:move', {
    srcPath: path.join(dirA, 'm-alpha'),
    type: 'folder',
    destDir: dirC,
    folderName: 'm-alpha',
    onConflict: 'rename',
  });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(dirA, 'm-alpha')), false);
  assert.equal(fs.existsSync(path.join(dirC, 'm-alpha', 'SKILL.md')), true);
  const scan = await app.invoke('scan');
  assert.equal(find(scan, 'm-alpha', 'claude-code'), undefined);
  assert.equal(find(scan, 'm-alpha', 'zcode').absPath, path.join(dirC, 'm-alpha'));
});

test('单文件 SKILL 也能迁移', async () => {
  writeFlatSkill(dirA, 'm-flat');
  const r = await app.invoke('skill:move', {
    srcPath: path.join(dirA, 'm-flat.md'),
    type: 'file',
    destDir: dirC,
    folderName: 'm-flat',
    onConflict: 'rename',
  });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(dirA, 'm-flat.md')), false);
  assert.equal(fs.existsSync(path.join(dirC, 'm-flat.md')), true);
});

test('目标同名：rename 自动改名；overwrite 整体替换', async () => {
  writeSkill(dirA, 'm-dup');
  writeSkill(dirC, 'm-dup', { files: { 'NOTE.md': 'x' } });
  const rn = await app.invoke('skill:move', {
    srcPath: path.join(dirA, 'm-dup'),
    type: 'folder',
    destDir: dirC,
    folderName: 'm-dup',
    onConflict: 'rename',
  });
  assert.equal(rn.ok, true);
  assert.equal(fs.existsSync(path.join(dirC, 'm-dup-2', 'SKILL.md')), true);

  writeSkill(dirA, 'm-dup'); // 还原实体（上一段把它搬走了）
  const ov = await app.invoke('skill:move', {
    srcPath: path.join(dirA, 'm-dup'),
    type: 'folder',
    destDir: dirC,
    folderName: 'm-dup',
    onConflict: 'overwrite',
  });
  assert.equal(ov.ok, true);
  // 覆盖后 m-dup 只剩一份，m-dup-2 不受影响
  assert.equal(fs.existsSync(path.join(dirC, 'm-dup', 'NOTE.md')), false);
  assert.equal(fs.existsSync(path.join(dirC, 'm-dup-2')), true);
});

test('迁移到当前所在目录被拒绝', async () => {
  writeSkill(dirA, 'm-self');
  const r = await app.invoke('skill:move', {
    srcPath: path.join(dirA, 'm-self'),
    type: 'folder',
    destDir: dirA,
    folderName: 'm-self',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'same-dir');
});

test('入站链接在迁移后自动重指向新位置', async () => {
  writeSkill(dirA, 'm-link');
  const link = path.join(dirB, 'm-link');
  fs.symlinkSync(fs.realpathSync(path.join(dirA, 'm-link')), link, LINK_TYPE);
  assert.equal(fs.existsSync(path.join(link, 'SKILL.md')), true);
  const r = await app.invoke('skill:move', {
    srcPath: path.join(dirA, 'm-link'),
    type: 'folder',
    destDir: dirC,
    folderName: 'm-link',
    onConflict: 'rename',
  });
  assert.equal(r.ok, true);
  assert.equal(r.rePointed >= 1, true);
  // 链接还在原位（dirB），但已指向新家
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(normP(fs.realpathSync(link)), normP(fs.realpathSync(path.join(dirC, 'm-link'))));
  const scan = await app.invoke('scan');
  const l = find(scan, 'm-link', 'zcode');
  assert.equal(l.linked, true);
});

test('leaveLink：原位置变成链接，原目录继续可用', async () => {
  writeSkill(dirA, 'm-leave');
  const r = await app.invoke('skill:move', {
    srcPath: path.join(dirA, 'm-leave'),
    type: 'folder',
    destDir: dirC,
    folderName: 'm-leave',
    onConflict: 'rename',
    leaveLink: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.leftLink, true);
  assert.equal(fs.lstatSync(path.join(dirA, 'm-leave')).isSymbolicLink(), true);
  assert.equal(normP(fs.realpathSync(path.join(dirA, 'm-leave'))), normP(fs.realpathSync(path.join(dirC, 'm-leave'))));
  const scan = await app.invoke('scan');
  const e = find(scan, 'm-leave', 'claude-code');
  assert.equal(e.linked, true);
});

test('源本身是链接时拒绝迁移', async () => {
  writeSkill(dirA, 'm-src-link');
  const link = path.join(dirB, 'm-src-link');
  fs.symlinkSync(fs.realpathSync(path.join(dirA, 'm-src-link')), link, LINK_TYPE);
  const r = await app.invoke('skill:move', {
    srcPath: link,
    type: 'folder',
    destDir: dirC,
    folderName: 'm-src-link',
    onConflict: 'rename',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'is-link');
});

test('跨卷且原件被锁定：副本转正为本体（partial），原件保留', async () => {
  writeSkill(dirA, 'm-partial');
  const fsMod = require('node:fs');
  const orig = fsMod.renameSync;
  // renameSync 抛 EXDEV 模拟跨卷；trashItem 恒失败模拟原件被占用 → 走到 src-locked 半成功分支
  fsMod.renameSync = () => {
    const e = new Error('EXDEV');
    e.code = 'EXDEV';
    throw e;
  };
  try {
    const r = await app.invoke('skill:move', {
      srcPath: path.join(dirA, 'm-partial'),
      type: 'folder',
      destDir: dirC,
      folderName: 'm-partial',
      onConflict: 'rename',
      leaveLink: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.partial, 'src-locked');
    assert.equal(r.leftLink, false); // 原件占着位置，链接建不了
    assert.equal(fs.existsSync(path.join(dirC, 'm-partial', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(dirA, 'm-partial')), true); // 原件保留待手动清理
  } finally {
    fsMod.renameSync = orig;
  }
});
