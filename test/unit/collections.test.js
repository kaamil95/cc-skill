// renderer/collections.js —— 分组成员解析。这是「分组视图显示哪些卡」的唯一真相源，
// 推错了界面不会报错，只会静默少卡或收错卡 —— 所以两级匹配（精确 + 名称回填）
// 和「歧义宁缺勿滥」都要有测试盯住。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'collections.js'), 'utf8');

function load() {
  const win = {};
  new Function('window', SRC)(win);
  return win.skillCollections;
}

const { normPath, entryDirs, itemMatches, resolveCollection, membershipsFor, suggestPrefixes, inScopeFor, collectionsInScope, canonCardsInScope } = load();

// 测试里的 ~ 展开桩：行为与渲染层一致（字符串拼接）
const expand = (p) => (String(p || '').startsWith('~') ? '/home/u' + p.slice(1) : p);

// 构造视图卡：本体 key = 目录/文件夹；链接卡只贡献 parentDir
const canon = (dir, folder, extra = {}) => ({
  key: (dir + '/' + folder).toLowerCase(),
  absPath: (dir + '/' + folder).toLowerCase(),
  folder,
  // 前缀检测读 name（SKILL.md 里的名字）；测试里与 folder 同名足够代表「名字以 folder 开头」的常态
  name: folder,
  parentDir: dir,
  linked: false,
  links: [],
  ...extra,
});

// ------------------------------ 基础工具 ------------------------------
test('normPath 统一分隔符与大小写', () => {
  assert.equal(normPath('C:\\A\\B\\'), normPath('C:/a/b/'));
  assert.equal(normPath('C:\\A\\B\\'), 'c:/a/b');
  assert.equal(normPath(''), '');
});

test('entryDirs = 本体目录 + 各链接目录；纯链接卡只记自己的目录', () => {
  const s = canon('C:\\skills\\a', 'doc');
  s.links = [{ parentDir: 'D:\\zcode\\skills', linked: true }];
  const dirs = [...entryDirs(s)];
  assert.equal(dirs.length, 2);
  assert.ok(dirs.includes(normPath('C:/skills/a')));
  assert.ok(dirs.includes(normPath('D:/zcode/skills')));
  // 本体未被扫描到的纯链接卡：自己是分组里唯一能定位的落点
  const link = { linked: true, parentDir: 'D:\\proj\\.claude\\skills' };
  assert.deepEqual([...entryDirs(link)], [normPath('D:/proj/.claude/skills')]);
});

// ------------------------------ 一级：精确匹配 ------------------------------
test('dir(~形式) + folder 精确命中本体', () => {
  // expand 桩把 ~/ 展开成 /home/u/…，卡片的 parentDir 就用展开后的形式
  const view = [canon('/home/u/.zcode/skills', 'wecomcli-doc')];
  assert.equal(itemMatches({ dir: '~/.zcode/skills', folder: 'wecomcli-doc' }, view[0], expand), true);
  assert.equal(itemMatches({ dir: '~/.zcode/skills', folder: 'wecomcli-doc' }, canon('/home/u/.zcode/skills', 'other'), expand), false);
});

test('精确匹配也认链接目录：入口建在别的 Agent 目录里照样命中', () => {
  const s = canon('C:\\skills\\a', 'wecomcli-doc');
  s.links = [{ parentDir: 'C:\\Users\\u\\.claude\\skills', linked: true }];
  assert.equal(itemMatches({ dir: 'C:/Users/u/.claude/skills', folder: 'wecomcli-doc' }, s, expand), true);
});

// ------------------------------ 二级：名称回填 ------------------------------
test('精确失配时按 folder 名唯一命中才回填', () => {
  const view = [canon('C:\\new-machine\\skills', 'wecomcli-doc')];
  const { cards, dangling } = resolveCollection(view, [{ dir: '~/.zcode/skills', folder: 'wecomcli-doc' }], expand);
  assert.equal(cards.size, 1);
  assert.equal(dangling.length, 0);
});

test('同名卡片两个以上时宁缺勿滥：不回填、计入 dangling', () => {
  const view = [canon('C:\\p1\\skills', 'deploy'), canon('C:\\p2\\skills', 'deploy')];
  const { cards, dangling } = resolveCollection(view, [{ dir: '~/.old/skills', folder: 'deploy' }], expand);
  assert.equal(cards.size, 0);
  assert.equal(dangling.length, 1);
});

test('彻底失配也计入 dangling（界面不显示，下次保存自愈）', () => {
  const view = [canon('C:\\skills', 'doc')];
  const { dangling } = resolveCollection(view, [{ dir: '~/.zcode/skills', folder: 'gone' }], expand);
  assert.equal(dangling.length, 1);
});

test('链接卡不参与解析：本体命中即可，链接跟着本体走', () => {
  const canonCard = canon('C:\\skills', 'doc');
  const linkCard = { key: 'x', linked: true, folder: 'doc', parentDir: 'D:\\other' };
  const { cards } = resolveCollection([canonCard, linkCard], [{ dir: 'C:/skills', folder: 'doc' }], expand);
  assert.ok(cards.has(canonCard.key));
  assert.ok(!cards.has(linkCard.key));
});

// ------------------------------ 汇总 ------------------------------
test('membershipsFor 一次算完全部分组归属', () => {
  const view = [canon('C:\\skills', 'doc'), canon('C:\\skills', 'mail')];
  const cols = [
    { id: 'c1', name: '企微', items: [{ dir: 'C:/skills', folder: 'doc' }] },
    {
      id: 'c2',
      name: '工作',
      items: [
        { dir: 'C:/skills', folder: 'doc' },
        { dir: 'C:/skills', folder: 'mail' },
      ],
    },
  ];
  const map = membershipsFor(view, cols, expand);
  assert.deepEqual(
    [...(map.get(view[0].key) || [])],
    [
      { id: 'c1', name: '企微' },
      { id: 'c2', name: '工作' },
    ]
  );
  assert.deepEqual([...(map.get(view[1].key) || [])], [{ id: 'c2', name: '工作' }]);
  assert.equal(map.get('nope'), undefined);
});

test('membershipsFor 对空分组列表返回空表', () => {
  assert.equal(membershipsFor([], [], expand).size, 0);
});

test('membershipsFor 传播到链接卡：项目视图的链接条目也能拿到归属', () => {
  const canonCard = canon('C:\\skills', 'doc');
  canonCard.links = [{ key: 'link-1', linked: true, folder: 'doc', parentDir: 'D:\\proj\\.claude\\skills' }];
  const cols = [{ id: 'c1', name: '企微', items: [{ dir: 'C:/skills', folder: 'doc' }] }];
  const map = membershipsFor([canonCard], cols, expand);
  assert.deepEqual(map.get('link-1'), [{ id: 'c1', name: '企微' }]);
});

// ------------------------------ 前缀建议 ------------------------------
test('suggestPrefixes：≥3 个同前缀才成候选，链接卡不参与', () => {
  const view = [
    canon('C:\\s', 'wecomcli-doc'),
    canon('C:\\s', 'wecomcli-mail'),
    canon('C:\\s', 'wecomcli-cal'),
    canon('C:\\s', 'deploy'),
    { linked: true, folder: 'wecomcli-extra', parentDir: 'D:\\x' },
  ];
  const out = suggestPrefixes(view);
  assert.deepEqual(out, [{ prefix: 'wecomcli-', count: 3 }]);
});

test('前缀太短（<3 字符）不算候选', () => {
  const view = [canon('C:\\s', 'ab-1'), canon('C:\\s', 'ab-2'), canon('C:\\s', 'ab-3')];
  assert.deepEqual(suggestPrefixes(view), []);
});

test('按出现次数降序排列', () => {
  const view = [
    canon('C:\\s', 'alpha-1'),
    canon('C:\\s', 'alpha-2'),
    canon('C:\\s', 'alpha-3'),
    canon('C:\\s', 'alpha-4'),
    canon('C:\\s', 'beta-1'),
    canon('C:\\s', 'beta-2'),
    canon('C:\\s', 'beta-3'),
  ];
  assert.deepEqual(
    suggestPrefixes(view).map((p) => p.prefix),
    ['alpha-', 'beta-']
  );
});

// ------------------------------ 三级：纯链接卡 ------------------------------
test('本体不在扫描范围内的纯链接卡也能入组（按链接自身目录精确命中）', () => {
  const linkCard = { key: 'link-key', linked: true, folder: 'wecomcli-doc', parentDir: 'D:\\proj\\.claude\\skills' };
  const { cards, dangling } = resolveCollection([linkCard], [{ dir: 'D:/proj/.claude/skills', folder: 'wecomcli-doc' }], expand);
  assert.deepEqual([...cards], ['link-key']);
  assert.equal(dangling.length, 0);
});

test('精确的链接匹配优先于按名称回填的启发式', () => {
  const canonCard = canon('C:\\elsewhere\\skills', 'deploy'); // 同名但在别的目录
  const linkCard = { key: 'link-key', linked: true, folder: 'deploy', parentDir: 'D:\\proj\\.claude\\skills' };
  const { cards } = resolveCollection([canonCard, linkCard], [{ dir: 'D:/proj/.claude/skills', folder: 'deploy' }], expand);
  assert.deepEqual([...cards], ['link-key']);
});

test('suggestPrefixes 同时看 folder：名称不含前缀但 folder 成族的也能检出', () => {
  const view = [
    canon('C:\s', 'wecomcli-doc', { name: '企业微信文档' }),
    canon('C:\s', 'wecomcli-mail', { name: '企业微信邮件' }),
    canon('C:\s', 'wecomcli-cal', { name: '企业微信日程' }),
  ];
  assert.deepEqual(suggestPrefixes(view), [{ prefix: 'wecomcli-', count: 3 }]);
});

// ------------------------------ 作用域 ------------------------------
test('inScopeFor：项目视图只认本项目成员，全局视图排除项目卡，总览/市场为 null', () => {
  const proj = inScopeFor('project:p1');
  assert.equal(proj({ project: { id: 'p1' } }), true);
  assert.equal(proj({ project: { id: 'p2' } }), false);
  assert.equal(proj({}), false);
  const agent = inScopeFor('claude-code');
  assert.equal(agent({ allAgentIds: ['claude-code'] }), true);
  assert.equal(agent({ allAgentIds: ['codex'] }), false);
  assert.equal(agent({ project: { id: 'p1' }, allAgentIds: ['claude-code'] }), false, '全局视图排除项目卡');
  assert.equal(inScopeFor('dashboard'), null);
  assert.equal(inScopeFor('market'), null);
});

test('collectionsInScope：旧数据无 scope 按 global；项目视图只见本项目组', () => {
  const cols = [
    { id: 'g1', name: 'G', items: [] },
    { id: 'p1', name: 'P1', scope: 'project:p1', items: [] },
    { id: 'p2', name: 'P2', scope: 'project:p2', items: [] },
  ];
  assert.deepEqual(
    collectionsInScope(cols, 'claude-code').map((c) => c.id),
    ['g1']
  );
  assert.deepEqual(
    collectionsInScope(cols, 'project:p1').map((c) => c.id),
    ['p1']
  );
});

test('canonCardsInScope：链接解析回本体并去重，作用域外的卡不计入', () => {
  const a = canon('C:/s', 'doc', { allAgentIds: ['cc'] });
  const link = { key: 'lk', linked: true, linkTarget: a.absPath, folder: 'doc', parentDir: 'C:/p/.claude/skills', allAgentIds: ['cc'] };
  const out = canonCardsInScope([a, link], 'cc');
  assert.deepEqual(
    out.map((s) => s.key),
    [a.key],
    '两条入口只算一个本体'
  );
  assert.deepEqual(canonCardsInScope([a], 'project:p1'), [], '项目视图不把全局卡算进来');
  assert.deepEqual(canonCardsInScope([a], 'dashboard'), []);
});
