// 导航守卫回归测试。
// 背景：在详情弹窗预览里点 SKILL.md 的相对链接，会把整个窗口导航到
// renderer/references/xxx.md；目标不存在时窗口只剩白屏，自绘标题栏随 DOM 一起消失，
// 用户只能杀进程。这里直接触发主进程的 will-navigate，断言它一定拦下。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { startApp, ROOT } = require('../helpers/harness');
const { tmpDir, makeConfig, writeSkill } = require('../helpers/fixtures');

let app;
let root;

before(async () => {
  root = tmpDir('cc-skill-guard-');
  writeSkill(root, 'alpha');
  app = await startApp({ config: makeConfig({ agentDirs: [root] }) });
});
after(() => {
  app.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

// 最小事件桩：只关心守卫有没有调 preventDefault
const fakeEvent = () => ({
  prevented: false,
  preventDefault() {
    this.prevented = true;
  },
});

test('窗口上装了导航守卫', () => {
  assert.equal(typeof app.windowOpenHandler(), 'function');
});

test('应用自身页面放行（含锚点）', () => {
  const ev = fakeEvent();
  app.emitWebContents('will-navigate', ev, pathToFileURL(path.join(ROOT, 'renderer', 'index.html')).href + '#tab');
  assert.equal(ev.prevented, false);
});

test('指向 renderer/references/*.md 的导航被拦下——这就是白屏那一步', () => {
  const ev = fakeEvent();
  const missing = path.join(ROOT, 'renderer', 'references', 'type-dp-security-matrix.md');
  app.emitWebContents('will-navigate', ev, pathToFileURL(missing).href);
  assert.equal(ev.prevented, true);
  assert.deepEqual(app.openPathCalls(), [], '文件不存在时不该调系统程序');
});

test('已存在的本地文件：拦下导航后交系统默认程序打开', () => {
  const ev = fakeEvent();
  const file = path.join(root, 'note.md');
  fs.writeFileSync(file, '# note\n', 'utf8');
  app.emitWebContents('will-navigate', ev, pathToFileURL(file).href);
  assert.equal(ev.prevented, true);
  assert.deepEqual(app.openPathCalls(), [file]);
});

test('外链拦下后交给系统浏览器', () => {
  const ev = fakeEvent();
  app.emitWebContents('will-navigate', ev, 'https://example.com/doc');
  assert.equal(ev.prevented, true);
  assert.deepEqual(app.openExternalCalls(), ['https://example.com/doc']);
});

test('javascript: 导航被拦且不触发任何系统调用', () => {
  const ev = fakeEvent();
  const paths = app.openPathCalls().length;
  const urls = app.openExternalCalls().length;
  app.emitWebContents('will-navigate', ev, 'javascript:alert(1)');
  assert.equal(ev.prevented, true);
  assert.equal(app.openPathCalls().length, paths);
  assert.equal(app.openExternalCalls().length, urls);
});

test('主 frame 加载失败会自动回到界面', () => {
  const before = app.loadFileCalls().length;
  app.emitWebContents('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///gone', true);
  assert.equal(app.loadFileCalls().length, before + 1);
});

test('子 frame 失败与 ERR_ABORTED 不触发重载', () => {
  const before = app.loadFileCalls().length;
  app.emitWebContents('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///gone', false);
  app.emitWebContents('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///gone', true);
  assert.equal(app.loadFileCalls().length, before);
});

test('渲染进程退出后重新加载界面', () => {
  const before = app.loadFileCalls().length;
  app.emitWebContents('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(app.loadFileCalls().length, before + 1);
});

test('自动恢复有滑窗限流：连续失败到上限后不再重载', () => {
  // 前面的用例已经用掉若干次配额，这里连打 5 次，最终必须停下来
  const before = app.loadFileCalls().length;
  for (let i = 0; i < 5; i++) app.emitWebContents('render-process-gone', {}, { reason: 'crashed' });
  assert.ok(app.loadFileCalls().length - before < 5, '连续失败必须被限流，不能无限重载');
});
