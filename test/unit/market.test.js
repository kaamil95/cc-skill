// 市场：链接解析、索引归一化、仓库树里的 SKILL 枚举。全是纯函数 / 本地目录，不联网。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseRepoRef, parseSource, normalizeIndexEntry, listSkillDirs, inspectSource } = require('../../src/market');
const { tmpDir, writeSkill } = require('../helpers/fixtures');

// ------------------------------ 链接解析 -------------------------------------
test('parseRepoRef 认得各种 GitHub 写法', () => {
  const cases = [
    ['owner/repo', { owner: 'owner', repo: 'repo', ref: '', path: '' }],
    ['https://github.com/owner/repo', { owner: 'owner', repo: 'repo', ref: '', path: '' }],
    ['https://github.com/owner/repo.git', { owner: 'owner', repo: 'repo', ref: '', path: '' }],
    ['git@github.com:owner/repo.git', { owner: 'owner', repo: 'repo', ref: '', path: '' }],
    ['https://github.com/owner/repo/tree/main/skills/x', { owner: 'owner', repo: 'repo', ref: 'main', path: 'skills/x' }],
    ['https://github.com/owner/repo/blob/main/skills/x/SKILL.md', { owner: 'owner', repo: 'repo', ref: 'main', path: 'skills/x/SKILL.md' }],
    ['owner/repo/tree/dev/skills/y', { owner: 'owner', repo: 'repo', ref: 'dev', path: 'skills/y' }],
    ['https://github.com/owner/repo/archive/refs/heads/main.zip', { owner: 'owner', repo: 'repo', ref: 'main', path: '' }],
    ['https://codeload.github.com/owner/repo/zip/main', { owner: 'owner', repo: 'repo', ref: 'main', path: '' }],
  ];
  for (const [input, want] of cases) {
    assert.deepEqual(parseRepoRef(input), want, input);
  }
});

test('parseRepoRef 对认不出的输入返回 null', () => {
  for (const bad of ['', '   ', 'just-one-word', 'https://example.com/x/y', null]) {
    assert.equal(parseRepoRef(bad), null, String(bad));
  }
});

test('parseSource 区分 GitHub 与直链 zip，其余一律拒绝', () => {
  assert.deepEqual(parseSource('owner/repo'), { kind: 'github', owner: 'owner', repo: 'repo', ref: '', path: '' });
  assert.deepEqual(parseSource('https://example.com/x.zip'), { kind: 'zip', url: 'https://example.com/x.zip' });
  assert.equal(parseSource('https://example.com/page.html'), null);
  assert.equal(parseSource('乱写的'), null);
});

// ------------------------------ 索引归一化 -----------------------------------
test('索引条目：repo 与 url 二选一，两者都没有就丢弃', () => {
  const byRepo = normalizeIndexEntry({ name: 'x', description: 'd', repo: 'o/r', path: 'skills/x', tags: ['a', 'b'] });
  assert.equal(byRepo.name, 'x');
  assert.deepEqual(byRepo.source, { kind: 'github', owner: 'o', repo: 'r', ref: '', path: 'skills/x' });
  assert.deepEqual(byRepo.tags, ['a', 'b']);

  const byUrl = normalizeIndexEntry({ name: 'y', url: 'https://e.test/y.zip' });
  assert.deepEqual(byUrl.source, { kind: 'zip', url: 'https://e.test/y.zip' });

  assert.equal(normalizeIndexEntry({ description: '没有名字' }), null);
  assert.equal(normalizeIndexEntry({ name: 'z' }), null, '既没有 repo 也没有 url');
  assert.equal(normalizeIndexEntry(null), null);
  assert.equal(normalizeIndexEntry({ name: 'w', url: 'ftp://x' }), null, '只接受 http(s) 直链');
});

test('索引条目：ref 显式给出的优先于从 repo 链接里解析出来的', () => {
  const e = normalizeIndexEntry({ name: 'x', repo: 'o/r/tree/main/sub', ref: 'v2' });
  assert.equal(e.source.ref, 'v2');
  assert.equal(e.source.path, 'sub');
});

// ------------------------------ 仓库树里的 SKILL ------------------------------
let root;
before(() => {
  root = tmpDir('cc-skill-market-');
  writeSkill(path.join(root, 'skills'), 'alpha');
  writeSkill(path.join(root, 'skills'), 'beta');
  writeSkill(path.join(root, 'nested', 'deep'), 'gamma');
  fs.mkdirSync(path.join(root, 'node_modules', 'junk'), { recursive: true });
  writeSkill(path.join(root, 'node_modules', 'junk'), 'should-be-skipped');
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'x', 'utf8');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('listSkillDirs 找出所有含 SKILL.md 的目录，并跳过 node_modules', () => {
  const found = listSkillDirs(root)
    .map((s) => s.relPath)
    .sort();
  assert.deepEqual(found, ['nested/deep/gamma', 'skills/alpha', 'skills/beta']);
});

test('listSkillDirs 带出名称 / 描述 / 文件数，供列表直接展示', () => {
  const alpha = listSkillDirs(root).find((s) => s.name === 'alpha');
  assert.match(alpha.description, /alpha 的描述/);
  assert.ok(alpha.fileCount >= 1);
  assert.ok(alpha.absPath.startsWith(root));
});

test('listSkillDirs 给出 SKILL.md 的文件路径（skill:read 要的是文件，不是目录）', () => {
  // 踩过：预览直接拿目录路径去 skill:read，报 EISDIR
  const alpha = listSkillDirs(root).find((s) => s.name === 'alpha');
  assert.equal(alpha.skillMdPath, path.join(alpha.absPath, 'SKILL.md'));
  assert.ok(fs.statSync(alpha.skillMdPath).isFile());
});

test('listSkillDirs 命中即止：SKILL.md 所在目录不再往下找嵌套的 SKILL', () => {
  const dir = tmpDir('cc-skill-market-nest-');
  try {
    writeSkill(dir, 'outer');
    writeSkill(path.join(dir, 'outer'), 'inner'); // outer/SKILL.md 与 outer/inner/SKILL.md
    const found = listSkillDirs(dir);
    assert.deepEqual(
      found.map((s) => s.name),
      ['outer']
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------ 取回来源的校验 --------------------------------
test('inspectSource 只接受 http(s) 的压缩包地址（不让 net.fetch 去碰 file://）', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://x/y.zip', 'javascript:alert(1)', '']) {
    await assert.rejects(() => inspectSource({ kind: 'zip', url }), /只支持 http\(s\)/, url);
  }
});

test('inspectSource 拒绝认不出的来源', async () => {
  await assert.rejects(() => inspectSource({ kind: 'nope' }), /无法识别的来源/);
  await assert.rejects(() => inspectSource(null), /无法识别的来源/);
});
