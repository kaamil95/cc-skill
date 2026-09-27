// 界面偏好的归一化——纯函数
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUi,
  OVERLAY_DEFAULTS,
  THEMES,
  THEME_BG,
  themeBg,
} = require('../../src/config');

test('ui 缺失时给全套默认值', () => {
  for (const input of [null, undefined, {}, { lang: 'xx' }]) {
    const ui = normalizeUi(input);
    assert.equal(ui.lang, 'auto', `输入 ${JSON.stringify(input)}`);
    assert.equal(ui.theme, 'light');
    assert.equal(ui.accent, 'auto');
    assert.equal(ui.overlayBlur, OVERLAY_DEFAULTS.blur);
    assert.equal(ui.overlayDim, OVERLAY_DEFAULTS.dim);
  }
});

test('合法的语言与遮罩值原样保留', () => {
  assert.deepEqual(normalizeUi({ lang: 'en', overlayBlur: 8, overlayDim: 0.5 }), {
    lang: 'en',
    theme: 'light',
    accent: 'auto',
    overlayBlur: 8,
    overlayDim: 0.5,
  });
});

test('越界的遮罩值被夹到范围内（手改 config.json 不该让界面失控）', () => {
  assert.equal(normalizeUi({ overlayBlur: -10 }).overlayBlur, 0);
  assert.equal(normalizeUi({ overlayBlur: 999 }).overlayBlur, 40);
  assert.equal(normalizeUi({ overlayDim: -1 }).overlayDim, 0);
  assert.equal(normalizeUi({ overlayDim: 5 }).overlayDim, 0.8);
});

test('非数字的遮罩值回落到默认值', () => {
  assert.equal(normalizeUi({ overlayBlur: 'abc' }).overlayBlur, OVERLAY_DEFAULTS.blur);
  assert.equal(normalizeUi({ overlayDim: null }).overlayDim, OVERLAY_DEFAULTS.dim);
  assert.equal(normalizeUi({ overlayDim: NaN }).overlayDim, OVERLAY_DEFAULTS.dim);
});

test('数字字符串按数字处理（config.json 手写常见）', () => {
  assert.equal(normalizeUi({ overlayBlur: '12' }).overlayBlur, 12);
  assert.equal(normalizeUi({ overlayDim: '0.6' }).overlayDim, 0.6);
});

test('边界值 0 不会被当成缺失', () => {
  assert.equal(normalizeUi({ overlayBlur: 0 }).overlayBlur, 0);
  assert.equal(normalizeUi({ overlayDim: 0 }).overlayDim, 0);
});

test('主题只认清单里的 id，其余回落到 light', () => {
  assert.equal(normalizeUi({ theme: 'dark' }).theme, 'dark');
  assert.equal(normalizeUi({ theme: 'sepia' }).theme, 'sepia');
  for (const bad of ['DARK', 'neon', '', null, 42, {}]) {
    assert.equal(normalizeUi({ theme: bad }).theme, 'light', `输入 ${JSON.stringify(bad)}`);
  }
});

test('强调色只接受 6 位十六进制，其余一律 auto（用主题自带的）', () => {
  assert.equal(normalizeUi({ accent: '#0A84FF' }).accent, '#0a84ff'); // 统一小写，便于比对
  assert.equal(normalizeUi({ accent: '  #34c759  ' }).accent, '#34c759');
  for (const bad of ['auto', 'red', '#fff', '#12345', 'javascript:alert(1)', null, 7]) {
    assert.equal(normalizeUi({ accent: bad }).accent, 'auto', `输入 ${JSON.stringify(bad)}`);
  }
});

test('每个主题都有窗口底色（主进程要在渲染层之前铺对底色）', () => {
  for (const t of THEMES) {
    assert.match(THEME_BG[t], /^#[0-9a-f]{6}$/i, `主题 ${t} 缺底色`);
    assert.equal(themeBg(t), THEME_BG[t]);
  }
  // 未知主题不能让窗口底色变成 undefined
  assert.equal(themeBg('nope'), THEME_BG.light);
  assert.equal(themeBg(undefined), THEME_BG.light);
});

