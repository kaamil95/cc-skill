// 市场全链路：起一个本地 HTTP 服务器当「GitHub」，真下载 zip、真解压、真安装，全程不碰外网。
const http = require('node:http');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startApp } = require('../helpers/harness');
const { tmpDir, makeConfig, writeSkill, zipDir } = require('../helpers/fixtures');

let app;
let root;
let agentDir;
let server;
let base;
let repoZipPath;
let indexPath;

before(async () => {
  root = tmpDir('cc-skill-market-it-');
  agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });

  // 一个普通仓库：skills/ 下两个 SKILL
  const repo = path.join(root, 'repo');
  writeSkill(path.join(repo, 'skills'), 'alpha', { files: { 'references/x.md': '# x\n' } });
  writeSkill(path.join(repo, 'skills'), 'beta');
  fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n', 'utf8');
  const repoZip = path.join(root, 'repo.zip');
  zipDir(repo, repoZip);
  repoZipPath = repoZip;

  // GitHub 下载下来的包会多套一层 <repo>-<ref>/，单独造一个来验证能钻进去
  const wrapped = path.join(root, 'wrapped');
  writeSkill(path.join(wrapped, 'demo-main', 'skills'), 'gamma');
  const wrappedZip = path.join(root, 'wrapped.zip');
  zipDir(wrapped, wrappedZip);

  indexPath = path.join(root, 'index.json');
  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      version: 1,
      name: '测试索引',
      skills: [
        { name: 'alpha', description: '来自索引', url: 'PLACEHOLDER/repo.zip', path: 'skills/alpha' },
        { name: '坏条目' }, // 既没 repo 也没 url，应被跳过并计数
      ],
    }),
    'utf8'
  );

  server = http.createServer((req, res) => {
    if (req.url.startsWith('/repo.zip')) return res.end(fs.readFileSync(repoZip));
    if (req.url.startsWith('/wrapped.zip')) return res.end(fs.readFileSync(wrappedZip));
    if (req.url.startsWith('/index.json')) {
      res.setHeader('content-type', 'application/json');
      return res.end(fs.readFileSync(indexPath, 'utf8').replace(/PLACEHOLDER/g, base));
    }
    if (req.url.startsWith('/not-an-index.json')) {
      res.setHeader('content-type', 'application/json');
      return res.end('{"hello":"world"}');
    }
    res.statusCode = 404;
    res.end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  app = await startApp({ config: makeConfig({ agentDirs: [agentDir] }) });
});
after(() => {
  app.cleanup();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('market:skillDetail / market:fetchSkill：详情与单技能取回走同一套树定位（fetch 注入）', async () => {
  const { setFetchImpl } = require('../../src/net');
  require('../../src/market').resetSourceHealth(); // 前面测试的假 fetch 可能已把 cdn/raw 熔断
  const json = (data) => ({ ok: true, status: 200, statusText: '', headers: { get: () => null }, json: async () => data });
  const text = (body) => ({
    ok: true,
    status: 200,
    statusText: '',
    headers: { get: () => null },
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body),
  });
  setFetchImpl(async (url) => {
    const u = String(url);
    if (u.includes('/git/trees/'))
      return json({
        tree: [
          { path: 'skills/uniq-skill/SKILL.md', type: 'blob' },
          { path: 'skills/uniq-skill/ref.md', type: 'blob' },
        ],
      });
    if (u.endsWith('/HEAD/skills/uniq-skill/SKILL.md')) return text(['---', 'name: uniq-skill', 'description: 集成测试用', '---', '正文'].join('\n'));
    if (u.endsWith('/HEAD/skills/uniq-skill/ref.md')) return text('ref');
    throw new Error('unexpected url: ' + u);
  });
  try {
    const d = await app.invoke('market:skillDetail', { owner: 'uniq-int', repo: 'repo', skillId: 'uniq-skill' });
    assert.equal(d.ok, true, 'skillDetail 失败：' + (d.error || ''));
    assert.equal(d.path, 'skills/uniq-skill');
    assert.equal(d.description, '集成测试用');
    assert.deepEqual(d.files, ['skills/uniq-skill/SKILL.md', 'skills/uniq-skill/ref.md']);

    const f = await app.invoke('market:fetchSkill', { owner: 'uniq-int', repo: 'repo', path: 'skills/uniq-skill' });
    assert.equal(f.ok, true);
    assert.deepEqual(f.files.sort(), ['SKILL.md', 'ref.md']);
    assert.equal(fs.readFileSync(path.join(f.dir, 'SKILL.md'), 'utf8').includes('集成测试用'), true);
    fs.rmSync(f.dir, { recursive: true, force: true });

    const bad = await app.invoke('market:skillDetail', { owner: 'uniq-int', repo: 'repo', skillId: 'nope' });
    assert.equal(bad.ok, false, '找不到目录走统一错误返回');
    assert.match(bad.error, /没有找到|读取 SKILL.md 失败/);
  } finally {
    setFetchImpl(null);
  }
});

test('market:skillDetail 网络差时整仓 zip 兜底：codeload 无配额也能出详情', async () => {
  const { setFetchImpl } = require('../../src/net');
  require('../../src/market').resetSourceHealth();
  const json = (data) => ({ ok: true, status: 200, statusText: '', headers: { get: () => null }, json: async () => data });
  setFetchImpl(async (url) => {
    const u = String(url);
    // raw 链路（contents / cdn / raw）全部不可达，模拟被限流 + raw 被墙的网络
    if (u.includes('api.github.com') || u.includes('jsdelivr') || u.includes('raw.githubusercontent')) {
      if (u.includes('/git/trees/')) return json({ tree: [{ path: 'skills/alpha/SKILL.md', type: 'blob' }] });
      throw new Error('unreachable');
    }
    // codeload（整仓 zip）是好的
    if (u.includes('codeload')) return { ok: true, status: 200, statusText: '', headers: { get: () => null }, body: fs.createReadStream(repoZipPath) };
    throw new Error('unexpected url: ' + u);
  });
  try {
    const d = await app.invoke('market:skillDetail', { owner: 'zipfb', repo: 'repo', skillId: 'alpha' });
    assert.equal(d.ok, true, 'zip 兜底失败：' + (d.error || ''));
    assert.equal(d.path, 'skills/alpha');
    assert.match(d.description, /alpha 的描述/);
    assert.ok(d.files.includes('SKILL.md'));
  } finally {
    setFetchImpl(null);
    require('../../src/market').resetSourceHealth();
  }
});
test('market:inspect 下载 zip 并列出其中所有 SKILL', async () => {
  const r = await app.invoke('market:inspect', { source: { kind: 'zip', url: `${base}/repo.zip` } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.skills.map((s) => s.name).sort(), ['alpha', 'beta']);
  const alpha = r.skills.find((s) => s.name === 'alpha');
  assert.match(alpha.description, /alpha 的描述/);
  // countFiles 统计的是「文件 + 目录」：SKILL.md + references/ + references/x.md
  assert.equal(alpha.fileCount, 3);
  assert.ok(fs.existsSync(path.join(alpha.absPath, 'SKILL.md')));
});

test('market:inspect 能钻进 GitHub 包的 <repo>-<ref>/ 外层目录', async () => {
  const r = await app.invoke('market:inspect', { source: { kind: 'zip', url: `${base}/wrapped.zip` } });
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.skills.map((s) => s.name),
    ['gamma']
  );
  assert.equal(r.skills[0].relPath, 'skills/gamma');
});

test('market:searchAll 聚合自定义索引：zip 条目归一成 kind:zip', async () => {
  const { setFetchImpl } = require('../../src/net');
  setFetchImpl(async (url, opts) => {
    // 本地夹具服务器走真 fetch，其余（skills.sh 等）一律拒绝，离线可重复
    if (String(url).startsWith('http://127.0.0.1')) return fetch(url, opts);
    throw new Error('unexpected');
  });
  try {
    const r = await app.invoke('market:searchAll', { query: 'alpha', indexUrl: `${base}/index.json` });
    assert.equal(r.ok, true);
    const custom = r.sources.find((s) => s.id === 'custom');
    assert.equal(custom.ok, true);
    assert.equal(custom.name, '测试索引');
    const zip = r.items.find((it) => it.kind === 'zip');
    assert.equal(zip.name, 'alpha');
    assert.deepEqual(zip.source, { kind: 'zip', url: `${base}/repo.zip` });
  } finally {
    setFetchImpl(null);
  }
});

test('从 inspect 的结果直接 skill:copy 安装：文件真的落到目标目录', async () => {
  const inspected = await app.invoke('market:inspect', { source: { kind: 'zip', url: `${base}/repo.zip` } });
  const alpha = inspected.skills.find((s) => s.name === 'alpha');
  const copied = await app.invoke('skill:copy', {
    srcPath: alpha.absPath,
    type: 'folder',
    destDir: agentDir,
    folderName: 'alpha',
    onConflict: 'rename',
  });
  assert.equal(copied.ok, true);
  assert.ok(fs.existsSync(path.join(agentDir, 'alpha', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(agentDir, 'alpha', 'references', 'x.md')));

  // 装完再扫一遍，应该能看见它
  const scanned = await app.invoke('scan');
  assert.ok(scanned.skills.some((s) => s.name === 'alpha'));
});

test('下载失败时返回可读错误，而不是抛异常', async () => {
  const r = await app.invoke('market:inspect', { source: { kind: 'zip', url: `${base}/missing.zip` } });
  assert.equal(r.ok, false);
  assert.match(r.error, /404/);
});

test('索引里写的子路径不能越出仓库范围（否则会去扫机器上的任意目录）', async () => {
  const r = await app.invoke('market:inspect', { source: { kind: 'zip', url: `${base}/repo.zip`, path: '../../../../..' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /越出了仓库范围/);
});

test('market:inspect 支持直接给原始链接（解析只在主进程做一处）', async () => {
  const r = await app.invoke('market:inspect', { raw: `${base}/repo.zip` });
  assert.equal(r.ok, true);
  assert.equal(r.skills.length, 2);

  const bad = await app.invoke('market:inspect', { raw: '这不是个链接' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /无法识别的来源/);
});

test('market:inspect 拒绝 file:// 这类本地协议', async () => {
  const r = await app.invoke('market:inspect', { source: { kind: 'zip', url: 'file:///etc/passwd' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /只支持 http\(s\)/);
});

test('market:setConfig 存索引地址与 token（token 只存本机，不进备份）', async () => {
  const r = await app.invoke('market:setConfig', { indexUrl: `${base}/index.json`, token: '  ghp_test  ' });
  assert.equal(r.ok, true);
  assert.equal(r.market.token, 'ghp_test');
  const stored = app.readConfig();
  assert.equal(stored.market.indexUrl, `${base}/index.json`);
  assert.equal(stored.market.token, 'ghp_test');
});

test('索引格式不对：聚合检索里 custom 来源失败但不拖垮整体', async () => {
  const { setFetchImpl } = require('../../src/net');
  setFetchImpl(async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return fetch(url, opts);
    throw new Error('unexpected');
  });
  try {
    const r = await app.invoke('market:searchAll', { query: 'x', indexUrl: `${base}/not-an-index.json` });
    assert.equal(r.ok, true, '单来源失败不拖垮聚合检索');
    const custom = r.sources.find((s) => s.id === 'custom');
    assert.equal(custom.ok, false);
    assert.match(custom.error, /索引格式不对/);
  } finally {
    setFetchImpl(null);
  }
});

test('inspectSource 的 github 分支：拼对 codeload 地址（用假 fetch 替掉真实网络）', async () => {
  const { setFetchImpl } = require('../../src/net');
  const seen = [];
  setFetchImpl(async (url) => {
    seen.push(url);
    return { ok: true, status: 200, statusText: '', headers: { get: () => null }, body: fs.createReadStream(repoZipPath) };
  });
  try {
    const r = await app.invoke('market:inspect', { source: { kind: 'github', owner: 'o', repo: 'r', ref: 'main' } });
    assert.equal(r.ok, true);
    assert.deepEqual(seen, ['https://codeload.github.com/o/r/zip/main']);
    assert.equal(r.skills.length, 2);
  } finally {
    setFetchImpl(null);
  }
});

test('token 只发给 GitHub 域名：索引源是别的域名就不带（聚合检索）', async () => {
  const { setFetchImpl } = require('../../src/net');
  await app.invoke('market:setConfig', { token: 'ghp_secret' });
  const seen = [];
  setFetchImpl(async (url, opts) => {
    seen.push({ url: String(url), auth: (opts && opts.headers && opts.headers.authorization) || '' });
    const json = (data) => ({ ok: true, status: 200, statusText: '', headers: { get: () => null }, json: async () => data });
    if (String(url).includes('evil.test')) return json({ name: '坏索引', skills: [] });
    throw new Error('unexpected url: ' + url);
  });
  try {
    const r = await app.invoke('market:searchAll', { query: 'x', indexUrl: 'https://evil.test/index.json' });
    assert.equal(r.ok, true);
    const custom = r.sources.find((s) => s.id === 'custom');
    assert.equal(custom.ok, true);
    const evil = seen.find((s) => s.url.includes('evil.test'));
    assert.equal(evil.auth, '', '非 GitHub 主机绝不能收到 token');
    await app.invoke('market:inspect', { source: { kind: 'github', owner: 'o', repo: 'r', ref: '' } });
    assert.equal(seen.at(-1).auth, 'Bearer ghp_secret', 'codeload 属于 GitHub，应当带上');
  } finally {
    setFetchImpl(null);
    await app.invoke('market:setConfig', { token: '' });
  }
});

// ------------------------------ 聚合检索 searchAll ----------------------------
test('market:searchAll：四来源并行聚合，SKILL 在前仓库在后，token 只发 GitHub', async () => {
  const { setFetchImpl } = require('../../src/net');
  await app.invoke('market:setConfig', { token: 'ghp_secret' });
  const seen = [];
  setFetchImpl(async (url, opts) => {
    seen.push({ url: String(url), auth: (opts && opts.headers && opts.headers.authorization) || '' });
    const json = (data) => ({ ok: true, status: 200, statusText: '', headers: { get: () => null }, json: async () => data });
    if (String(url).includes('skillhub.club')) {
      return json({
        skills: [
          {
            name: 'skill-hub',
            author: 'a',
            description: 'hub 自带描述',
            repo_url: 'https://github.com/a/r4/tree/main/skills/skill-hub',
            github_stars: 3,
            category: 'development',
          },
        ],
      });
    }
    if (String(url).includes('skills.sh')) {
      return json({ skills: [{ source: 'a/r1', skillId: 'skill-a', name: 'skill-a', installs: 12 }] });
    }
    if (String(url).includes('skillsmp.com')) {
      return json({
        success: true,
        data: { skills: [{ name: 'skill-b', author: 'a', description: '自带描述', githubUrl: 'https://github.com/a/r2/tree/main/skills/skill-b', stars: 7 }] },
      });
    }
    if (String(url).includes('api.github.com/search')) {
      return json({ total_count: 1, items: [{ full_name: 'a/r3', description: 'repo desc', stargazers_count: 5, owner: { login: 'a' }, name: 'r3' }] });
    }
    throw new Error('unexpected url: ' + url);
  });
  const lastFor = (frag) => seen.filter((s) => s.url.includes(frag)).at(-1);
  try {
    const r = await app.invoke('market:searchAll', { query: 'commit', indexUrl: '' });
    assert.equal(r.ok, true);
    // 四来源各自汇报成功与条数（SkillHub 在最前：整页条目自带描述与星标）
    assert.deepEqual(
      r.sources.map((s) => [s.id, s.ok, s.count]),
      [
        ['skillhub', true, 1],
        ['skills-sh', true, 1],
        ['skillsmp', true, 1],
        ['github', true, 1],
      ]
    );
    // 统一形状：SKILL 条目在前、仓库条目在后；热门排序按装机量降序（无装机量比星标）
    assert.equal(r.items[0].kind, 'skill');
    assert.equal(r.items[0].name, 'skill-a', '装机量 12 的排在最前');
    assert.equal(r.items[0].srcName, 'skills.sh');
    assert.equal(r.items[1].kind, 'skill');
    assert.equal(r.items[1].name, 'skill-b', '同为 0 装机量，星标 7 的排在星标 3 前面');
    assert.equal(r.items[1].description, '自带描述');
    assert.equal(r.items[2].kind, 'skill');
    assert.equal(r.items[2].name, 'skill-hub');
    assert.equal(r.items[2].srcName, 'SkillHub');
    assert.equal(r.items[2].description, 'hub 自带描述');
    assert.equal(r.items[3].kind, 'repo');
    assert.equal(r.items[3].name, 'a/r3');
    // token 纪律：站方接口与 skillsmp 不带 token，GitHub 搜索带
    assert.equal(lastFor('skillhub.club').auth, '', 'SkillHub 不是 GitHub 域，绝不能带 token');
    assert.equal(lastFor('skills.sh').auth, '', 'skills.sh 不是 GitHub 域，绝不能带 token');
    assert.equal(lastFor('skillsmp.com').auth, '', 'skillsmp 不是 GitHub 域，绝不能带 token');
    assert.equal(lastFor('api.github.com').auth, 'Bearer ghp_secret', 'GitHub 搜索应当带上');
  } finally {
    setFetchImpl(null);
    await app.invoke('market:setConfig', { token: '' });
    require('../../src/market').resetSourceHealth();
  }
});

test('market:repoSkills：树定位列出仓库里的 SKILL 并补描述（fetch 注入）', async () => {
  const { setFetchImpl } = require('../../src/net');
  const json = (data) => ({ ok: true, status: 200, statusText: '', headers: { get: () => null }, json: async () => data });
  const text = (body) => ({
    ok: true,
    status: 200,
    statusText: '',
    headers: { get: () => null },
    text: async () => body,
    arrayBuffer: async () => Buffer.from(body),
  });
  setFetchImpl(async (url) => {
    const u = String(url);
    if (u.includes('/git/trees/'))
      return json({
        tree: [
          { path: 'skills/one/SKILL.md', type: 'blob' },
          { path: 'skills/two/SKILL.md', type: 'blob' },
        ],
      });
    if (u.endsWith('/HEAD/skills/one/SKILL.md')) return text(['---', 'name: one', 'description: 第一个', '---', '正文'].join('\n'));
    if (u.endsWith('/HEAD/skills/two/SKILL.md')) return text(['---', 'name: two', 'description: 第二个', '---', '正文'].join('\n'));
    throw new Error('unexpected url: ' + u);
  });
  try {
    const r = await app.invoke('market:repoSkills', { owner: 'rs', repo: 'repo' });
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.skills.map((s) => s.name),
      ['one', 'two']
    );
    assert.equal(r.skills[0].description, '第一个');
    assert.equal(r.skills[0].path, 'skills/one');
  } finally {
    setFetchImpl(null);
  }
});
