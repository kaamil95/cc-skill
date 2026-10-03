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
  // 市场弹窗当年在 DOM 里排在确认弹窗之后，不给确认弹窗显式抬层级的话，点「安装」
  // 弹出的确认框会被压在下面。市场如今是侧栏页，用同样排在后面的 add-agent 弹窗守住前提。
  assert.match(css, /#modal-confirm\s*\{\s*z-index:\s*\d+/, '确认弹窗需要显式 z-index');
  const confirmAt = html.indexOf('id="modal-confirm"');
  const addAgentAt = html.indexOf('id="modal-add-agent"');
  assert.ok(confirmAt > 0 && addAgentAt > 0 && addAgentAt > confirmAt, 'add-agent 弹窗确实是排在确认弹窗之后的那个（这条测试的前提）');
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
    '导出配置到文件',
    '从文件导入配置',
    '导出时包含 WebDAV 密码',
    '设为我的机器标识',
    '删除机器',
    '本机',
    '另一台电脑',
    '恢复',
    '收起',
    '备份 {n} 份',
    '来源机器',
    '换一份…',
    '本机目录里的备份',
    '另一台机器的备份',
    '这份备份来自「{name}」，不是本机。勾上表示这就是这台电脑（例如刚重装过系统），项目配置与它名下的项目 SKILL 会一并还原。',
    '未恢复 {n} 个项目配置：这份备份不算本机的。若这就是本机（例如刚重装过系统），重新打开弹窗勾选「这就是这台电脑」再来一次。',
    '另有 {n} 个项目 SKILL 会一并恢复到本机的项目里',
    '另有 {n} 个项目 SKILL 不会恢复：这份备份不是本机的（勾下面的认领可以把它认回来）',
    '未恢复 {n} 个项目 SKILL：这份备份不是本机的（勾「这就是这台电脑」可以认回来）',
    '未恢复 {n} 个项目 SKILL：它们的项目没在本机登记过',
    '同时恢复了 {n} 个项目 SKILL ✓',
    '云端按机器分目录：每台备份过的机器一个子目录，备份包与它那一份信息都在里面。可以直接用别的机器的备份来恢复本机 —— 那只会还原全局 SKILL，项目级的只在恢复本机自己的备份时才回来。',
    // 词条里的 \n 在 i18n.js 源码里是转义写法，这里也要照抄转义，否则比的是真换行
    '从云端永久删除这台机器的整个目录，连同里面 {n} 份备份？\\n这个操作不可撤销。',
    // 总览的云端机器 / 设置的分类页签
    '云端机器',
    '立即备份',
    '备份中…',
    '请先在设置里填写 WebDAV 配置',
    '刷新',
    '管理',
    '查看全部',
    '共 {n} 台',
    '未备份',
    '认不出',
    '{n} 份',
    '云端还没有任何机器档案，上传一次备份就会出现这台机器。',
    '已从云端读到 {n} 台机器 ✓',
    '读取云端档案失败：',
    '外观',
    '云同步',
    '机器',
    '配置',
    '网络',
    '恢复默认只影响 Agents、SKILL 目录与项目列表，不会删除磁盘上的任何文件。',
    '导出配置到文件',
    '从文件导入配置',
    '云端根目录固定为 cc-skill-sync，每台机器在它下面各占一个子目录；多台机器共用一个网盘也不会互相覆盖。',
    '本机还没有云端备份 —— 请先选一台机器，再挑它的备份',
    '链路通（{ms} ms），目标返回 HTTP {s}',
    // 缺失目录的标记
    '目录不存在',
    '点击查看缺失的目录',
    // SKILL 市场（侧栏页，聚合检索）
    'SKILL 市场',
    '热门 SKILL',
    '检索结果',
    '发现并安装社区 SKILL，一次检索，聚合所有来源',
    '从 GitHub 安装',
    'Token 设置',
    'GitHub Token（可选）',
    '返回',
    '输入关键词开始检索',
    '未返回',
    '相关仓库（整仓安装）',
  ]) {
    assert.ok(dict.includes(`'${key}':`) || dict.includes(`"${key}":`), 'i18n.js 缺少词条：' + key);
  }
});

// ------------------------------ SKILL 市场（侧栏页） --------------------------
test('SKILL 市场是侧栏页：一个搜索框聚合所有来源', () => {
  // 三来源页签并成一个搜索框：来源只是行上的徽章，检索在主进程聚合
  assert.match(html, /data-filter="market"/, '侧栏要有 SKILL 市场这一项');
  assert.match(appJs, /function renderMarketPage\(\)/, '市场页要有自己的渲染函数');
  assert.match(appJs, /function bindMarketPage\(\)/, '页面重画后事件要重挂（不能留在模块加载期）');
  for (const gone of ['data-mk-src=', 'mk-pane-', 'mk-query-b', 'mk-go-b', 'mk-go-index', 'selectMkSource', 'mk-adv', 'mk-token', 'mk-index', 'mk-go-url']) {
    assert.ok(!appJs.includes(gone), '旧来源入口必须清掉：' + gone);
  }
  // 聚合检索走 market:searchAll；站点注册表仍从主进程拉（快捷标签）
  assert.match(appJs, /market:searchAll/, '聚合检索要走新通道');
  assert.match(appJs, /market:listBuiltin/, '快捷标签的站点注册表要从 market:listBuiltin 拉取');
  // 官网式首页：进页自动拉热门 + 快捷标签 + 节标题 + 头像行，不能一上来空空如也
  assert.match(appJs, /mk-tags/, '要有快捷标签行');
  assert.match(appJs, /featuredTried/, '热门只自动拉一次，失败下次进页重试');
  assert.match(appJs, /mk-sec-head/, '结果区要有节标题行');
  assert.match(appJs, /mk-avatar/, '结果行要有首字母头像');
  assert.match(css, /\.mk-tag\s*\{/, '缺快捷标签样式');
  assert.match(css, /\.mk-avatar\s*\{/, '缺头像样式');
  assert.match(css, /\.mk-sec-head\s*\{/, '缺节标题样式');
  assert.match(css, /\.mk-spin\s*\{/, '缺检索等待的转圈动画样式');
  assert.match(css, /\.mk-dup\b/, '缺「同名已存在」强调徽章样式');
  assert.match(appJs, /localNames/, '结果行要按本机已装名单标记「同名已存在」');
  assert.match(html, /modal-mkgh/, '从 GitHub 安装要有自己的弹窗');
  assert.match(appJs, /modal-mkgh/, '弹窗要从市场页打开');
  assert.match(html, /set-gh-token/, 'GitHub Token 要迁到设置页');
  assert.match(appJs, /set-gh-token/, '设置页要填存好的 Token');
  assert.match(css, /\.mkd-skill-item\b/, '缺仓库模式 SKILL 清单样式');
  // 详情弹窗：skill/repo/zip 三种条目都进同一个弹窗
  assert.match(appJs, /market:repoSkills/, '仓库条目要拉仓库 SKILL 清单');
  assert.match(appJs, /function mkEntryUrl\(/, '要有条目 URL 构造器');
  assert.match(appJs, /shell:openUrl/, '「在 GitHub 查看」要走 shell:openUrl');
  assert.match(appJs, /mk-act-install/, '行上要有独立的「安装」按钮');
  assert.match(appJs, /stopPropagation\(\)/, '安装按钮不能冒泡成「打开详情」');
  // 弹窗时代的遗骸必须清掉，否则 id 契约测试会替我们拦下——但语义要写明
  assert.ok(!html.includes('modal-market'), '发现弹窗应当删除');
  assert.ok(!html.includes('btn-market'), '顶栏「发现」按钮应当删除');
  assert.ok(!appJs.includes("openModal('modal-market')"), '市场不再走 openModal');
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
    // mk-target 随市场页长在 app.js 的模板里（弹窗删了），其余仍在 index.html
    const re = new RegExp(`id="${id}" class="picker"`);
    assert.ok(re.test(html) || re.test(appJs), `#${id} 应当是 .picker 容器`);
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
  const fillAt = appJs.indexOf("fillTargetPicker($('#copy-dir'), prefer, undefined, dupDirsFor(s.name))");
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

// ------------------------------ 总览：分区与云端机器 ---------------------------
// 踩过：指标 / 分布 / 最近动态三者挤在同一张容器里靠细分隔线分节，动态与上面的数据
// 连成一片，一屏扫下来分不出「哪块结束了」。现在每块各占一张卡，SKILL 网格仍排最后。
test('总览每块内容各占一张卡，SKILL 网格仍排在最下面', () => {
  assert.ok(!appJs.includes('class="overview"'), '旧的单容器三段式应当拆开');
  assert.ok(/\.dash-card\s*\{/.test(css), '缺 .dash-card 样式');
  const at = appJs.indexOf("$('#grid').innerHTML =");
  const end = appJs.indexOf("$('#grid').onclick = onDashboardClick");
  assert.ok(at > 0 && end > at, '找不到总览的拼装代码');
  const expr = appJs.slice(at, end);
  for (const key of ['overviewCard', 'activityCard']) assert.ok(expr.includes(key), '总览缺少 ' + key + ' 这一块');
  assert.ok(expr.indexOf('overviewCard') < expr.indexOf('activityCard'), '最近动态要排在指标 / 分布那块之后');
  assert.ok(expr.lastIndexOf('sections') > expr.indexOf('activityCard'), '全局 / 项目 SKILL 的网格仍要排在最后');
  // 机器列表整块只在配了 WebDAV 时出现：没配就没什么可看的
  assert.ok(expr.includes("webdavReady() ? machinesCardHTML() : ''"), '云端机器那块要按 WebDAV 是否配置来决定出不出');
  assert.ok(/\.dash-machines\s*\{/.test(css), '缺机器列表的样式');
});

test('缺失的目录要指得出是哪一个：芯片写明、总览的缺失数可点进去', () => {
  // 踩过：总览只报「N 个目录缺失」，缺了哪个全靠悬停提示；芯片上也只有一圈橙框 + ⚠，
  // 不看提示根本不知道那意味着什么。现在芯片直接写明「目录不存在」，总览的数字可点
  // 跳到该 Agent 的视图 —— 缺口在那边逐个标出。
  assert.match(appJs, /class="warn-tag"/, '芯片上要有可见的「目录不存在」标记');
  assert.match(appJs, /dash-warn dash-miss" data-agent=/, '总览的缺失数要带上 agent id 才点得进去');
  assert.match(appJs, /if \(miss\) return setFilter\(miss\.dataset\.agent\);/, '点缺失数要跳到对应 Agent 的视图');
  // 踩过：主进程 expand 用 path.join（反斜杠），渲染层 ~ 展开是拼接（正斜杠），严格 === 比不出
  // 缺失 —— 默认 Agent 的目录全是 ~ 形式，标记从来没亮过。比之前必须收敛分隔符。
  assert.match(appJs, /const normP = \(p\) => String\(p \|\| ''\)\.replace\(\/\\\\\/g, '\/'\);/, '路径比对要先统一分隔符');
  assert.ok(!appJs.includes('state.missing.some((m2) => m2.dir === expand(d))'), '不能再拿未归一的路径做严格相等');
  assert.match(css, /\.dir-chip\.warn\s*\{[^}]*warn-soft/, '缺失芯片要有底色，光一圈橙框不够显眼');
  assert.match(css, /\.dir-chip \.warn-tag\s*\{/, '缺 warn-tag 样式');
  assert.match(css, /\.dash-warn\.dash-miss\s*\{[^}]*cursor: pointer/, '可点的缺失数要有手型光标');
});

test('云端档案按需拉取：问过一次就不再问，失败也算问过', () => {
  // 搜索框每敲一个字都会重画总览，而 sync:machines 是一次 PROPFIND + 每个侧车一次 GET。
  // 失败若不当「问过」，WebDAV 地址写错 / 断网时就会每敲一个字重发一次（这条路上没有防抖）。
  assert.match(appJs, /if \(!webdavReady\(\) \|\| state\.machinesLoading \|\| state\.machinesTried\) return;/, 'ensureMachines 要先看缓存再决定拉不拉');
  assert.match(appJs, /state\.machinesTried = true;/, '问过就要落标记');
  // 落标记的位置必须在成败分支之外，否则失败态又会每次重画都重发
  const mark = appJs.indexOf('state.machinesTried = true;');
  const branch = appJs.indexOf('if (r && r.ok) {', mark - 400);
  assert.ok(branch > 0 && mark < branch, '「问过」的标记要写在成败分支之前（成功和失败都算问过）');
  assert.match(appJs, /function invalidateMachines\(\)/, '云端变了要能作废这份缓存');
  // 每条「云端变了」的路径都要作废，逐个盯住（只数调用次数会漏掉整条路径）
  const near = (anchor, span = 300) => {
    const i = appJs.indexOf(anchor);
    assert.ok(i > 0, '找不到锚点，测试本身过期了：' + anchor);
    return appJs.slice(i, i + span).includes('invalidateMachines()');
  };
  assert.ok(near("toast(t('已备份到云端 ✓'), 'ok');"), '手动备份之后没有作废机器列表缓存');
  assert.ok(near('state.webdav = wdReadInputs();'), '保存 WebDAV 配置之后没有作废');
  assert.ok(near('state.webdav = c.webdav;'), '自动备份之后没有作废');
  assert.ok(near('// 文件里可能带了新的 WebDAV 地址', 260), '导入配置（可能换了服务器）之后没有作废');
  assert.ok(near("api.invoke('sync:resetMachine')", 400), '重置本机标识之后没有作废');
  assert.ok(near('// 刚恢复的这份备份可能就是本机', 140), '恢复完成之后没有作废');
});

test('总览一画的就先把机器列表拉起来，首帧不会先断言一句「云端还没有任何机器档案」', () => {
  // 踩过：ensureMachines() 排在 innerHTML 赋值之后，第一帧会画出「云端还没有任何机器档案 /
  // 共 0 台」—— 那是关于云端的事实，还没问过就不该说，而且这段时间「刷新」会被守卫早退。
  const assign = appJs.indexOf("$('#grid').innerHTML =\n    overviewCard");
  const ensure = appJs.indexOf('if (webdavReady()) ensureMachines();');
  assert.ok(assign > 0 && ensure > 0, '找不到总览的拼装或拉取调用');
  assert.ok(ensure < assign, 'ensureMachines() 要排在 innerHTML 赋值之前');
});

test('总览的最近动态随日志实时刷新', () => {
  // 这块只在整页重画时才更新（而整页要等下次 scan），不在 log() 里推一把就会一直停在
  // 「共 0 条」—— 今天装了个 SKILL，总览上却什么都没发生。
  // 注意要断在调用点：`renderDashboardLogs()` 后面带分号才是调用，函数定义是 `() {`
  assert.match(appJs, /renderDashboardLogs\(\);[\s\S]{0,120}log:append/, '写日志时要顺手刷总览那块');
  assert.match(appJs, /function renderDashboardLogs\(\) \{[\s\S]{0,120}?if \(!box\) return;/, '总览不在屏幕上时什么都不做');
  assert.match(appJs, /id="dash-logs"/, '动态容器要有 id');
  assert.match(appJs, /id="dash-log-hint"/, '条数那行也要能单独刷（不然「共 0 条」会留着）');
});

test('机器卡片的状态各有形状与颜色，不是只靠文字', () => {
  // 分支逐个钉住：改错映射（例如把「认不出」判成 ok）测试必须变红，
  // 只断言函数存在是不够的
  assert.match(
    appJs,
    /if \(!m\.backups \|\| !m\.backups\.length\) return m\.unreadable \? \{ cls: 'warn', label: t\('认不出'\) \} : \{ cls: '', label: t\('未备份'\) \};/,
    '没有备份 = 灰点；档案读不出来（认不出是哪台）= 橙点'
  );
  assert.match(appJs, /return \{ cls: 'ok', label: tf\('\{n\} 份', \{ n: m\.backups\.length \}\) \};/, '有备份 = 绿点 + 份数');
  for (const cls of ['', '.ok', '.warn']) assert.ok(css.includes('.machine-state' + cls), '缺状态胶囊样式：machine-state' + cls);
  assert.match(css, /\.machine-dot\.ok\s*\{\s*background:\s*var\(--green\)/, '圆点要按状态上色（ok 用绿）');
  assert.match(css, /\.machine-dot\.warn\s*\{\s*background:\s*var\(--orange\)/, '圆点要按状态上色（warn 用橙）');
  assert.match(css, /\.machine-card\.self\s*\{/, '本机要能一眼分出来（强调色竖标）');
  // 卡片与「云端机器档案」弹窗共用同一行文案，免得同一份数据两处各说各话
  assert.match(appJs, /const line = machineBackupLine\(m\)/, '卡片要复用弹窗那行文案');
});

// ------------------------------ 云端机器档案：按机器分目录 ----------------------
// 踩过：平铺布局下备份包的归属只能靠侧车记着的那一份，于是「这台机器有几份备份」
// 无从得知（界面自己都承认过这一点），恢复也只能在「我的那份」与「全局最新」之间二选一。
// 现在云端每台机器一个目录，份数与归属都由目录本身决定。
test('机器档案：一台机器一行，恢复 / 备份列表 / 删除都写明是哪一台', () => {
  assert.match(appJs, /function machineRowHTML\(m, open\)/, '每行要知道自己是不是展开着');
  assert.match(appJs, /btnHTML\('useBackup', \{ dir: m\.dir, name: m\.latest\.name \}, t\('恢复'\)/, '每行要有「恢复」入口');
  assert.match(appJs, /btnHTML\('deleteMachine', \{ dir: m\.dir, n: m\.backups\.length \}/, '删的是整个目录，份数要带进确认框');
  assert.match(appJs, /btnHTML\('toggle', \{ dir: m\.dir \}/, '要能展开挑历史副本');
  assert.match(appJs, /state\.machinesOpen = state\.machinesOpen === dir \? '' : dir/, '展开状态按目录记');
  assert.ok(/\.mc-backups\s*\{/.test(css), '缺展开后备份列表的样式');
  assert.ok(/\.mc-backup\s*\{/.test(css), '缺单份备份那一行的样式');
  // 平铺时代的两个中间态按钮不该再出现
  assert.ok(!appJs.includes("t('移出列表')"), '「移出列表」在分目录后只会留下一个认不出的目录，已取消');
  assert.ok(!appJs.includes("t('删除档案与备份')"), '它已被「删除机器（整个目录）」取代');
});

test('「立即备份」长在本机那一行，机器列表这个管理界面不掺和', () => {
  // 备份是「本机」自己的动作，不是机器列表的管理动作 —— 所以外层卡头只有刷新 / 管理，
  // 备份按钮进机器档案里本机那一行
  assert.match(appJs, /if \(m\.self\) acts\.push\(btnHTML\('backup', \{ dir: m\.dir \}, t\('立即备份'\), ' primary'\)\)/, '本机行要有「立即备份」');
  assert.ok(!appJs.includes('id="btn-dash-backup"'), '总览卡头不该再有备份按钮');
  assert.match(appJs, /function runBackup\(btn\)/, '处理函数要有');
  assert.ok(!/function runBackup\(btn\)[\s\S]{0,900}await wdSave\(\)/.test(appJs), '不许存设置表单 —— 那条路上表单是空白的');
  assert.match(appJs, /if \(act === 'backup'\) \{\s*if \(await runBackup\(btn\)\) await loadMachines\(\);/, '备份完成要原地重拉，新副本立刻可见');
});

test('恢复弹窗：先说清这份备份是哪台机器的、哪一份', () => {
  assert.match(html, /id="rv-machine"/, '要有「来源机器」一行');
  assert.match(html, /id="btn-restore-switch"/, '要有「换一份…」的入口');
  assert.match(appJs, /\$\('#rv-machine'\)\.textContent = \[info\.machineName \|\| info\.hostname/, '来源机器要显示名字与目录');
  assert.match(appJs, /dir: state\.restoreDir,\s*name: state\.restoreName,/, '确认恢复要把目录与备份名一起回传');
});

test('恢复的各条入口都不能把没填过的设置表单存回去', () => {
  // 真机踩过：机器档案里点「恢复」→ openRestore 先 wdSave() —— 而设置表单从没填过（全空白），
  // 一保存就把用户配好的 WebDAV 连密码一起抹掉，恢复随即报「请先填写 WebDAV 配置」。
  // 门在 wdSave 本身：设置弹窗没开就直接短路
  const at = appJs.indexOf('async function wdSave()');
  const fn = appJs.slice(at, at + 900);
  assert.match(fn, /if \(\$\('#modal-settings'\)\.classList\.contains\('hidden'\)\) return true;/, '设置弹窗没开时 wdSave 必须短路');
  const openRestoreBody = appJs.slice(appJs.indexOf('async function openRestore('), appJs.indexOf("$('#btn-wd-restore')"));
  assert.ok(!/\bawait wdSave\(\)/.test(openRestoreBody), 'openRestore 自己不许存表单');
  // 设置页那个按钮的表单就在眼前，它保留「先存再恢复」
  assert.match(appJs, /#btn-wd-restore'\)\.addEventListener\('click', async \(\) => \{\s*if \(!\(await wdSave\(\)\)\) return toast/, '设置页入口要先存再恢复');
});

test('「从云端下载」先认本机自己的备份，没有就把选择权交给用户', () => {
  const at = appJs.indexOf('async function openRestore(');
  const body = appJs.slice(at, appJs.indexOf("$('#btn-wd-restore')"));
  assert.match(body, /sync:machines/, '要先看云端机器列表');
  assert.match(body, /m\.self && m\.backups\.length/, '只认本机目录里真有备份的那一行');
  assert.match(body, /openMachines\(\)/, '本机还没有备份时转到机器档案去挑，而不是静默退回「云端最新一条」');
});

test('项目级 SKILL 的归属跟着「是不是本机的备份」走，勾选框一改提示就变', () => {
  // 勾「这就是这台电脑」等于断言「这份备份是本机的」，项目级 SKILL 的提示必须跟着改 ——
  // 否则用户勾完看到的还是「不会恢复」
  assert.match(appJs, /function restoreSameMachine\(info\)/, '要有一个统一的判定');
  assert.match(appJs, /function renderRestoreNotes\(info\)/, '提示单独拆一层');
  assert.match(appJs, /\$\('#rv-adopt'\)\.addEventListener\('change'/, '勾选后要重画提示');
  assert.match(appJs, /if \(state\.restoreInfo\) renderRestoreNotes\(state\.restoreInfo\)/, '重画用的是弹窗那一份信息');
  // 勾一下认领绝不能把上面那组 Agent 勾选框重建一遍：用户取消掉的会被悄悄勾回来，
  // 恢复范围就跟着变了
  assert.ok(
    !/\$\('#rv-adopt'\)\.addEventListener\('change',[^;]*renderRestoreScope\(/.test(appJs),
    '认领的 change 处理器不许调 renderRestoreScope（那会重建勾选框）'
  );
  // 认领行要先摆好（它会把勾选框重置），提示才读得对
  const adoptAt = appJs.indexOf('  renderAdoptRow(info);\n  // 按钮的可用状态');
  const scopeAt = appJs.indexOf('  renderRestoreScope(info);\n  $(#rv-status'.replace('(#', "('#"));
  assert.ok(adoptAt > 0 && scopeAt > adoptAt, 'renderAdoptRow 要排在 renderRestoreScope 之前');
  assert.match(appJs, /if \(projectCount\) \{/, '有项目级 SKILL 时才提这一句');
});

// ------------------------------ 设置：两处容易混的入口 -------------------------
// 踩过：顶栏有个「导入 SKILL」，设置-配置里又有「导出到文件 / 从文件导入」，两个都叫「导入」，
// 点下去才知道一个是装 SKILL 内容、一个是换整套配置（Agents / 项目 / WebDAV）。
// 配置页这两个名字里必须带「配置」。
test('「导入 SKILL」与「导入配置」在名字上就分得开', () => {
  assert.match(html, /id="btn-import"[\s\S]{0,400}?导入 SKILL/, '顶栏那个装的是 SKILL 内容');
  assert.match(html, /id="btn-cfg-export" data-i18n="导出配置到文件"/, '配置页的导出要写明是「配置」');
  assert.match(html, /id="btn-cfg-import" data-i18n="从文件导入配置"/, '配置页的导入要写明是「配置」');
});

// 远程目录是可留空的一项：默认值写在提示里，不逼着用户填
test('远程目录不再是输入项：根目录固定，说明里讲清子目录规矩', () => {
  // 云端已按机器分目录，让用户填根目录只会引来「两台机器填了不同的根目录就互相看不见」
  // 这类问题。所以那格输入删掉，只留一行说明
  assert.ok(!html.includes('id="wd-path"'), '不该再有远程目录输入框');
  assert.ok(!appJs.includes("$('#wd-path')"), 'app.js 也不该再引用它');
  assert.ok(!html.includes('wd-optional'), '可留空那套样式随输入框一起退场');
  assert.ok(!css.includes('.wd-optional'), 'CSS 里同样不该再有');
  assert.match(html, /data-i18n="云端根目录固定为 cc-skill-sync，每台机器在它下面各占一个子目录；多台机器共用一个网盘也不会互相覆盖。"/, '要有一行说明');
  // 服务器地址 / 用户名 / 密码三样还在
  for (const id of ['wd-url', 'wd-user', 'wd-pass']) assert.ok(html.includes(`id="${id}"`), '还该有 #' + id);
});

// ------------------------------ 设置：分类页签 ---------------------------------
// 配置项越加越多，一列排到底就只能靠眼睛扫。按类别分页，一屏一类。
test('设置按类别分页：页签、面板、app.js 的清单三处对得上', () => {
  const ids = idsIn(html);
  const tabs = [...html.matchAll(/data-set-tab="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.length >= 4, '设置该按类别分页，实际只有 ' + tabs.length + ' 类');
  const list = /const SET_TABS = \[([^\]]*)\]/.exec(appJs);
  assert.ok(list, 'app.js 里应有 SET_TABS 清单');
  const keys = [...list[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(tabs, keys, '页签按钮与 SET_TABS 必须一一对应，否则某类永远切不到');
  for (const k of keys) assert.ok(ids.has('set-pane-' + k), 'index.html 缺少 #set-pane-' + k + ' 面板');
  assert.ok(tabs[0] === 'appear', '外观是最常改的一类，排在第一个');
});

test('设置的页签在 modal-body 之外，内容滚动时分类栏不跟着滚走', () => {
  const from = html.indexOf('id="modal-settings"');
  const tabsAt = html.indexOf('id="set-tabs"', from);
  const bodyAt = html.indexOf('<div class="modal-body">', from);
  assert.ok(from > 0 && tabsAt > from && bodyAt > from, '找不到设置弹窗的页签或内容区');
  assert.ok(tabsAt < bodyAt, '页签要排在 modal-body 之前');
  // 详情弹窗 / 市场弹窗也用 .tab 类，查询必须限定在 #set-tabs 内（跨弹窗撞类绑错处理器踩过一次）
  assert.match(appJs, /\$\$\('#set-tabs \.tab'\)/, '页签查询要限定作用域');
  assert.match(appJs, /classList\.toggle\('hidden', k !== key\)/, '切页签要收掉其他面板');
  assert.match(appJs, /\$\('#set-pane-' \+ k\)/, '面板是 #set-pane-<分类>');
});

test('多目录 Agent 视图按目录分段，且不丢卡', () => {
  // 共用目录混在 Agent 自己的目录里时，看不出哪张卡物理上落在哪个目录 —— 按目录分段
  assert.match(appJs, /buckets/, 'app.js 应有目录分桶');
  assert.match(appJs, /viewedEntry\(s, state\.filter\)\.parentDir/, '分组键是「当前视图条目」所在目录');
  // 兜底断言：parentDir 不在任何已登记目录的条目单独成段，绝不能静默丢卡
  assert.match(appJs, /绝不能静默丢卡/, '必须有丢卡兜底注释标记');
});
