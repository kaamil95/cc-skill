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

test('market:index 归一化索引条目，脏条目跳过并计数', async () => {
  const r = await app.invoke('market:index', { url: `${base}/index.json` });
  assert.equal(r.ok, true);
  assert.equal(r.name, '测试索引');
  assert.equal(r.items.length, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.items[0].name, 'alpha');
  assert.deepEqual(r.items[0].source, { kind: 'zip', url: `${base}/repo.zip` });
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

test('索引格式不对时报错，而不是静默当成空索引', async () => {
  const r = await app.invoke('market:index', { url: `${base}/not-an-index.json` });
  assert.equal(r.ok, false);
  assert.match(r.error, /索引格式不对/);
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

test('token 只发给 GitHub 域名：索引源是别的域名就不带', async () => {
  const { setFetchImpl } = require('../../src/net');
  await app.invoke('market:setConfig', { token: 'ghp_secret' });
  const seen = [];
  setFetchImpl(async (url, opts) => {
    seen.push({ url, auth: (opts && opts.headers && opts.headers.authorization) || '' });
    return { ok: true, status: 200, statusText: '', headers: { get: () => null }, body: fs.createReadStream(indexPath) };
  });
  try {
    await app.invoke('market:index', { url: 'https://evil.test/index.json' });
    assert.equal(seen.at(-1).auth, '', '非 GitHub 主机绝不能收到 token');
    await app.invoke('market:inspect', { source: { kind: 'github', owner: 'o', repo: 'r', ref: '' } });
    assert.equal(seen.at(-1).auth, 'Bearer ghp_secret', 'codeload 属于 GitHub，应当带上');
  } finally {
    setFetchImpl(null);
    await app.invoke('market:setConfig', { token: '' });
  }
});
