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
const { writeSkill, makeConfig, makeWebdavConfig, tmpDir, zipDir, captureHomeEnv, setHome, restoreHomeEnv } = require('../helpers/fixtures');
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
  assert.deepEqual(r.externalDirs, [], '本机配置里在用的目录不该被当成「配置之外」');
  assert.ok(fs.existsSync(path.join(outsideDir, 'outside', 'SKILL.md')), 'HOME 之外的目录也要还原');
  assert.ok(fs.existsSync(path.join(agentDir, 'alpha', 'SKILL.md')), 'HOME 之下的照旧');
});

test('不是本机自己的备份：绝对路径目录与项目配置一律跳过，不造幽灵目录', async () => {
  // 上面那条规则的另一面：备份里的绝对路径只有「本机配置里在用的」才直接写。
  // 换台机器的备份里，那些路径指的是原机器的位置 —— 照着建只会得到一棵没人读的目录树，
  // 正是当初「换台电脑恢复出一堆幽灵目录」那个缺陷。
  const projDir = tmpDir('cc-skill-proj-');
  extraDirs.push(projDir);
  await app.invoke('config:set', { projects: [{ id: 'p1', dir: projDir, name: 'proj' }] });
  const up = await app.invoke('sync:backup');
  assert.equal(up.ok, true, JSON.stringify(up));
  const info = await app.invoke('sync:restoreInfo');

  // 冒充「另一台机器」：换掉本机标识，并且本机配置里没有 outsideDir 这个目录了
  await app.invoke('sync:resetMachine');
  await app.invoke('config:set', { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: [agentDir] }] });
  fs.rmSync(outsideDir, { recursive: true, force: true });

  const r = await app.invoke('sync:restoreApply', { name: info.name });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.sameMachine, false);
  assert.equal(r.projectConfigSkipped, 1, '不同机器的项目路径不通用');
  assert.deepEqual(
    r.externalDirs.map((x) => x.dir),
    [outsideDir],
    '本机配置之外的目录不该被直接写入，而要交给用户判断'
  );
  assert.ok(!fs.existsSync(path.join(outsideDir, 'outside', 'SKILL.md')), '不该照着备份包重建目录');
  assert.ok(fs.existsSync(path.join(agentDir, 'alpha', 'SKILL.md')), '~ 形式照旧还原');

  // 用户明确点头之后才写：这是那条「由用户断言，而不是由包自证」的边界
  const forced = await app.invoke('sync:restoreApply', { name: info.name, allowExternalDirs: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.deepEqual(forced.externalDirs, [], '写过了就不该再报');
  assert.ok(fs.existsSync(path.join(outsideDir, 'outside', 'SKILL.md')), '确认之后要真的写进去');
  await app.invoke('config:set', { projects: [] });
});

test('伪造 machineId 的备份包：不确认就地写不进任何绝对路径', async () => {
  // 回归防线。machineId 不是凭证 —— 它就写在云端侧车文件名、以及每份备份包的 manifest 里，
  // 谁都能抄。曾经的做法是「包里的 destDir 与包里的 agents[].dirs 互相印证」，那等于让被恢复的
  // 文件自己给自己发通行证：两边都填同一个任意路径即可，用户点一次「确认恢复」就写进去了。
  //
  // 用例自带一个云端备份名，不覆盖别的用例用到的包 —— 覆盖会顺带改掉后面用例恢复到的内容
  const zipName = 'cc-skill-backup-20260201-010101.zip';

  // 伪造的包：冒充本机（真实 machineId）、把目标指向任意绝对路径
  const payload = path.join(tmpDir('cc-skill-forge-'), 'payload');
  const spoofDir = tmpDir('cc-skill-spoof-');
  fs.writeFileSync(path.join(spoofDir, 'user-file.txt'), '本机原有的文件', 'utf8');
  fs.mkdirSync(path.join(payload, 'data', 't0', 'pwn'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'data', 't0', 'pwn', 'SKILL.md'), '---\nname: pwn\ndescription: x\n---\n\n正文\n', 'utf8');
  fs.writeFileSync(
    path.join(payload, 'manifest.json'),
    JSON.stringify({
      app: 'CC Skill',
      manifestVersion: 1,
      created: new Date().toISOString(),
      hostname: 'evil',
      machineId: app.readConfig().machineId, // ← 抄来的标识，冒充「本机自己的备份」
      settings: { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: ['~/.claude/skills'] }] },
      targets: [{ id: 't0', destDir: spoofDir, kind: 'global', projectId: null, agentIds: ['claude-code'], count: 1 }],
      entries: [{ target: 't0', folder: 'pwn' }],
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(payload, 'config.json'),
    JSON.stringify({ agents: [{ id: 'claude-code', name: 'Claude Code', dirs: [spoofDir] }], projects: [], ui: {} }),
    'utf8'
  );
  stub.files.set('/dav/' + zipName, fs.readFileSync(zipDir(payload, path.join(path.dirname(payload), 'forged.zip'))));

  const r = await app.invoke('sync:restoreApply', { name: zipName });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.sameMachine, true, '（前提）伪造的标识确实让 sameMachine 为真 —— 所以它不能当门用');
  assert.deepEqual(
    r.externalDirs.map((x) => x.dir),
    [spoofDir],
    '不在本机配置里的绝对路径必须留给用户判断'
  );
  assert.ok(!fs.existsSync(path.join(spoofDir, 'pwn', 'SKILL.md')), '没确认就不该写进去');
  assert.ok(fs.existsSync(path.join(spoofDir, 'user-file.txt')), '更不该删掉那个目录里原有文件');

  // 而本机自己的备份落在「~ 目录」里的那部分照旧要恢复
  assert.ok(fs.existsSync(path.join(agentDir, 'alpha', 'SKILL.md')));

  // 用户没确认时，第二次不带 allowExternalDirs 也还是写不进去
  // （第一次恢复会把包里的 Agent 目录并进本机配置，所以这一条同时守住「别把外来绝对路径
  //   并进配置」—— 并进去了，第二次就会被当成「本机的目录」直接写）
  const again = await app.invoke('sync:restoreApply', { name: zipName });
  assert.equal(again.ok, true);
  assert.ok(!fs.existsSync(path.join(spoofDir, 'pwn', 'SKILL.md')), '重复恢复也不能绕过去');
  assert.ok(!(app.readConfig().agents[0].dirs || []).some((d) => d.includes(path.basename(spoofDir))), '外来绝对路径不该被并进本机配置');
  stub.remove('/dav/' + zipName);
  fs.rmSync(spoofDir, { recursive: true, force: true });
});

test('声明里带 .. 或不是绝对路径的目标一律当非法数据丢掉', async () => {
  // expand('~/../..') 会落到 home 之外 —— 备份包是外来输入，没有理由需要这种目标目录。
  // 同样自带一个云端备份名，不动别的用例用到的包
  const zipName = 'cc-skill-backup-20260203-030303.zip';
  const escaped = path.join(tmpDir('cc-skill-escape-'), 'target');
  const payload = path.join(tmpDir('cc-skill-dots-'), 'payload');
  fs.mkdirSync(path.join(payload, 'data', 't0', 'dots'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'data', 't0', 'dots', 'SKILL.md'), '---\nname: dots\ndescription: x\n---\n\n正文\n', 'utf8');
  const makeManifest = (destDir) => ({
    app: 'CC Skill',
    manifestVersion: 1,
    created: new Date().toISOString(),
    hostname: 'evil',
    machineId: app.readConfig().machineId,
    settings: { agents: [] },
    targets: [{ id: 't0', destDir, kind: 'global', projectId: null, agentIds: ['claude-code'], count: 1 }],
    entries: [{ target: 't0', folder: 'dots' }],
  });
  fs.writeFileSync(path.join(payload, 'config.json'), JSON.stringify({ agents: [], projects: [], ui: {} }), 'utf8');

  for (const destDir of ['~/../' + path.basename(escaped), 'relative/dir']) {
    fs.writeFileSync(path.join(payload, 'manifest.json'), JSON.stringify(makeManifest(destDir)), 'utf8');
    stub.files.set('/dav/' + zipName, fs.readFileSync(zipDir(payload, path.join(path.dirname(payload), 'dots.zip'))));
    const r = await app.invoke('sync:restoreApply', { name: zipName, allowExternalDirs: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.restored, 0, `${destDir} 不该被写入`);
    assert.equal(r.skippedInvalid, 1, `${destDir} 应被记成非法条目`);
  }
  assert.ok(!fs.existsSync(path.join(escaped, 'dots')), '不该在 home 之外造出目录');
  stub.remove('/dav/' + zipName);
  fs.rmSync(escaped, { recursive: true, force: true });
});

test('重装系统后认领：项目配置与 HOME 之外的目录一次全回来', async () => {
  const projDir = tmpDir('cc-skill-proj-');
  extraDirs.push(projDir);
  // 第一台机器：项目 + HOME 之外的目录都配上，然后备份
  await app.invoke('config:set', {
    agents: [{ id: 'claude-code', name: 'Claude Code', dirs: [agentDir, outsideDir] }],
    projects: [{ id: 'p1', dir: projDir, name: 'proj' }],
  });
  writeSkill(outsideDir, 'outside');
  const up = await app.invoke('sync:backup');
  assert.equal(up.ok, true, JSON.stringify(up));
  const machineA = app.readConfig().machineId;

  // 重装系统：新标识，配置回到初始状态（没有项目、没有 HOME 之外的目录）
  const reset = await app.invoke('sync:resetMachine');
  assert.notEqual(reset.machineId, machineA, '重装后是个新标识');
  await app.invoke('config:set', { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: [agentDir] }], projects: [] });
  fs.rmSync(outsideDir, { recursive: true, force: true });

  const info = await app.invoke('sync:restoreInfo');
  assert.equal(info.sameMachine, false, '换了标识，这份备份就不再算本机的');
  assert.equal(info.machineId, machineA, '弹窗要拿到备份来自哪台机器，才能提示认领');

  // 第一遍：认领 + 把本机认识的部分恢复回来。HOME 之外的目录来自备份包、本机配置里没有，
  // 所以要交给用户点头（这一步就是「由用户断言，而不是由包自证」的落点）
  const adopted = await app.invoke('sync:restoreApply', { name: info.name, adoptMachine: true });
  assert.equal(adopted.ok, true, JSON.stringify(adopted));
  assert.equal(adopted.adoptedMachine, true);
  assert.equal(adopted.sameMachine, true);
  assert.equal(app.readConfig().machineId, machineA, '认领就是认下这个标识');
  assert.equal(adopted.projectConfigSkipped, 0, '认领之后项目配置要还原');
  assert.deepEqual(
    adopted.externalDirs.map((x) => x.dir),
    [outsideDir],
    '本机配置之外的目录要单独交给用户确认'
  );
  assert.ok(!fs.existsSync(path.join(outsideDir, 'outside', 'SKILL.md')), '确认之前不写');
  assert.deepEqual(
    app.readConfig().projects.map((p) => p.id),
    ['p1']
  );

  // 第二遍：用户确认那些目录属于本机
  const forced = await app.invoke('sync:restoreApply', { name: info.name, allowExternalDirs: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.deepEqual(forced.externalDirs, []);
  assert.ok(fs.existsSync(path.join(outsideDir, 'outside', 'SKILL.md')), '确认之后目录真的落回来了');
  await app.invoke('config:set', { projects: [] });
});

test('认领之后恢复失败：本机标识要还回去', async () => {
  // 认领是立刻落盘的（否则后面算 sameMachine 用的就不是新身份）。所以失败路径必须回滚：
  // 用户看到「恢复失败」而标识已经成了别人的，下一次备份就会写进对方的档案。
  const machineA = app.readConfig().machineId;
  await app.invoke('sync:resetMachine');
  const machineB = app.readConfig().machineId;
  assert.notEqual(machineA, machineB);

  // 一个结构上合法、落地时必定抛错的包：destDir 的父级是一条文件，mkdir 会 ENOTDIR
  const blocked = path.join(root, 'blocked');
  fs.writeFileSync(blocked, '这里是一条文件，不是目录', 'utf8');
  const payload = path.join(tmpDir('cc-skill-rollback-'), 'payload');
  fs.mkdirSync(path.join(payload, 'data', 't0', 'boom'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'data', 't0', 'boom', 'SKILL.md'), '---\nname: boom\ndescription: x\n---\n\n正文\n', 'utf8');
  fs.writeFileSync(
    path.join(payload, 'manifest.json'),
    JSON.stringify({
      app: 'CC Skill',
      manifestVersion: 1,
      created: new Date().toISOString(),
      hostname: 'x',
      machineId: machineA, // 认领它
      settings: { agents: [] },
      targets: [{ id: 't0', destDir: '~/blocked/sub', kind: 'global', projectId: null, agentIds: ['claude-code'], count: 1 }],
      entries: [{ target: 't0', folder: 'boom' }],
    }),
    'utf8'
  );
  const zipName = 'cc-skill-backup-20260202-020202.zip';
  stub.files.set('/dav/' + zipName, fs.readFileSync(zipDir(payload, path.join(path.dirname(payload), 'boom.zip'))));

  const r = await app.invoke('sync:restoreApply', { name: zipName, adoptMachine: true });
  assert.equal(r.ok, false, '写不进去就该报失败');
  assert.equal(app.readConfig().machineId, machineB, '认领要回滚，别让用户看到「失败」而身份已是别人的');

  fs.rmSync(blocked, { force: true });
  stub.remove('/dav/' + zipName);
});

test('旧版备份（认领时包里没有 machineId）不该把整次恢复拒掉', async () => {
  const zipName = 'cc-skill-backup-20260204-040404.zip';
  const payload = path.join(tmpDir('cc-skill-noid-'), 'payload');
  fs.mkdirSync(path.join(payload, 'data', 't0', 'noid'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'data', 't0', 'noid', 'SKILL.md'), '---\nname: noid\ndescription: x\n---\n\n正文\n', 'utf8');
  fs.writeFileSync(
    path.join(payload, 'manifest.json'),
    JSON.stringify({
      app: 'CC Skill',
      manifestVersion: 1,
      created: new Date().toISOString(),
      hostname: 'old',
      // 刻意不写 machineId：旧版备份就是这样
      settings: { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: ['~/.claude/skills'] }] },
      targets: [{ id: 't0', destDir: '~/.claude/skills', kind: 'global', projectId: null, agentIds: ['claude-code'], count: 1 }],
      entries: [{ target: 't0', folder: 'noid' }],
    }),
    'utf8'
  );
  stub.files.set('/dav/' + zipName, fs.readFileSync(zipDir(payload, path.join(path.dirname(payload), 'noid.zip'))));

  const r = await app.invoke('sync:restoreApply', { name: zipName, adoptMachine: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 1, '认领无从谈起，但 SKILL 该照常恢复');
  assert.equal(r.adoptedMachine, false);
  assert.ok(fs.existsSync(path.join(agentDir, 'noid', 'SKILL.md')));
  stub.remove('/dav/' + zipName);
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

// ------------------------------ 机器档案 --------------------------------------
// 这一段按「本机标识还是原来那个」为前提写，所以改标识的用例放在最后。
const FOREIGN_ZIP = 'cc-skill-backup-20260101-010101.zip';
const foreignMeta = () => ({
  machineId: 'foreign-machine',
  machineName: '旧笔记本',
  hostname: 'OLD-PC',
  name: FOREIGN_ZIP,
  created: '2026-01-01T01:01:01.000Z',
  entries: 2,
  size: 50,
});

test('机器档案：列出云端各台机器，本机排在最前', async () => {
  stub.writeJson('/dav/' + FOREIGN_ZIP, { fake: true });
  stub.writeJson('/dav/host-foreign.json', foreignMeta());

  const r = await app.invoke('sync:machines');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.machines[0].self, true, '本机排最前');
  assert.equal(r.machines[0].name, os.hostname(), '没起过名就用 hostname');
  // 名字里有非法字符的机器标识不该被当成「本机」
  assert.equal(r.machines.filter((m) => m.self).length, 1);

  const foreign = r.machines.find((m) => m.machineId === 'foreign-machine');
  assert.equal(foreign.name, '旧笔记本', '没别名时用那台机器自己声明的名字');
  assert.equal(foreign.hostname, 'OLD-PC', '真实 hostname 留着，换名不该让排查时认不出机器');
  assert.equal(foreign.backup.name, FOREIGN_ZIP);
  assert.equal(foreign.backup.present, true);
  assert.ok(!r.orphans.includes(FOREIGN_ZIP), '被档案引用的备份不算无主');
});

test('机器改名：本机改自己的名字，别的机器记成本机别名', async () => {
  const self = app.readConfig().machineId;
  const r1 = await app.invoke('sync:renameMachine', { machineId: self, name: '  我的 台式机  ' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.self, true);
  assert.equal(app.readConfig().machineName, '我的 台式机', '进去之前先归一化');

  const r2 = await app.invoke('sync:renameMachine', { machineId: 'foreign-machine', name: '老笔记本' });
  assert.equal(r2.ok, true);
  assert.equal(r2.self, false);
  assert.deepEqual(app.readConfig().machineNames, { 'foreign-machine': '老笔记本' }, '别名只落本机配置');

  const list = await app.invoke('sync:machines');
  assert.equal(list.machines.find((m) => m.self).name, '我的 台式机');
  assert.equal(list.machines.find((m) => m.machineId === 'foreign-machine').name, '老笔记本', '别名优先于侧车里的名字');
  assert.equal(stub.readJson('/dav/host-foreign.json').machineName, '旧笔记本', '改名不写回云端侧车（那台机器下次备份会覆盖掉）');

  assert.equal((await app.invoke('sync:renameMachine', { machineId: '../evil', name: 'x' })).ok, false);

  // 空名字 = 清掉：本机回落到 hostname，别名直接删 —— 弹窗上就是这么承诺的，
  // 不然机器一旦改过名就再也回不到 hostname
  assert.equal((await app.invoke('sync:renameMachine', { machineId: 'foreign-machine', name: '   ' })).ok, true);
  assert.deepEqual(app.readConfig().machineNames, {}, '空名字要把别名删掉');
  assert.equal((await app.invoke('sync:renameMachine', { machineId: self, name: '' })).ok, true);
  assert.equal(app.readConfig().machineName, '');
  const back = await app.invoke('sync:machines');
  assert.equal(back.machines.find((m) => m.self).name, os.hostname(), '清空后回落 hostname');
  // 收尾：留一个名字，别影响后续用例对「本机名」的断言
  await app.invoke('sync:renameMachine', { machineId: self, name: '我的 台式机' });
});

test('机器档案：移出只删档案，删除则连它最近那份备份一起删', async () => {
  // 移出：侧车没了，备份还在云端
  const kept = await app.invoke('sync:forgetMachine', { file: 'host-foreign.json' });
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.equal(kept.deletedBackup, '');
  assert.ok(!stub.files.has('/dav/host-foreign.json'));
  assert.ok(stub.files.has('/dav/' + FOREIGN_ZIP), '只是移出列表时不该动备份');

  // 再挂一次，这次连备份一起删
  stub.writeJson('/dav/host-foreign.json', foreignMeta());
  const gone = await app.invoke('sync:forgetMachine', { file: 'host-foreign.json', deleteBackups: true });
  assert.equal(gone.ok, true, JSON.stringify(gone));
  assert.equal(gone.deletedBackup, FOREIGN_ZIP);
  assert.ok(!stub.files.has('/dav/' + FOREIGN_ZIP));
  assert.ok(!stub.files.has('/dav/host-foreign.json'));

  // 本机自己的档案不给删：下一次备份会立刻写回来，要换身份该走认领或重置。
  // 先备份一次，保证「本机档案」确实在云端 —— 前面的用例改过标识，别依赖累积下来的历史
  assert.equal((await app.invoke('sync:backup')).ok, true);
  const selfFile = 'host-' + app.readConfig().machineId + '.json';
  assert.ok(stub.files.has('/dav/' + selfFile), '本机档案确实在云端');
  const self = await app.invoke('sync:forgetMachine', { file: selfFile });
  assert.equal(self.ok, false);
  assert.equal(self.reason, 'self');
  assert.ok(stub.files.has('/dav/' + selfFile), '拒绝了就不该真的删掉');

  // 路径穿越被挡在文件名校验上
  assert.equal((await app.invoke('sync:forgetMachine', { file: '../latest.json' })).ok, false);
});

test('无主备份单独列出来，可逐个删掉', async () => {
  const orphan = 'cc-skill-backup-20250601-000000.zip';
  stub.writeJson('/dav/' + orphan, { fake: true });

  const list = await app.invoke('sync:machines');
  assert.ok(list.orphans.includes(orphan), '没被任何档案引用的备份要单独列出来');
  assert.ok(!list.orphans.includes(stub.readJson(stub.metaPath()).name), '全局最新那条是有效引用，不算无主');

  const del = await app.invoke('sync:deleteBackup', { name: orphan });
  assert.equal(del.ok, true);
  assert.ok(!stub.files.has('/dav/' + orphan));
  assert.equal((await app.invoke('sync:deleteBackup', { name: '../../evil.zip' })).ok, false);
});

test('侧车里的字段先归一化再用（别人写的、或坏掉的文件都可能）', async () => {
  stub.writeJson('/dav/host-hostile.json', {
    machineId: '../../etc/passwd',
    machineName: 'x'.repeat(200),
    hostname: '坏\u0000主机\n名',
    name: '../../evil.zip',
    created: 'y'.repeat(500),
    entries: 'lots',
  });

  const r = await app.invoke('sync:machines');
  assert.equal(r.ok, true, JSON.stringify(r));
  const m = r.machines.find((x) => x.file === 'host-hostile.json');
  assert.ok(m, '坏掉的侧车照样列出来 —— 它正是最该被清掉的那种');
  assert.equal(m.machineId, '', '不合形状的标识当没有');
  assert.equal(m.self, false, '标识非法就不可能是「本机」');
  assert.equal(m.name.length, 40, '名字按机器名的规则限长');
  assert.ok(
    [...m.hostname].every((ch) => ch.codePointAt(0) >= 32 && ch.codePointAt(0) !== 127),
    '控制字符要被换掉'
  );
  assert.equal(m.backup, null, '备份名不合形状 → 当成没有备份');
  assert.ok(!r.orphans.includes('../../evil.zip'), '坏名字不该进无主备份列表');

  stub.remove('/dav/host-hostile.json');
});

test('本机还没在这里备份过时，档案列表也补一行空的自己', async () => {
  // 自己先换一个新标识：这样本机在云端就一定没有侧车（别依赖前面用例留下的状态）。
  // 这一行要能一眼看出「我在不在这儿」，也留个改名的入口；它没有侧车文件，所以删不了
  const fresh = await app.invoke('sync:resetMachine');
  assert.equal(fresh.ok, true);
  assert.ok(!stub.files.has('/dav/host-' + fresh.machineId + '.json'), '前提：云端没有这个标识的侧车');
  // 顺便清掉名字（前面的用例改过名），这样断言才不依赖用例之间的顺序
  await app.invoke('sync:renameMachine', { machineId: fresh.machineId, name: '' });

  const r = await app.invoke('sync:machines');
  assert.equal(r.ok, true, JSON.stringify(r));
  const self = r.machines.filter((m) => m.self);
  assert.equal(self.length, 1, '本机那一行要在，且只有一行');
  assert.equal(self[0].machineId, fresh.machineId);
  assert.equal(self[0].file, '', '没有侧车文件');
  assert.equal(self[0].backup, null, '还没备份过');
  assert.equal(self[0].name, os.hostname(), '没起过名就显示 hostname');
});

test('认领与重置本机标识', async () => {
  const before = app.readConfig().machineId;
  const adopted = await app.invoke('sync:adoptMachine', { machineId: 'foreign-machine' });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.changed, true);
  assert.equal(app.readConfig().machineId, 'foreign-machine');
  // 已经就是这个标识时不算失败，只是没变
  const again = await app.invoke('sync:adoptMachine', { machineId: 'foreign-machine' });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal((await app.invoke('sync:adoptMachine', { machineId: 'bad id!' })).ok, false);

  const reset = await app.invoke('sync:resetMachine');
  assert.equal(reset.ok, true);
  assert.notEqual(reset.machineId, 'foreign-machine');
  assert.notEqual(reset.machineId, before);
  assert.equal(app.readConfig().machineId, reset.machineId);
});
