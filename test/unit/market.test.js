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

// ------------------------------ 内置市场适配器 --------------------------------
// 适配器是纯映射：给什么 JSON 出什么条目。fetch 层注入假实现，全程离线。
const { setFetchImpl } = require('../../src/net');
const { listBuiltinMarkets, searchBuiltin, searchSkillhub } = require('../../src/market');

const jsonRes = (data) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => data });

test('内置市场注册表：两个站都登记在案', () => {
  assert.deepEqual(
    listBuiltinMarkets().map((m) => m.id),
    ['skills-sh', 'skillsmp']
  );
});

test('searchBuiltin(skills-sh)：source 拆成 GitHub 来源，installs 进 meta，拆不出的丢弃', async () => {
  const seen = [];
  setFetchImpl(async (url) => {
    seen.push(url);
    return jsonRes({
      skills: [
        { id: 'mattpocock/skills/setup-pre-commit', source: 'mattpocock/skills', skillId: 'setup-pre-commit', name: 'setup-pre-commit', installs: 407450 },
        { source: 'not-a-repo', name: 'junk' },
        { source: 'o/r' },
      ],
    });
  });
  const r = await searchBuiltin('skills-sh', 'commit');
  assert.ok(seen[0].includes('skills.sh/api/search?q=commit'));
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 2, '拆不出 owner/repo 的条目丢弃');
  assert.deepEqual(r.items[0].source, { kind: 'github', owner: 'mattpocock', repo: 'skills', ref: '', path: '' });
  assert.equal(r.items[0].meta.installs, 407450);
  assert.equal(r.items[0].meta.skillId, 'setup-pre-commit');
  assert.equal(r.items[1].name, 'r', '没名字的条目用仓库名兜底');
  await assert.rejects(() => searchBuiltin('nope', 'x'), /未知的内置市场/);
});

test('searchAll：skills.sh 整表只取一次，按页切片（少量多次），缓存命中不再发请求', async () => {
  const { searchAll } = require('../../src/market');
  let calls = 0;
  setFetchImpl(async (url) => {
    if (String(url).includes('skills.sh')) {
      calls++;
      // 45 条：够切出两整页（20/20）再剩 5 条，正好验完切片边界
      const skills = Array.from({ length: 45 }, (_, i) => ({ source: `o/r${i}`, skillId: `s${i}`, name: `s${i}`, installs: i }));
      return jsonRes({ skills });
    }
    return jsonRes({ skills: [] }); // 其余来源给空表，专注验 skills.sh 的切片
  });
  try {
    const p1 = await searchAll('cache-slice-test', { token: '', indexUrl: '' });
    assert.equal(calls, 1, '首次检索恰好发一次请求');
    assert.equal(p1.sources.find((s) => s.id === 'skills-sh').count, 20, '第一页只给 20 条');
    assert.equal(p1.items[0].installs, 19, '聚合排序按装机量降序');

    const p2 = await searchAll('cache-slice-test', { token: '', indexUrl: '', page: 2 });
    assert.equal(calls, 1, '翻页命中缓存，不再打站方接口');
    assert.equal(p2.sources.find((s) => s.id === 'skills-sh').count, 20, '第二页是下一条 20');

    const p3 = await searchAll('cache-slice-test', { token: '', indexUrl: '', page: 3 });
    assert.equal(calls, 1);
    assert.equal(p3.sources.find((s) => s.id === 'skills-sh').count, 5, '末页只剩零头');
  } finally {
    setFetchImpl(null);
  }
});

test('searchBuiltin(skillsmp)：githubUrl 拆成 owner/repo/ref/path，stars/author 进 meta', async () => {
  const seen = [];
  setFetchImpl(async (url) => {
    seen.push(url);
    return jsonRes({
      success: true,
      data: {
        skills: [
          {
            name: 'claw-score',
            author: 'openclaw',
            description: '审计 SKILL',
            githubUrl: 'https://github.com/openclaw/openclaw/tree/main/.agents/skills/claw-score',
            stars: 390629,
          },
        ],
      },
    });
  });
  const r = await searchBuiltin('skillsmp', 'claw');
  assert.ok(seen[0].includes('skillsmp.com/api/v1/skills/search'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.items[0].source, { kind: 'github', owner: 'openclaw', repo: 'openclaw', ref: 'main', path: '.agents/skills/claw-score' });
  assert.equal(r.items[0].meta.stars, 390629);
  assert.equal(r.items[0].meta.author, 'openclaw');
});

test('searchSkillhub：目录接口映射出完整条目（描述/星标/分类/路径），hash 链接也认', async () => {
  const seen = [];
  setFetchImpl(async (url) => {
    seen.push(String(url));
    if (String(url).includes('skillhub.club/api/v1/desktop/catalog')) {
      return jsonRes({
        skills: [
          {
            name: 'hub-skill',
            author: 'hu',
            description: '目录自带描述',
            repo_url: 'https://github.com/hu/repo/tree/main/skills/hub-skill',
            github_stars: 42,
            category: 'testing',
            tags: ['t1'],
          },
          { name: 'hash-skill', author: 'hu', description: 'd2', repo_url: 'https://github.com/hu/repo2#skills~hash-skill', github_stars: 1 },
          { name: 'nopath', author: 'hu', repo_url: 'not-a-github-url' },
        ],
      });
    }
    throw new Error('unexpected url: ' + url);
  });
  const r = await searchSkillhub('');
  assert.ok(seen[0].includes('skillhub.club/api/v1/desktop/catalog'));
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items[0].source, { kind: 'github', owner: 'hu', repo: 'repo', ref: 'main', path: 'skills/hub-skill' });
  assert.equal(r.items[0].description, '目录自带描述');
  assert.equal(r.items[0].meta.stars, 42);
  assert.equal(r.items[0].meta.skillId, 'hub-skill');
  assert.equal(r.items[0].meta.category, 'testing');
  // #skills~x → skills/x（与 skillhub-desktop 的解析一致）
  assert.deepEqual(r.items[1].source, { kind: 'github', owner: 'hu', repo: 'repo2', ref: '', path: 'skills/hash-skill' });
});

test('parseSkillhubRepoUrl：#skills-xxx 单段 hash 也归到 skills/ 目录', () => {
  const { parseSkillhubRepoUrl } = require('../../src/market');
  assert.deepEqual(parseSkillhubRepoUrl('https://github.com/o/r#skills-commit'), { owner: 'o', repo: 'r', ref: '', path: 'skills/commit' });
  assert.deepEqual(parseSkillhubRepoUrl('https://github.com/o/r/tree/main/a/b'), { owner: 'o', repo: 'r', ref: 'main', path: 'a/b' });
  assert.equal(parseSkillhubRepoUrl('https://example.com/x'), null);
});

// ------------------------------ SKILL 定位与取回 ------------------------------
// 定位走仓库树（一次请求拿到全仓路径），取回走 raw 单文件下载。注入假 fetch 离线跑。
const { findSkillDir, repoTree, resolveEntry, skillDetail, fetchSkillFiles, ownerAvatar, readRawBytes } = require('../../src/market');

const treeRes = (paths) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ tree: paths.map((p) => ({ path: p, type: 'blob' })) }),
});
const mdRes = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body, arrayBuffer: async () => Buffer.from(body) });
// 多行 SKILL.md 用数组拼：字面量里塞 \n 既难读，也容易被工具链吃掉转义
const mdFile = (...lines) => lines.join('\n');
const missRes = () => ({ ok: false, status: 404, statusText: 'Not Found', headers: { get: () => null } });

test('findSkillDir：目录名与 skillId 同名，层级最浅的优先；根 SKILL.md 只在仓库同名时命中', () => {
  const paths = ['skills/engineering/tdd/SKILL.md', 'a/b/c/tdd/SKILL.md', 'skills/other/SKILL.md', 'README.md'];
  assert.equal(findSkillDir(paths, 'tdd', 'repo'), 'skills/engineering/tdd');
  assert.equal(findSkillDir(paths, 'other', 'repo'), 'skills/other');
  assert.equal(findSkillDir(paths, 'nope', 'repo'), null);
  assert.equal(findSkillDir(['SKILL.md', 'x.md'], 'repo', 'repo'), '', '仓库同名 → 根目录');
  assert.equal(findSkillDir(['SKILL.md'], 'other', 'repo'), null, '不同名时根 SKILL.md 不吸附');
  assert.equal(findSkillDir(paths, '', 'repo'), null);
});

test('repoTree：优先 GitHub 官方树接口（与仓库当前状态一致），同一仓库只拉一次', async () => {
  const seen = [];
  setFetchImpl(async (url) => {
    seen.push(String(url));
    assert.ok(String(url).includes('api.github.com'), '先走官方接口：' + url);
    return treeRes(['skills/alpha/SKILL.md', 'skills/alpha/ref.md']);
  });
  const a = await repoTree('uniq-tree', 'repo');
  const b = await repoTree('uniq-tree', 'repo');
  assert.deepEqual(a, ['skills/alpha/SKILL.md', 'skills/alpha/ref.md']);
  assert.deepEqual(b, a);
  assert.equal(seen.length, 1, '第二次走缓存');
});

test('repoTree：官方接口限流（429）时退到 jsDelivr 清单，并把限流记下来', async () => {
  const seen = [];
  setFetchImpl(async (url) => {
    seen.push(String(url));
    if (String(url).includes('api.github.com')) return { ok: false, status: 429, statusText: 'rate limited', headers: { get: () => null } };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ files: [{ name: '/skills/beta/SKILL.md' }] }) };
  });
  const paths = await repoTree('uniq-fallback', 'repo', { token: 'ghp_x' });
  assert.deepEqual(paths, ['skills/beta/SKILL.md']);
  assert.ok(
    seen.some((u) => u.includes('data.jsdelivr.com')),
    '退到了 jsDelivr 清单'
  );
});

test('readRawBytes：四源竞速，contents 赢家记忆，第二次直取首选', async () => {
  const seen = [];
  require('../../src/market').resetSourceHealth();
  setFetchImpl(async (url) => {
    seen.push(String(url));
    if (String(url).includes('/contents/')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ encoding: 'base64', content: Buffer.from('hi 内容').toString('base64') }),
      };
    }
    return missRes();
  });
  const buf = await readRawBytes('uniq-bytes', 'repo', 'skills/x/SKILL.md');
  assert.equal(buf.toString('utf8'), 'hi 内容');
  assert.ok(
    seen.some((u) => u.includes('/repos/uniq-bytes/repo/contents/skills/x/SKILL.md')),
    'contents 参与竞速'
  );
  const n1 = seen.length;
  await readRawBytes('uniq-bytes', 'repo', 'skills/x/SKILL.md');
  assert.equal(seen.length, n1 + 1, '第二次直取首选源，只发一个请求');
  assert.ok(seen.at(-1).includes('/contents/'), '首选源就是上一轮的赢家 contents');
});

test('readRawBytes：官方源全挂时自动锁进能通的代理源（零配置）', async () => {
  const seen = [];
  require('../../src/market').resetSourceHealth();
  setFetchImpl(async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('ghproxy.net')) return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('via-ghproxy') };
    // 模拟被墙：连接级失败（非 HTTP 4xx/5xx），会触发熔断
    throw new Error('fetch failed');
  });
  const buf = await readRawBytes('uniq-cn', 'repo', 'skills/x/SKILL.md');
  assert.equal(buf.toString('utf8'), 'via-ghproxy');
  const ghproxyCount = seen.filter((u) => u.includes('ghproxy.net')).length;
  await readRawBytes('uniq-cn', 'repo', 'skills/y/SKILL.md');
  const after = seen.filter((u) => u.includes('ghproxy.net')).length;
  assert.equal(after, ghproxyCount + 1, '第二次只发 ghproxy 一个请求，不再陪跑被墙的源');
});

test('resolveEntry：靠仓库树定位目录，再读 SKILL.md 取 frontmatter 描述', async () => {
  setFetchImpl(async (url) => {
    if (url.includes('/git/trees/')) return treeRes(['skills/eng/myskill/SKILL.md']);
    if (url.endsWith('/HEAD/skills/eng/myskill/SKILL.md')) return mdRes(mdFile('---', 'description: 一句话说明', '---', '# 正文'));
    return missRes();
  });
  const r = await resolveEntry({ name: 'myskill', source: { kind: 'github', owner: 'uniq-resolve', repo: 'repo' }, meta: { skillId: 'myskill' } });
  assert.equal(r.description, '一句话说明');
  assert.equal(r.path, 'skills/eng/myskill');
});

test('resolveEntry：条目自带 path 时不再拉仓库树，直接读那个目录', async () => {
  const seen = [];
  setFetchImpl(async (url) => {
    seen.push(url);
    if (url.endsWith('/HEAD/known/dir/SKILL.md')) return mdRes(mdFile('# 只有正文', '', '第一段就是描述。'));
    return missRes();
  });
  const r = await resolveEntry({ name: 'x', source: { kind: 'github', owner: 'uniq-known', repo: 'repo', path: 'known/dir' } });
  assert.equal(r.path, 'known/dir');
  assert.equal(r.description, '第一段就是描述。');
  assert.ok(!seen.some((u) => u.includes('/git/trees/')), '自带路径就不该再拉树');
});

test('resolveEntry：树拉不到（限流）时描述留空，且不写缓存', async () => {
  let calls = 0;
  setFetchImpl(async () => {
    calls++;
    return { ok: false, status: 403, statusText: 'rate limited', headers: { get: () => null } };
  });
  const item = { name: 'x', source: { kind: 'github', owner: 'uniq-403', repo: 'repo' } };
  assert.deepEqual(await resolveEntry(item), { description: '', path: null });
  await resolveEntry(item);
  assert.ok(calls > 1, '没写缓存 → 下次还会重试');
});

test('skillDetail：返回描述、SKILL.md 正文与目录下的文件清单', async () => {
  setFetchImpl(async (url) => {
    if (url.includes('/git/trees/')) return treeRes(['skills/det/SKILL.md', 'skills/det/ref/a.md', 'skills/other/SKILL.md']);
    if (url.endsWith('/HEAD/skills/det/SKILL.md')) return mdRes(mdFile('---', 'name: det', 'description: 详情', '---', '正文内容'));
    return missRes();
  });
  const r = await skillDetail({ owner: 'uniq-detail', repo: 'repo', skillId: 'det' });
  assert.equal(r.ok, true);
  assert.equal(r.path, 'skills/det');
  assert.equal(r.description, '详情');
  assert.equal(r.body, '正文内容');
  assert.deepEqual(r.files, ['skills/det/SKILL.md', 'skills/det/ref/a.md']);
  await assert.rejects(() => skillDetail({ owner: 'uniq-detail', repo: 'repo', skillId: 'missing' }), /没有找到/);
});

test('fetchSkillFiles：只下这一个目录的文件，落到临时目录', async () => {
  const root = tmpDir('cc-skill-fetchtest-');
  setFetchImpl(async (url) => {
    if (url.includes('/git/trees/')) return treeRes(['skills/one/SKILL.md', 'skills/one/sub/x.md', 'skills/two/SKILL.md']);
    if (url.endsWith('/HEAD/skills/one/SKILL.md')) return mdRes('body-1');
    if (url.endsWith('/HEAD/skills/one/sub/x.md')) return mdRes('body-2');
    return missRes();
  });
  const r = await fetchSkillFiles({ owner: 'uniq-fetch', repo: 'repo', path: 'skills/one' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.sort(), ['SKILL.md', 'sub/x.md']);
  assert.equal(fs.readFileSync(path.join(r.dir, 'SKILL.md'), 'utf8'), 'body-1');
  assert.equal(fs.readFileSync(path.join(r.dir, 'sub', 'x.md'), 'utf8'), 'body-2');
  fs.rmSync(r.dir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('fetchSkillFiles：文件过多时明确报错（由渲染层退回整仓流程）', async () => {
  const many = Array.from({ length: 90 }, (_, i) => `skills/big/f${i}.md`);
  setFetchImpl(async (url) => (url.includes('/git/trees/') ? treeRes(many) : missRes()));
  await assert.rejects(() => fetchSkillFiles({ owner: 'uniq-big', repo: 'repo', path: 'skills/big' }), /文件太多/);
});

test('ownerAvatar：取回后转成 data URL，第二次走缓存', async () => {
  let calls = 0;
  setFetchImpl(async () => {
    calls++;
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => Buffer.from([1, 2, 3]) };
  });
  const a = await ownerAvatar({ owner: 'uniq-avatar' });
  assert.equal(a.ok, true);
  assert.ok(a.dataUrl.startsWith('data:image/png;base64,'));
  await ownerAvatar({ owner: 'uniq-avatar' });
  assert.equal(calls, 1, '第二次命中缓存');
});
