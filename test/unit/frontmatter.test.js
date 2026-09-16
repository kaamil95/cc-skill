// SKILL.md frontmatter 解析——纯函数，直接 import
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseFrontmatter, firstParagraph, skillTemplate } = require('../../src/skills');

test('解析基本的 name / description，并切出正文', () => {
  const r = parseFrontmatter('---\nname: my-skill\ndescription: 一句话说明\n---\n\n# 标题\n\n正文。\n');
  assert.equal(r.meta.name, 'my-skill');
  assert.equal(r.meta.description, '一句话说明');
  assert.equal(r.body, '# 标题\n\n正文。\n', 'frontmatter 与正文之间的空行应被全部吃掉');
  assert.ok(!r.body.includes('name:'), '正文里不该再带上 frontmatter');
});

test('没有 frontmatter 时原样当正文，meta 为 null', () => {
  const r = parseFrontmatter('# 只有正文\n');
  assert.equal(r.meta.name, null);
  assert.equal(r.meta.description, null);
  assert.equal(r.body, '# 只有正文\n');
});

test('空值字段返回 null（而不是空字符串）', () => {
  const r = parseFrontmatter('---\nname:\ndescription:\n---\n');
  assert.equal(r.meta.name, null);
  assert.equal(r.meta.description, null);
});

test('跨行的 description 折叠成一行', () => {
  const r = parseFrontmatter('---\nname: x\ndescription: 第一段\n  第二段\n---\n');
  assert.equal(r.meta.description, '第一段 第二段');
});

test('跨行的值在遇到下一个 key 时收住', () => {
  const r = parseFrontmatter('---\ndescription: 第一段\n  第二段\nname: x\n---\n');
  assert.equal(r.meta.description, '第一段 第二段');
  assert.equal(r.meta.name, 'x');
});

test('值后面有空行也不会把空行吃进描述', () => {
  const r = parseFrontmatter('---\ndescription: hello\n\nname: x\n---\n');
  assert.equal(r.meta.description, 'hello');
  assert.equal(r.meta.name, 'x');
});

test('字段名只在行首匹配，不会把正文里的同名文本吃掉', () => {
  const r = parseFrontmatter('---\nname: real\n---\n\nname: 正文里的假字段\n');
  assert.equal(r.meta.name, 'real');
  assert.match(r.body, /正文里的假字段/);
});

test('去掉包裹的引号，并还原转义', () => {
  assert.equal(parseFrontmatter('---\nname: "带 空格"\n---\n').meta.name, '带 空格');
  assert.equal(parseFrontmatter("---\nname: 'single'\n---\n").meta.name, 'single');
  assert.equal(parseFrontmatter('---\nname: "a\\"b"\n---\n').meta.name, 'a"b');
  assert.equal(parseFrontmatter('---\nname: "a\\\\b"\n---\n').meta.name, 'a\\b');
  // 只有落单的引号时不当作包裹处理
  assert.equal(parseFrontmatter('---\nname: "\n---\n').meta.name, '"');
});

test('firstParagraph 跳过标题 / 分隔线，并截断到 300 字', () => {
  assert.equal(firstParagraph('# 标题\n\n第一段正文。\n\n第二段。'), '第一段正文。');
  assert.equal(firstParagraph(''), '');
  assert.equal(firstParagraph('# 只有标题'), '');
  assert.equal(firstParagraph('x'.repeat(500)).length, 300);
});

test('firstParagraph 整体跳过代码块', () => {
  assert.equal(firstParagraph('---\n```\ncode\n```\n实际段落'), '实际段落');
  assert.equal(firstParagraph('~~~js\nconst a = 1;\n~~~\n说明文字'), '说明文字');
  assert.equal(firstParagraph('```\n只有代码\n```'), '', '整篇都是代码时没有可用的描述');
});

test('skillTemplate 生成的结构能被自己解析回来（含引号与反斜杠）', () => {
  for (const [name, desc] of [
    ['my-skill', '一句话描述'],
    ['a"b', '含 "引号" 的描述'],
    ['a\\b', '含 \\ 反斜杠'],
    ['a\\"b', '两样都有 \\ 和 "'],
  ]) {
    const back = parseFrontmatter(skillTemplate(name, desc));
    assert.equal(back.meta.name, name, `name 往返失败: ${name}`);
    assert.equal(back.meta.description, desc, `description 往返失败: ${desc}`);
  }
  assert.match(parseFrontmatter(skillTemplate('my-skill', 'x')).body, /^# my-skill/);
});
