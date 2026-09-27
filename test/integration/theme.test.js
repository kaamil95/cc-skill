// 主题的落盘与窗口底色。
// 窗口背景是原生层，必须在渲染层跑起来之前就按主题铺对，否则切到深色后重载会闪一下白。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('../helpers/harness');
const { THEME_BG } = require('../../src/config');

let app;

before(async () => {
  app = await startApp({ config: { agents: [], projects: [], ui: { lang: 'zh', theme: 'dark', accent: '#8b5cf6' } } });
});
after(() => app.cleanup());

test('窗口创建时就按配置里的主题铺好底色', () => {
  assert.equal(app.windowOptions().backgroundColor, THEME_BG.dark);
});

test('config:set 保存主题与强调色，并把非法值归一化', async () => {
  const r = await app.invoke('config:set', { ui: { theme: 'sepia', accent: '#FF0000' } });
  assert.equal(r.ok, true);
  assert.equal(r.ui.theme, 'sepia');
  assert.equal(r.ui.accent, '#ff0000', '统一小写，便于与预设色比对');
  assert.equal(app.readConfig().ui.theme, 'sepia');

  const bad = await app.invoke('config:set', { ui: { theme: 'neon', accent: 'red' } });
  assert.equal(bad.ui.theme, 'light');
  assert.equal(bad.ui.accent, 'auto');
});

test('只改语言时不会把主题清掉（ui 是合并而不是整体替换）', async () => {
  await app.invoke('config:set', { ui: { theme: 'contrast', accent: '#0d9488' } });
  const r = await app.invoke('config:set', { ui: { lang: 'en' } });
  assert.equal(r.ui.theme, 'contrast');
  assert.equal(r.ui.accent, '#0d9488');
  assert.equal(r.ui.lang, 'en');
});

test('win:setBackground 按主题换窗口底色，未知主题回落到浅色', async () => {
  await app.invoke('win:setBackground', { theme: 'contrast' });
  assert.equal(app.backgroundColors().at(-1), THEME_BG.contrast);
  await app.invoke('win:setBackground', { theme: 'nope' });
  assert.equal(app.backgroundColors().at(-1), THEME_BG.light);
});

test('app:paths 下发的 ui 带主题字段（渲染层启动时读它）', async () => {
  const p = await app.invoke('app:paths');
  assert.ok(['light', 'dark', 'sepia', 'contrast'].includes(p.ui.theme));
  assert.match(p.ui.accent, /^(#[0-9a-f]{6}|auto)$/);
});
