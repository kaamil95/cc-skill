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
  // 密码不进包：包躺在云端，而恢复必须能连上云端，凭据本来就在本机配置里
  assert.equal(packedConfig.webdav.password, undefined, 'config.json 里不该有 WebDAV 密码');
  assert.equal(manifest.settings.webdav.password, undefined, 'settings 里也不该有');
  assert.equal(packedConfig.webdav.url, stub.url, '地址等其它设置照旧随包走');

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

test('restoreInfo 优先取本机自己那个目录，并带上 Agent 明细', async () => {
  const r = await app.invoke('sync:restoreInfo');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.source, 'local');
  assert.equal(r.detailed, true);
  assert.deepEqual(r.agents.map((a) => a.id).sort(), ['claude-code', 'codex']);
  assert.equal(r.projectCount, 1, '项目级 SKILL 要单独计数，弹窗据此说明「本机备份才恢复」');

  const cc = r.agents.find((a) => a.id === 'claude-code');
  assert.deepEqual(cc.dirs, ['~/.claude/skills'], '弹窗要显示技能将落到哪个目录');
  assert.equal(cc.count, 1);
});

test('本机的档案没了也能找回自己的目录，目录整个没了才退回别台机器', async () => {
  const mine = (await app.invoke('sync:machines')).machines.find((m) => m.self);
  const profileKey = stub.machineProfilePath(mine.dir);
  const originalProfile = stub.files.get(profileKey);
  const zip = stub.backupsIn(mine.dir).pop();
  const sidecarKey = stub.sidecarOf(mine.dir, zip);
  const originalSidecar = stub.files.get(sidecarKey);

  // 改了名 + 档案也没了：目录名尾部写着完整标识，照样落回原来那个目录
  // （名字变了 → 按名字算出来的目录名对不上；档案没了 → 只能靠目录名里的标识）
  await app.invoke('sync:renameMachine', { machineId: mine.machineId, name: 'NEW-NAME' });
  stub.remove(profileKey);
  const viaName = await app.invoke('sync:restoreInfo');
  assert.equal(viaName.dir, mine.dir, '靠目录名尾部的标识认回原目录');
  assert.equal(viaName.source, 'local');
  stub.files.set(profileKey, originalProfile);
  await app.invoke('sync:renameMachine', { machineId: mine.machineId, name: '' });

  // 侧车里的标识被改成了别人的：这一份就不算本机的了（弹窗据此提示「认领」）
  stub.writeJson(sidecarKey, { ...JSON.parse(originalSidecar.toString('utf8')), machineId: 'another-machine' });
  const foreign = await app.invoke('sync:restoreInfo');
  assert.equal(foreign.sameMachine, false, '标识对不上 → 不算本机的备份');
  assert.equal(foreign.dir, mine.dir, '目录还是本机的，只是这一份包不算');
  stub.files.set(sidecarKey, originalSidecar);

  // 目录整个没了（新装的机器）→ 退回最近上传的那台机器
  const otherDir = 'old-pc-33333333-4444-5555-6666-777777777777';
  stub.collections.add(`${stub.basePath()}/${otherDir}`);
  stub.writeJson(`${stub.basePath()}/${otherDir}/cc-skill-backup-20250101-000000.zip`, { fake: true });
  const saved = new Map([...stub.files].filter(([k]) => k.startsWith(`${stub.basePath()}/${mine.dir}/`)));
  for (const k of saved.keys()) stub.files.delete(k);
  stub.collections.delete(`${stub.basePath()}/${mine.dir}`);
  const fallback = await app.invoke('sync:restoreInfo');
  assert.equal(fallback.source, 'latest', '本机没目录 → 用最近上传的那台机器');
  assert.equal(fallback.dir, otherDir, '退回的不能是本机那个已经不存在的目录');
  for (const [k, v] of saved) stub.files.set(k, v);
  stub.collections.add(`${stub.basePath()}/${mine.dir}`);
  stub.collections.delete(`${stub.basePath()}/${otherDir}`);
  stub.remove(`${stub.basePath()}/${otherDir}/cc-skill-backup-20250101-000000.zip`);
  assert.equal((await app.invoke('sync:restoreInfo')).source, 'local', '复原后仍认本机那份');
});

test('按 Agent 勾选恢复：只落地勾选的全局 Agent，项目 SKILL 不受勾选影响', async () => {
  for (const d of [claudeDir, codexDir, path.join(homeA, 'work')]) fs.rmSync(d, { recursive: true, force: true });

  const info = await app.invoke('sync:restoreInfo');

  // 显式传空数组 = 一个 Agent 都不选，恢复应当什么都不做（渲染层据此把按钮置灰）
  const none = await app.invoke('sync:restoreApply', { dir: info.dir, name: info.name, agentIds: [] });
  assert.equal(none.ok, true);
  assert.equal(none.restored, 0, '空选择不该恢复任何技能');
  assert.equal(none.restoredProjects, 0, '整次都是空操作，项目也不动');
  assert.ok(!fs.existsSync(codexDir), '空选择时不该创建任何目录');

  const r = await app.invoke('sync:restoreApply', { dir: info.dir, name: info.name, agentIds: ['codex'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 1, '只恢复勾选的 codex');
  assert.equal(r.skippedAgents, 1, 'claude-code 未勾选');
  assert.equal(r.skippedProjects, 0, '（前提）这份备份是本机的，项目不会被「不是本机」挡掉');
  assert.equal(r.restoredProjects, 1, '项目 SKILL 不跟着 Agent 勾选走，本机备份就还原');

  assert.ok(fs.existsSync(path.join(codexDir, 'beta', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(claudeDir, 'alpha')), '未勾选的 Agent 不该被写入');
  assert.ok(fs.existsSync(path.join(projSkillDir, 'proj-skill', 'SKILL.md')), '项目 SKILL 落到本机项目里');
});

// 手工造一个备份包：用来构造「被篡改的条目」「别台机器的配置」这类正常备份不会产生的输入
const FAKE = 'fake-pc-22222222-3333-4444-5555-666666666666';

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
  stub.collections.add(`${stub.basePath()}/${FAKE}`);
  stub.files.set(`${stub.basePath()}/${FAKE}/${name}`, fs.readFileSync(zipPath));
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

test('备份包声明里的绝对路径无从落地时：不落地，交给用户判断', async () => {
  const ghost = path.join(app.workDir, 'ghost-home', '.claude', 'skills');
  const name = putBackup(
    'cc-skill-backup-20200101-000000.zip',
    // settings 里声明了 ~ 目录也不管用：落点只认「本机配置里在用的目录」或用户点头
    manifestOf({
      agents: [{ id: 'claude-code', name: 'Claude Code', dirs: ['~/.claude/skills'] }],
      targets: [{ id: 't0', destDir: ghost, kind: 'global', projectId: null, agentIds: ['claude-code'], count: 1 }],
      entries: [{ target: 't0', folder: 'old-skill' }],
    }),
    { 'data/t0/old-skill/SKILL.md': '---\nname: old-skill\n---\n' }
  );

  const r = await app.invoke('sync:restoreApply', { dir: FAKE, name });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 0, '不在本机配置里就不落地');
  assert.deepEqual(r.externalDirs, [{ dir: ghost, count: 1 }], '要把这批路径和条数报出来交给用户，而不是静默报成功');
  assert.ok(!fs.existsSync(ghost), '不该照着上传机器的绝对路径重建目录');

  // 用户确认之后才写 —— 这条边界由用户把守，不由备份包自证
  const forced = await app.invoke('sync:restoreApply', { dir: FAKE, name, allowExternalDirs: true });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(forced.restored, 1, '确认后就该写进去');
  assert.ok(fs.existsSync(path.join(ghost, 'old-skill', 'SKILL.md')));
  fs.rmSync(path.join(app.workDir, 'ghost-home'), { recursive: true, force: true });
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

  const r = await app.invoke('sync:restoreApply', { dir: FAKE, name });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.restored, 0);
  assert.equal(r.skippedInvalid, 2, '带分隔符或 .. 的条目一律拒绝');
  assert.ok(fs.existsSync(path.join(sentinel, 'keep.txt')), '目标目录之外的文件绝不能被删');
  fs.rmSync(sentinel, { recursive: true, force: true });
});

test('恢复范围参数不合法时直接拒绝，而不是默默当成「全选」', async () => {
  const info = await app.invoke('sync:restoreInfo');
  for (const bad of ['claude-code', 123, {}]) {
    const r = await app.invoke('sync:restoreApply', { dir: info.dir, name: info.name, agentIds: bad });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 不该通过`);
    assert.match(String(r.error), /不合法/);
  }
});

test('别台机器的备份：不还原项目配置，也不还原它的项目级 SKILL', async () => {
  const before = app.readConfig().projects.map((p) => p.id);
  const projSkills = path.join(projDir, '.claude', 'skills');
  const name = putBackup(
    'cc-skill-backup-20200104-000000.zip',
    {
      ...manifestOf({
        agents: [{ id: 'claude-code', name: 'Claude Code', dirs: ['~/.claude/skills'] }],
        targets: [{ id: 't0', destDir: projSkills, kind: 'project', projectId: 'foreign-proj', agentIds: ['claude-code'], count: 1 }],
        entries: [{ target: 't0', folder: 'foreign-proj-skill' }],
      }),
      machineId: 'some-other-machine',
    },
    {
      'data/t0/foreign-proj-skill/SKILL.md': '---\nname: foreign-proj-skill\n---\n',
      'config.json': JSON.stringify({
        ui: { lang: 'zh' },
        agents: [{ id: 'claude-code', dirs: ['~/.claude/skills'] }],
        projects: [{ id: 'foreign-proj', name: 'foreign', dir: 'C:/Users/someone/Work/foreign' }],
      }),
    }
  );

  const r = await app.invoke('sync:restoreApply', { dir: FAKE, name });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.projectConfigSkipped, 1, '没还原的项目数要报出来');
  assert.equal(r.restoredProjects, 0, '别台机器的项目级 SKILL 不落地');
  assert.equal(r.skippedProjects, 1, '也不该混进「项目没登记过」那一档');
  assert.deepEqual(
    app.readConfig().projects.map((p) => p.id),
    before,
    '本机项目列表不该被换成别人机器的'
  );
  assert.ok(!fs.existsSync(path.join(projSkills, 'foreign-proj-skill')), '哪怕项目目录本机认识，也不还原别台机器的项目 SKILL');
});

test('同一台机器的备份仍然还原项目配置（灾备场景）', async () => {
  const mine = app.readConfig().machineId;
  const name = putBackup(
    'cc-skill-backup-20200105-000000.zip',
    {
      ...manifestOf({ agents: [], targets: [], entries: [] }),
      machineId: mine,
    },
    {
      'config.json': JSON.stringify({
        ui: { lang: 'zh' },
        agents: [],
        projects: [{ id: 'mine-proj', name: 'mine', dir: '~/Work/mine' }],
      }),
    }
  );

  const r = await app.invoke('sync:restoreApply', { dir: FAKE, name });
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
    const r = await app.invoke('sync:restoreApply', { dir: info.dir, name: info.name });
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
  assert.ok(stub.files.has(`${stub.basePath()}/${r.dir}/${r.name}`), '而且落在本机自己的目录里');
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
