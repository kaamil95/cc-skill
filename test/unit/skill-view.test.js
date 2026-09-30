// renderer/skill-view.js —— 「这个 Agent 是实体还是链接」的判定。
// 和 theme.js 一样是浏览器脚本，用最小 window 桩跑起来即可，不需要 DOM。
//
// 为什么值得测：界面上每张卡片是「一份实体 + 指向它的若干链接」折叠出来的，
// 所以这个判定得从 agentIds / links 的关系里推。推错了界面不会报错，
// 只会把链接标成实体 —— 而这正是它要解决的问题本身。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'skill-view.js'), 'utf8');

function load() {
  const win = {};
  new Function('window', SRC)(win);
  return win.skillView;
}

const { linkOnlyAgentIds, linkRole, viewedEntry } = load();

// ------------------------------ 卡片该打哪种标记 ------------------------------
test('linkRole 区分 失效链接 / 链接 / 本体 / 普通副本', () => {
  assert.equal(linkRole({}), 'copy');
  assert.equal(linkRole({ linked: true, linkTarget: '/x' }), 'link');
  assert.equal(linkRole({ linkCount: 2 }), 'canon');
  assert.equal(linkRole({ linked: true, dangling: true }), 'dangling');
});

test('linkRole 优先级：失效 > 链接 > 本体', () => {
  // 失效链接同时也是链接；一个既有链接又统计到 linkCount 的条目（扫描竞态）也按链接算
  assert.equal(linkRole({ dangling: true, linked: true, linkCount: 3 }), 'dangling');
  assert.equal(linkRole({ linked: true, linkCount: 3 }), 'link');
});

// ------------------------------ 哪个 Agent 是链接 ------------------------------
test('普通副本：所有 Agent 都是实体', () => {
  const ids = linkOnlyAgentIds({ agentIds: ['codex', 'claude'], links: [] });
  assert.deepEqual([...ids], []);
});

test('本体 + 别处的链接：只有链接那头的 Agent 算链接', () => {
  const s = {
    agentIds: ['codex', 'zcode'], // 实体在共享目录里，这两个 Agent 都读得到
    linkCount: 1,
    links: [{ agentIds: ['claude'] }], // Claude Code 那边是链过来的
  };
  assert.deepEqual([...linkOnlyAgentIds(s)], ['claude']);
  assert.equal(linkRole(s), 'canon');
});

test('同一个 Agent 既有实体又有链接时以实体为准（文件确实在那儿）', () => {
  // ~/.claude/skills 放了实体，~/.agents/skills 又链了一份，两个目录都算 Claude Code
  const s = { agentIds: ['claude'], links: [{ agentIds: ['claude', 'codex'] }] };
  assert.deepEqual([...linkOnlyAgentIds(s)], ['codex']);
});

test('自身就是链接时，它名下的 Agent 全是链接（唯一副本不在扫描范围内）', () => {
  const s = { linked: true, linkTarget: '/elsewhere/x', agentIds: ['claude'], links: [] };
  assert.deepEqual([...linkOnlyAgentIds(s)], ['claude']);
  assert.equal(linkRole(s), 'link');
});

test('links / agentIds 缺省时不抛错', () => {
  assert.deepEqual([...linkOnlyAgentIds({})], []);
  assert.deepEqual([...linkOnlyAgentIds({ agentIds: ['claude'] })], []);
  assert.deepEqual([...linkOnlyAgentIds({ linked: true, links: [{}] })], []);
});

// ------------------------------ 当前视图代表哪一条 ------------------------------
// 真机踩过：实体在 ~/.agents/skills（Codex/ZCode 共用），~/.claude/skills 里是链接。
// 在「Claude Code 的 SKILL」视图里卡片却打着「本体」徽章 —— 用户看到的列表标题是
// 「Claude Code 的 SKILL」，那卡片就该说 Claude Code 目录里是什么。
const canon = {
  key: 'C:/u/.agents/skills/x',
  absPath: 'C:/u/.agents/skills/x',
  agentIds: ['codex', 'zcode'],
  linkCount: 1,
  links: [{ absPath: 'C:/u/.claude/skills/x', linked: true, linkTarget: 'C:/u/.agents/skills/x', agentIds: ['claude'] }],
};

test('筛到「名下是链接」的那个 Agent 时，卡片代表那条链接', () => {
  const seen = viewedEntry(canon, 'claude');
  assert.equal(seen.absPath, 'C:/u/.claude/skills/x');
  assert.equal(linkRole(seen), 'link', '这时该打「链接」而不是「本体」');
});

test('筛到「名下是实体」的 Agent 时，卡片仍代表实体', () => {
  for (const f of ['codex', 'zcode']) {
    const seen = viewedEntry(canon, f);
    assert.equal(seen.absPath, 'C:/u/.agents/skills/x');
    assert.equal(linkRole(seen), 'canon');
  }
});

test('没有 Agent 上下文的视图（总览 / 项目 / 空筛选）呈现实体记录', () => {
  for (const f of ['dashboard', 'project:p1', '', null, undefined]) {
    assert.equal(viewedEntry(canon, f), canon, String(f));
  }
});

test('同一个 Agent 名下既有实体又有链接时，实体优先', () => {
  const both = { absPath: '/a', agentIds: ['claude'], linkCount: 1, links: [{ absPath: '/b', linked: true, agentIds: ['claude'] }] };
  assert.equal(viewedEntry(both, 'claude'), both, '文件确实在实体那格');
});

test('筛到的 Agent 两边都没有时兜底返回实体（不该发生，但不能返回 undefined）', () => {
  assert.equal(viewedEntry(canon, 'zcode-not-here'), canon);
  assert.equal(viewedEntry({ absPath: '/a', agentIds: [] }, 'claude').absPath, '/a');
});
