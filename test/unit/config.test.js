// 界面偏好的归一化——纯函数
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUi, OVERLAY_DEFAULTS } = require('../../src/config');

test('ui 缺失时给全套默认值', () => {
  for (const input of [null, undefined, {}, { lang: 'xx' }]) {
    const ui = normalizeUi(input);
    assert.equal(ui.lang, 'auto', `输入 ${JSON.stringify(input)}`);
    assert.equal(ui.overlayBlur, OVERLAY_DEFAULTS.blur);
    assert.equal(ui.overlayDim, OVERLAY_DEFAULTS.dim);
  }
});

test('合法的语言与遮罩值原样保留', () => {
  assert.deepEqual(normalizeUi({ lang: 'en', overlayBlur: 8, overlayDim: 0.5 }), { lang: 'en', overlayBlur: 8, overlayDim: 0.5 });
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
