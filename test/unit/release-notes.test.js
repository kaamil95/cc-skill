// scripts/release-notes.js —— 发版说明从 CHANGELOG 里取，取错了 Release 正文就会挂错版本，
// 所以这一层单独测。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sectionFor } = require('../../scripts/release-notes');

const MD = `# Changelog

## [Unreleased]

### Added
- 还没发的东西

## [0.0.2] - 2026-10-01

### Added
- 新功能 A

### Fixed
- 修了 B

## [0.0.1] - 2026-09-14

第一个版本。

### Added
- 初始功能
`;

test('抽出指定版本那一节的正文，不含标题行', () => {
  const body = sectionFor(MD, '0.0.2');
  assert.match(body, /新功能 A/);
  assert.match(body, /修了 B/);
  assert.ok(!body.includes('0.0.2'), '标题行不该混进正文');
  assert.ok(!body.includes('还没发的东西'), '不该串到 Unreleased');
  assert.ok(!body.includes('初始功能'), '不该串到上一个版本');
});

test('抽最后一个版本时也能收住（后面没有别的标题了）', () => {
  const body = sectionFor(MD, '0.0.1');
  assert.match(body, /初始功能/);
  assert.ok(!body.includes('修了 B'));
});

test('Unreleased 抽得出来，但只有真的写了这个版本号才会用', () => {
  assert.match(sectionFor(MD, 'Unreleased'), /还没发的东西/);
  assert.equal(sectionFor(MD, '0.0.3'), '', '不存在的版本应当返回空串');
});

test('版本号按整段匹配，0.0.1 不会误配到 0.0.10', () => {
  const md = '## [0.0.10] - x\n\n十号\n\n## [0.0.1] - y\n\n一号\n';
  assert.match(sectionFor(md, '0.0.1'), /一号/);
  assert.ok(!sectionFor(md, '0.0.1').includes('十号'));
  assert.match(sectionFor(md, '0.0.10'), /十号/);
});

test('没有方括号的标题也认（`## 0.0.2` 这种写法）', () => {
  assert.match(sectionFor('## 0.0.2\n\n裸标题\n', '0.0.2'), /裸标题/);
});

test('CRLF 的 CHANGELOG 也读得对', () => {
  const crlf = MD.replace(/\n/g, '\r\n');
  assert.match(sectionFor(crlf, '0.0.2'), /新功能 A/);
});
