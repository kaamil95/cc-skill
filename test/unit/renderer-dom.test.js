// 渲染层的静态契约：app.js 里用到的每个 id 选择器，必须真的存在于 index.html，
// 或由 app.js 自己的 innerHTML 模板创建。写错一个 id 会让 app.js 在加载时抛
// TypeError（对 null 调 addEventListener），界面直接停在静态空壳上——
// 这正是「一错就白屏」那一类故障，值得在测试里先拦一道。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('renderer/index.html');
const appJs = read('renderer/app.js');
const bootJs = read('renderer/boot-guard.js');

const idsIn = (text) => new Set([...text.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
// 选择器里的 #id：$('#x') / $$('#x .y')。$('#' + id) 这类拼接出来的前缀（如 'panel-'）不算
const referencedIds = (text) => new Set([...text.matchAll(/[$(]{1,2}\('#([A-Za-z0-9_-]+)/g)].map((m) => m[1]).filter((id) => !id.endsWith('-')));

test('app.js 引用的每个 id 都真实存在（index.html 或 app.js 模板里）', () => {
  const available = new Set([...idsIn(html), ...idsIn(appJs), ...idsIn(bootJs)]);
  const missing = [...referencedIds(appJs)].filter((id) => !available.has(id));
  assert.deepEqual(missing, [], '找不到这些 id，加载时会直接抛错：' + missing.join(', '));
});

test('引用预览弹窗（点 SKILL.md 内链接后打开的）元素齐全', () => {
  const ids = idsIn(html);
  for (const id of ['modal-ref', 'ref-title', 'ref-path', 'ref-md', 'btn-ref-back', 'btn-ref-open']) {
    assert.ok(ids.has(id), 'index.html 缺少 #' + id);
  }
});

test('启动兜底脚本在 app.js 之前加载', () => {
  const bootAt = html.indexOf('src="boot-guard.js"');
  const appAt = html.indexOf('src="app.js"');
  assert.ok(bootAt > 0 && appAt > 0 && bootAt < appAt, 'boot-guard.js 必须先于 app.js 引入');
});

// ------------------------------ 主题契约 ------------------------------------
const css = read('renderer/styles.css');
const themeJs = read('renderer/theme.js');

/** 抓出每个 [data-theme='x'] { ... } 块里定义的变量名 */
function themeBlocks(source) {
  const out = {};
  for (const m of source.matchAll(/\[data-theme='([a-z]+)'\]\s*\{([^}]*)\}/g)) {
    out[m[1]] = new Set([...m[2].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((x) => x[1]));
  }
  return out;
}

// 每套主题都必须覆盖的颜色变量。--accent-* 系列由 color-mix 从 --accent 派生，不必逐个写；
// --radius / --font / --mono 与颜色无关；--red / --green / --orange 允许继承（饱和色在哪套底色上都成立）。
const REQUIRED_TOKENS = [
  '--bg',
  '--panel',
  '--inset',
  '--field',
  '--field-hover',
  '--field-active',
  '--hairline',
  '--hairline-strong',
  '--ring',
  '--ring-strong',
  '--dot-ring',
  '--text',
  '--text-2',
  '--text-3',
  '--text-label',
  '--icon-faint',
  '--fill-faint',
  '--fill',
  '--fill-soft',
  '--fill-hover',
  '--fill-active',
  '--scroll',
  '--scroll-hover',
  '--glass-topbar',
  '--glass-sidebar',
  '--glass-toast',
  '--code-bg',
  '--code-text',
  '--pre-bg',
  '--pre-border',
  '--editor-bg',
  '--quote',
  '--table-border',
  '--chevron',
  '--shadow-card',
  '--shadow-card-hover',
  '--shadow-modal',
  '--shadow-btn',
  '--shadow-pop',
  '--shadow-pop-hover',
  '--accent',
  '--on-accent',
  '--ok-text',
  '--ok-soft',
  '--warn-text',
  '--warn-strong',
  '--warn-soft',
  '--err-text',
  '--err-soft',
  '--purple-text',
  '--purple-soft',
  '--link',
];

test('四套主题都定义了全部颜色变量（漏一个就会在深色界面上留一块浅色）', () => {
  const blocks = themeBlocks(css);
  const declared = [...themeJs.matchAll(/const THEMES = \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]));
  assert.deepEqual(Object.keys(blocks).sort(), [...declared].sort(), 'styles.css 的主题块与 theme.js 的 THEMES 清单必须一一对应');
  for (const [id, vars] of Object.entries(blocks)) {
    const missing = REQUIRED_TOKENS.filter((v) => !vars.has(v));
    assert.deepEqual(missing, [], `主题 ${id} 缺少：${missing.join(', ')}`);
  }
});

test('主题块之外不许出现字面颜色（深色下漏一个写死的 #fff 就是一块白斑）', () => {
  // 抠掉四套主题块后再找颜色；剩下这几个是刻意与主题无关的
  const withoutThemes = css.replace(/\[data-theme='[a-z]+'\]\s*\{[^}]*\}/g, '');
  const allowed = [
    /#e81123/, // Windows 关闭按钮的约定色
    /#fff\b(?!\w)/, // 红底徽标 / 危险按钮上的白字
    /rgba\(15, 15, 18,/, // 弹窗遮罩
    /conic-gradient/, // 自定义取色器的彩虹环
    /mask-image/, // 卡片芯片行的淡出遮罩：只用 alpha 通道，与主题无关
  ];
  const offenders = withoutThemes
    .split('\n')
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter(({ line }) => /#[0-9a-fA-F]{3,8}|rgba?\(/.test(line))
    .filter(({ line }) => !allowed.some((re) => re.test(line)));
  assert.deepEqual(offenders, [], '这些行应该改用变量：' + JSON.stringify(offenders));
});

test('强调色预设都是 6 位十六进制（config 的校验只认这个格式）', () => {
  const list = /const ACCENTS = \[([^\]]*)\]/.exec(themeJs);
  assert.ok(list, 'theme.js 里应有 ACCENTS 清单');
  const hexes = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(hexes.length >= 4, '预设色太少，用户没有可选余地');
  for (const hex of hexes) assert.match(hex, /^#[0-9a-f]{6}$/, hex + ' 不是规范的 6 位十六进制');
});

test('设置面板的主题按钮与主题清单一致，且每块预览都带 data-theme', () => {
  const blocks = themeBlocks(css);
  const ids = [...html.matchAll(/data-theme-id="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, Object.keys(blocks), '每个主题都要有一个按钮，顺序也要对得上');
  // 迷你预览靠 [data-theme] 作用在自己身上取色，漏了属性就会是一块空白
  const swatches = [...html.matchAll(/class="theme-swatch" data-theme="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(swatches, ids, '每块主题预览都要带上对应的 data-theme');
  for (const id of ['set-theme', 'set-accent', 'set-accent-custom']) {
    assert.ok(idsIn(html).has(id), 'index.html 缺少 #' + id);
  }
});

test('主题脚本在 app.js 之前加载（否则首帧会闪一下默认配色）', () => {
  const themeAt = html.indexOf('src="theme.js"');
  const appAt = html.indexOf('src="app.js"');
  assert.ok(themeAt > 0 && appAt > 0 && themeAt < appAt, 'theme.js 必须先于 app.js 引入');
});

// ------------------------------ 隐藏 / 弹窗层级 ------------------------------
// 这两个都是「界面上看起来没反应、其实是层叠没生效」的坑，各踩过一次。
test('styles.css 里有通用的 .hidden 规则', () => {
  // 原先每个元素各写一条 `.xxx.hidden { display:none }`，新加的元素漏写就会出现
  // 「加了 hidden 类却依然显示」：市场弹窗的三个来源页签曾经同时显示。
  assert.match(css, /\.hidden\s*\{\s*display:\s*none/, '需要一条通用 .hidden 规则兜住所有元素');
});

test('确认弹窗的层级高于业务弹窗（不能靠 DOM 顺序）', () => {
  // 市场弹窗在 DOM 里排在确认弹窗之后，不给确认弹窗显式抬层级的话，
  // 点「安装」弹出的确认框会被压在下面，按钮点不到 —— 安装流程整个卡住。
  assert.match(css, /#modal-confirm\s*\{\s*z-index:\s*\d+/, '确认弹窗需要显式 z-index');
  const confirmAt = html.indexOf('id="modal-confirm"');
  const marketAt = html.indexOf('id="modal-market"');
  assert.ok(confirmAt > 0 && marketAt > 0 && marketAt > confirmAt, '市场弹窗确实是排在确认弹窗之后的那个（这条测试的前提）');
});

test('类选择器一律限定作用域（跨弹窗撞类会把处理器绑错）', () => {
  // 踩过：详情弹窗用全局的 .tab 选择器绑页签，市场弹窗的来源页签也叫 .tab，于是被一起绑上，
  // 点一下就走市场页签上并不存在的 dataset.tab，拼出匹配不到元素的选择器 → 每次点击抛 TypeError。
  // .modal-overlay 是刻意全局的（要一次遍历所有弹窗遮罩），白名单放行。
  const GLOBAL_OK = new Set(['modal-overlay']);
  const unscoped = [...appJs.matchAll(/\$\$\('\.([a-zA-Z-]+)'\)/g)].map((m) => m[1]).filter((c) => !GLOBAL_OK.has(c));
  assert.deepEqual(unscoped, [], '这些类选择器没限定作用域：' + unscoped.join(', '));
});
