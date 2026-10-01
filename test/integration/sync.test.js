// WebDAV 备份 / 恢复全链路（对着内存版 WebDAV 桩服务器跑）
// 除了功能正确，还锁住三条行为契约：
//   1. 确认（restoreApply）之前绝不下载整包 —— 这是「点了按钮要卡几秒」那个 bug 的回归防线
//   2. 无论成功失败，临时目录都不残留
//   3. 备份只落在「本机自己那个目录」里，别人的目录一个字节都不动
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

/** 本机在云端的目录名（跟界面走同一条路：从机器档案里读，不在这里重算一遍） */
const myDir = async () => {
  const r = await app.invoke('sync:machines');
  return r.machines.find((m) => m.self).dir;
};

const MY = 'my-machine-11111111-2222-3333-4444-555555555555';
const FOREIGN = 'old-pc-9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f';
const FOREIGN_ID = '9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f';

/** 造一个备份包塞进云端某个目录（伪造 / 别台机器 / 缺字段的老包都用它）。
 *  tree 按 target id 分组：{ t0: { 文件夹名: { 相对文件: 内容 } } } */
function putZip(dir, zipName, { manifest, configJson, tree = {} }) {
  const payload = path.join(tmpDir('cc-skill-payload-'), 'payload');
  extraDirs.push(path.dirname(payload));
  for (const [target, folders] of Object.entries(tree)) {
    for (const [folder, files] of Object.entries(folders)) {
      const all = { 'SKILL.md': `---\nname: ${folder}\ndescription: x\n---\n\n正文\n`, ...files };
      for (const [rel, content] of Object.entries(all)) {
        const full = path.join(payload, 'data', target, folder, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
      }
    }
  }
  fs.writeFileSync(path.join(payload, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  fs.writeFileSync(path.join(payload, 'config.json'), JSON.stringify(configJson), 'utf8');
  const zip = zipDir(payload, path.join(path.dirname(payload), 'payload.zip'));
  stub.collections.add(`/dav/${dir}`);
  stub.files.set(`/dav/${dir}/${zipName}`, fs.readFileSync(zip));
  return zipName;
}

/** 别台机器的目录：档案 + 一份备份 + 它的侧车 */
function writeForeignDir({ zip = 'cc-skill-backup-20260101-010101.zip', entries = 2 } = {}) {
  const p = `/dav/${FOREIGN}`;
  stub.collections.add(p);
  stub.writeJson(`${p}/machine.json`, { machineId: FOREIGN_ID, machineName: '旧笔记本', hostname: 'OLD-PC' });
  stub.writeJson(`${p}/${zip}`, { fake: true });
  stub.writeJson(`${p}/${zip}.json`, {
    name: zip,
    machineId: FOREIGN_ID,
    machineName: '旧笔记本',
    hostname: 'OLD-PC',
    created: '2026-01-01T01:01:01.000Z',
    entries,
    size: 50,
    agents: [],
    projectCount: 0,
  });
  return zip;
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
  // 上面的循环换着远程目录存配置，「登记机器档案」也跟着写到了别的路径下。
  // 清干净，再按正式配置登记一次 —— 后面所有用例都假定云端只有 /dav 这一处
  stub.files.clear();
  stub.collections.clear();
  await app.invoke('sync:setConfig', { webdav: makeWebdavConfig(stub.url) });
  const dir = await myDir();
  assert.deepEqual(stub.machineDirs(), [dir], '保存配置后本机档案应当已经在云端');
  assert.ok(stub.readJson(stub.machineProfilePath(dir)), 'machine.json 也在');
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

test('sync:backup 把整包写进本机自己的目录，根目录下不再散落侧车', async () => {
  writeSkill(agentDir, 'alpha', { files: { 'ref/a.md': 'A' } });
  writeSkill(agentDir, 'beta');
  const r = await app.invoke('sync:backup');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.count, 2);
  assert.match(r.name, /^cc-skill-backup-\d{8}-\d{6}\.zip$/);

  // 目录名 = 可读 slug + 完整标识：网盘里认得出，且标识就在名字里
  const dir = await myDir();
  assert.match(dir, /^[a-z0-9-]+-[0-9a-f-]{36}$/, `目录名应是 slug-标识，实际 ${dir}`);
  assert.ok(dir.endsWith(app.readConfig().machineId), '完整标识写在名字尾部');

  const files = stub.filesIn(dir);
  assert.ok(files.includes(r.name), '备份包要在本机目录里');
  assert.ok(files.includes(r.name + '.json'), '每份备份带一份同名侧车');
  assert.deepEqual(filesInRoot(), [], '根目录下不该再散落备份与侧车');

  const meta = stub.readJson(stub.sidecarOf(dir, r.name));
  assert.equal(meta.name, r.name, '侧车必须指向这一份');
  assert.equal(meta.hostname, os.hostname());
  assert.equal(meta.entries, 2);
  assert.equal(meta.size, r.size);
  assert.ok(meta.agents.length > 0, '侧车要带 Agent 维度汇总，弹窗才能按 Agent 勾选');
  assert.equal(meta.projectCount, 0, '本次没有项目级 SKILL');

  const profile = stub.readJson(stub.machineProfilePath(dir));
  assert.equal(profile.machineId, app.readConfig().machineId, 'machine.json 记着这台机器是谁');
});

/** 云端根目录下的散落文件（分目录之后应当一个都没有） */
function filesInRoot() {
  return [...stub.files.keys()].filter((p) => /^\/dav\/[^/]+$/.test(p));
}

test('sync:restoreInfo 只读侧车，不下载整包', async () => {
  stub.log.length = 0;
  const r = await app.invoke('sync:restoreInfo');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.detailed, true);
  assert.equal(r.dir, await myDir());
  assert.equal(r.hostname, os.hostname());
  assert.equal(r.entries, 2);
  assert.ok(r.size > 0);
  assert.equal(r.source, 'local', '本机备份过就用本机目录里那份');
  assert.equal(r.sameMachine, true, '标识对得上');
  assert.deepEqual(stub.zipDownloads(), [], '确认前不该下载整包');
});

test('侧车没写成功时降级为 HEAD，且同样不下载整包', async () => {
  stub.hideMeta = true;
  stub.log.length = 0;
  const r = await app.invoke('sync:restoreInfo');
  assert.equal(r.ok, true);
  assert.equal(r.detailed, false);
  assert.equal(r.hostname, '');
  assert.equal(r.entries, 0);
  assert.ok(r.size > 0, '大小应回退到 HEAD 的 content-length');
  assert.deepEqual(stub.zipDownloads(), [], '降级路径同样不该下载整包');
  stub.hideMeta = false;
});

test('云端没有任何备份时报错', async () => {
  const savedFiles = new Map(stub.files);
  const savedDirs = new Set(stub.collections);
  stub.files.clear();
  stub.collections.clear();
  const r = await app.invoke('sync:restoreInfo');
  assert.equal(r.ok, false);
  assert.match(r.error, /没有找到任何备份/);
  stub.files = savedFiles;
  stub.collections = savedDirs;
});

test('非法备份名 / 非法目录名被拒绝，且不发出任何请求', async () => {
  const dir = await myDir();
  stub.log.length = 0;
  for (const name of ['../../evil.zip', 'cc-skill-backup-../x.zip', '', null, 'other.zip']) {
    const r = await app.invoke('sync:restoreApply', { dir, name });
    assert.equal(r.ok, false, `名字 ${JSON.stringify(name)} 不该通过`);
    assert.match(r.error, /不合法/);
  }
  // 目录名要拼进 URL，同样只允许单个路径片段
  for (const bad of ['../x', 'a/b', '..', '']) {
    const r = await app.invoke('sync:restoreApply', { dir: bad, name: 'cc-skill-backup-20260101-000000.zip' });
    assert.equal(r.ok, false, `目录 ${JSON.stringify(bad)} 不该通过`);
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
  const r = await app.invoke('sync:restoreApply', { dir: info.dir, name: info.name });
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

  const r = await app.invoke('sync:restoreApply', { dir: info.dir, name: info.name });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 3, 'HOME 之外的也要算上');
  assert.deepEqual(r.externalDirs, [], '本机配置里在用的目录不该被当成「配置之外」');
  assert.ok(fs.existsSync(path.join(outsideDir, 'outside', 'SKILL.md')), 'HOME 之外的目录也要还原');
  assert.ok(fs.existsSync(path.join(agentDir, 'alpha', 'SKILL.md')), 'HOME 之下的照旧');
});

test('不是本机自己的备份：绝对路径目录与项目配置一律跳过，不造幽灵目录', async () => {
  // 上面那条规则的另一面：备份里的绝对路径只有「本机配置里在用的」才直接写。
  // 从别的机器那个目录恢复时，那些路径指的是原机器的位置 —— 照着建只会得到一棵没人读的
  // 目录树，正是当初「换台电脑恢复出一堆幽灵目录」那个缺陷。
  const projDir = tmpDir('cc-skill-proj-');
  extraDirs.push(projDir);
  await app.invoke('config:set', { projects: [{ id: 'p1', dir: projDir, name: 'proj' }] });
  const up = await app.invoke('sync:backup');
  assert.equal(up.ok, true, JSON.stringify(up));
  const mine = await myDir();
  const info = await app.invoke('sync:restoreInfo', { dir: mine });

  // 冒充「另一台机器」：换掉本机标识，并且本机配置里没有 outsideDir 这个目录了
  await app.invoke('sync:resetMachine');
  await app.invoke('config:set', { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: [agentDir] }] });
  fs.rmSync(outsideDir, { recursive: true, force: true });

  const r = await app.invoke('sync:restoreApply', { dir: info.dir, name: info.name });
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
  const forced = await app.invoke('sync:restoreApply', { dir: info.dir, name: info.name, allowExternalDirs: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.deepEqual(forced.externalDirs, [], '写过了就不该再报');
  assert.ok(fs.existsSync(path.join(outsideDir, 'outside', 'SKILL.md')), '确认之后要真的写进去');
  await app.invoke('config:set', { projects: [] });
});

test('伪造 machineId 的备份包：不确认就地写不进任何绝对路径', async () => {
  // 回归防线。machineId 不是凭证 —— 它就写在目录名和每份备份包的 manifest 里，谁都能抄。
  // 曾经的做法是「包里的 destDir 与包里的 agents[].dirs 互相印证」，那等于让被恢复的
  // 文件自己给自己发通行证：两边都填同一个任意路径即可，用户点一次「确认恢复」就写进去了。
  const zipName = 'cc-skill-backup-20260201-010101.zip';
  const spoofDir = tmpDir('cc-skill-spoof-');
  extraDirs.push(spoofDir);
  fs.writeFileSync(path.join(spoofDir, 'user-file.txt'), '本机原有的文件', 'utf8');

  putZip(MY, zipName, {
    manifest: {
      app: 'CC Skill',
      manifestVersion: 1,
      created: new Date().toISOString(),
      hostname: 'evil',
      machineId: app.readConfig().machineId, // ← 抄来的标识，冒充「本机自己的备份」
      settings: { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: ['~/.claude/skills'] }] },
      targets: [{ id: 't0', destDir: spoofDir, kind: 'global', projectId: null, agentIds: ['claude-code'], count: 1 }],
      entries: [{ target: 't0', folder: 'pwn' }],
    },
    configJson: { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: [spoofDir] }], projects: [], ui: {} },
    tree: { t0: { pwn: {} } },
  });

  const r = await app.invoke('sync:restoreApply', { dir: MY, name: zipName });
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
  const again = await app.invoke('sync:restoreApply', { dir: MY, name: zipName });
  assert.equal(again.ok, true);
  assert.ok(!fs.existsSync(path.join(spoofDir, 'pwn', 'SKILL.md')), '重复恢复也不能绕过去');
  assert.ok(!(app.readConfig().agents[0].dirs || []).some((d) => d.includes(path.basename(spoofDir))), '外来绝对路径不该被并进本机配置');
  stub.remove(`/dav/${MY}/${zipName}`);
});

test('~ 形式的目标目录同样要过「本机配置」这道门', async () => {
  // 回归防线。~ 形式看着无害（反正落在 home 里），但 home 底下是 .ssh / .aws 这些真东西：
  // 一个 `destDir: '~'`、folder 是 `.ssh` 的包，会让 removePath 把整个 ~/.ssh 删掉重建成一个目录。
  // 所以 ~ 形式和绝对路径一个待遇 —— 只认「本机配置里在用的目录」或用户点过头的
  const zipName = 'cc-skill-backup-20260208-080808.zip';
  const victim = path.join(root, '.ssh');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'id_rsa'), '本机私钥', 'utf8');

  putZip(MY, zipName, {
    manifest: {
      app: 'CC Skill',
      manifestVersion: 1,
      created: new Date().toISOString(),
      hostname: 'evil',
      machineId: app.readConfig().machineId,
      settings: { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: ['~/.claude/skills'] }] },
      targets: [{ id: 't0', destDir: '~', kind: 'global', projectId: null, agentIds: ['claude-code'], count: 1 }],
      entries: [{ target: 't0', folder: '.ssh' }],
    },
    configJson: { agents: [], projects: [], ui: {} },
    tree: { t0: { '.ssh': { 'SKILL.md': 'x' } } },
  });

  const r = await app.invoke('sync:restoreApply', { dir: MY, name: zipName });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 0, '不在本机配置里的 ~ 目录不该直接写');
  assert.deepEqual(r.externalDirs, [{ dir: '~', count: 1 }], '要交给用户判断');
  assert.ok(fs.existsSync(path.join(victim, 'id_rsa')), '绝不能把 ~/.ssh 删掉');
  stub.remove(`/dav/${MY}/${zipName}`);
  fs.rmSync(victim, { recursive: true, force: true });
});

test('声明里带 .. 或不是绝对路径的目标一律当非法数据丢掉', async () => {
  // expand('~/../..') 会落到 home 之外 —— 备份包是外来输入，没有理由需要这种目标目录。
  const zipName = 'cc-skill-backup-20260203-030303.zip';
  const escaped = path.join(tmpDir('cc-skill-escape-'), 'target');
  extraDirs.push(path.dirname(escaped));
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

  for (const destDir of ['~/../' + path.basename(escaped), 'relative/dir']) {
    putZip(MY, zipName, {
      manifest: makeManifest(destDir),
      configJson: { agents: [], projects: [], ui: {} },
      tree: { t0: { dots: {} } },
    });
    const r = await app.invoke('sync:restoreApply', { dir: MY, name: zipName, allowExternalDirs: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.restored, 0, `${destDir} 不该被写入`);
    assert.equal(r.skippedInvalid, 1, `${destDir} 应被记成非法条目`);
  }
  assert.ok(!fs.existsSync(path.join(escaped, 'dots')), '不该在 home 之外造出目录');
  stub.remove(`/dav/${MY}/${zipName}`);
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
  const dirA = await myDir();

  // 重装系统：新标识，配置回到初始状态（没有项目、没有 HOME 之外的目录）
  const reset = await app.invoke('sync:resetMachine');
  assert.notEqual(reset.machineId, machineA, '重装后是个新标识');
  await app.invoke('config:set', { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: [agentDir] }], projects: [] });
  fs.rmSync(outsideDir, { recursive: true, force: true });

  // 本机没有自己的目录 → 弹窗退回最近上传的那台机器（而且正是原来那个目录）
  const info = await app.invoke('sync:restoreInfo');
  assert.equal(info.dir, dirA, '新机器没有自己的目录，退回最近上传的那台');
  assert.equal(info.source, 'latest');
  assert.equal(info.sameMachine, false, '换了标识，这份备份就不再算本机的');
  assert.equal(info.machineId, machineA, '弹窗要拿到备份来自哪台机器，才能提示认领');

  // 第一遍：认领 + 把本机认识的部分恢复回来。HOME 之外的目录来自备份包、本机配置里没有，
  // 所以要交给用户点头（这一步就是「由用户断言，而不是由包自证」的落点）
  const adopted = await app.invoke('sync:restoreApply', { dir: info.dir, name: info.name, adoptMachine: true });
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
  const forced = await app.invoke('sync:restoreApply', { dir: info.dir, name: info.name, allowExternalDirs: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.deepEqual(forced.externalDirs, []);
  assert.ok(fs.existsSync(path.join(outsideDir, 'outside', 'SKILL.md')), '确认之后目录真的落回来了');
  await app.invoke('config:set', { projects: [] });
});

test('认领之后仍然写回原来那个目录，不会因为改名多开一个', async () => {
  // 认领回来的机器，名字可能已经和当初建目录时不一样了。目录名是按「当时的名字」算出来的，
  // 所以必须靠 machine.json 里的标识找回来 —— 否则每认领/改名一次就多一个目录，
  // 旧备份再也没人认领
  await app.invoke('sync:renameMachine', { machineId: app.readConfig().machineId, name: '换了个名字' });
  const before = await myDir();
  const dirsBefore = stub.machineDirs().length;
  const up = await app.invoke('sync:backup');
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.equal(await myDir(), before, '改名不该搬目录');
  assert.equal(stub.machineDirs().length, dirsBefore, '也不该新开一个');
  await app.invoke('sync:renameMachine', { machineId: app.readConfig().machineId, name: '' });
});

test('认领之后恢复失败：本机标识要还回去', async () => {
  // 认领是立刻落盘的（否则后面算 sameMachine 用的就不是新身份）。所以失败路径必须回滚：
  // 用户看到「恢复失败」而标识已经成了别人的，下一次备份就会写进对方的目录。
  const machineA = app.readConfig().machineId;
  await app.invoke('sync:resetMachine');
  const machineB = app.readConfig().machineId;
  assert.notEqual(machineA, machineB);

  // 一个结构上合法、落地时必定抛错的包：目标目录的父级是一条文件，mkdir 会 ENOTDIR。
  // 落点必须是「本机配置里在用的目录」，所以先把它登记成一个 Agent 目录 ——
  // 这条用例要测的是失败回滚，不是落点审查
  const blocked = path.join(root, 'blocked');
  fs.writeFileSync(blocked, '这里是一条文件，不是目录', 'utf8');
  await app.invoke('config:set', { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: [agentDir, '~/blocked/sub'] }] });
  const zipName = 'cc-skill-backup-20260202-020202.zip';
  putZip(MY, zipName, {
    manifest: {
      app: 'CC Skill',
      manifestVersion: 1,
      created: new Date().toISOString(),
      hostname: 'x',
      machineId: machineA, // 认领它
      settings: { agents: [] },
      targets: [{ id: 't0', destDir: '~/blocked/sub', kind: 'global', projectId: null, agentIds: ['claude-code'], count: 1 }],
      entries: [{ target: 't0', folder: 'boom' }],
    },
    configJson: { agents: [], projects: [], ui: {} },
    tree: { t0: { boom: {} } },
  });

  const r = await app.invoke('sync:restoreApply', { dir: MY, name: zipName, adoptMachine: true });
  assert.equal(r.ok, false, '写不进去就该报失败');
  assert.equal(app.readConfig().machineId, machineB, '认领要回滚，别让用户看到「失败」而身份已是别人的');

  fs.rmSync(blocked, { force: true });
  await app.invoke('config:set', { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: [agentDir] }] });
  stub.remove(`/dav/${MY}/${zipName}`);
});

test('包里没有 machineId 时认领无从谈起，但 SKILL 该照常恢复', async () => {
  const zipName = 'cc-skill-backup-20260204-040404.zip';
  putZip(MY, zipName, {
    manifest: {
      app: 'CC Skill',
      manifestVersion: 1,
      created: new Date().toISOString(),
      hostname: 'old',
      // 刻意不写 machineId
      settings: { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: ['~/.claude/skills'] }] },
      targets: [{ id: 't0', destDir: '~/.claude/skills', kind: 'global', projectId: null, agentIds: ['claude-code'], count: 1 }],
      entries: [{ target: 't0', folder: 'noid' }],
    },
    configJson: { agents: [], projects: [], ui: {} },
    tree: { t0: { noid: {} } },
  });

  const r = await app.invoke('sync:restoreApply', { dir: MY, name: zipName, adoptMachine: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 1, '认领无从谈起，但 SKILL 该照常恢复');
  assert.equal(r.adoptedMachine, false);
  assert.ok(fs.existsSync(path.join(agentDir, 'noid', 'SKILL.md')));
  stub.remove(`/dav/${MY}/${zipName}`);
});

test('恢复：备份里的 WebDAV 地址与本机不同时清空本机密码，相同时留着', async () => {
  // 备份包躺在云端（还可能被分享出去），里面不该有密码；而恢复必须能连上云端，
  // 说明凭据本来就在本机配置里 —— 所以剥掉它不损失什么，却少一份泄露面
  const zipName = 'cc-skill-backup-20260205-050505.zip';
  const putConfig = (webdav) => {
    putZip(MY, zipName, {
      manifest: {
        app: 'CC Skill',
        manifestVersion: 1,
        created: new Date().toISOString(),
        hostname: 'x',
        machineId: app.readConfig().machineId,
        settings: { agents: [] },
        targets: [{ id: 't0', destDir: '~/.claude/skills', kind: 'global', projectId: null, agentIds: ['claude-code'], count: 1 }],
        entries: [{ target: 't0', folder: 'w' }],
      },
      configJson: { agents: [], projects: [], ui: {}, webdav },
      tree: { t0: { w: {} } },
    });
  };

  // ① 备份里的地址是别人的 → 本机密码必须清掉（否则下一次备份把它发到那个地址去）
  await app.invoke('sync:setConfig', { webdav: makeWebdavConfig(stub.url) });
  assert.equal(app.readConfig().webdav.password, 'p', '前提：本机有密码');
  putConfig({ url: 'https://someone-else.test/dav', username: 'attacker', remotePath: 'dav' });
  const moved = await app.invoke('sync:restoreApply', { dir: MY, name: zipName });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.passwordCleared, true, '要告诉界面密码被清空了');
  assert.equal(app.readConfig().webdav.url, 'https://someone-else.test/dav');
  assert.equal(app.readConfig().webdav.password, '', '密码不能跟着备份里的地址走');

  // ② 地址与账号都一样（本机自己的备份就是这样，只差结尾斜杠）→ 密码留着，不该逼用户重填
  await app.invoke('sync:setConfig', { webdav: makeWebdavConfig(stub.url) });
  putConfig({ url: stub.url + '/', username: 'u', remotePath: 'dav' });
  const same = await app.invoke('sync:restoreApply', { dir: MY, name: zipName });
  assert.equal(same.ok, true, JSON.stringify(same));
  assert.equal(same.passwordCleared, false, '同一个服务器不该清密码');
  assert.equal(app.readConfig().webdav.password, 'p');
  stub.remove(`/dav/${MY}/${zipName}`);
});

test('备份包损坏时失败且不落地任何文件、不残留临时目录', async () => {
  const info = await app.invoke('sync:restoreInfo');
  const tempsBefore = listRestoreTemps();
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.mkdirSync(agentDir, { recursive: true });

  stub.corruptZip = true;
  const r = await app.invoke('sync:restoreApply', { dir: info.dir, name: info.name });
  stub.corruptZip = false;

  assert.equal(r.ok, false);
  assert.deepEqual(fs.readdirSync(agentDir), [], '失败时不该写入任何东西');
  assertNoNewTemps(tempsBefore);
});

test('远端 404 时失败且不残留临时目录', async () => {
  const tempsBefore = listRestoreTemps();
  const r = await app.invoke('sync:restoreApply', { dir: MY, name: 'cc-skill-backup-19990101-000000.zip' });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /404/);
  assertNoNewTemps(tempsBefore);
});

test('恢复会一并还原备份里的设置（Agents / 项目 / 语言）', async () => {
  // 本地把界面偏好改掉，恢复后不该被旧备份的 config.json 清空
  await app.invoke('config:set', { ui: { lang: 'en', overlayBlur: 6, overlayDim: 0.7 } });

  const info = await app.invoke('sync:restoreInfo');
  const r = await app.invoke('sync:restoreApply', { dir: info.dir, name: info.name });
  assert.equal(r.ok, true);
  assert.equal(r.appliedConfig, true, '备份里带了 config.json，应一并恢复');

  const ui = app.readConfig().ui;
  assert.equal(ui.lang, 'zh', '语言以备份为准');
  assert.equal(typeof ui.overlayBlur, 'number', '遮罩配置不该被清掉');
  assert.equal(typeof ui.overlayDim, 'number');
});

// ------------------------------ 项目级 SKILL ---------------------------------
// 项目路径是机器相关的，所以项目级 SKILL 只在「这份备份是本机的」时还原；
// 而落点还有一道更硬的门：必须在**本机注册过的**项目目录里。
test('本机自己的备份：项目级 SKILL 一起回来', async () => {
  const projDir = tmpDir('cc-skill-proj-restore-');
  extraDirs.push(projDir);
  const projSkills = path.join(projDir, '.claude', 'skills');
  await app.invoke('config:set', { projects: [{ id: 'p1', dir: projDir, name: 'proj' }] });
  writeSkill(projSkills, 'proj-skill');

  const up = await app.invoke('sync:backup');
  assert.equal(up.ok, true, JSON.stringify(up));
  const info = await app.invoke('sync:restoreInfo');
  assert.equal(info.projectCount, 1, '侧车要记着有几个项目级 SKILL');

  fs.rmSync(projSkills, { recursive: true, force: true });
  const r = await app.invoke('sync:restoreApply', { dir: info.dir, name: info.name });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.sameMachine, true);
  assert.equal(r.restoredProjects, 1, '本机备份要把项目级 SKILL 还原');
  assert.equal(r.skippedProjects, 0);
  assert.ok(fs.existsSync(path.join(projSkills, 'proj-skill', 'SKILL.md')), '项目级 SKILL 要真的落回去');
});

test('项目落点不在本机登记的项目里：列给用户确认，形状不对的连确认机会都没有', async () => {
  // 备份包说它在哪个项目里不算数，本机认识这个项目才算 —— 与全局那条「配置说了才算」同一个规矩。
  // 而「在项目目录之内」还不够：项目根目录本身也在之内，一条 destDir 指项目根、folder 是
  // `.git` 的条目能把整个仓库连根删掉，所以落点还必须是某个项目的 SKILL 目录那个形状
  const projDir = tmpDir('cc-skill-proj-gate-');
  extraDirs.push(projDir);
  const projSkills = path.join(projDir, '.claude', 'skills');
  const zipName = 'cc-skill-backup-20260207-070707.zip';
  const manifest = (targets, entries) => ({
    app: 'CC Skill',
    manifestVersion: 1,
    created: new Date().toISOString(),
    hostname: 'x',
    machineId: app.readConfig().machineId, // 本机的备份（项目级 SKILL 才谈得上）
    settings: { agents: [] },
    targets,
    entries,
  });
  // ① 落点形状对，但包里的项目列表是空的 → 本机不认识它，交给用户确认
  putZip(MY, zipName, {
    manifest: manifest(
      [{ id: 't0', destDir: projSkills, kind: 'project', projectId: 'p9', agentIds: ['claude-code'], count: 1 }],
      [{ target: 't0', folder: 'proj-skill' }]
    ),
    configJson: { agents: [], projects: [], ui: {} },
    tree: { t0: { 'proj-skill': {} } },
  });

  const first = await app.invoke('sync:restoreApply', { dir: MY, name: zipName });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.sameMachine, true, '（前提）标识是本机的');
  assert.equal(first.restoredProjects, 0);
  assert.deepEqual(first.externalDirs, [{ dir: projSkills, count: 1 }], '要列出来交给用户，而不是静默丢掉');
  assert.ok(!fs.existsSync(path.join(projSkills, 'proj-skill', 'SKILL.md')), '没确认就不写');

  // 用户点头之后才写
  const forced = await app.invoke('sync:restoreApply', { dir: MY, name: zipName, allowExternalDirs: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(forced.restoredProjects, 1, '确认之后要真的写进去');
  assert.ok(fs.existsSync(path.join(projSkills, 'proj-skill', 'SKILL.md')));
  fs.rmSync(projSkills, { recursive: true, force: true });

  // ② 落点形状不对（项目根目录、folder 是 .git）→ 当非法数据丢掉，连确认都不给
  fs.mkdirSync(path.join(projDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(projDir, '.git', 'config'), '本机原有的 git 配置', 'utf8');
  putZip(MY, zipName, {
    manifest: manifest(
      [{ id: 't0', destDir: projDir, kind: 'project', projectId: 'p9', agentIds: ['claude-code'], count: 1 }],
      [{ target: 't0', folder: '.git' }]
    ),
    configJson: { agents: [], projects: [{ id: 'p9', name: 'p', dir: projDir }], ui: {} },
    tree: { t0: { '.git': { config: '被替换了' } } },
  });
  const bad = await app.invoke('sync:restoreApply', { dir: MY, name: zipName, allowExternalDirs: true });
  assert.equal(bad.ok, true, JSON.stringify(bad));
  assert.equal(bad.restoredProjects, 0, '形状不对的落点一律不写');
  assert.equal(bad.skippedInvalid, 1);
  assert.deepEqual(bad.externalDirs, [], '连「交给用户确认」都不该有 —— 它根本不是个 SKILL 目录');
  assert.equal(fs.readFileSync(path.join(projDir, '.git', 'config'), 'utf8'), '本机原有的 git 配置', '仓库不能被连根删掉');
  stub.remove(`/dav/${MY}/${zipName}`);
  await app.invoke('config:set', { projects: [] });
});

test('重装 + 认领：项目配置与项目级 SKILL 一次全回来', async () => {
  // 认领回来的项目列表是这一次恢复才写进本机配置的，项目级 SKILL 的落点判定必须在那之后做 ——
  // 否则第一次恢复会把项目 SKILL 全判成「项目没登记过」，用户得点两次
  const projDir = tmpDir('cc-skill-proj-claim-');
  extraDirs.push(projDir);
  const projSkills = path.join(projDir, '.claude', 'skills');
  await app.invoke('config:set', { projects: [{ id: 'p1', dir: projDir, name: 'proj' }] });
  writeSkill(projSkills, 'proj-skill');
  assert.equal((await app.invoke('sync:backup')).ok, true);
  const machineA = app.readConfig().machineId;

  // 重装：新标识 + 空的配置（没有项目）
  await app.invoke('sync:resetMachine');
  await app.invoke('config:set', { projects: [] });
  fs.rmSync(projSkills, { recursive: true, force: true });

  const info = await app.invoke('sync:restoreInfo');
  const r = await app.invoke('sync:restoreApply', { dir: info.dir, name: info.name, adoptMachine: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(app.readConfig().machineId, machineA, '认领成功');
  assert.deepEqual(r.externalDirs, [], '项目落点正是本机（刚认领回来）的项目，不必再问一次');
  assert.equal(r.restoredProjects, 1, '一次就够，不需要恢复两遍');
  assert.ok(fs.existsSync(path.join(projSkills, 'proj-skill', 'SKILL.md')));
  await app.invoke('config:set', { projects: [] });
});

test('别台机器的备份：项目级 SKILL 一律不恢复', async () => {
  const projDir = tmpDir('cc-skill-proj-other-');
  extraDirs.push(projDir);
  const projSkills = path.join(projDir, '.claude', 'skills');
  const zipName = 'cc-skill-backup-20260206-060606.zip';
  putZip(FOREIGN, zipName, {
    manifest: {
      app: 'CC Skill',
      manifestVersion: 1,
      created: new Date().toISOString(),
      hostname: 'OLD-PC',
      machineId: FOREIGN_ID,
      settings: { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: ['~/.claude/skills'] }] },
      targets: [
        { id: 't0', destDir: '~/.claude/skills', kind: 'global', projectId: null, agentIds: ['claude-code'], count: 1 },
        { id: 't1', destDir: projDir + '/.claude/skills', kind: 'project', projectId: 'p9', agentIds: ['claude-code'], count: 1 },
      ],
      entries: [
        { target: 't0', folder: 'g' },
        { target: 't1', folder: 'proj-skill' },
      ],
    },
    configJson: { agents: [], projects: [], ui: {} },
    // 项目那一条的源在包里的 t1 下：目标目录不是本机的，所以它连碰都不该碰
    tree: { t0: { g: {} }, t1: { 'proj-skill': {} } },
  });

  await app.invoke('config:set', { projects: [{ id: 'p1', dir: projDir, name: 'proj' }] });
  const r = await app.invoke('sync:restoreApply', { dir: FOREIGN, name: zipName });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.sameMachine, false);
  assert.equal(r.restored, 1, '全局的那一个照旧还原');
  assert.equal(r.restoredProjects, 0, '别台机器的项目级 SKILL 不恢复');
  assert.ok(!fs.existsSync(path.join(projSkills, 'proj-skill', 'SKILL.md')));
  await app.invoke('config:set', { projects: [] });
  stub.remove(`/dav/${FOREIGN}/${zipName}`);
});

// ------------------------------ 机器档案 --------------------------------------
// 这一段按「本机标识还是原来那个」为前提写，所以改标识的用例放在最后。

test('机器档案：列出云端每台机器，本机排在最前，各自带着自己的备份', async () => {
  const foreignZip = writeForeignDir();
  // 本机再多备一份，好验「每台机器各自列出自己的备份」。
  // 先清掉机器名，这样「没起过名就用 hostname」不依赖前面用例留下的状态
  await app.invoke('sync:renameMachine', { machineId: app.readConfig().machineId, name: '' });
  assert.equal((await app.invoke('sync:backup')).ok, true);

  const r = await app.invoke('sync:machines');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.machines[0].self, true, '本机排最前');
  assert.equal(r.machines[0].name, os.hostname(), '没起过名就用 hostname');
  assert.deepEqual(
    r.machines[0].backups.map((b) => b.name),
    stub.backupsIn(await myDir()),
    '本机列出自己目录里的全部备份'
  );
  assert.ok(r.machines[0].latest.entries > 0, '最新那份要带明细');
  // 名字里有非法字符的机器标识不该被当成「本机」
  assert.equal(r.machines.filter((m) => m.self).length, 1);

  const foreign = r.machines.find((m) => m.machineId === FOREIGN_ID);
  assert.equal(foreign.dir, FOREIGN);
  assert.equal(foreign.name, '旧笔记本', '没别名时用那台机器自己声明的名字');
  assert.equal(foreign.hostname, 'OLD-PC', '真实 hostname 留着，换名不该让排查时认不出机器');
  assert.deepEqual(foreign.backups, [{ name: foreignZip, created: new Date(2026, 0, 1, 1, 1, 1).toISOString() }]);
  assert.equal(foreign.latest.entries, 2);
  assert.equal(foreign.unreadable, false);
});

test('档案坏掉的目录照样列出来（它正是最该被删的那种）', async () => {
  // 目录名里也没有标识可认（不是 slug-标识 那个形状）→ 认不出是谁，但备份还在，仍要能恢复、能删
  stub.collections.add('/dav/broken-folder');
  stub.writeJson('/dav/broken-folder/machine.json', { machineId: '不合法的 标识!' });
  stub.writeJson('/dav/broken-folder/cc-skill-backup-20260301-010101.zip', { fake: true });

  const r = await app.invoke('sync:machines');
  const broken = r.machines.find((m) => m.dir === 'broken-folder');
  assert.ok(broken, '档案坏掉的目录也要出现');
  assert.equal(broken.unreadable, true);
  assert.equal(broken.machineId, '', '认不出标识');
  assert.equal(broken.name, 'broken-folder', '没有可用名字时用目录名');
  assert.equal(broken.backups.length, 1, '备份还是要列出来 —— 它仍然能被恢复');
  stub.collections.delete('/dav/broken-folder');
});

test('别台机器的备份：可以挑历史副本恢复', async () => {
  const older = 'cc-skill-backup-20250101-010101.zip';
  putZip(FOREIGN, older, {
    manifest: {
      app: 'CC Skill',
      manifestVersion: 1,
      created: '2025-01-01T01:01:01.000Z',
      hostname: 'OLD-PC',
      machineId: FOREIGN_ID,
      settings: { agents: [{ id: 'claude-code', name: 'Claude Code', dirs: ['~/.claude/skills'] }] },
      targets: [{ id: 't0', destDir: '~/.claude/skills', kind: 'global', projectId: null, agentIds: ['claude-code'], count: 1 }],
      entries: [{ target: 't0', folder: 'old' }],
    },
    configJson: { agents: [], projects: [], ui: {} },
    tree: { t0: { old: {} } },
  });

  const list = await app.invoke('sync:machines');
  const foreign = list.machines.find((m) => m.machineId === FOREIGN_ID);
  assert.equal(foreign.backups.length, 2, '两份都要列出来');
  assert.equal(foreign.backups[0].name, older, '按文件名时间戳排序');
  assert.equal(foreign.backups[0].created, new Date(2025, 0, 1, 1, 1, 1).toISOString(), '时间从文件名解析，不必为每份都发一次请求');

  // 指定早的那一份：能打开弹窗信息，也能真的恢复（这份的侧车不存在 → 降级为 HEAD）
  const info = await app.invoke('sync:restoreInfo', { dir: FOREIGN, name: older });
  assert.equal(info.ok, true, JSON.stringify(info));
  assert.equal(info.name, older);
  assert.equal(info.source, 'latest', '不是本机目录里那份');
  assert.equal(info.sameMachine, false);
  assert.ok(info.size > 0, '没有侧车就退回 HEAD 拿大小');
  const r = await app.invoke('sync:restoreApply', { dir: FOREIGN, name: older });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 1, '恢复的是挑中的那一份，不是最新那份');
  stub.remove(`/dav/${FOREIGN}/${older}`);
});

test('保留策略：本机目录最多留 10 份，别台机器的目录一份也不动', async () => {
  const dir = await myDir();
  // 直接往云端塞 12 份（快过文件名的时间戳精度 —— 连打十几次备份都落在同一秒，
  // 名字会撞在一起，测不出策略）
  const names = [];
  for (let i = 0; i < 12; i++) {
    const n = `cc-skill-backup-2026070${i < 10 ? i : 9}-0${i % 10}0000.zip`;
    names.push(n);
  }
  for (const n of [...new Set(names)].sort()) stub.writeJson(`/dav/${dir}/${n}`, { fake: true });

  assert.equal((await app.invoke('sync:backup')).ok, true);
  const kept = stub.backupsIn(dir);
  assert.equal(kept.length, 10, `本机目录只该留 10 份，实际 ${kept.length}`);
  assert.deepEqual(kept, kept.slice().sort(), '留下的应是最新的 10 份');
  assert.ok(!kept.includes('cc-skill-backup-20260700-000000.zip'), '最旧的要被清掉');
  // 侧车跟着备份一起走，别留一堆指向不存在备份的孤儿文件
  assert.ok(!stub.filesIn(dir).includes('cc-skill-backup-20260700-000000.zip.json'), '侧车要跟着删');
  assert.equal(stub.backupsIn(FOREIGN).length, 1, '别人的目录不归我们清理');
});

test('机器改名：本机改自己的名字，别的机器记成本机别名', async () => {
  const self = app.readConfig().machineId;
  const r1 = await app.invoke('sync:renameMachine', { machineId: self, name: '  我的 台式机  ' });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.self, true);
  assert.equal(app.readConfig().machineName, '我的 台式机', '进去之前先归一化');

  const r2 = await app.invoke('sync:renameMachine', { machineId: FOREIGN_ID, name: '老笔记本' });
  assert.equal(r2.ok, true);
  assert.equal(r2.self, false);
  assert.deepEqual(app.readConfig().machineNames, { [FOREIGN_ID]: '老笔记本' }, '别名只落本机配置');

  const list = await app.invoke('sync:machines');
  assert.equal(list.machines.find((m) => m.self).name, '我的 台式机');
  assert.equal(list.machines.find((m) => m.machineId === FOREIGN_ID).name, '老笔记本', '别名优先于档案里的名字');
  assert.equal(stub.readJson(`/dav/${FOREIGN}/machine.json`).machineName, '旧笔记本', '别名不写回云端（那台机器下次备份会覆盖掉）');

  assert.equal((await app.invoke('sync:renameMachine', { machineId: '../evil', name: 'x' })).ok, false);

  // 空名字 = 清掉：本机回落到 hostname，别名直接删 —— 弹窗上就是这么承诺的，
  // 不然机器一旦改过名就再也回不到 hostname
  assert.equal((await app.invoke('sync:renameMachine', { machineId: FOREIGN_ID, name: '   ' })).ok, true);
  assert.deepEqual(app.readConfig().machineNames, {}, '空名字要把别名删掉');
  assert.equal((await app.invoke('sync:renameMachine', { machineId: self, name: '' })).ok, true);
  assert.equal(app.readConfig().machineName, '');
  const back = await app.invoke('sync:machines');
  assert.equal(back.machines.find((m) => m.self).name, os.hostname(), '清空后回落 hostname');
});

test('删除机器：整个目录连同它的备份一起消失，别人的目录不动', async () => {
  const foreignBackups = stub.backupsIn(FOREIGN);
  assert.ok(foreignBackups.length > 0, '前提：别台机器目录里有备份');

  const r = await app.invoke('sync:deleteMachine', { dir: FOREIGN });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.deleted, foreignBackups.length, '确认框要能写明删掉了几份');
  assert.deepEqual(stub.backupsIn(FOREIGN), [], '目录里的备份全没了');
  assert.equal(stub.readJson(`/dav/${FOREIGN}/machine.json`), null, '档案也没了');
  assert.ok(!stub.collections.has(`/dav/${FOREIGN}`), '目录本身也删掉');

  // 本机自己的目录不给删：下一次备份会立刻写回来，要换身份该走认领或重置
  const my = await myDir();
  const self = await app.invoke('sync:deleteMachine', { dir: my });
  assert.equal(self.ok, false);
  assert.equal(self.reason, 'self');
  assert.ok(stub.backupsIn(my).length > 0, '拒绝了就不该真的删掉');
  assert.equal((await app.invoke('sync:deleteMachine', { dir: '../x' })).ok, false, '路径穿越挡在目录名校验上');

  // 档案被人改成别的标识、机器又改过名 —— 两处「本该认出本机」的线索都断了，
  // 目录名尾部的标识还得兜住
  await app.invoke('sync:renameMachine', { machineId: app.readConfig().machineId, name: 'NEW-NAME' });
  const profileKey = stub.machineProfilePath(my);
  const saved = stub.files.get(profileKey);
  stub.writeJson(profileKey, { machineId: 'someone-else', machineName: 'x', hostname: 'x' });
  const stillSelf = await app.invoke('sync:deleteMachine', { dir: my });
  assert.equal(stillSelf.ok, false, '目录名里还写着本机标识，就该继续拒绝');
  assert.equal(stillSelf.reason, 'self');
  stub.files.set(profileKey, saved);
  await app.invoke('sync:renameMachine', { machineId: app.readConfig().machineId, name: '' });
});

test('删除某一份备份：只删那一份和它的侧车', async () => {
  const dir = await myDir();
  const [oldest] = stub.backupsIn(dir);
  const before = stub.backupsIn(dir).length;

  const r = await app.invoke('sync:deleteBackup', { dir, name: oldest });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(stub.backupsIn(dir).length, before - 1);
  assert.ok(!stub.filesIn(dir).includes(oldest + '.json'), '侧车一并删掉');
  assert.equal((await app.invoke('sync:deleteBackup', { dir, name: '../../evil.zip' })).ok, false);
  assert.equal((await app.invoke('sync:deleteBackup', { dir: '../x', name: oldest })).ok, false);
});

test('目录名与档案里的字段先归一化再用（别人写的、或坏掉的文件都可能）', async () => {
  stub.writeJson('/dav/hostile-9f8e7d6c-5b4a-4938-8271-111111111111/machine.json', {
    machineId: '../../etc/passwd',
    machineName: 'x'.repeat(200),
    hostname: '坏 主机\n名',
  });
  const r = await app.invoke('sync:machines');
  assert.equal(r.ok, true, JSON.stringify(r));
  const m = r.machines.find((x) => x.dir === 'hostile-9f8e7d6c-5b4a-4938-8271-111111111111');
  assert.ok(m, '坏档案的目录照样列出来');
  assert.equal(m.machineId, '9f8e7d6c-5b4a-4938-8271-111111111111', '不合形状的标识退回目录名尾部那个');
  assert.equal(m.self, false, '标识非法就不可能是「本机」');
  assert.equal(m.name.length, 40, '名字按机器名的规则限长');
  assert.ok(
    [...m.hostname].every((ch) => ch.codePointAt(0) >= 32 && ch.codePointAt(0) !== 127),
    '控制字符要被换掉'
  );
  assert.deepEqual(m.backups, [], '目录里没有备份就是空的');
  stub.collections.delete('/dav/hostile-9f8e7d6c-5b4a-4938-8271-111111111111');
});

test('本机还没在这里备份过时，档案列表也补一行空的自己', async () => {
  // 自己先换一个新标识：这样本机在云端就一定没有目录（别依赖前面用例留下的状态）。
  // 这一行要能一眼看出「我在不在这儿」，也留个改名的入口
  const fresh = await app.invoke('sync:resetMachine');
  assert.equal(fresh.ok, true);
  assert.ok(!stub.machineDirs().some((d) => d.endsWith(fresh.machineId)), '前提：云端没有这个标识的目录');
  await app.invoke('sync:renameMachine', { machineId: fresh.machineId, name: '' });

  const r = await app.invoke('sync:machines');
  assert.equal(r.ok, true, JSON.stringify(r));
  const self = r.machines.filter((m) => m.self);
  assert.equal(self.length, 1, '本机那一行要在，且只有一行');
  assert.equal(self[0].machineId, fresh.machineId);
  assert.equal(self[0].dir, 'desktop-dp04gj0-' + fresh.machineId, '这一行给出它将会用的目录名');
  assert.ok(!stub.machineDirs().includes(self[0].dir), '而云端确实还没有这个目录');
  assert.deepEqual(self[0].backups, [], '还没备份过');
  assert.equal(self[0].name, os.hostname(), '没起过名就显示 hostname');
});

test('认领与重置本机标识', async () => {
  const before = app.readConfig().machineId;
  const adopted = await app.invoke('sync:adoptMachine', { machineId: FOREIGN_ID });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.changed, true);
  assert.equal(app.readConfig().machineId, FOREIGN_ID);
  // 已经就是这个标识时不算失败，只是没变
  const again = await app.invoke('sync:adoptMachine', { machineId: FOREIGN_ID });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal((await app.invoke('sync:adoptMachine', { machineId: 'bad id!' })).ok, false);

  const reset = await app.invoke('sync:resetMachine');
  assert.equal(reset.ok, true);
  assert.notEqual(reset.machineId, FOREIGN_ID);
  assert.notEqual(reset.machineId, before);
  assert.equal(app.readConfig().machineId, reset.machineId);
});
