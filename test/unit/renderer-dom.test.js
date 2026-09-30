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

// ------------------------------ 本体 / 链接的区分 ------------------------------
// 踩过：链接安装与本体是同一个 accent 蓝底 🔗 徽章，只有一个「×N」之差，
// 扫一眼根本分不出哪张卡片才是文件所在。区分必须靠形状，不能只靠文字。
test('本体与链接用两套相反的视觉（实心 vs 虚线描边）', () => {
  assert.match(appJs, /card-type canon/, '本体要有自己的徽章类');
  assert.match(appJs, /card-type link/, '链接要有自己的徽章类');
  assert.match(css, /\.card-type\.canon\s*\{[^}]*background:\s*var\(--accent\)/, '本体徽章应当是实心强调色');
  assert.match(css, /\.card-type\.link\s*\{[^}]*dashed/, '链接徽章应当是虚线描边');
});

test('卡片左侧还有一道竖标（形状先于文字，不读字也能分）', () => {
  assert.match(css, /\.card--canon::before/, '本体缺左侧实线竖标');
  assert.match(css, /\.card--link::before/, '链接缺左侧虚线竖标');
  assert.match(appJs, /' card--' \+ role/, '卡片应当按 linkRole 挂上对应的类');
});

test('卡片与详情描述的是「当前视图这一条」，不是背后的实体', () => {
  // 列表标题写着「<Agent> 的 SKILL」，那卡片就该说这个 Agent 目录里是什么。
  // 踩过：实体在 ~/.agents/skills（Codex/ZCode 共用），Claude Code 名下是链接，
  // 在 Claude Code 视图里卡片却打着「本体」徽章，点删除还会把共用的实体删掉。
  assert.match(appJs, /const entry = viewedEntry\(s, state\.filter\)/, 'cardHTML 要按当前筛选取这一条');
  assert.match(appJs, /viewedEntry\(s, state\.filter\)/, 'openDetail 默认也要按当前筛选取这一条');
});

test('每一条删除路径都作用于当前视图这一条', () => {
  // 踩过：详情弹窗里的删除改对了，卡片上那个内联「删除」按钮漏了 —— 在 Claude Code
  // 视图里删一条链接，确认框写的却是「删除 SKILL…1 个 Agent 共用此唯一副本」，
  // 按下去真把 .agents 里的实体删了。逐个入口盯住，别再漏第二个。
  const args = [...appJs.matchAll(/(?<!function )deleteSkill\(([^)]*)\)/g)].map((m) => m[1].trim()).filter((a) => a && a !== 's, closeAfter = false'); // 去掉函数定义本身
  assert.ok(args.length >= 2, '应当找到卡片与详情弹窗两处删除入口，实际：' + JSON.stringify(args));
  for (const a of args) {
    assert.match(a, /viewedEntry|detailEntry/, `这条删除路径没走当前视图这一条：deleteSkill(${a})`);
  }
});

test('只通过链接出现的 Agent，芯片与实体所在的 Agent 长得不一样', () => {
  // 一行芯片里「文件在这儿」和「只是链过来」原本完全一样，而卡片多半是被某个
  // Agent 筛出来的 —— 芯片才是回答「那文件到底在哪」的地方。
  assert.match(css, /\.chip\.link-chip\s*\{[^}]*dashed/, '链接芯片应当是虚线');
  assert.match(appJs, /agentChipHTML/, '实体与链接芯片要由同一个函数分流');
  assert.match(appJs, /linkOnlyAgentIds/, '芯片的链接判定要走 skillView');
});

test('skill-view.js 在 app.js 之前加载（app.js 顶部就解构它）', () => {
  const at = html.indexOf('src="skill-view.js"');
  const appAt = html.indexOf('src="app.js"');
  assert.ok(at > 0 && appAt > 0 && at < appAt, 'skill-view.js 必须先于 app.js 引入');
});

test('新加的界面文案都有英文对照（英文环境下不会掉出中文）', () => {
  const dict = read('renderer/i18n.js');
  for (const key of [
    '本体',
    '{n} 个链接',
    '通过链接共用，文件不在这里',
    '共用',
    '项目 · {name}',
    // 机器与配置 / 云端机器档案
    '机器与配置',
    '机器名',
    '机器标识',
    '重置标识',
    '云端机器档案',
    '导出到文件',
    '从文件导入',
    '导出时包含 WebDAV 密码',
    '设为我的机器标识',
    '移出列表',
    '删除档案与备份',
    '本机',
    '另一台电脑',
    '未被任何档案引用的备份',
    '这份备份来自「{name}」，不是本机。勾上表示这就是这台电脑（例如刚重装过系统），项目配置与 HOME 之外的目录会一并还原。',
    '未恢复 {n} 个项目配置：这份备份不算本机的。若这就是本机（例如刚重装过系统），重新打开弹窗勾选「这就是这台电脑」再来一次。',
  ]) {
    assert.ok(dict.includes(`'${key}':`) || dict.includes(`"${key}":`), 'i18n.js 缺少词条：' + key);
  }
});

// ------------------------------ 机器身份 --------------------------------------
// 踩过：机器标识是 config.json 里的随机 UUID，重装系统后变成新的，于是「同一台电脑」被
// 当成新机器 —— 项目配置与 HOME 之外的目录都不还原。身份不靠硬件指纹去猜（重装恰好让
// OS 级指纹失效，而硬件序列号最容易撞号，认错成「同一台」比认成「不同台」危险得多），
// 改成由用户在恢复弹窗里明确认领。
test('恢复弹窗里的认领开关默认收起，拿到对方标识才显示', () => {
  // 踩过：这一行用 hidden 属性收起，可它自己的 class 声明了 display:grid —— 作者样式压过
  // UA 的 [hidden]{display:none}，于是它一直可见，而 hidden 属性读回来还是 true，
  // 用户勾的是一个「看得见却被静默忽略」的框。断言必须盯可见性语义，不能只盯属性在不在。
  const rowTag = (html.match(/<label[^>]*id="rv-adopt-row"[^>]*>/) || [''])[0];
  assert.ok(rowTag, '认领行要在 index.html 里');
  assert.match((rowTag.match(/class="([^"]+)"/) || [])[1] || '', /\bhidden\b/, '认领行默认必须收起（用 .hidden 类）');
  assert.ok(!/\shidden(\s|>)/.test(rowTag), '不要用 hidden 属性：.adopt-row 有 display 声明，属性收不起来');
  assert.match(appJs, /const canAdopt = !!info\.machineId && !info\.sameMachine/, '只有拿到对方标识、且确认不是本机时才给认领');
  assert.match(appJs, /classList\.toggle\('hidden', !canAdopt\)/, '收起/展开要走 .hidden 类');
  assert.match(appJs, /const adoptMachine = !\$\('#rv-adopt-row'\)\.classList\.contains\('hidden'\)/, '读勾选状态也要按同一套判据');
});

test('带 display 声明的元素不能用 hidden 属性收起（.adopt-row 那类坑）', () => {
  // 通用防线：index.html 里带 hidden 属性、又不带 .hidden 类、而某个 class 声明了 display 的元素，
  // 都会「永远可见」。同类坑只有过 .adopt-row 一处，这条断言把它钉住，也拦住以后新加的。
  const displayClasses = new Set();
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)[^{}]*\{([^}]*)\}/g)) {
    if (/(^|;|\s)display\s*:/.test(m[2])) displayClasses.add(m[1]);
  }
  const offenders = [];
  for (const m of html.matchAll(/<[a-zA-Z][^>]*\bhidden\b[^>]*>/g)) {
    const tag = m[0];
    const cls = ((tag.match(/class="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
    if (cls.includes('hidden')) continue;
    const hit = cls.filter((c) => displayClasses.has(c));
    if (hit.length) offenders.push((tag.match(/id="([^"]+)"/) || [])[1] + '（' + hit.join(',') + '）');
  }
  assert.deepEqual(offenders, [], '这些元素加了 hidden 属性却收不起来：' + offenders.join('、'));
});

test('认领与重置走同一个写入点，身份不接受任意字符串', () => {
  const webdav = read('src/webdav.js');
  assert.match(webdav, /function adoptMachineId\(id\)/, '认领收在一个函数里');
  assert.match(webdav, /MACHINE_ID_RE\.test\(clean\)/, '标识要过校验，不合法直接拒');
  assert.match(appJs, /sync:resetMachine/, '重置标识是认领的反向出口');
  // 机器标识绝不进备份包 / 配置文件——它是身份，不是配置
  assert.match(read('src/config.js'), /machineId 不跟着走/);
});

// ------------------------------ 目标目录选择器 --------------------------------
// 原先用原生 <select>，选项只能写成 `~/.claude/skills · Claude Code` —— 路径在前、
// Agent 在后，两段信息一样重，扫下来分不出哪个是 Agent 哪个是目录；共用的
// ~/.agents/skills 还会在 Codex 和 ZCode 下各出现一次，看着像两条不同的目标。
test('目标目录用自绘下拉，不再是原生 select', () => {
  for (const id of ['copy-dir', 'new-dir', 'import-target', 'mk-target']) {
    assert.match(html, new RegExp(`id="${id}" class="picker"`), `#${id} 应当是 .picker 容器`);
    assert.ok(!html.includes(`<select id="${id}"`), `#${id} 不该还是原生 select`);
  }
});

test('读目标目录一律走 pickerValue（.value 在 div 上是 undefined）', () => {
  const raw = [...appJs.matchAll(/\$\('#(copy-dir|new-dir|import-target|mk-target)'\)\.value/g)];
  assert.deepEqual(
    raw.map((m) => m[1]),
    [],
    '这些地方还在读 .value：' + raw.map((m) => m[1]).join(', ')
  );
  assert.ok(appJs.includes('pickerValue('), 'app.js 里应有 pickerValue');
});

test('下拉弹层挂在 body 上（modal-body 是 overflow-y:auto，留在里面会被裁掉）', () => {
  assert.match(css, /\.picker-pop\s*\{[^}]*position:\s*fixed/, '弹层需要 fixed 定位');
  assert.match(appJs, /document\.body\.appendChild\(pickerPop\)/, '弹层要挂到 body 上');
});

test('弹窗关闭时收掉下拉弹层（它不在弹窗的 DOM 里，不会跟着隐藏）', () => {
  assert.match(appJs, /const closeModal = \(id\) => \{[^}]*closePicker\(\)/s, 'closeModal 要先收掉弹层');
});

test('下拉打开时按 Esc 只收下拉，不连整个弹窗一起关掉', () => {
  // document 上有一个「Esc 关掉所有弹窗」的处理器（见 app.js 的全局 keydown）。
  // 下拉不拦住冒泡的话，按一下 Esc 连安装弹窗一起没了 —— 真机踩过。
  assert.match(appJs, /e\.stopPropagation\(\);\s*closePicker\(\)/, '下拉的 Esc 要先 stopPropagation 再收自己');
});

// ------------------------------ 详情弹窗里的重复 ------------------------------
test('「装到别处」只有一个入口（页签里那个按钮已合并进页脚）', () => {
  // 原先链接页签里有个「＋ 安装链接到其他 Agent」，页脚还有个「复制到其他 Agent…」，
  // 点开的是同一个弹窗，只是一个默认链接、一个默认复制 —— 同一个门的两个把手。
  // 现在只留页脚那个，名字也改成中性的「安装到其他 Agent…」（弹窗里本来就能选方式）。
  assert.ok(!html.includes('btn-add-link'), 'index.html 里不该再有 #btn-add-link');
  assert.ok(!appJs.includes('btn-add-link'), 'app.js 里不该再引用 #btn-add-link');
  assert.match(appJs, /t\('安装到其他 Agent…'\)/, '页脚按钮要用中性文案');
});

test('链接列表里属于当前条目的那一行不再重复给按钮', () => {
  // 打开的就是一条链接时，那一行的路径 / Agent 芯片页头已经写过，
  // 「打开 / 卸载」也和页脚的「打开所在文件夹 / 删除」是同一件事
  assert.match(appJs, /state\.detailEntry/, '要能认出当前条目');
  assert.match(appJs, /link-here/, '当前条目要有自己的标记');
  assert.match(css, /\.link-here\s*\{/, '缺 .link-here 样式');
});

test('安装方式默认「创建链接」，且排在最前', () => {
  // 一份实体、多 Agent 共用是这个应用的主推用法；复制出 N 份各自发散的副本正是它要解决的问题。
  // 单文件 SKILL 建不了链接（copySkill 直接返回 invalid-link），项目目录里链接有被误提交的风险，
  // 这两种回落到复制。
  assert.match(appJs, /const canLink = linkAllowed && !isProjectTarget/, '能不能用链接要按目标目录算');
  assert.match(appJs, /\$\('#copy-mode-link'\)\.checked = true/, '默认选中链接');
  assert.match(appJs, /\$\('#copy-mode-copy'\)\.checked = true/, '不可用时退回复制');
  // 默认值依赖选中的目标目录，所以必须排在 fillTargetPicker 之后
  const fillAt = appJs.indexOf("fillTargetPicker($('#copy-dir'), prefer)");
  const defAt = appJs.indexOf('applyTarget(true)');
  assert.ok(fillAt > 0 && defAt > 0 && fillAt < defAt, '先填目标目录，再定默认安装方式');
  // 单选行里「创建链接」排在「复制副本」前面，和默认值一致
  const linkAt = html.indexOf('id="copy-mode-link"');
  const copyAt = html.indexOf('id="copy-mode-copy"');
  assert.ok(linkAt > 0 && copyAt > 0 && linkAt < copyAt, '默认项要排在前面');
});

test('目标目录换到项目里时，链接选项被禁掉并退回复制', () => {
  // 只做「降级」：用户手选的复制不会被掰回链接；但被这一条自动改掉的那次会记下来
  // （autoDowngraded），目标改回可链接的目录时还原 —— 否则「默认链接」绕一圈项目目录后就悄悄失效了
  assert.match(appJs, /\$\('#copy-mode-link'\)\.disabled = !canLink/, '不可用时要禁掉选项');
  assert.match(appJs, /\$\('#copy-dir'\)\._onPick = /, '目标目录变化时要重新判定');
  assert.match(appJs, /if \(el\._onPick\) el\._onPick\(value\)/, 'setPickerValue 要通知调用方');
  assert.match(appJs, /autoDowngraded = true/, '被自动降级的那次要记下来');
});
