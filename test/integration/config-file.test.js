// 配置文件的导出 / 导入：换台机器、留个档、多套配置之间来回换。
// 这两条通道只能从文件对话框进入，所以先把路径放进 harness 的 dialog 桩里。
// 契约：导入分两步——先只读文件给摘要，用户确认之后才动本机配置。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { startApp } = require('../helpers/harness');

let app;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-skill-cfgfile-'));
  app = await startApp();
});
after(() => {
  app.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

const outPath = () => path.join(dir, 'exported.json');
const inPath = () => path.join(dir, 'imported.json');

const IMPORTED = {
  kind: 'config',
  exportedAt: '2026-01-01T00:00:00.000Z',
  config: {
    agents: [{ id: 'x', name: 'X', dirs: ['~/.x/skills'] }, { id: 'y', name: 'Y', dirs: [] }, { name: '没有 id 的脏条目' }],
    projects: [{ id: 'p1', dir: '/tmp/imported-proj', name: 'imported-proj' }],
    ui: { lang: 'zh' },
    webdav: { url: 'https://other.test/dav', username: 'u2', password: 'p2', remotePath: 'cc' },
    machineName: '别的机器',
  },
};

/** 摆好「用户选了哪个文件」，再把内容写进去 */
function pickImportFile(content) {
  fs.writeFileSync(inPath(), typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  app.dialog().openPaths = [inPath()];
}

// ------------------------------ 导出 ----------------------------------------
test('导出：写出配置文件，默认不含 WebDAV 密码与机器标识', async () => {
  await app.invoke('config:set', { agents: [{ id: 'a', name: 'A', dirs: [] }], projects: [], ui: { lang: 'en' } });
  await app.invoke('sync:setConfig', { webdav: { url: 'https://dav.test/dav', username: 'u', password: 'secret', remotePath: 'cc' } });
  await app.invoke('config:set', { machineName: '我的台式机' });

  app.dialog().savePath = outPath();
  const r = await app.invoke('config:exportFile', { includePassword: false });
  assert.equal(r.ok, true, JSON.stringify(r));

  const payload = JSON.parse(fs.readFileSync(outPath(), 'utf8'));
  assert.equal(payload.kind, 'config');
  assert.equal(payload.config.agents.length, 1);
  assert.equal(payload.config.machineId, undefined, '机器标识是身份，不进配置文件');
  assert.equal(payload.config.machineName, '我的台式机', '机器名跟着走，换台机器不用重新起名');
  assert.equal(payload.config.webdav.password, undefined, '默认不导出密码');
  assert.equal(payload.config.ui.lang, 'en');
});

test('导出：勾上才会带上密码', async () => {
  app.dialog().savePath = outPath();
  assert.equal((await app.invoke('config:exportFile', { includePassword: true })).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(outPath(), 'utf8')).config.webdav.password, 'secret');
});

test('导出：用户取消对话框时什么都不做', async () => {
  app.dialog().savePath = null;
  const r = await app.invoke('config:exportFile', {});
  assert.equal(r.ok, false);
  assert.equal(r.canceled, true);
});

// ------------------------------ 导入 ----------------------------------------
test('导入第一步：只读文件给摘要，本机配置一动不动', async () => {
  const before = app.readConfig();
  pickImportFile(IMPORTED);

  const r = await app.invoke('config:importFile');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.summary, {
    agents: 2, // 那条没有 id 的脏条目不算数——摘要要说的是「会落地多少」
    projects: 1,
    lang: 'zh',
    webdav: true,
    password: true,
    machineName: '别的机器',
    exportedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(app.readConfig().agents, before.agents, '确认之前不该动本机 Agents');
  assert.equal(app.readConfig().ui.lang, before.ui.lang);
});

test('导入第二步：Agents 与项目按文件替换，界面偏好与 WebDAV 分别处理', async () => {
  const before = app.readConfig();
  const payload = JSON.parse(fs.readFileSync(inPath(), 'utf8'));
  const r = await app.invoke('config:importApply', { payload, includeWebdav: false });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(
    r.agents.map((a) => a.id),
    ['x', 'y'],
    '文件里的 Agent 替换本机的，脏条目丢掉'
  );
  assert.deepEqual(
    r.projects.map((p) => p.id),
    ['p1']
  );
  assert.equal(app.readConfig().ui.lang, 'zh', '语言跟着文件走');
  assert.equal(typeof app.readConfig().ui.overlayBlur, 'number', '本机新加的界面偏好不该被清掉');
  assert.equal(app.readConfig().webdav.url, before.webdav.url, '没勾 WebDAV 就不导入它');
  assert.equal(app.readConfig().machineName, '我的台式机', '本机已经起过名，文件里的名字不覆盖');
  assert.equal(r.webdavApplied, false);
});

test('导入第二步：勾上 WebDAV 就连设置一起导入', async () => {
  const payload = JSON.parse(fs.readFileSync(inPath(), 'utf8'));
  const r = await app.invoke('config:importApply', { payload, includeWebdav: true });
  assert.equal(r.ok, true);
  assert.equal(r.webdavApplied, true);
  assert.equal(app.readConfig().webdav.url, 'https://other.test/dav');
  assert.equal(app.readConfig().webdav.password, 'p2');
});

test('导入：回传的 payload 同样要过校验（它经渲染层转了一手）', async () => {
  const r = await app.invoke('config:importApply', { payload: { kind: 'market' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-config');
});

test('导入：不是本应用的文件 / 坏 JSON 都被挡下', async () => {
  pickImportFile({ kind: 'market', skills: [] });
  const notConfig = await app.invoke('config:importFile');
  assert.equal(notConfig.ok, false);
  assert.equal(notConfig.reason, 'not-config');

  pickImportFile('{ 这不是 JSON');
  const badJson = await app.invoke('config:importFile');
  assert.equal(badJson.ok, false);
  assert.equal(badJson.reason, 'invalid-json');

  app.dialog().openPaths = [];
  const canceled = await app.invoke('config:importFile');
  assert.equal(canceled.ok, false);
  assert.equal(canceled.canceled, true);
});
