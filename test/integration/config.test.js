// 配置读写、路径信息、操作日志、导入前检查
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { startApp } = require('../helpers/harness');
const { writeSkill, makeConfig, tmpDir, zipDir } = require('../helpers/fixtures');

let app;
let root;
let agentDir;

before(async () => {
  root = tmpDir('cc-skill-config-');
  agentDir = path.join(root, 'skills');
  fs.mkdirSync(agentDir, { recursive: true });
  app = await startApp({ config: makeConfig({ agentDirs: [agentDir] }) });
});

after(() => {
  app.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

test('config:get 返回 Agents', async () => {
  const r = await app.invoke('config:get');
  assert.equal(r.agents.length, 1);
  assert.equal(r.agents[0].id, 'claude-code');
});

test('config:set 只传 ui 时不会误伤 Agents / 项目', async () => {
  const before = await app.invoke('config:get');
  const r = await app.invoke('config:set', { ui: { lang: 'en' } });
  assert.equal(r.ok, true);
  assert.equal(r.ui.lang, 'en');
  assert.deepEqual(r.agents, before.agents);
  assert.deepEqual(r.projects, []);
  assert.equal(app.readConfig().ui.lang, 'en');
});

test('config:set 会把项目名缺失/存成路径的情况自愈为目录名', async () => {
  const dir = path.join(root, 'my-proj');
  fs.mkdirSync(dir, { recursive: true });
  const r = await app.invoke('config:set', { projects: [{ id: 'p1', name: dir, dir }] });
  assert.equal(r.ok, true);
  assert.equal(r.projects[0].name, 'my-proj');
  assert.ok(!/[\\/]/.test(r.projects[0].name));
});

test('config:set 过滤掉缺 id / dir 的脏项目', async () => {
  const r = await app.invoke('config:set', { projects: [{ id: 'ok', dir: root, name: 'ok' }, { id: 'no-dir' }, null] });
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.projects.map((p) => p.id),
    ['ok']
  );
});

test('config:set 只传 ui.lang 时不会清掉遮罩配置', async () => {
  await app.invoke('config:set', { ui: { lang: 'zh', overlayBlur: 8, overlayDim: 0.5 } });
  const r = await app.invoke('config:set', { ui: { lang: 'en' } });
  assert.equal(r.ui.lang, 'en');
  assert.equal(r.ui.overlayBlur, 8, '遮罩模糊应被保留');
  assert.equal(r.ui.overlayDim, 0.5, '遮罩变暗应被保留');
  assert.deepEqual(app.readConfig().ui, { lang: 'en', overlayBlur: 8, overlayDim: 0.5 });
});

test('config:set 会夹住越界的遮罩值', async () => {
  const r = await app.invoke('config:set', { ui: { lang: 'zh', overlayBlur: 999, overlayDim: -3 } });
  assert.equal(r.ok, true);
  assert.equal(r.ui.overlayBlur, 40);
  assert.equal(r.ui.overlayDim, 0);
});

test('config:set 拒绝非数组的 agents / projects', async () => {
  assert.equal((await app.invoke('config:set', { agents: 'oops' })).reason, 'invalid');
  assert.equal((await app.invoke('config:set', { projects: 42 })).reason, 'invalid');
});

test('config:set 把 HOME 下的目录归一化存成 ~ 形式', async () => {
  const r = await app.invoke('config:set', { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: [agentDir] }] });
  assert.equal(r.ok, true);
  const stored = app.readConfig().agents[0].dirs[0];
  assert.ok(stored.startsWith('~/'), `应存成 ~ 形式，实际: ${stored}`);
  // 而 scan 仍能展开回真实路径
  const scanned = await app.invoke('scan');
  assert.ok(scanned.skills.length >= 0);
  assert.deepEqual(scanned.missingDirs, []);
});

test('config:reset 恢复内置 Agents 并清空项目', async () => {
  const r = await app.invoke('config:reset');
  assert.equal(r.ok, true);
  assert.deepEqual(r.projects, []);
  assert.ok(r.agents.length >= 5, '应恢复成内置的完整 Agent 列表');
  assert.equal(app.readConfig().agents.length, r.agents.length);
});

test('app:paths 暴露 userData / home / 日志路径与界面语言', async () => {
  const r = await app.invoke('app:paths');
  assert.ok(r.userData.includes('user-data'));
  assert.ok(r.home.length > 0);
  assert.ok(r.logFile.endsWith('cc-skill.log'));
  assert.ok(['auto', 'zh', 'en'].includes(r.ui.lang));
  // 界面偏好（弹窗遮罩）随 ui 一起下发
  assert.equal(typeof r.ui.overlayBlur, 'number');
  assert.equal(typeof r.ui.overlayDim, 'number');
});

test('log:append 落盘到应用目录，不污染仓库', async () => {
  const r = await app.invoke('log:append', { type: 'info', msg: '来自测试的一条记录' });
  assert.equal(r.ok, true);
  const { logFile } = await app.invoke('app:paths');
  assert.ok(logFile.startsWith(app.workDir), `日志应落在应用目录，实际: ${logFile}`);
  assert.match(fs.readFileSync(logFile, 'utf8'), /来自测试的一条记录/);

  // 仓库里可能已有开发者自己跑出来的 cc-skill.log，但绝不该多出测试这条
  const repoLog = path.join(process.cwd(), 'cc-skill.log');
  if (fs.existsSync(repoLog)) {
    assert.ok(!fs.readFileSync(repoLog, 'utf8').includes('来自测试的一条记录'), '测试不该写进仓库日志');
  }
});

test('import:inspect 在文件夹里定位技能根并读出元信息', async () => {
  const src = writeSkill(root, 'import-me', { files: { 'ref/x.md': 'x' } });
  const r = await app.invoke('import:inspect', { source: src });
  assert.equal(r.ok, true);
  assert.equal(r.folder, 'import-me');
  assert.equal(r.name, 'import-me');
  assert.equal(r.description, 'import-me 的描述');
  assert.equal(r.fileCount, 3); // SKILL.md + ref + ref/x.md
});

test('import:inspect 能向下两层找到 SKILL.md', async () => {
  const outer = path.join(root, 'nested-outer');
  writeSkill(outer, 'deep-skill');
  const r = await app.invoke('import:inspect', { source: outer });
  assert.equal(r.ok, true);
  assert.equal(r.folder, 'deep-skill');
});

test('import:inspect 对不含 SKILL.md 的目录返回 no-skill', async () => {
  const empty = path.join(root, 'empty-dir');
  fs.mkdirSync(empty, { recursive: true });
  const r = await app.invoke('import:inspect', { source: empty });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-skill');
});

test('import:inspect 能解压 zip 后再定位技能根', { skip: process.platform !== 'win32' }, async () => {
  const src = writeSkill(root, 'zipped-skill');
  const zip = zipDir(src, path.join(root, 'one-skill.zip'));
  const r = await app.invoke('import:inspect', { source: zip });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'zipped-skill');
});
