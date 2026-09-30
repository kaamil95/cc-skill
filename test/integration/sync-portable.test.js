// 跨机器恢复：备份包里存的是 ~ 形式路径，恢复时按「本机」的 home 展开。
// 这是「换台电脑恢复出一堆没人读的幽灵目录」那个缺陷的回归防线——
// sync.test.js 备份与恢复用的是同一个用户目录，永远测不到这类问题。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { startApp } = require('../helpers/harness');
const { writeSkill, makeConfig, makeWebdavConfig, tmpDir, zipDir, captureHomeEnv, setHome, restoreHomeEnv } = require('../helpers/fixtures');
const { WebdavStub } = require('../helpers/webdav-stub');
const { unpackZip } = require('../../src/zip');
// 自动备份由主进程调度、没有 IPC 通道，直接 require 模块——harness 与本文件共用同一份
// require 缓存，拿到的是和 IPC 处理器同一个实例（含同一份 config）
const webdav = require('../../src/webdav');
const { getConfig } = require('../../src/config');

// 靠改 os.homedir() 的取值来模拟「另一台电脑」：Windows 认 USERPROFILE，POSIX 认 HOME
const ORIG_HOME_ENV = captureHomeEnv();

let app;
let stub;
let homeA;
let homeB;
let claudeDir;
let codexDir;
let projDir;
let projSkillDir;

before(async () => {
  homeA = tmpDir('cc-skill-homeA-');
  homeB = tmpDir('cc-skill-homeB-');
  setHome(homeA);

  claudeDir = path.join(homeA, '.claude', 'skills');
  codexDir = path.join(homeA, '.codex', 'skills');
  projDir = path.join(homeA, 'work', 'myproj');
  projSkillDir = path.join(projDir, '.claude', 'skills');
  for (const d of [claudeDir, codexDir, projSkillDir]) fs.mkdirSync(d, { recursive: true });

  writeSkill(claudeDir, 'alpha');
  writeSkill(codexDir, 'beta');
  writeSkill(projSkillDir, 'proj-skill');

  stub = new WebdavStub();
  const url = await stub.start();
  app = await startApp({
    config: makeConfig({
      agents: [
        { id: 'claude-code', name: 'Claude Code', color: '#e07a4f', dirs: [claudeDir] },
        { id: 'codex', name: 'Codex', color: '#19b39a', dirs: [codexDir] },
      ],
      projects: [{ id: 'p1', name: 'myproj', dir: projDir }],
      webdav: makeWebdavConfig(url),
    }),
  });
});

after(() => {
  app.cleanup();
  stub.stop();
  restoreHomeEnv(ORIG_HOME_ENV);
  for (const d of [homeA, homeB]) fs.rmSync(d, { recursive: true, force: true });
});

test('备份包存的是 ~ 形式路径，不含上传机器的用户目录', async () => {
  // 先起个名、给别的机器起个别名：这两样都不该随备份上云（别名是本机自己的显示信息；
  // 机器名只走 manifest 顶层）
  await app.invoke('sync:renameMachine', { machineId: app.readConfig().machineId, name: '我的台式机' });
  await app.invoke('sync:renameMachine', { machineId: 'some-other-machine', name: '老笔记本' });

  const r = await app.invoke('sync:backup');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.count, 3, '2 个全局 + 1 个项目');

  // 直接拆开上传上去的那个包，检查 manifest 里到底存了什么
  const inspect = tmpDir('cc-skill-inspect-');
  const zipPath = inspect + '.zip';
  fs.writeFileSync(zipPath, stub.files.get(stub.zipPath()));
  await unpackZip(zipPath, inspect);
  const manifest = JSON.parse(fs.readFileSync(path.join(inspect, 'manifest.json'), 'utf8'));
  const packedConfig = JSON.parse(fs.readFileSync(path.join(inspect, 'config.json'), 'utf8'));
  fs.rmSync(inspect, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });

  // 本机标识绝不能随备份跑到别的机器上，否则恢复后两台机器会共用同一个身份
  assert.equal(packedConfig.machineId, undefined, 'machineId 不该进备份包');
  assert.equal(manifest.settings.machineId, undefined);
  // 但 manifest 要记下「打包的是哪台机器」——恢复时靠它判断能否连项目一起还原
  assert.equal(manifest.machineId, app.readConfig().machineId);
  // 机器名只走顶层；别名压根不上云（它是本机给别人起的名字，跑到别的机器上没有意义）
  assert.equal(manifest.settings.machineName, undefined, 'settings 里不该有机器名');
  assert.equal(manifest.settings.machineNames, undefined, '别名不该随备份上云');
  assert.equal(manifest.machineName, '我的台式机', '名字要在顶层，别的机器读侧车才看得到');

  const dests = manifest.targets.map((t) => t.destDir);
  for (const expected of ['~/.claude/skills', '~/.codex/skills']) {
    assert.ok(dests.includes(expected), `应存 ~ 形式，实际: ${dests.join(' | ')}`);
  }
  for (const d of dests) {
    assert.ok(!d.toLowerCase().includes(homeA.toLowerCase()), `不该泄漏上传机器的绝对路径: ${d}`);
  }
  // 项目级 SKILL 同样存 ~ 形式，虽然默认不恢复，但记录必须可移植
  assert.ok(dests.includes('~/work/myproj/.claude/skills'), `项目路径也要归一化，实际: ${dests.join(' | ')}`);
});

test('restoreInfo 优先取本机自己上传的备份，并带上 Agent 明细', async () => {
  const r = await app.invoke('sync:restoreInfo');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.source, 'local');
  assert.equal(r.detailed, true);
  assert.deepEqual(r.agents.map((a) => a.id).sort(), ['claude-code', 'codex']);
  assert.equal(r.projectCount, 1, '项目级 SKILL 要单独计数，弹窗据此提示「不在恢复范围内」');

  const cc = r.agents.find((a) => a.id === 'claude-code');
  assert.deepEqual(cc.dirs, ['~/.claude/skills'], '弹窗要显示技能将落到哪个目录');
  assert.equal(cc.count, 1);
});

test('本机侧车失效时退回云端最新一条', async () => {
  const hostKey = stub.hostMetaPath();
  assert.ok(hostKey, '备份时应写入本机专属侧车');
  const original = stub.files.get(hostKey);
  const withPatch = (patch) => stub.writeJson(hostKey, { ...JSON.parse(original.toString('utf8')), ...patch });

  stub.remove(hostKey);
  assert.equal((await app.invoke('sync:restoreInfo')).source, 'latest', '本机没备份过 → 用最新一条');

  // 机器身份只看 machineId：hostname 相同/不同的两台机器都不会互相顶掉备份
  withPatch({ hostname: 'SOMETHING-ELSE' });
  assert.equal((await app.invoke('sync:restoreInfo')).source, 'local', 'hostname 不参与判定');

  withPatch({ machineId: 'another-machine' });
  assert.equal((await app.invoke('sync:restoreInfo')).source, 'latest', 'machineId 对不上 → 不算本机的备份');

  withPatch({ name: 'cc-skill-backup-19990101-000000.zip' });
  assert.equal((await app.invoke('sync:restoreInfo')).source, 'latest', '侧车指向的备份已不存在 → 降级');

  stub.files.set(hostKey, original);
  assert.equal((await app.invoke('sync:restoreInfo')).source, 'local', '复原后仍认本机那份');
});

test('按 Agent 勾选恢复：只落地勾选的 Agent，项目 SKILL 一律不落地', async () => {
  for (const d of [claudeDir, codexDir, path.join(homeA, 'work')]) fs.rmSync(d, { recursive: true, force: true });

  const info = await app.invoke('sync:restoreInfo');

  // 显式传空数组 = 一个 Agent 都不选，恢复应当什么都不做（渲染层据此把按钮置灰）
  const none = await app.invoke('sync:restoreApply', { name: info.name, agentIds: [] });
  assert.equal(none.ok, true);
  assert.equal(none.restored, 0, '空选择不该恢复任何技能');
  assert.ok(!fs.existsSync(codexDir), '空选择时不该创建任何目录');

  const r = await app.invoke('sync:restoreApply', { name: info.name, agentIds: ['codex'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 1, '只恢复勾选的 codex');
  assert.equal(r.skippedAgents, 1, 'claude-code 未勾选');
  assert.equal(r.skippedProjects, 1, '项目 SKILL 不在恢复范围内');

  assert.ok(fs.existsSync(path.join(codexDir, 'beta', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(claudeDir, 'alpha')), '未勾选的 Agent 不该被写入');
  assert.ok(!fs.existsSync(path.join(projSkillDir, 'proj-skill')), '项目 SKILL 不该落地');
});

// 手工造一个备份包：用来构造「旧版绝对路径」「被篡改的条目」这类正常备份不会产生的输入
function putBackup(name, manifest, files) {
  const root = tmpDir('cc-skill-fake-');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  const zipPath = root + '.zip';
  zipDir(root, zipPath);
  stub.files.set('/dav/' + name, fs.readFileSync(zipPath));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  return name;
}

const manifestOf = ({ targets, entries, agents = [] }) => ({
  app: 'CC Skill',
  manifestVersion: 1,
  created: new Date().toISOString(),
  hostname: 'OLD-PC',
  settings: { agents },
  targets,
  entries,
});

test('旧版备份里的绝对路径无从映射时：不落地，交给用户判断', async () => {
  const ghost = path.join(app.workDir, 'ghost-home', '.claude', 'skills');
  const name = putBackup(
    'cc-skill-backup-20200101-000000.zip',
    // settings 里没有 ~ 目录声明 → 无从判断原路径对应哪个本机目录
    manifestOf({
      targets: [{ id: 't0', destDir: ghost, kind: 'global', projectId: null, agentIds: ['claude-code'], count: 1 }],
      entries: [{ target: 't0', folder: 'old-skill' }],
    }),
    { 'data/t0/old-skill/SKILL.md': '---\nname: old-skill\n---\n' }
  );

  const r = await app.invoke('sync:restoreApply', { name });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 0, '映射不上就不落地');
  assert.deepEqual(r.externalDirs, [{ dir: ghost, count: 1 }], '要把这批路径和条数报出来交给用户，而不是静默报成功');
  assert.ok(!fs.existsSync(ghost), '不该照着上传机器的绝对路径重建目录');

  // 用户确认之后才写 —— 这条边界由用户把守，不由备份包自证
  const forced = await app.invoke('sync:restoreApply', { name, allowExternalDirs: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(forced.restored, 1, '确认后就该写进去');
  assert.ok(fs.existsSync(path.join(ghost, 'old-skill', 'SKILL.md')));
  fs.rmSync(path.join(app.workDir, 'ghost-home'), { recursive: true, force: true });
});

test('旧版备份的绝对路径能按 manifest 声明的 ~ 目录映射到本机', async () => {
  // 复刻真实场景：备份来自另一台机器，其用户目录在本机根本不存在
  const foreign = ['C:', 'Users', 'cc-skill-ghost-user', '.claude', 'skills'].join('\\');
  const name = putBackup(
    'cc-skill-backup-20200103-000000.zip',
    manifestOf({
      agents: [{ id: 'claude-code', name: 'Claude Code', dirs: ['~/.claude/skills'] }],
      targets: [{ id: 't0', destDir: foreign, kind: 'global', projectId: null, agentIds: ['claude-code'], count: 1 }],
      entries: [{ target: 't0', folder: 'from-old-pc' }],
    }),
    { 'data/t0/from-old-pc/SKILL.md': '---\nname: from-old-pc\n---\n' }
  );

  fs.rmSync(claudeDir, { recursive: true, force: true });
  const r = await app.invoke('sync:restoreApply', { name });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 1, '旧路径要映射到本机 home，而不是被丢掉');
  assert.deepEqual(r.relocated, [{ from: foreign, to: '~/.claude/skills' }]);
  assert.ok(fs.existsSync(path.join(claudeDir, 'from-old-pc', 'SKILL.md')));
  assert.ok(!fs.existsSync(foreign), '绝不去创建原机器的绝对路径');
});

test('备份包里的目录名不能越出目标目录（防篡改包删掉本机文件）', async () => {
  const sentinel = path.join(homeA, 'cc-skill-sentinel');
  fs.mkdirSync(sentinel, { recursive: true });
  fs.writeFileSync(path.join(sentinel, 'keep.txt'), 'x', 'utf8');

  const name = putBackup(
    'cc-skill-backup-20200102-000000.zip',
    manifestOf({
      targets: [{ id: 't0', destDir: '~/.claude/skills', kind: 'global', projectId: null, agentIds: ['claude-code'], count: 2 }],
      // 第二条的 folder 从 ~/.claude/skills 往上爬两级，正好命中 sentinel；
      // 没有守卫的话，下面那句 rmSync 会把它连根删掉
      entries: [
        { target: 't0', folder: '../..' },
        { target: 't0', folder: '../../cc-skill-sentinel' },
      ],
    }),
    { 'data/t0/x/SKILL.md': 'x' }
  );

  const r = await app.invoke('sync:restoreApply', { name });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 0);
  assert.equal(r.skippedInvalid, 2, '带分隔符或 .. 的条目一律拒绝');
  assert.ok(fs.existsSync(path.join(sentinel, 'keep.txt')), '目标目录之外的文件绝不能被删');
  fs.rmSync(sentinel, { recursive: true, force: true });
});

test('恢复范围参数不合法时直接拒绝，而不是默默当成「全选」', async () => {
  const info = await app.invoke('sync:restoreInfo');
  for (const bad of ['claude-code', 123, {}]) {
    const r = await app.invoke('sync:restoreApply', { name: info.name, agentIds: bad });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 不该通过`);
    assert.match(String(r.error), /不合法/);
  }
});

test('换一台电脑恢复时不还原项目配置（项目路径不通用）', async () => {
  const before = app.readConfig().projects.map((p) => p.id);
  const name = putBackup(
    'cc-skill-backup-20200104-000000.zip',
    { ...manifestOf({ agents: [], targets: [], entries: [] }), machineId: 'some-other-machine' },
    {
      'config.json': JSON.stringify({
        ui: { lang: 'zh' },
        agents: [{ id: 'claude-code', dirs: ['~/.claude/skills'] }],
        projects: [{ id: 'foreign-proj', name: 'foreign', dir: 'C:/Users/someone/Work/foreign' }],
      }),
    }
  );

  const r = await app.invoke('sync:restoreApply', { name });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.projectConfigSkipped, 1, '没还原的项目数要报出来');
  assert.deepEqual(
    app.readConfig().projects.map((p) => p.id),
    before,
    '本机项目列表不该被换成别人机器的'
  );
});

test('同一台机器的备份仍然还原项目配置（灾备场景）', async () => {
  const mine = app.readConfig().machineId;
  const name = putBackup(
    'cc-skill-backup-20200105-000000.zip',
    { ...manifestOf({ agents: [], targets: [], entries: [] }), machineId: mine },
    {
      'config.json': JSON.stringify({
        ui: { lang: 'zh' },
        agents: [],
        projects: [{ id: 'mine-proj', name: 'mine', dir: '~/Work/mine' }],
      }),
    }
  );

  const r = await app.invoke('sync:restoreApply', { name });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.projectConfigSkipped, 0);
  assert.deepEqual(
    app.readConfig().projects.map((p) => p.id),
    ['mine-proj']
  );
});

test('换一台电脑恢复：按本机 home 展开 ~，不去重建上传机器的目录', async () => {
  for (const d of [claudeDir, codexDir]) fs.rmSync(d, { recursive: true, force: true });

  const info = await app.invoke('sync:restoreInfo');
  setHome(homeB);
  try {
    const r = await app.invoke('sync:restoreApply', { name: info.name });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.restored, 2, '不传 agentIds 视为全选');

    assert.ok(fs.existsSync(path.join(homeB, '.claude', 'skills', 'alpha', 'SKILL.md')), '应落到本机的用户目录');
    assert.ok(fs.existsSync(path.join(homeB, '.codex', 'skills', 'beta', 'SKILL.md')));
    assert.ok(!fs.existsSync(claudeDir), '不该按上传机器的绝对路径重建幽灵目录');
    assert.ok(!fs.existsSync(codexDir));
  } finally {
    setHome(homeA);
  }
});

test('云端保留策略绕过「其他机器最近的那份备份」', async () => {
  fs.mkdirSync(claudeDir, { recursive: true });
  writeSkill(claudeDir, 'keeper');

  const old = [];
  for (let i = 0; i < 11; i++) {
    const n = `cc-skill-backup-202001${String(i).padStart(2, '0')}-000000.zip`;
    stub.files.set('/dav/' + n, Buffer.from('x'));
    old.push(n);
  }
  // 另一台机器把它最旧的一份标记成「本机最近备份」——共用同一个远端目录时，它不该被挤掉
  stub.writeJson('/dav/host-other-machine.json', { name: old[0], machineId: 'other', hostname: 'OTHER-PC' });

  const r = await app.invoke('sync:backup');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(stub.files.has('/dav/' + old[0]), '其他机器最近那份不能被删');
  assert.ok(!stub.files.has('/dav/' + old[1]), '超出上限且非保护的旧备份应被清理');
});

test('自动备份：本机没备份过就不自动上传，避免顶掉云端的旧备份', async () => {
  await app.invoke('sync:setConfig', { webdav: { ...makeWebdavConfig(stub.url), autoBackup: true, autoBackupFreq: 'startup' } });
  // 前面几个用例已经手动备份过，这里显式按回「本机还没备份过」的初始态
  getConfig().webdav.everBackedUp = false;

  assert.equal((await webdav.autoBackupCheck({ atStartup: true })).skipped, 'needs-first-backup');

  // 手动备份一次之后放行；「仅启动时」在运行中的定期复查里不再触发
  await app.invoke('sync:backup');
  assert.equal((await webdav.autoBackupCheck({ atStartup: false })).skipped, 'startup-only');
  assert.equal((await webdav.autoBackupCheck({ atStartup: true })).skipped, 'unchanged', '内容没变就不用再传');
});

test('自动备份：内容变了就真的传一份', async () => {
  writeSkill(claudeDir, 'auto-added');
  const r = await webdav.autoBackupCheck({ atStartup: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.name, '应真的上传了一份备份');
  assert.ok(stub.files.has('/dav/' + r.name));
});

test('自动备份调度：启动跑一轮，把真的上传了的结果回传宿主', async () => {
  writeSkill(claudeDir, 'scheduled');
  const seen = [];
  const job = webdav.startAutoBackup({ intervalMs: 60000, startupDelayMs: 5, onResult: (r) => seen.push(r) });
  try {
    const deadline = Date.now() + 20000;
    while (!seen.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  } finally {
    job.stop();
  }
  assert.equal(seen.length, 1, '应上报一次自动备份结果');
  assert.ok(seen[0].name, '上报的应该是真正完成的上传，而不是 skipped');
});
