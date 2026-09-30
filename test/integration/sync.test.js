// WebDAV 备份 / 恢复全链路（对着内存版 WebDAV 桩服务器跑）
// 除了功能正确，还锁住两条行为契约：
//   1. 确认（restoreApply）之前绝不下载整包 —— 这是「点了按钮要卡几秒」那个 bug 的回归防线
//   2. 无论成功失败，临时目录都不残留
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { startApp } = require('../helpers/harness');
const { writeSkill, makeConfig, makeWebdavConfig, tmpDir, captureHomeEnv, setHome, restoreHomeEnv } = require('../helpers/fixtures');
const { WebdavStub } = require('../helpers/webdav-stub');

let app;
let stub;
let root;
let agentDir;
let outsideDir;
let savedHomeEnv;
const extraDirs = []; // 用例内临时建的目录，统一在 after 里清掉

// 应用自己的临时目录已被 harness 隔离到 workDir 下，这里看到的就是它产生的全部临时文件
const listRestoreTemps = () => fs.readdirSync(app.tempDir).filter((n) => n.startsWith('cc-skill-restore-'));
function assertNoNewTemps(before) {
  const fresh = listRestoreTemps().filter((n) => !before.includes(n));
  assert.deepEqual(fresh, [], `残留了临时目录: ${fresh.join(', ')}`);
}

before(async () => {
  // SKILL 目录要真的落在 HOME 之下：备份把目录存成 ~ 形式、恢复再按本机 home 展开，
  // 这条链路是「换台电脑恢复」的前提，而它只有在 HOME 之下才走得通。
  // 用开发机的 os.tmpdir() 当 HOME 是靠不住的（见 fixtures.js 的说明）。
  savedHomeEnv = captureHomeEnv();
  root = tmpDir('cc-skill-sync-');
  setHome(root);
  agentDir = path.join(root, '.claude', 'skills');
  // HOME 之外的目录：备份存不下 ~ 形式，只能存绝对路径
  outsideDir = tmpDir('cc-skill-outside-');
  fs.mkdirSync(agentDir, { recursive: true });
  stub = new WebdavStub();
  const url = await stub.start();
  app = await startApp({ config: makeConfig({ agentDirs: [agentDir], webdav: makeWebdavConfig(url) }) });
});

after(() => {
  app.cleanup();
  stub.stop();
  for (const d of [root, outsideDir, ...extraDirs]) fs.rmSync(d, { recursive: true, force: true });
  restoreHomeEnv(savedHomeEnv);
});

test('sync:setConfig 归一化远程路径的各种斜杠写法', async () => {
  const cases = [
    ['//a//b/', '/a/b'],
    ['a', '/a'],
    ['/a/b', '/a/b'],
    ['', '/cc-skill-sync'],
  ];
  for (const [input, expected] of cases) {
    await app.invoke('sync:setConfig', { webdav: makeWebdavConfig(stub.url, input) });
    const r = await app.invoke('sync:getConfig');
    assert.equal(r.webdav.remotePath, expected, `输入 ${JSON.stringify(input)}`);
  }
  await app.invoke('sync:setConfig', { webdav: makeWebdavConfig(stub.url) });
});

test('sync:test 连接成功并自动建目录', async () => {
  const r = await app.invoke('sync:test');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(stub.requests('MKCOL').length > 0, '应尝试创建远程目录');
});

test('没有可备份的 SKILL 时明确报错', async () => {
  const r = await app.invoke('sync:backup');
  assert.equal(r.ok, false);
  assert.match(r.error, /没有可备份/);
});

test('sync:backup 上传整包 + latest.json 元数据', async () => {
  writeSkill(agentDir, 'alpha', { files: { 'ref/a.md': 'A' } });
  writeSkill(agentDir, 'beta');
  const r = await app.invoke('sync:backup');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.count, 2);
  assert.match(r.name, /^cc-skill-backup-\d{8}-\d{6}\.zip$/);

  const meta = stub.readJson(stub.metaPath());
  assert.ok(meta, '应上传 latest.json');
  assert.equal(meta.name, r.name, '元数据必须指向最新那份备份');
  assert.equal(meta.hostname, os.hostname());
  assert.equal(meta.entries, 2);
  assert.equal(meta.size, r.size);

  // 本机专属侧车：恢复时据此优先取「本机自己上传的那份」，而不是云端最新那条
  const hostPath = stub.hostMetaPath();
  assert.ok(hostPath, '应同时上传本机专属侧车文件');
  assert.equal(stub.readJson(hostPath).name, r.name);
  assert.ok(meta.agents.length > 0, '侧车要带 Agent 维度汇总，弹窗才能按 Agent 勾选');
  assert.equal(meta.projectCount, 0, '本次没有项目级 SKILL');
});

test('sync:restoreInfo 只读元数据，不下载整包', async () => {
  stub.log.length = 0;
  const r = await app.invoke('sync:restoreInfo');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.detailed, true);
  assert.equal(r.hostname, os.hostname());
  assert.equal(r.entries, 2);
  assert.ok(r.size > 0);
  assert.equal(r.source, 'local', '本机备份过就用本机那份');
  assert.deepEqual(stub.zipDownloads(), [], '确认前不该下载整包');
});

test('旧备份（无 latest.json）降级为 HEAD，且同样不下载整包', async () => {
  stub.hideMeta = true;
  stub.log.length = 0;
  const r = await app.invoke('sync:restoreInfo');
  assert.equal(r.ok, true);
  assert.equal(r.detailed, false);
  assert.equal(r.hostname, '');
  assert.equal(r.entries, 0);
  assert.equal(r.source, 'latest', '读不到侧车元数据时退回全局最新一条');
  assert.ok(r.size > 0, '大小应回退到 HEAD 的 content-length');
  assert.deepEqual(stub.zipDownloads(), [], '降级路径同样不该下载整包');
  stub.hideMeta = false;
});

test('云端没有任何备份时报错', async () => {
  const saved = new Map(stub.files);
  stub.files.clear();
  const r = await app.invoke('sync:restoreInfo');
  assert.equal(r.ok, false);
  assert.match(r.error, /没有找到任何备份/);
  stub.files = saved;
});

test('非法备份名被拒绝，且不发出任何请求', async () => {
  stub.log.length = 0;
  for (const name of ['../../evil.zip', 'cc-skill-backup-../x.zip', '', null, 'other.zip']) {
    const r = await app.invoke('sync:restoreApply', { name });
    assert.equal(r.ok, false, `名字 ${JSON.stringify(name)} 不该通过`);
    assert.match(r.error, /不合法/);
  }
  assert.deepEqual(stub.log, [], '被拒绝的请求不该触网');
});

test('确认后：下载 → 解压 → 覆盖还原，且临时目录不残留', async () => {
  const info = await app.invoke('sync:restoreInfo');
  const tempsBefore = listRestoreTemps();

  // 模拟换机：本地 SKILL 全没了
  fs.rmSync(agentDir, { recursive: true, force: true });

  stub.log.length = 0;
  const r = await app.invoke('sync:restoreApply', { name: info.name });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 2);
  assert.equal(stub.zipDownloads().length, 1, '确认后应正好下载一次整包');

  assert.ok(fs.existsSync(path.join(agentDir, 'alpha', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(agentDir, 'alpha', 'ref', 'a.md')), '子目录也要还原');
  assert.ok(fs.existsSync(path.join(agentDir, 'beta', 'SKILL.md')));
  assertNoNewTemps(tempsBefore);
});

test('HOME 之外的 Agent 目录：同机恢复照样还原', async () => {
  // 自定义的 Agent 目录常在 home 之外，备份存不下 ~ 形式，只能存绝对路径。
  // 恢复时不能把这类绝对路径一律当成「别的机器的」跳过 —— 它就在本机、配置里也写着，
  // 照原样写回才对。以前这里会 restored 少一个、并在界面上报「无法映射到本机目录」。
  await app.invoke('config:set', { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: [agentDir, outsideDir] }] });
  writeSkill(outsideDir, 'outside');

  const up = await app.invoke('sync:backup');
  assert.equal(up.ok, true, JSON.stringify(up));

  const info = await app.invoke('sync:restoreInfo');
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });

  const r = await app.invoke('sync:restoreApply', { name: info.name });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 3, 'HOME 之外的也要算上');
  assert.deepEqual(r.skippedExternal, [], '本机在用的目录不该被当成无法映射的路径');
  assert.ok(fs.existsSync(path.join(outsideDir, 'outside', 'SKILL.md')), 'HOME 之外的目录也要还原');
  assert.ok(fs.existsSync(path.join(agentDir, 'alpha', 'SKILL.md')), 'HOME 之下的照旧');
});

test('本机已经不再用的绝对路径目录，仍然跳过（不造幽灵目录）', async () => {
  // 上面那条规则的另一面：绝对路径只有「本机自己的、且现在还在配置里」才认。
  // 目录已经从配置里摘掉之后，照着备份包写回去只会得到一棵没人读的目录树 ——
  // 那正是换机恢复要避免的事，同机也一样。
  const stale = tmpDir('cc-skill-stale-');
  extraDirs.push(stale);
  writeSkill(stale, 'stale-skill');
  const dirs = [agentDir, outsideDir, stale];
  await app.invoke('config:set', { agents: [{ id: 'claude-code', name: 'Claude Code', dirs }] });
  assert.equal((await app.invoke('sync:backup')).ok, true);

  // 备份完就把这个目录从配置里摘掉（outsideDir 留着，它才是本机在用的那个）
  await app.invoke('config:set', { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: [agentDir, outsideDir] }] });
  const info = await app.invoke('sync:restoreInfo');
  fs.rmSync(stale, { recursive: true, force: true });

  const r = await app.invoke('sync:restoreApply', { name: info.name });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(
    r.skippedExternal.map((x) => x.dir),
    [stale],
    '只该跳过本机不再使用的那个目录'
  );
  assert.ok(!fs.existsSync(path.join(stale, 'stale-skill')), '不该照着备份包重建目录');
  assert.ok(fs.existsSync(path.join(outsideDir, 'outside', 'SKILL.md')), '本机在用的照旧还原');
});

test('备份包损坏时失败且不落地任何文件、不残留临时目录', async () => {
  const info = await app.invoke('sync:restoreInfo');
  const tempsBefore = listRestoreTemps();
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.mkdirSync(agentDir, { recursive: true });

  stub.corruptZip = true;
  const r = await app.invoke('sync:restoreApply', { name: info.name });
  stub.corruptZip = false;

  assert.equal(r.ok, false);
  assert.deepEqual(fs.readdirSync(agentDir), [], '失败时不该写入任何东西');
  assertNoNewTemps(tempsBefore);
});

test('远端 404 时失败且不残留临时目录', async () => {
  const tempsBefore = listRestoreTemps();
  const r = await app.invoke('sync:restoreApply', { name: 'cc-skill-backup-19990101-000000.zip' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /404/);
  assertNoNewTemps(tempsBefore);
});

test('恢复会一并还原备份里的设置（Agents / 项目 / 语言）', async () => {
  // 本地把界面偏好改掉，恢复后不该被旧备份的 config.json 清空
  await app.invoke('config:set', { ui: { lang: 'en', overlayBlur: 6, overlayDim: 0.7 } });

  const info = await app.invoke('sync:restoreInfo');
  const r = await app.invoke('sync:restoreApply', { name: info.name });
  assert.equal(r.ok, true);
  assert.equal(r.appliedConfig, true, '备份里带了 config.json，应一并恢复');

  const ui = app.readConfig().ui;
  assert.equal(ui.lang, 'zh', '语言以备份为准');
  assert.equal(typeof ui.overlayBlur, 'number', '遮罩配置不该被清掉');
  assert.equal(typeof ui.overlayDim, 'number');
});
