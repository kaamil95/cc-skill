// 目录遍历与技能根定位——纯文件系统逻辑
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { countFiles, findSkillRoot, makeSkill, applyLinkInfo } = require('../../src/skills');
const { writeSkill, tmpDir } = require('../helpers/fixtures');

let root;

before(() => {
  root = tmpDir('cc-skill-unit-files-');
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('countFiles 递归统计文件与目录，且有 500 上限', () => {
  const dir = writeSkill(root, 'counted', { files: { 'a.md': 'a', 'sub/b.md': 'b', 'sub/deep/c.md': 'c' } });
  // SKILL.md + a.md + sub + sub/b.md + sub/deep + sub/deep/c.md = 6
  assert.equal(countFiles(dir), 6);

  const many = path.join(root, 'many');
  fs.mkdirSync(many, { recursive: true });
  for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), '', 'utf8');
  assert.ok(countFiles(many) <= 502, '超过 500 个就该提前收手');
});

test('countFiles 对不存在的目录返回 0 而不是抛错', () => {
  assert.equal(countFiles(path.join(root, 'nope')), 0);
});

test('findSkillRoot 直接命中当前目录', () => {
  const dir = writeSkill(root, 'direct');
  assert.equal(findSkillRoot(dir), dir);
});

test('findSkillRoot 向下两层找到嵌套的技能根', () => {
  const outer = path.join(root, 'outer');
  const inner = writeSkill(outer, 'inner');
  assert.equal(findSkillRoot(outer), inner);

  const deep = path.join(root, 'deep');
  const nested = writeSkill(path.join(deep, 'l1'), 'l2');
  assert.equal(findSkillRoot(deep), nested);
});

test('findSkillRoot 跳过隐藏目录，也找不到时返回 null', () => {
  const hidden = path.join(root, 'hidden');
  writeSkill(path.join(hidden, '.git'), 'ignored');
  assert.equal(findSkillRoot(hidden), null);

  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  assert.equal(findSkillRoot(empty), null);
});

test('makeSkill 读出 frontmatter，缺失时回落到文件夹名', () => {
  const dir = writeSkill(root, 'named', { description: '描述文本' });
  const sk = makeSkill(dir, 'folder', 'named', new Set(['claude-code']), path.join(dir, 'SKILL.md'));
  assert.equal(sk.name, 'named');
  assert.equal(sk.description, '描述文本');
  assert.deepEqual(sk.agentIds, ['claude-code']);
  assert.equal(sk.type, 'folder');
  assert.equal(sk.parentDir, root);
  assert.equal(sk.linkCount, 0);

  const bare = path.join(root, 'bare');
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, 'SKILL.md'), '# 没有 frontmatter\n\n第一段正文。\n', 'utf8');
  const sk2 = makeSkill(bare, 'folder', 'bare', new Set(), path.join(bare, 'SKILL.md'));
  assert.equal(sk2.name, 'bare', '没有 name 就用文件夹名');
  assert.equal(sk2.description, '第一段正文。', '没有 description 就用首段正文');
});

test('applyLinkInfo 对普通目录不加标记', () => {
  const dir = writeSkill(root, 'plain');
  const sk = makeSkill(dir, 'folder', 'plain', new Set(), path.join(dir, 'SKILL.md'));
  applyLinkInfo(sk);
  assert.equal(sk.linked, undefined);
  assert.equal(sk.linkTarget, undefined);
});
