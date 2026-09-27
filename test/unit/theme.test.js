// renderer/theme.js 是浏览器脚本（没有模块系统），这里用最小 DOM 桩把它跑起来。
// 只测它真正负责的两件事：把主题写进 DOM、为自选强调色定出可读的前景色。
// 配色的具体色值在 styles.css 里，由 renderer-dom.test.js 把关。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'theme.js'), 'utf8');

function loadTheme(seed) {
  const styleMap = new Map();
  const el = {
    dataset: {},
    style: {
      setProperty: (k, v) => styleMap.set(k, v),
      removeProperty: (k) => styleMap.delete(k),
    },
  };
  const store = new Map();
  if (seed) store.set('cc-skill-theme', JSON.stringify(seed));
  const win = {};
  const doc = { documentElement: el };
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  new Function('window', 'document', 'localStorage', SRC)(win, doc, ls);
  return { theme: win.theme, el, styleMap, store };
}

test('theme.js 加载时自己就套用上次的配色（首帧不闪默认色）', () => {
  // 只给缓存、不手动调用任何函数：脚本本身必须把配色套上。
  // 踩过：applyCached 写好了但没人调，缓存形同虚设，深色主题每次启动都闪一帧浅色
  const { el, styleMap } = loadTheme({ theme: 'dark', accent: '#34c759' });
  assert.equal(el.dataset.theme, 'dark');
  assert.equal(styleMap.get('--accent'), '#34c759');
});

test('apply 把主题写到 <html data-theme>，非法主题回落到 light', () => {
  const { theme, el } = loadTheme();
  assert.equal(theme.apply({ theme: 'dark' }), 'dark');
  assert.equal(el.dataset.theme, 'dark');
  assert.equal(theme.apply({ theme: 'neon' }), 'light');
  assert.equal(el.dataset.theme, 'light');
});

test('accent=auto 时清掉内联覆盖，让主题自带的强调色生效', () => {
  const { theme, styleMap } = loadTheme();
  theme.apply({ theme: 'dark', accent: '#ff0000' });
  assert.equal(styleMap.get('--accent'), '#ff0000');
  theme.apply({ theme: 'dark', accent: 'auto' });
  // 必须是 removeProperty：留一个内联值会把深色主题自带的亮蓝盖掉
  assert.equal(styleMap.has('--accent'), false);
  assert.equal(styleMap.has('--on-accent'), false);
});

test('自选强调色同时定出对比度更高的前景色', () => {
  const { theme } = loadTheme();
  // 阈值取黑白对比度相等的点（L≈0.179），所以结果一定是两者里更清楚的那个
  assert.equal(theme.deriveAccent('#000000').onAccent, '#ffffff');
  assert.equal(theme.deriveAccent('#ffe066').onAccent, '#1d1d1f', '明黄底必须转深字');
  // 预设里的绿：白字只有 2.2:1，深字 9.5:1 —— 阈值取 0.6 时这里会错判成白字
  assert.equal(theme.deriveAccent('#34c759').onAccent, '#1d1d1f');
  assert.equal(theme.deriveAccent('#8b5cf6').onAccent, '#1d1d1f');
  // 默认的浅色主题蓝仍然配白字（4.7:1 > 4.47:1）
  assert.equal(theme.deriveAccent('#0071e3').onAccent, '#ffffff');
});

test('deriveAccent 只接受 6 位十六进制并统一小写', () => {
  const { theme } = loadTheme();
  assert.equal(theme.deriveAccent('#0A84FF').accent, '#0a84ff');
  for (const bad of ['#fff', 'auto', '', null, '#12345', 'red']) assert.equal(theme.deriveAccent(bad), null);
});

test('缓存能在下次启动首帧前套用', () => {
  const { theme, el, styleMap, store } = loadTheme();
  theme.cache({ theme: 'sepia', accent: '#b4530a' });
  assert.ok(store.has('cc-skill-theme'));
  theme.applyCached();
  assert.equal(el.dataset.theme, 'sepia');
  assert.equal(styleMap.get('--accent'), '#b4530a');
});

test('缓存损坏 / 缺失时不抛错，也不写坏 DOM', () => {
  const { theme, el } = loadTheme();
  assert.equal(theme.readCache(), null);
  theme.applyCached();
  assert.equal(el.dataset.theme, undefined);
});
