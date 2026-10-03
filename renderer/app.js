/* CC Skill 渲染进程：全部 UI 逻辑 */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const svgIcon = (paths, size = 14, sw = 1.7) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const FOLDER_SVG = svgIcon(
  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  15
);
const FILE_SVG = svgIcon('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>', 15);
const FOLDER_BIG = svgIcon(
  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  46,
  1.2
);
const SEARCH_BIG = svgIcon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 46, 1.2);
// 总览「云端机器」卡片上的设备图标
const DEVICE_SVG = svgIcon('<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8.5 20.5h7"/><path d="M12 16.5v4"/>', 17, 1.6);
const CHECK_BIG = svgIcon('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5.5"/>', 40, 1.4);
const WARN_BIG = svgIcon(
  '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  40,
  1.4
);

const state = {
  skills: [],
  view: [],
  agents: [],
  projects: [],
  webdav: {},
  missing: [],
  HOME: '',
  filter: 'dashboard',
  search: '',
  detail: null,
  // 详情弹窗当前代表的那一条磁盘记录（见 viewedEntry）：在 Agent 视图里可能是链接条目，
  // 与 detail（整个技能的实体记录）不是同一个对象
  detailEntry: null,
  // SKILL 内引用文件的预览栈：每层记下自己的目录，嵌套引用才解析得对
  refStack: [],
  importSrc: null,
  logs: [],
  unreadErrors: 0,
  restoreDir: '',
  restoreName: null,
  restoreAgents: null,
  // 弹窗里那一份备份的完整信息：勾「这就是这台电脑」时要拿它重画恢复范围
  restoreInfo: null,
  dupGroups: [],
  editingAgents: null,
  editingProjects: null,
  ui: { lang: 'auto' },
  proxy: { mode: 'system', url: '', bypass: '' },
  marketCfg: { indexUrl: '', token: '' },
  // SKILL 市场页的工作状态：进入市场页时按 defaultMkState() 初始化（含 localStorage 记忆）
  market: null,
  // 机器身份：标识用于和云端档案比对，名字只用于显示（见 src/config.js 的说明）
  machine: { id: '', name: '', hostname: '' },
  // 云端机器档案列表，以及待改名的目标（null = 改本机）
  machines: [],
  // 总览那块机器列表的状态。云端档案是网络请求，不能每敲一个搜索字就重拉一遍：
  // 问过一次（成功或失败）就记下 machinesTried，云端真变了再用 invalidateMachines() 作废
  machinesLoading: false,
  machinesTried: false,
  machinesError: '',
  machinesRemote: '',
  // 机器档案里展开着的那台机器（目录名），空 = 全收起
  machinesOpen: '',
  renameTarget: null,
  // 设置弹窗当前停在的分类页签
  settingsTab: 'appear',
  logFile: '',
};

// 目标目录下拉的弹层状态。声明在这里而不是靠近实现，是为了让 closeModal 在
// 任何时机都能安全调用 closePicker（`let` 在声明前是 TDZ，会直接抛错）
let pickerPop = null;
let pickerOpenEl = null;

// ~ 形式 ↔ 本机绝对路径。三个函数都必须做分隔符边界判断：只比对前缀会把
// C:\Users\kaix 误判成 C:\Users\kai 之下的 ~/x，而路径一旦这样写进配置就再也还原不回来。
// 比对前还要统一两种分隔符——Windows 上 C:\a\b 与 C:/a/b 是同一个目录。
const isTilde = (p) => /^~(?=$|[\\/])/.test(String(p || '').trim());
const toSlash = (p) =>
  String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
const homePrefix = () => toSlash(state.HOME);
const underHome = (p) => {
  const h = homePrefix().toLowerCase();
  if (!h || !p) return false;
  const s = toSlash(p).toLowerCase();
  return s === h || s.startsWith(h + '/');
};
const expand = (p) => (isTilde(p) ? state.HOME + String(p).trim().slice(1) : p);
const shortPath = (p) => (underHome(p) ? '~' + toSlash(p).slice(homePrefix().length) : p);
const toTilde = (p) => {
  if (!underHome(p)) return p;
  const rest = toSlash(p).slice(homePrefix().length).split('/').filter(Boolean).join('/');
  return rest ? '~/' + rest : '~';
};
const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const isProjectTarget = (v) => {
  const norm = String(v || '')
    .replace(/[\\/]+/g, '/')
    .toLowerCase();
  return state.projects.some((p) =>
    norm.startsWith(
      String(p.dir)
        .replace(/[\\/]+/g, '/')
        .toLowerCase()
    )
  );
};
const agentById = (id) => state.agents.find((a) => a.id === id);

// ------------------------------ 日志 / Toast ---------------------------------
function log(msg, type = '') {
  state.logs.unshift({ time: new Date(), type, msg });
  if (state.logs.length > 500) state.logs.pop();
  if (!$('#modal-logs').classList.contains('hidden')) renderLogs();
  else if (type === 'err') {
    state.unreadErrors++;
    updateLogBadge();
  }
  // 总览上的「最近动态」直接跟着走：它现在独占一块，等下次整页重画就已经错过这一条了
  renderDashboardLogs();
  api.invoke('log:append', { type, msg }).catch(() => {});
}

function toast(msg, type = '') {
  log(msg, type);
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  if (type === 'err') {
    el.title = t('点击查看操作日志');
    el.addEventListener('click', () => {
      el.remove();
      openLogs();
    });
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 10000 : 2800);
}

function renderLogs() {
  const list = $('#log-list');
  if (!state.logs.length) {
    list.innerHTML = '<li class="log-empty">' + t('暂无日志') + '</li>';
    return;
  }
  const tag = (ty) => (ty === 'err' ? t('错误') : ty === 'ok' ? t('成功') : t('信息'));
  list.innerHTML = state.logs
    .map(
      (e) => `
    <li class="log-item ${e.type}">
      <span class="log-time">${e.time.toLocaleTimeString('zh-CN', { hour12: false })}</span>
      <span class="log-type">${tag(e.type)}</span>
      <span class="log-msg">${esc(e.msg)}</span>
    </li>`
    )
    .join('');
}
function updateLogBadge() {
  const b = $('#log-badge');
  if (state.unreadErrors > 0) {
    b.textContent = state.unreadErrors > 99 ? '99+' : state.unreadErrors;
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
}
function openLogs() {
  state.unreadErrors = 0;
  updateLogBadge();
  renderLogs();
  openModal('modal-logs');
}

window.addEventListener('error', (e) => toast(t('程序异常：') + (e.message || t('未知错误')), 'err'));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  toast(t('异步操作异常：') + ((r && (r.message || r)) || t('未知错误')), 'err');
});

// 致命错误兜底：把错误画进主区，并留下「重试 / 打开操作日志」两个出口。
// 顶栏与侧栏是 index.html 里的静态 DOM，不依赖任何数据，此时依然可点——
// 这是「出错了不等于什么都做不了」的底线：绝不能让界面停在空壳上。
function renderFatal(msg, retry) {
  log(msg, 'err');
  const grid = $('#grid');
  if (!grid) return;
  // 清掉旧数据：否则之后任何一次 renderGrid()（比如在搜索框里打字）会把错误卡冲掉，
  // 界面悄悄回到一份过期的列表上，用户以为一切都好
  state.view = [];
  state.skills = [];
  const title = $('#main-title');
  if (title) title.textContent = t('出错了');
  const hint = $('#main-hint');
  if (hint) hint.textContent = '';
  grid.innerHTML = `<div class="empty"><div class="big">${WARN_BIG}</div>${esc(msg)}
    <div class="dash-actions">
      <button class="btn primary" id="fatal-retry">${t('重试')}</button>
      <button class="btn" id="fatal-logs">${t('打开操作日志')}</button>
    </div>
  </div>`;
  const retryBtn = $('#fatal-retry');
  if (retryBtn) {
    if (retry) retryBtn.addEventListener('click', retry);
    else retryBtn.disabled = true;
  }
  const logBtn = $('#fatal-logs');
  if (logBtn) logBtn.addEventListener('click', openLogs);
}

// ------------------------------ 弹窗 ----------------------------------------
const openModal = (id) => $('#' + id).classList.remove('hidden');
const closeModal = (id) => {
  // 下拉弹层挂在 body 上，不跟着弹窗一起隐藏 —— 弹窗关了要顺手收掉
  closePicker();
  // 改名弹窗的目标也要一起清掉，免得关掉之后还被回车用陈旧目标改一次
  if (id === 'modal-rename') state.renameTarget = null;
  $('#' + id).classList.add('hidden');
};

// 统一风格的确认弹窗（替代原生 confirm，样式与「从云端恢复」一致）。
// 文案由调用方传入**已翻译**的成品字符串（调用点用的是 tf/t），这里不再过 t()。
let confirmSettle = null;
function confirmModal({ title, message, confirmLabel = '确定', danger = true }) {
  $('#cf-title').textContent = title;
  $('#cf-msg').textContent = message;
  // 非破坏性操作不放警告图标；用 display 而不是 visibility，免得空出图标的位置把标题推右
  $('#cf-ico').style.display = danger ? '' : 'none';
  const ok = $('#cf-ok');
  ok.textContent = confirmLabel;
  ok.classList.toggle('danger-solid', danger);
  ok.classList.toggle('primary', !danger);
  openModal('modal-confirm');
  ok.focus();
  return new Promise((resolve) => {
    confirmSettle = resolve;
  });
}
function settleConfirm(ok) {
  closeModal('modal-confirm');
  const resolve = confirmSettle;
  confirmSettle = null;
  if (resolve) resolve(ok);
}
$('#cf-ok').addEventListener('click', () => settleConfirm(true));
$('#cf-cancel').addEventListener('click', () => settleConfirm(false));
// 点遮罩空白处 / 按 Esc 都算取消
$('#modal-confirm').addEventListener('mousedown', (e) => {
  if (e.target === e.currentTarget) settleConfirm(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal-confirm').classList.contains('hidden')) settleConfirm(false);
});
$$('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
// 引用弹窗不管怎么关（×、点遮罩、Esc）都要清栈，否则下次从详情点引用会多出一层
// 指向旧文件的「返回上一份」
const clearRefStack = () => (state.refStack = []);
$$('.modal-overlay').forEach((ov) =>
  ov.addEventListener('mousedown', (e) => {
    if (e.target !== ov) return;
    ov.classList.add('hidden');
    if (ov.id === 'modal-ref') clearRefStack();
  })
);

// ------------------------------ 扫描 / 渲染 ---------------------------------
// 扫描序号：重叠的两次扫描可能后发先至，用旧结果覆盖新结果（已有的 restoreSeq 是同样的道理）
let scanSeq = 0;
async function scan() {
  const seq = ++scanSeq;
  let r;
  try {
    r = await api.invoke('scan');
  } catch (err) {
    r = { ok: false, error: String((err && err.message) || err) };
  }
  if (seq !== scanSeq) return false; // 期间又发起了一次扫描，这次的结果作废
  // IPC 层把异常收成 { ok:false }，这里必须显式判断：把 undefined 塞进 state，
  // 下一步 buildDisplayList 就会抛错，界面停在空壳上——那是另一种白屏。
  if (!r || !r.ok) {
    renderFatal(t('扫描失败：') + ((r && r.error) || t('未知错误')), () => scan());
    return false;
  }
  state.skills = r.skills || [];
  state.agents = r.agents;
  state.projects = r.projects || [];
  state.webdav = r.webdav || {};
  state.missing = r.missingDirs || [];
  state.view = buildDisplayList();
  i18n.apply(document);
  renderSidebar();
  renderGrid();
  updateDupsButton();
  return true;
}

function buildDisplayList() {
  const canonByKey = new Map();
  for (const s of state.skills) if (!s.linked) canonByKey.set(s.absPath.toLowerCase(), s);
  const view = [];
  for (const s of state.skills) {
    if (s.linked && s.linkTarget) {
      const canon = canonByKey.get(s.linkTarget.toLowerCase());
      if (canon) {
        (canon.links ||= []).push(s);
        continue;
      }
    }
    view.push(s);
  }
  for (const s of view) {
    s.links ||= [];
    s.allAgentIds = [...new Set([...s.agentIds, ...s.links.flatMap((l) => l.agentIds)])];
  }
  return view;
}

function renderSidebar() {
  const nav = $('#agent-nav');
  nav.innerHTML =
    state.agents
      .map((a) => {
        const n = state.view.filter((s) => !s.project && s.allAgentIds.includes(a.id)).length;
        return `<div class="nav-item ${state.filter === a.id ? 'active' : ''}" data-filter="${esc(a.id)}">
        <span class="nav-dot" style="background:${esc(a.color)}"></span>
        <span class="nav-name">${esc(a.name)}</span>
        <span class="nav-count">${n}</span>
      </div>`;
      })
      .join('') +
    `<div class="nav-item nav-add" id="nav-add-agent" title="${esc(t('添加自定义 Agent'))}">
        <span class="nav-icon">＋</span>
        <span class="nav-name">${t('添加 Agent')}</span>
      </div>`;
  // 只留两项：SKILL 目录数在主区概览里已有，侧栏再报一遍是重复信息
  $('#sidebar-foot').innerHTML = tf('{gn} 个 SKILL · {pn} 个项目', {
    gn: state.view.length,
    pn: state.projects.length,
  });
  $$('#agent-nav .nav-item:not(.nav-add)').forEach((el) => el.addEventListener('click', () => setFilter(el.dataset.filter)));
  const addA = $('#nav-add-agent');
  if (addA) addA.addEventListener('click', openAddAgentModal);
  renderProjectNav();
}

function renderProjectNav() {
  const section = $('#project-section');
  const el = $('#project-nav');
  section.style.display = '';
  const addProjectBtn = `<div class="nav-item nav-add" id="nav-add-project" title="${esc(t('选择一个项目目录，扫描其中的 SKILL'))}">
      <span class="nav-icon">＋</span>
      <span class="nav-name">${t('添加项目')}</span>
    </div>`;
  el.innerHTML =
    state.projects
      .map((p) => {
        const n = state.view.filter((s) => s.project && s.project.id === p.id).length;
        const key = 'project:' + p.id;
        return `<div class="nav-item ${state.filter === key ? 'active' : ''}" data-filter="${esc(key)}" title="${esc(p.dir)}">
        <span class="nav-icon">${FOLDER_SVG}</span>
        <span class="nav-name">${esc(p.name)}</span>
        <span class="nav-count">${n}</span>
      </div>`;
      })
      .join('') + addProjectBtn;
  $$('#project-nav .nav-item:not(.nav-add)').forEach((el2) => el2.addEventListener('click', () => setFilter(el2.dataset.filter)));
  const add = $('#nav-add-project');
  if (add) add.addEventListener('click', addProjectFlow);
}

// 侧栏快捷添加项目：选目录 → 保存配置 → 扫描 → 跳到该项目视图
async function addProjectFlow() {
  const dir = toTilde(await api.invoke('dialog:pickFolder'));
  if (!dir) return;
  if (state.projects.some((p) => p.dir.toLowerCase() === dir.toLowerCase())) {
    toast(t('该项目已在列表中'), 'err');
    return;
  }
  const name =
    dir
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() || dir;
  const projects = state.projects.concat([{ id: 'proj-' + Date.now(), name, dir }]);
  const r = await api.invoke('config:set', { agents: state.agents, projects });
  if (!r.ok) {
    toast(t('添加失败'), 'err');
    return;
  }
  state.projects = r.projects || projects;
  const added = state.projects[state.projects.length - 1];
  toast(tf('已添加 {name} ✓', { name }), 'ok');
  await scan();
  setFilter('project:' + added.id);
}

// ＋ 添加 Agent：命名后创建（目录为空，首次安装时自动生成默认目录）
function openAddAgentModal() {
  $('#new-agent-name').value = '';
  openModal('modal-add-agent');
  setTimeout(() => $('#new-agent-name').focus(), 50);
}

$('#btn-add-agent-go').addEventListener('click', async () => {
  const name = $('#new-agent-name').value.trim();
  if (!name) return toast(t('请填写 Agent 名称'), 'err');
  if (state.agents.some((a) => a.name === name)) return toast(t('已存在同名 Agent'), 'err');
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent';
  let id = slug;
  while (state.agents.some((a) => a.id === id)) id += '-2';
  const colors = ['#e07a4f', '#19b39a', '#f0a35c', '#4f8ef7', '#8b5cf6', '#e2556e', '#38bdf8'];
  const agents = state.agents.concat([{ id, name, color: colors[state.agents.length % colors.length], dirs: [] }]);
  const r = await api.invoke('config:set', { agents, projects: state.projects });
  if (!r.ok) return toast(t('创建失败：'), 'err');
  toast(tf('已添加 {name} ✓', { name }), 'ok');
  closeModal('modal-add-agent');
  await scan();
  setFilter(id);
});

function setFilter(f) {
  state.filter = f;
  $$('#sidebar .nav-item').forEach((el) => el.classList.toggle('active', el.dataset.filter === f));
  $$('#agent-nav .nav-item').forEach((el) => el.classList.toggle('active', el.dataset.filter === f));
  $$('#project-nav .nav-item').forEach((el) => el.classList.toggle('active', el.dataset.filter === f));
  if (f === 'dashboard') {
    $('#main-title').textContent = t('总览');
  } else if (f === 'market') {
    $('#main-title').textContent = t('SKILL 市场');
  } else if (String(f).startsWith('project:')) {
    const proj = state.projects.find((p) => p.id === f.slice(8));
    $('#main-title').textContent = proj ? tf('{name} · SKILL', { name: proj.name }) : t('项目 SKILL');
  } else {
    const a = agentById(f);
    $('#main-title').textContent = a ? tf('{name} 的 SKILL', { name: a.name }) : t('全部 SKILL');
  }
  renderGrid();
}

// ------------------------------ 卡片 / 网格 ---------------------------------
const { linkOnlyAgentIds, linkRole, viewedEntry } = window.skillView;

// 实体所在的 Agent 是实心芯片 + 彩色圆点；只通过链接出现的 Agent 是虚线芯片 + 🔗。
// 光靠卡片顶部的徽章不够：一行芯片里「文件在这儿」和「只是链过来」原本长得一模一样。
function agentChipHTML(a, isLink) {
  return isLink
    ? `<span class="chip link-chip" title="${t('通过链接共用，文件不在这里')}">🔗 ${esc(a.name)}</span>`
    : `<span class="chip"><span class="dot" style="background:${esc(a.color)}"></span>${esc(a.name)}</span>`;
}

function cardHTML(s) {
  // 卡片描述的是「当前视图下这个 Agent 目录里的那一条」：在 Claude Code 视图里，
  // 如果 Claude Code 名下是链接，这张卡就呈现成链接，而不是它背后那份实体。
  // 芯片行照旧列全部 Agent 的真实情况，两者合起来才回答得了「文件到底在哪」。
  const entry = viewedEntry(s, state.filter);
  // Agent 芯片最多显示 3 个，多的折成 +N：卡片一行放不下 7 个芯片，挤起来只会换行把高度搞乱
  const linkIds = linkOnlyAgentIds(s);
  const agents = s.allAgentIds.map(agentById).filter(Boolean);
  const shown = agents.slice(0, 3);
  const chips = (s.project ? [`<span class="chip proj-chip" title="${esc(t('项目 SKILL') + ' · ' + s.project.name)}">${esc(s.project.name)}</span>`] : [])
    .concat(shown.map((a) => agentChipHTML(a, linkIds.has(a.id))))
    .concat(agents.length > shown.length ? [`<span class="chip">+${agents.length - shown.length}</span>`] : [])
    .join('');
  const type = s.type === 'file' ? `<span class="card-type">${t('单文件')}</span>` : '';
  // 本体与链接刻意用两套相反的视觉：本体是实心徽章 + 卡片左侧实线（文件真在这儿），
  // 链接是虚线描边 + 左侧虚线（这里只是指向别处的一份引用）。两处都靠形状区分而不只是
  // 文字 —— 原先两者是同一个 accent 蓝底 🔗 徽章，扫一眼根本分不出来。
  const role = linkRole(entry);
  const linkBadge =
    role === 'dangling'
      ? `<span class="card-type warn" title="${t('源 SKILL 已被删除或移动')}">⚠ ${t('失效链接')}</span>`
      : role === 'link'
        ? `<span class="card-type link" title="${t('链接：只存一份，源更新即时生效')}">🔗 ${t('链接')}</span>`
        : role === 'canon'
          ? `<span class="card-type canon" title="${tf('{n} 个 Agent 通过链接共用此唯一副本', { n: entry.linkCount })}">${t('本体')} · ${tf('{n} 个链接', { n: entry.linkCount })}</span>`
          : '';
  const dirName = entry.type === 'file' ? entry.folder + '.md' : entry.folder;
  const pathText = entry.dangling ? t('源已丢失') : entry.linked ? '→ ' + shortPath(entry.linkTarget || entry.absPath) : dirName;
  const pathTip = entry.linked ? entry.linkTarget || entry.absPath : entry.absPath;
  return `<div class="card${role === 'copy' ? '' : ' card--' + role}" data-key="${esc(s.key)}">
    <div class="card-top">
      <div class="card-name">${esc(s.name)}</div>
      <div class="card-badges">${type}${linkBadge}</div>
    </div>
    <div class="card-desc" title="${esc(s.description)}">${esc(s.description) || '<span style="opacity:.55">' + t('（无描述）') + '</span>'}</div>
    <div class="card-path" title="${esc(pathTip)}">${esc(pathText)}</div>
    <div class="card-foot">
      <div class="card-chips">${chips}</div>
      <div class="card-actions">
        <button class="btn sm act-copy" title="${t('安装到其他 Agent（复制副本或创建链接）')}">${t('安装')}</button>
        <button class="btn sm danger act-del" title="${t('删除（移入回收站）')}">${t('删除')}</button>
      </div>
    </div>
  </div>`;
}

function bindCards() {
  $$('#grid .card').forEach((card) => {
    const s = state.view.find((x) => x.key === card.dataset.key);
    if (!s) return;
    card.addEventListener('click', () => openDetail(s));
    $('.act-copy', card).addEventListener('click', (e) => {
      e.stopPropagation();
      openCopyModal(s);
    });
    $('.act-del', card).addEventListener('click', (e) => {
      e.stopPropagation();
      // 与卡片呈现保持一致：删的是当前视图这一条（在 Agent 视图里可能是链接），
      // 而不是它背后那份实体 —— 否则确认框写「删除 SKILL…链接将失效」，
      // 按下去删掉的却是别的 Agent 正在共用的实体
      deleteSkill(viewedEntry(s, state.filter));
    });
  });
}

function renderGrid() {
  if (state.filter === 'dashboard') return renderDashboard();
  if (state.filter === 'market') return renderMarketPage();

  const q = state.search.trim().toLowerCase();
  const match = (s) => !q || (s.name + ' ' + (s.description || '') + ' ' + s.folder).toLowerCase().includes(q);

  const isProjectFilter = String(state.filter).startsWith('project:');
  let sections;
  let cfgCard = '';
  if (isProjectFilter) {
    const pid = state.filter.slice(8);
    const proj = state.projects.find((p) => p.id === pid);
    sections = [{ title: '', tag: '', dir: proj ? proj.dir : '', items: state.view.filter((s) => s.project && s.project.id === pid && match(s)) }];
    if (proj) {
      cfgCard = `<div class="agent-block scope-cfg">
        <div class="dash-sec">${t('项目路径')}</div>
        <div class="dir-chips"><span class="dir-chip" title="${esc(proj.dir)}">${esc(proj.dir)}</span></div>
        <div class="agent-add-dir"><button class="btn sm danger act-proj-del" data-id="${esc(proj.id)}" data-name="${esc(proj.name)}">${t('移除项目')}</button></div>
      </div>`;
    }
  } else {
    const a = agentById(state.filter);
    sections = [{ title: '', tag: '', dir: '', items: state.view.filter((s) => !s.project && s.allAgentIds.includes(state.filter) && match(s)) }];
    if (a) {
      // 主进程的 expand 走 path.join（反斜杠），渲染层的 ~ 展开是字符串拼接（正斜杠）——
      // 直接 === 会把同一目录比成两个，~ 形式的缺失目录就永远标不出来。比之前先收敛分隔符。
      const normP = (p) => String(p || '').replace(/\\/g, '/');
      const isMissing = (d) => state.missing.some((m2) => normP(m2.dir) === normP(expand(d)));
      const dirs =
        (a.dirs || [])
          .map((d) => {
            // 不存在的目录直接在芯片上写明，不靠悬停提示 —— 缺了哪个要一眼可见
            const missing = isMissing(d);
            return `<span class="dir-chip ${missing ? 'warn' : ''}" title="${esc(expand(d))}${missing ? '（' + t('目录不存在，安装时将自动创建') + '）' : ''}">
            ${missing ? '<span class="warn-ico">⚠</span>' : ''}${esc(d)}${missing ? `<span class="warn-tag">${t('目录不存在')}</span>` : ''}<span class="rm cfg-dir-rm" data-dir="${esc(d)}">×</span></span>`;
          })
          .join('') || `<span class="hint">${t('暂无目录')}</span>`;
      cfgCard = `<div class="agent-block scope-cfg">
        <div class="dash-sec">${t('SKILL 目录')}</div>
        <div class="dir-chips">${dirs}</div>
        <div class="agent-add-dir"><button class="btn sm act-dir-add">${t('＋ 添加 SKILL 目录')}</button></div>
      </div>`;
    }
  }

  const grid = $('#grid');
  const total = sections.reduce((n, sec) => n + sec.items.length, 0);
  $('#main-hint').textContent = tf('共 {n} 个 SKILL', { n: total });

  // 空状态同样要带出路径 / 目录管理卡：新添加的项目或 Agent 还没有 SKILL 时，仍可移除项目、添加目录
  let body;
  if (!state.view.length) {
    body = `<div class="empty"><div class="big">${FOLDER_BIG}</div>
      ${t('还没有扫描到任何 SKILL。<br>选择左侧 Agent 可「＋ 添加 SKILL 目录」，或点击「＋ 添加项目」登记项目目录。')}</div>`;
  } else if (!total) {
    body = `<div class="empty"><div class="big">${SEARCH_BIG}</div>${q ? tf('没有匹配「{q}」的 SKILL', { q: esc(q) }) : t('当前筛选下暂无 SKILL')}</div>`;
  } else {
    body = sections
      .map(
        (sec) => `
    ${sec.title ? `<div class="section-head"><h3>${esc(sec.title)}</h3>${sec.tag ? `<span class="chip proj-chip">${esc(sec.tag)}</span>` : ''}<span class="hint">${tf('{n} 个', { n: sec.items.length })}</span></div>` : ''}
    <div class="grid">${sec.items.map(cardHTML).join('')}</div>`
      )
      .join('');
  }

  grid.innerHTML = cfgCard + body;

  bindCards();

  const gridEl = $('#grid');
  gridEl.onclick = async (e) => {
    const rmDir = e.target.closest('.cfg-dir-rm');
    if (rmDir) {
      await saveAgentDirs(
        state.filter,
        (agentById(state.filter).dirs || []).filter((d) => d !== rmDir.dataset.dir)
      );
      return;
    }
    const addDir = e.target.closest('.act-dir-add');
    if (addDir) {
      const d = toTilde(await api.invoke('dialog:pickFolder'));
      if (!d) return;
      const a = agentById(state.filter);
      if ((a.dirs || []).includes(d)) return toast(t('该目录已存在'), 'err');
      await saveAgentDirs(state.filter, [...(a.dirs || []), d]);
      return;
    }
    const delProj = e.target.closest('.act-proj-del');
    if (delProj) {
      const okRemove = await confirmModal({
        title: t('移除项目'),
        message: tf('移除项目「{name}」？\n（只影响 CC Skill 的管理范围，不会删除磁盘上的任何文件）', { name: delProj.dataset.name }),
        confirmLabel: t('移除'),
        danger: false,
      });
      if (!okRemove) return;
      await api.invoke('config:set', { agents: state.agents, projects: state.projects.filter((p) => p.id !== delProj.dataset.id) });
      toast(t('已移除项目 ✓'), 'ok');
      setFilter('dashboard');
      scan();
    }
  };
}

async function saveAgentDirs(agentId, dirs) {
  const agents = state.agents.map((a) => (a.id === agentId ? { ...a, dirs } : a));
  const r = await api.invoke('config:set', { agents, projects: state.projects });
  if (r.ok) {
    toast(t('已保存 ✓'), 'ok');
    scan();
  } else toast(t('保存失败'), 'err');
}

// ------------------------------ 总览仪表盘 ------------------------------------
function renderDashboard() {
  const q = state.search.trim().toLowerCase();
  const match = (s) => !q || (s.name + ' ' + (s.description || '') + ' ' + s.folder).toLowerCase().includes(q);

  const global = state.view.filter((s) => !s.project && match(s));
  const projSkills = state.view.filter((s) => s.project && match(s));
  const links = state.skills.filter((s) => s.linked && !s.dangling).length;
  const dangling = state.skills.filter((s) => s.dangling).length;
  const dupGroups = buildDupGroups().length;

  const tiles = [
    { n: global.length, label: t('全局 SKILL') },
    { n: projSkills.length, label: t('项目 SKILL') },
    { n: state.agents.length, label: t('Agent') },
    { n: state.projects.length, label: t('项目') },
    { n: links, label: t('链接安装') },
    { n: dupGroups, label: t('待合并重复组'), warn: dupGroups > 0 },
  ];
  const missingByAgent = new Map();
  for (const m of state.missing) for (const id of m.agentIds) missingByAgent.set(id, (missingByAgent.get(id) || 0) + 1);

  const agentRows = state.agents
    .map((a) => {
      const n = global.filter((s) => s.allAgentIds.includes(a.id)).length;
      const miss = missingByAgent.get(a.id) || 0;
      return `<div class="dash-row">
        <span class="dot" style="background:${esc(a.color)}"></span>
        <span class="dash-name">${esc(a.name)}</span>
        <span class="dash-sub">${miss ? `<span class="dash-warn dash-miss" data-agent="${esc(a.id)}" title="${t('点击查看缺失的目录')}">⚠ ${tf('{n} 个目录缺失', { n: miss })} ›</span>` : tf('{n} 个目录', { n: (a.dirs || []).length })}</span>
        <span class="dash-n">${n}</span>
      </div>`;
    })
    .join('');
  const projRows = state.projects.length
    ? state.projects
        .map((p) => {
          const n = projSkills.filter((s) => s.project && s.project.id === p.id).length;
          return `<div class="dash-row">
            <span class="nav-icon" style="color:var(--text-3)">${FOLDER_SVG}</span>
            <span class="dash-name">${esc(p.name)}</span>
            <span class="dash-sub" title="${esc(p.dir)}">${esc(shortPath(p.dir))}</span>
            <span class="dash-n">${n}</span>
          </div>`;
        })
        .join('')
    : '<div class="hint" style="padding:8px 2px">' + t('还没有添加项目，点击左侧栏「＋ 添加项目」。') + '</div>';
  const logRows = logRowsHTML();

  const sections = [{ title: t('全局 SKILL'), tag: '', items: state.view.filter((s) => !s.project && match(s)) }]
    .concat(
      state.projects.map((p) => ({
        title: p.name,
        tag: t('项目'),
        items: state.view.filter((s) => s.project && s.project.id === p.id && match(s)),
      }))
    )
    .filter((sec) => sec.items.length);

  $('#main-hint').textContent = '';
  // 指标与分布仍是同一张卡里的两段（它们是一回事：本机的家底），用细分隔线分节；
  // 最近动态则单独成块 —— 早先它也挤在这张容器里，和上面的数据连成一片，
  // 一屏扫下来分不出「哪块结束了」。云端机器同理，各占一块。
  // 全局与项目 SKILL 的网格仍然排在最后。
  const overviewCard = `
    <section class="dash-card">
      <div class="ov-stats">
        ${tiles
          .map(
            (tl) =>
              `<div class="ov-stat"><div class="ov-n ${tl.warn ? 'warn' : ''}${tl.n ? '' : ' zero'}">${tl.n}</div><div class="ov-label">${tl.label}</div></div>`
          )
          .join('')}
      </div>
      <div class="ov-cols">
        <div class="ov-col">
          <div class="ov-sec">${t('AGENT 分布')}</div>
          ${agentRows || '<div class="hint">' + t('无') + '</div>'}
        </div>
        <div class="ov-col">
          <div class="ov-sec">${t('项目分布')}</div>
          ${projRows}
        </div>
      </div>
    </section>`;
  // 最近动态独占一块：它和上面的家底不是一类东西，连在一起看不出边界
  const activityCard = `
    <section class="dash-card">
      <div class="dash-head">
        <h3>${t('最近动态')}</h3>
        <span class="hint" id="dash-log-hint">${tf('共 {n} 条', { n: state.logs.length })}</span>
        <div class="dash-head-acts">
          <button class="btn sm" id="btn-dash-log-more">${t('查看全部')}</button>
        </div>
      </div>
      <div class="ov-activity" id="dash-logs">${logRows}</div>
    </section>`;
  // 先把拉取启动起来再画：machinesLoading 是同步置位的，所以首帧显示的就是「正在读取云端档案…」。
  // 反过来先画再拉，第一帧会断言一句「云端还没有任何机器档案，上传一次备份就会出现这台机器。」
  // —— 那是关于云端的事实，还没问过就不该说；这段时间里的「刷新」也会被守卫早退，像点不动。
  if (webdavReady()) ensureMachines();
  $('#grid').innerHTML =
    overviewCard +
    (webdavReady() ? machinesCardHTML() : '') +
    activityCard +
    (dangling ? `<div class="link-hint warn">${tf('⚠ 检测到 {n} 个失效链接（源已被删除），可在列表中筛选清理。', { n: dangling })}</div>` : '') +
    sections
      .map(
        (sec) => `
      <div class="section-head"><h3>${esc(sec.title)}</h3>${sec.tag ? `<span class="chip proj-chip">${esc(sec.tag)}</span>` : ''}<span class="hint">${tf('{n} 个', { n: sec.items.length })}</span></div>
      <div class="grid">${sec.items.map(cardHTML).join('')}</div>`
      )
      .join('');
  bindCards();
  $('#grid').onclick = onDashboardClick;
}

/** 总览上的点击：机器列表的刷新 / 管理与「查看全部日志」都走事件代理（卡片会整块重画） */
function onDashboardClick(e) {
  if (e.target.closest('#btn-dash-machines-refresh')) return reloadMachines();
  if (e.target.closest('#btn-dash-machines-manage') || e.target.closest('.machine-card')) return openMachines();
  if (e.target.closest('#btn-dash-log-more')) return openLogs();
  // 「N 个目录缺失」点了跳到该 Agent 的视图 —— 缺的目录在那边的芯片上逐个标出
  const miss = e.target.closest('.dash-miss');
  if (miss) return setFilter(miss.dataset.agent);
}

// ------------------------------ 总览：云端机器 --------------------------------
// 远程设备列表的样子：一台机器一张卡，左边设备图标、右边状态胶囊，中间是名字 /
// 主机名 / 最后一次备份。整块只在配了 WebDAV 时出现 —— 没配就没什么可看的。
const webdavReady = () => !!(state.webdav && state.webdav.url);

function machinesCardHTML() {
  return `<section class="dash-card">
    <div class="dash-head">
      <h3>${t('云端机器')}</h3>
      <span class="hint" id="dash-machines-hint">${esc(machinesHeadHint())}</span>
      <div class="dash-head-acts">
        <button class="btn sm" id="btn-dash-machines-refresh">${t('刷新')}</button>
        <button class="btn sm" id="btn-dash-machines-manage">${t('管理')}</button>
      </div>
    </div>
    <div class="dash-machines" id="dash-machines">${machinesInnerHTML()}</div>
  </section>`;
}

// 「正在读」要判在「读失败」前面：在读的时候界面该说在读，而不是继续举着上一次的失败 ——
// 点「刷新」之后还停在「✗ 读取失败」会让人以为按钮没反应
function machinesHeadHint() {
  if (state.machinesLoading) return t('正在读取云端档案…');
  if (state.machinesError) return t('读取失败');
  const n = tf('共 {n} 台', { n: state.machines.length });
  return state.machinesRemote ? n + ' · ' + state.machinesRemote : n;
}

function machinesInnerHTML() {
  if (!state.machines.length) {
    if (state.machinesLoading) return `<div class="dash-note">${t('正在读取云端档案…')}</div>`;
    if (state.machinesError) return `<div class="dash-note err">✗ ${esc(state.machinesError)}</div>`;
    return `<div class="dash-note">${esc(t('云端还没有任何机器档案，上传一次备份就会出现这台机器。'))}</div>`;
  }
  return state.machines.map(machineCardHTML).join('');
}

/** 一台机器的备份状态：决定圆点与胶囊的颜色（cls 为空 = 云端还没有它的备份） */
function machineState(m) {
  // 目录在、但档案读不出来（认不出是哪台）→ 橙点：它正是最该被处理的那种
  if (!m.backups || !m.backups.length) return m.unreadable ? { cls: 'warn', label: t('认不出') } : { cls: '', label: t('未备份') };
  return { cls: 'ok', label: tf('{n} 份', { n: m.backups.length }) };
}

function machineCardHTML(m) {
  const st = machineState(m);
  const host = [m.hostname, m.machineId ? m.machineId.slice(0, 8) : ''].filter(Boolean).join(' · ');
  // 与「云端机器档案」弹窗里同一行文案：一处改了另一处不会各说各话
  const line = machineBackupLine(m);
  return `<div class="machine-card${m.self ? ' self' : ''}${st.cls ? '' : ' idle'}" title="${esc(line)}">
    <div class="machine-ico">${DEVICE_SVG}</div>
    <div class="machine-main">
      <div class="machine-name"><b>${esc(m.name)}</b>${m.self ? `<span class="mc-tag">${esc(t('本机'))}</span>` : ''}</div>
      ${host ? `<div class="machine-host">${esc(host)}</div>` : ''}
      <div class="machine-meta"><span class="machine-dot ${st.cls}"></span><span>${esc(line)}</span></div>
    </div>
    <span class="machine-state ${st.cls}">${esc(st.label)}</span>
  </div>`;
}

/** 只重画总览这一块：加载态 / 结果 / 失败态都从这里过一道，别处不必知道细节 */
function renderDashboardMachines() {
  const box = $('#dash-machines');
  if (!box) return;
  box.innerHTML = machinesInnerHTML();
  const hint = $('#dash-machines-hint');
  if (hint) hint.textContent = machinesHeadHint();
  const btn = $('#btn-dash-machines-refresh');
  if (btn) btn.disabled = state.machinesLoading;
}

/** 懒加载：问过一次就不再问（搜索框每敲一个字都会重画总览，而这是一次网络请求） */
async function ensureMachines() {
  if (!webdavReady() || state.machinesLoading || state.machinesTried) return;
  await loadMachines();
}

/** 手动「刷新」：作废缓存重拉。显式动作要给回音，所以这条路上有 toast */
async function reloadMachines() {
  if (state.machinesLoading) return;
  state.machinesTried = false;
  state.machinesLoading = true;
  renderDashboardMachines(); // 先把「正在读取…」摆出来，别让按钮点下去像没反应
  const r = await loadMachines();
  if (r && r.ok) toast(tf('已从云端读到 {n} 台机器 ✓', { n: state.machines.length }), 'ok');
  else toast(t('读取云端档案失败：') + state.machinesError, 'err');
}

/** 云端变了（备份 / 恢复 / 换身份 / 改 WebDAV 配置）之后，总览那块已经不准了 */
function invalidateMachines() {
  state.machinesTried = false;
  if (state.filter === 'dashboard') renderGrid(); // 总览在屏幕上就顺手重取
}

/**
 * 备份动作本体：按钮在期间禁用并显示「备份中…」，结果用 toast 回音。
 * 入口在机器档案里本机那一行 —— 备份是「本机」的动作，不是机器列表这个管理界面的事。
 * 备份不删除任何东西（最多把 10 份之外的旧份挤掉，且那是既定策略），所以不用确认框。
 */
async function runBackup(btn) {
  if (!webdavReady()) return toast(t('请先在设置里填写 WebDAV 配置'), 'err');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('备份中…');
  try {
    const r = await api.invoke('sync:backup');
    if (!r.ok) return toast(t('备份失败：') + r.error, 'err');
    toast(tf('{name}（{count} 个 SKILL / {size}）', { name: r.name, count: r.count, size: fmtSize(r.size) }), 'ok');
    return true;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ------------------------------ 总览：最近动态 --------------------------------
/** 只列最近 5 条，全量在「操作日志」里（见 openLogs） */
function logRowsHTML() {
  if (!state.logs.length)
    return '<div class="hint" style="padding:8px 2px">' + t('暂无操作记录；安装 / 合并 / 删除的结果都会记录在「操作日志」中。') + '</div>';
  return state.logs
    .slice(0, 5)
    .map(
      (e) => `<div class="dash-row">
        <span class="log-time">${e.time.toLocaleTimeString('zh-CN', { hour12: false })}</span>
        <span class="log-type ${e.type}">${e.type === 'err' ? t('错误') : e.type === 'ok' ? t('成功') : t('信息')}</span>
        <span class="dash-sub" style="flex:1;white-space:normal">${esc(e.msg)}</span>
      </div>`
    )
    .join('');
}

/** 每来一条日志就单独刷这一块：这块不随整页重画，等下次渲染就漏掉刚才那条了 */
function renderDashboardLogs() {
  const box = $('#dash-logs');
  if (!box) return;
  box.innerHTML = logRowsHTML();
  const hint = $('#dash-log-hint');
  if (hint) hint.textContent = tf('共 {n} 条', { n: state.logs.length });
}

// ------------------------------ 详情 ----------------------------------------
// s 是整个技能（实体记录，负责芯片行 / 链接页签 / 安装），entry 是当前视图下这一条
// 磁盘记录（负责路径、提示条、打开文件夹、删除）。两者在「全部 SKILL」里是同一个对象；
// 在某个 Agent 视图里、且该 Agent 名下是链接时才会分开。
function openDetail(s, entry) {
  const seen = entry || viewedEntry(s, state.filter);
  state.detail = s;
  state.detailEntry = seen;
  state.refStack = [];
  $('#detail-title').textContent = s.name;
  const linkIds = linkOnlyAgentIds(s);
  const chips = (s.project ? [`<span class="chip proj-chip">${esc(s.project.name)}</span>`] : [])
    .concat(
      s.allAgentIds.map((id) => {
        const a = agentById(id);
        return a ? agentChipHTML(a, linkIds.has(id)) : '';
      })
    )
    .join('');
  $('#detail-meta').innerHTML = chips + `<span class="path" title="${esc(seen.absPath)}">${esc(seen.absPath)}</span>`;
  // 页脚那个按钮就是唯一的「装到别处」入口：安装弹窗里本来就能选复制还是链接，
  // 页签里再放一个默认选链接的按钮，只是同一个弹窗的第二个门
  $('#btn-detail-copy').textContent = s.project ? t('提取到全局…') : t('安装到其他 Agent…');
  const hint = $('#detail-hint');
  if (seen.dangling) {
    hint.className = 'link-hint warn';
    hint.textContent = t('⚠ 此条目是失效链接：源 SKILL 已被删除或移动，可安全清理。');
  } else if (seen.linked) {
    hint.className = 'link-hint';
    hint.textContent = tf('🔗 链接：文件不在这里，唯一副本位于 {p}；在这里编辑即修改唯一副本。', { p: shortPath(seen.linkTarget || '') });
  } else if (seen.linkCount) {
    hint.className = 'link-hint';
    hint.textContent = tf('📦 本体：文件就在这个目录，另有 {n} 个 Agent 通过链接共用它；在这里更新，所有 Agent 即时生效。', { n: seen.linkCount });
  } else {
    hint.className = 'hidden';
    hint.textContent = '';
  }
  $('#panel-preview').classList.remove('hidden');
  $('#panel-edit').classList.add('hidden');
  $('#panel-files').classList.add('hidden');
  $('#panel-links').classList.add('hidden');
  $$('#modal-detail .tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === 'preview'));
  $('#detail-editor').value = t('加载中…');
  $('#detail-files').innerHTML = '<li>' + t('加载中…') + '</li>';
  openModal('modal-detail');

  api.invoke('skill:read', { path: seen.skillMdPath }).then((r) => {
    if (r.ok) {
      $('#detail-md').innerHTML = api.md(r.body);
      $('#detail-editor').value = r.content;
    } else {
      $('#detail-md').textContent = t('读取失败：') + (r.error || '');
    }
  });
  api.invoke('skill:files', { dir: seen.type === 'folder' ? seen.absPath : seen.parentDir, type: seen.type }).then((r) => {
    if (!r.ok || !r.files.length) {
      $('#detail-files').innerHTML =
        `<li style="color:var(--text-3)">${seen.type === 'file' ? t('单文件 SKILL（') + esc(seen.folder) + '.md）' : t('空目录')}</li>`;
      return;
    }
    $('#detail-files').innerHTML = r.files
      .map((f) => `<li>${f.isDir ? FOLDER_SVG : FILE_SVG}<span>${esc(f.name)}</span><span class="fsize">${f.isDir ? t('目录') : fmtSize(f.size)}</span></li>`)
      .join('');
  });
  renderDetailLinks(s);
}

function renderDetailLinks(s) {
  const box = $('#detail-links');
  if (s.type !== 'folder') {
    box.innerHTML = '<div class="log-empty" style="padding:26px">' + t('单文件 SKILL 暂不支持链接安装') + '</div>';
    return;
  }
  if (!s.links || !s.links.length) {
    box.innerHTML =
      '<div class="log-empty" style="padding:30px">' +
      t('还没有安装任何链接') +
      '<br><span class="hint">' +
      t('点右下角「安装到其他 Agent…」，安装方式选「创建链接」，即可让其他 Agent 共用这份唯一副本') +
      '</span></div>';
    return;
  }
  // 正在看的这一条本身就是链接时，它在列表里就是「你在这儿」：路径与 Agent 芯片页头
  // 已经写过，打开/卸载也和页脚的「打开所在文件夹 / 删除」是同一件事，所以只留个标记，
  // 不再重复给按钮
  const here = state.detailEntry;
  box.innerHTML = s.links
    .map((l) => {
      const isHere = !!here && l.absPath === here.absPath;
      return `
    <div class="link-row" data-path="${esc(l.absPath)}" data-dir="${esc(l.parentDir)}" data-name="${esc(l.name)}" data-canon-key="${esc(s.key)}">
      <span class="link-tag ${l.dangling ? 'bad' : ''}">${l.dangling ? '⚠ ' + t('失效') : t('正常')}</span>
      <span class="dup-agents">${l.agentIds
        .map((id) => {
          const a = agentById(id);
          return a ? `<span class="chip"><span class="dot" style="background:${esc(a.color)}"></span>${esc(a.name)}</span>` : '';
        })
        .join(' ')}</span>
      <span class="link-path" title="${esc(l.absPath)}">${esc(shortPath(l.absPath))}</span>
      <span class="link-actions">${
        isHere
          ? `<span class="link-here">${t('当前条目')}</span>`
          : `<button class="btn sm act-link-open">${t('打开')}</button>
        <button class="btn sm danger act-link-uninstall">${t('卸载')}</button>`
      }</span>
    </div>`;
    })
    .join('');
}

$('#detail-links').addEventListener('click', async (e) => {
  const openBtn = e.target.closest('.act-link-open');
  if (openBtn) {
    const row = openBtn.closest('.link-row');
    api.invoke('shell:openPath', { path: row.dataset.dir });
    return;
  }
  const unBtn = e.target.closest('.act-link-uninstall');
  if (!unBtn) return;
  const row = unBtn.closest('.link-row');
  const okUninstall = await confirmModal({
    title: t('卸载链接'),
    message: tf('卸载链接「{name}」？\n仅移除链接，唯一副本不受影响：\n{path}', { name: row.dataset.name, path: row.dataset.path }),
    confirmLabel: t('卸载'),
  });
  if (!okUninstall) return;
  const r = await api.invoke('skill:trash', { path: row.dataset.path });
  if (!r.ok) {
    toast(t('卸载失败：') + (r.error || ''), 'err');
    return;
  }
  toast(t('已卸载链接（唯一副本保留）'), 'ok');
  await scan();
  const fresh = state.view.find((x) => x.key === row.dataset.canonKey);
  if (fresh) openDetail(fresh);
  else closeModal('modal-detail');
});

// ------------------------------ SKILL 内的引用链接 ---------------------------
// markdown 里的相对链接若原样交给浏览器，会按页面基准（renderer/）解析并把整个窗口
// 导航走——目标不存在时窗口只剩白屏，连自绘标题栏都随 DOM 一起消失。这里全部拦下：
// 交给主进程按 SKILL 所在目录解析，再决定内嵌预览 / 交系统程序 / 拒绝。
const refModalOpen = () => !$('#modal-ref').classList.contains('hidden');
const detailBaseDir = () => {
  const s = state.detail;
  if (!s) return '';
  return s.type === 'folder' ? s.absPath : s.parentDir;
};
// 引用弹窗打开时以栈顶目录为基准，嵌套引用才解析得对
const refBaseDir = () => (refModalOpen() && state.refStack.length ? state.refStack[state.refStack.length - 1].baseDir : detailBaseDir());

document.addEventListener('click', (e) => {
  const a = e.target.closest('.md a[href]');
  if (!a) return;
  e.preventDefault(); // 绝不把导航交给浏览器
  openMarkdownLink(a.getAttribute('href'));
});

async function openMarkdownLink(href) {
  const link = String(href || '').trim();
  if (!link) return;
  if (link.startsWith('#')) {
    const el = document.getElementById(link.slice(1));
    if (el) el.scrollIntoView({ block: 'start' });
    return;
  }
  const r = await api.invoke('skill:readRef', { baseDir: refBaseDir(), href: link });
  if (!r || !r.ok) return reportRefFailure(r, link);
  if (r.kind === 'external') {
    const o = await api.invoke('shell:openUrl', { url: r.url });
    if (!o || !o.ok) toast(t('打开链接失败'), 'err');
    return;
  }
  if (r.kind === 'text') return showRef(r);
  await api.invoke('shell:openPath', { path: r.path });
  toast(t('已用系统默认程序打开'));
}

// 失败一律给一句能读懂的话：解析结果里的绝对路径也带出来，方便用户自己去看
function reportRefFailure(r, href) {
  const reason = (r && r.reason) || 'error';
  if (reason === 'outside') return toast(t('该链接指向 SKILL 目录之外，已阻止'), 'err');
  if (reason === 'scheme') return toast(t('不支持的链接协议，已阻止'), 'err');
  if (reason === 'directory') {
    api.invoke('shell:openPath', { path: r.path });
    return toast(t('这是一个目录，已用系统默认程序打开'));
  }
  if (reason === 'missing') return toast(t('引用的文件不存在：') + shortPath(r.path || href), 'err');
  toast(t('读取引用失败：') + ((r && r.error) || href), 'err');
}

// 引用预览：栈里连内容一起存下，「返回」就是纯重绘，不再走一次 IPC
function showRef(r) {
  const name = String(r.path).split(/[\\/]/).filter(Boolean).pop() || r.path;
  state.refStack.push({ baseDir: String(r.path).replace(/[\\/][^\\/]*$/, ''), path: r.path, name, body: r.body || '' });
  renderRef();
  openModal('modal-ref');
}

function renderRef() {
  const top = state.refStack[state.refStack.length - 1];
  if (!top) return closeModal('modal-ref');
  $('#ref-title').textContent = top.name;
  $('#ref-path').textContent = shortPath(top.path);
  $('#ref-md').innerHTML = api.md(top.body);
  $('#btn-ref-back').classList.toggle('hidden', state.refStack.length <= 1);
  $('#btn-ref-open').onclick = () => api.invoke('shell:openPath', { path: top.path });
}

$('#btn-ref-back').addEventListener('click', () => {
  state.refStack.pop();
  renderRef();
});
// 关掉引用弹窗就把栈清空，免得下次从别的 SKILL 点链接时用错基准目录
$$('#modal-ref [data-close]').forEach((b) => b.addEventListener('click', () => (state.refStack = [])));

// 详情弹窗的页签处理器：选择器必须限定在 #modal-detail 内。
// 市场弹窗的来源页签也用 .tab 类，全局选择器会把它们一起绑上，点一下就走 el.dataset.tab
// （市场页签上这个值是 undefined），拼出来的选择器匹配不到元素，于是每次点击抛一次 TypeError。
$$('#modal-detail .tab').forEach((el) =>
  el.addEventListener('click', () => {
    $$('#modal-detail .tab').forEach((x) => x.classList.toggle('active', x === el));
    ['preview', 'edit', 'files', 'links'].forEach((p2) => $('#panel-' + p2).classList.add('hidden'));
    $('#panel-' + el.dataset.tab).classList.remove('hidden');
  })
);

$('#btn-save-skill').addEventListener('click', async () => {
  const r = await api.invoke('skill:write', { path: state.detail.skillMdPath, content: $('#detail-editor').value });
  if (r.ok) {
    toast(t('已保存 ✓'), 'ok');
    scan();
  } else toast(t('保存失败：') + (r.error || ''), 'err');
});

$('#btn-detail-open').addEventListener('click', () => {
  // 打开的是「你现在看的这一条」，不是它背后那份实体 —— 在 Claude Code 视图里
  // 点开一个链接，就该打开 Claude Code 目录里那个条目
  const e = state.detailEntry || state.detail;
  api.invoke('shell:openPath', { path: e.type === 'folder' ? e.absPath : e.parentDir });
});

// 删除同样只作用于当前视图这一条：在某个 Agent 视图里删掉一条链接，
// 不该把别的 Agent 正在共用的实体一起删了
$('#btn-detail-delete').addEventListener('click', () => deleteSkill(state.detailEntry || state.detail, true));
$('#btn-detail-copy').addEventListener('click', () => openCopyModal(state.detail));

async function deleteSkill(s, closeAfter = false) {
  let msg;
  if (s.dangling) {
    msg = tf('清理失效链接「{name}」？\n仅删除残留链接（源 SKILL 已不存在）：\n{path}', { name: s.name, path: s.absPath });
  } else if (s.linked) {
    msg = tf('移除链接「{name}」？\n仅移除链接，唯一副本（{p}）不受影响。', { name: s.name, p: shortPath(s.linkTarget || '') });
  } else if (s.linkCount) {
    msg = tf('确定删除 SKILL「{name}」？\n注意：{n} 个 Agent 通过链接共用此唯一副本，删除后这些链接将失效。\n{path}', {
      name: s.name,
      n: s.linkCount,
      path: s.absPath,
    });
  } else {
    msg = tf('确定删除 SKILL「{name}」吗？\n将移入回收站：\n{path}', { name: s.name, path: s.absPath });
  }
  const okTrash = await confirmModal({ title: t('删除确认'), message: msg, confirmLabel: t('删除') });
  if (!okTrash) return;
  const r = await api.invoke('skill:trash', { path: s.absPath });
  if (r.ok) {
    toast(r.linkRemoved ? t('已移除链接（唯一副本保留）🗑') : t('已移入回收站 🗑'), 'ok');
    if (closeAfter) closeModal('modal-detail');
    scan();
  } else toast(t('删除失败：') + (r.error || ''), 'err');
}

// --------------------------- 目标目录选择（公用） ----------------------------
// 自绘的下拉，替代原生 <select>：原生选项里塞不下「圆点 + Agent 名 + 灰掉的目录」，
// 而「这是哪个 Agent 的哪个目录」正是这个控件唯一要回答的问题。
// 原先的 `~/.claude/skills · Claude Code` 是路径在前、Agent 在后，一行里两段信息
// 一样重，扫下来分不出哪个是 Agent、哪个是目录，共用的 ~/.agents/skills 还会
// 在 Codex 和 ZCode 下各出现一次，看着像两条不同的目标。

function targetGroups() {
  // 共用目录（如 ~/.agents/skills 被多个 Agent 读）单独成组，与普通 Agent 目录平级：
  // 混在一起就要靠「共用」标签逐行解释，分了组整组不言自明，行内专注回答「谁在用」。
  const byDir = new Map();
  for (const a of state.agents) for (const d of a.dirs || []) byDir.set(d, (byDir.get(d) || []).concat(a));
  const solo = [];
  const shared = [];
  for (const [d, owners] of byDir) {
    const item = { value: d, dir: d, agents: owners, shared: owners.length > 1, agent: '', color: '' };
    if (item.shared) shared.push(item);
    else {
      item.agent = owners[0].name;
      item.color = owners[0].color;
      solo.push(item);
    }
  }
  const groups = [{ title: t('全局 · Agent 目录'), items: solo }];
  if (shared.length) groups.push({ title: t('全局 · 共享目录'), items: shared });
  for (const p of state.projects) {
    const items = ['.claude', '.agents', '.zcode', '.codex', '.qoder'].map((sub) => ({
      value: `${p.dir.replace(/[\\/]+$/, '')}/${sub}/skills`,
      agent: p.name,
      color: '',
      dir: `${sub}/skills`,
      tag: '',
    }));
    groups.push({ title: tf('项目 · {name}', { name: p.name }), items });
  }
  return groups.filter((g) => g.items.length);
}

const pickerValue = (el) => el.dataset.value || '';

function pickerFaceHTML(o) {
  if (!o) return `<span class="picker-dir">${esc(t('（没有可用的目标目录）'))}</span>`;
  // 共用目录：叠点 + 全部 Agent 名字，路径靠右兜底——「谁在用」一眼可数
  if (o.shared) {
    const names = o.agents.map((a) => a.name).join(' · ');
    return `<span class="picker-face">
      <span class="opt-dots">${o.agents.map((a) => `<span class="dot" style="background:${esc(a.color)}"></span>`).join('')}</span>
      <span class="picker-agent">${esc(names)}</span>
      <span class="picker-dir" title="${esc(o.dir)}">${esc(shortPath(o.dir))}</span>
    </span>`;
  }
  return `<span class="picker-face">
      ${o.color ? `<span class="dot" style="background:${esc(o.color)}"></span>` : ''}
      <span class="picker-agent">${esc(o.agent)}</span>
      <span class="picker-dir" title="${esc(o.dir)}">${esc(shortPath(o.dir))}</span>
    </span>`;
}

function fillTargetPicker(el, preferValue) {
  const groups = targetGroups();
  el._groups = groups;
  el._opts = groups.flatMap((g) => g.items);
  el.innerHTML = `<button type="button" class="picker-btn" aria-haspopup="listbox" aria-expanded="false"></button>`;
  const wanted = preferValue && el._opts.some((o) => o.value === preferValue) ? preferValue : (el._opts[0] || {}).value;
  setPickerValue(el, wanted);
  el.querySelector('.picker-btn').onclick = (e) => {
    e.stopPropagation();
    el.dataset.open === 'true' ? closePicker() : openPicker(el);
  };
  el.querySelector('.picker-btn').onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openPicker(el, e.key === 'ArrowDown' ? 0 : -1);
    } else if (e.key === 'Escape' && el.dataset.open === 'true') {
      // 同上：焦点还停在按钮上时按 Esc，也只收下拉
      e.stopPropagation();
      closePicker();
    }
  };
}

function setPickerValue(el, value) {
  el.dataset.value = value || '';
  const btn = el.querySelector('.picker-btn');
  if (btn) btn.innerHTML = pickerFaceHTML(el._opts.find((o) => o.value === value));
  // 让调用方能在选中项变化时做点事（安装弹窗靠它按目标目录调整安装方式）。
  // fillTargetPicker 初始化时会调到这里，那时 _onPick 还没挂上，所以不会误触发。
  if (el._onPick) el._onPick(value);
}

// ------------------------------ 下拉弹层 ------------------------------------
// 挂到 body 上而不是留在 .picker 里：modal-body 是 overflow-y:auto，留在里面会被裁掉
function closePicker() {
  if (pickerPop) pickerPop.remove();
  pickerPop = null;
  if (pickerOpenEl) pickerOpenEl.dataset.open = 'false';
  if (pickerOpenEl) pickerOpenEl.querySelector('.picker-btn').setAttribute('aria-expanded', 'false');
  pickerOpenEl = null;
  document.removeEventListener('click', onPickerDocClick, true);
  window.removeEventListener('scroll', placePicker, true);
  window.removeEventListener('resize', placePicker);
}

function placePicker() {
  if (!pickerPop || !pickerOpenEl) return;
  const r = pickerOpenEl.querySelector('.picker-btn').getBoundingClientRect();
  const h = pickerPop.offsetHeight;
  const below = r.bottom + 4;
  pickerPop.style.left = r.left + 'px';
  pickerPop.style.width = r.width + 'px';
  // 底下放不下就翻到上方，别让列表跑出屏幕
  pickerPop.style.top = below + h > window.innerHeight - 8 && r.top - h - 4 > 8 ? r.top - h - 4 + 'px' : below + 'px';
}

function onPickerDocClick(e) {
  if (pickerPop && pickerPop.contains(e.target)) return;
  if (pickerOpenEl && pickerOpenEl.contains(e.target)) return;
  closePicker();
}

// 下拉选项：普通项一行「Agent · 目录」；共用项同构 —— 叠点 + 全部 Agent 名字
// （' · ' 分隔）在左、路径灰字在后，组标题已说明这是共享目录
function pickerOptHtml(el) {
  return (o) => {
    if (o.shared) {
      const names = o.agents.map((a) => a.name).join(' · ');
      return `<button type="button" class="picker-opt shared" role="option" data-value="${esc(o.value)}"
          aria-selected="${o.value === pickerValue(el)}" title="${esc(names)}">
          <span class="opt-dots">${o.agents.map((a) => `<span class="dot" style="background:${esc(a.color)}"></span>`).join('')}</span>
          <span class="picker-agent">${esc(names)}</span>
          <span class="picker-dir" title="${esc(o.dir)}">${esc(shortPath(o.dir))}</span>
        </button>`;
    }
    return `<button type="button" class="picker-opt" role="option" data-value="${esc(o.value)}"
          aria-selected="${o.value === pickerValue(el)}">
          ${o.color ? `<span class="dot" style="background:${esc(o.color)}"></span>` : ''}
          <span class="picker-agent">${esc(o.agent)}</span>
          <span class="picker-dir" title="${esc(o.dir)}">${esc(shortPath(o.dir))}</span>
          ${o.tag ? `<span class="picker-tag">${esc(o.tag)}</span>` : ''}
        </button>`;
  };
}

function openPicker(el, focusIdx) {
  closePicker();
  const groups = el._groups || [];
  pickerPop = document.createElement('div');
  pickerPop.className = 'picker-pop';
  pickerPop.setAttribute('role', 'listbox');
  pickerPop.innerHTML = groups.length
    ? groups.map((g) => `<div class="picker-group">${esc(g.title)}</div>` + g.items.map(pickerOptHtml(el)).join('')).join('')
    : `<div class="picker-empty">${esc(t('还没有配置任何 Agent 目录或项目'))}</div>`;
  document.body.appendChild(pickerPop);
  el.dataset.open = 'true';
  el.querySelector('.picker-btn').setAttribute('aria-expanded', 'true');
  pickerOpenEl = el;
  placePicker();

  pickerPop.onclick = (e) => {
    const opt = e.target.closest('.picker-opt');
    if (!opt) return;
    setPickerValue(el, opt.dataset.value);
    closePicker();
    el.querySelector('.picker-btn').focus();
  };
  pickerPop.onkeydown = (e) => {
    const opts = [...pickerPop.querySelectorAll('.picker-opt')];
    const cur = opts.findIndex((o) => o === document.activeElement);
    if (e.key === 'Escape') {
      // 只关下拉，别让 Esc 继续冒泡到 document —— 那里有个「关掉所有弹窗」的处理器，
      // 不拦住的话按一下 Esc 连整个安装弹窗一起没了
      e.preventDefault();
      e.stopPropagation();
      closePicker();
      el.querySelector('.picker-btn').focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(cur + 1, opts.length - 1) : Math.max(cur - 1, 0);
      opts[next]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      document.activeElement?.click();
    }
  };
  // 弹层里的方向键要能直接落上去，所以先给一个可聚焦元素
  const opts = [...pickerPop.querySelectorAll('.picker-opt')];
  const sel = opts.findIndex((o) => o.getAttribute('aria-selected') === 'true');
  const start = focusIdx === 0 ? 0 : focusIdx === -1 ? opts.length - 1 : sel >= 0 ? sel : 0;
  opts[start]?.focus();

  document.addEventListener('click', onPickerDocClick, true);
  // 弹层用 fixed 坐标，容器一滚就跟丢了 —— 跟着重新摆一次
  window.addEventListener('scroll', placePicker, true);
  window.addEventListener('resize', placePicker);
}

// --------------------------- 安装（复制 / 链接） -----------------------------
function openCopyModal(s) {
  const fromProject = !!s.project;
  $('#copy-src').innerHTML =
    tf(s.type === 'folder' ? '将安装 {name}（整目录）' : '将安装 {name}（单文件）', { name: esc(s.name) }) +
    (fromProject ? ` <span class="chip proj-chip">${esc(s.project.name)}</span>` : '');
  const prefer = fromProject ? ((agentById(s.agentIds[0]) || {}).dirs || [])[0] : null;
  fillTargetPicker($('#copy-dir'), prefer);

  // 默认「创建链接」：一份实体、多 Agent 共用是这个应用的主推用法，复制出 N 份各自发散的
  // 副本正是它要解决的问题。两种情况回落到「复制副本」：
  //   · 单文件 SKILL —— 建不了链接（copySkill 直接返回 invalid-link）
  //   · 目标落在项目目录里 —— 项目多是 Git 仓库，链接有被误提交的风险
  // 所以这一步必须排在 fillTargetPicker 之后：默认值要看当前选中的目标目录。
  const linkAllowed = s.type === 'folder';
  $('#copy-link-label').style.display = linkAllowed ? '' : 'none';
  // 目标目录换到项目里时，链接就不可用了：禁掉选项并退回复制，而不是让界面摆着一个
  // 按下去会被 doInstall 悄悄改掉的选项。
  // 只做「降级」：用户自己选的复制不会被掰回链接；但被这一条自动改掉的那次会记下来，
  // 目标改回可链接的目录时还原 —— 否则「默认链接」在绕一圈项目目录后就悄悄失效了。
  let autoDowngraded = false;
  const applyTarget = (isDefault) => {
    const canLink = linkAllowed && !isProjectTarget(pickerValue($('#copy-dir')));
    $('#copy-mode-link').disabled = !canLink;
    $('#copy-link-label').title = canLink ? '' : t('项目目录通常是 Git 仓库，链接有误提交风险');
    if (!canLink) {
      if (!$('#copy-mode-copy').checked) autoDowngraded = true;
      $('#copy-mode-copy').checked = true;
    } else if (isDefault || autoDowngraded) {
      $('#copy-mode-link').checked = true;
      autoDowngraded = false;
    }
  };
  $('#copy-dir')._onPick = () => applyTarget(false);
  // 用户自己点过单选，就把「自动降级」那笔账销掉 —— 他选的就是他要的。
  // 用 click 而不是 change：点一个已经选中的单选框不产生 change 事件，但那是明确的表态
  // （比如刚被自动降级成复制，用户又点了一下复制）。用 onclick 赋值而不是 addEventListener：
  // 弹窗每次打开都会走到这里，监听器不能叠加。（applyTarget 里的 .checked = true 是程序设的，
  // 不触发 click，不会误销）
  $$('input[name=copy-mode]').forEach((r) => {
    r.onclick = () => {
      autoDowngraded = false;
    };
  });
  applyTarget(true);

  openModal('modal-copy');
  $('#btn-copy-go').onclick = () => doInstall(s, false);
}
async function doInstall(s, forceCopy) {
  let mode = forceCopy ? 'copy' : $('input[name=copy-mode]:checked').value;
  const destDir = pickerValue($('#copy-dir'));
  if (mode === 'link' && isProjectTarget(destDir)) {
    mode = 'copy';
    toast(t('项目目录通常是 Git 仓库，链接有误提交风险，已改为复制副本'));
  }
  const r = await api.invoke('skill:copy', {
    srcPath: s.absPath,
    type: s.type,
    destDir,
    folderName: s.folder,
    onConflict: $('input[name=copy-conflict]:checked').value,
    mode,
  });
  if (r.ok) {
    toast(r.linked ? t('已创建链接（单一副本）✓') : isProjectTarget(destDir) ? t('已安装到项目 ✓') : t('已复制到全局 ✓'), 'ok');
    closeModal('modal-copy');
    scan();
    return;
  }
  if (r.reason === 'cross-volume') {
    toast(t('源与目标不在同一磁盘，无法创建链接，已改为复制副本'));
    return doInstall(s, true);
  }
  if (r.reason === 'exists') {
    toast(t('目标已存在同名 SKILL，请选择覆盖或自动重命名'), 'err');
  } else {
    toast(t('操作失败：') + (r.error || ''), 'err');
  }
}

// --------------------------- 合并重复 ----------------------------------------
function buildDupGroups() {
  const real = state.skills.filter((s) => s.type === 'folder' && !s.linked);
  const byName = new Map();
  for (const s of real) {
    if (!byName.has(s.folder)) byName.set(s.folder, []);
    byName.get(s.folder).push(s);
  }
  const groups = [];
  for (const [folder, copies] of byName) {
    if (copies.length < 2) continue;
    copies.sort((a, b) => b.agentIds.length - a.agentIds.length || a.parentDir.localeCompare(b.parentDir));
    groups.push({ folder, copies, keepIdx: 0, same: null, hasProject: copies.some((c) => isProjectTarget(c.parentDir)) });
  }
  return groups;
}

function updateDupsButton() {
  const n = buildDupGroups().length;
  // 没有重复项时按钮直接退场：工具栏上不该常驻一个永远是 0 的入口
  $('#btn-dups').classList.toggle('hidden', n === 0);
  $('#dups-label').textContent = n ? tf('合并重复 ({n})', { n }) : t('合并重复');
}

async function openDupsModal() {
  state.dupGroups = buildDupGroups();
  const groups = state.dupGroups;
  const list = $('#dups-list');
  if (!groups.length) {
    list.innerHTML = '<div class="empty" style="padding:34px"><div class="big">' + CHECK_BIG + '</div>' + t('没有发现重复的 SKILL，很好 ✨') + '</div>';
    openModal('modal-dups');
    return;
  }
  list.innerHTML = groups
    .map(
      (g, gi) => `
    <div class="dup-group" data-gi="${gi}">
      <div class="dup-head"><b>${esc(g.folder)}</b><span class="dup-tag" id="dup-tag-${gi}">${t('比对中…')}</span></div>
      ${g.copies
        .map(
          (c, ci) => `
        <div class="dup-row">
          <label class="dup-keep"><input type="radio" name="keep-${gi}" value="${ci}" ${ci === 0 ? 'checked' : ''} /> ${t('保留')}</label>
          <span class="dup-path" title="${esc(c.absPath)}">${esc(shortPath(c.parentDir))}</span>
          <span class="dup-agents">${c.agentIds
            .map((id) => {
              const a = agentById(id);
              return a ? `<span class="chip"><span class="dot" style="background:${esc(a.color)}"></span>${esc(a.name)}</span>` : '';
            })
            .join(' ')}</span>
          <span class="dup-files">${c.fileCount} ${t('个文件')}</span>
        </div>`
        )
        .join('')}
      <button class="btn sm primary act-merge" data-gi="${gi}">${g.hasProject ? t('合并 / 同步（项目侧覆盖为保留副本内容）') : t('合并：其余替换为链接')}</button>
    </div>`
    )
    .join('');
  openModal('modal-dups');
  for (const [gi, g] of groups.entries()) {
    const results = await Promise.all(g.copies.slice(1).map((c) => api.invoke('skill:compare', { pathA: g.copies[0].absPath, pathB: c.absPath })));
    g.same = results.every((r) => r.ok && r.same);
    const el = $('#dup-tag-' + gi);
    if (el) {
      el.textContent = g.same ? t('内容一致，可放心合并') : t('⚠ 内容不同，请确认保留哪份');
      el.className = 'dup-tag ' + (g.same ? 'tag-ok' : 'tag-warn');
    }
  }
}

$('#dups-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.act-merge');
  if (!btn) return;
  const gi = +btn.dataset.gi;
  const g = state.dupGroups[gi];
  const keepIdx = +($(`input[name=keep-${gi}]:checked`) || { value: 0 }).value;
  const keep = g.copies[keepIdx];
  const others = g.copies.filter((c, i2) => i2 !== keepIdx);
  const warn = g.same === false ? '\n\n' + t('注意：各副本内容不同，未选中的全局副本将进入回收站（可找回）。') : '';
  const action = g.hasProject
    ? tf('以 {p} 中的副本为准：\n· 其余全局目录中的副本 → 移入回收站并替换为链接\n· 项目目录中的副本 → 用保留副本的内容覆盖同步（Git 仓库不建链接）', {
        p: shortPath(keep.parentDir),
      }) + warn
    : tf('保留 {p} 中的副本作为唯一实体，\n其余 {n} 份移入回收站并替换为链接。', { p: shortPath(keep.parentDir), n: others.length }) + warn;
  const okMerge = await confirmModal({
    title: t('合并重复'),
    message: tf('合并「{name}」：\n{action}\n\n继续？', { name: g.folder, action }),
    confirmLabel: t('合并'),
  });
  if (!okMerge) return;
  const r = await performMerge(g, keepIdx);
  if (r.failed === 0) {
    const parts = [t('1 份唯一副本')];
    if (r.linked) parts.push(tf('{n} 个链接', { n: r.linked }));
    if (r.synced) parts.push(tf('{n} 个项目同步', { n: r.synced }));
    toast(tf('已合并「{name}」：{parts} ✓', { name: g.folder, parts: parts.join(' + ') }), 'ok');
  } else {
    toast(tf('「{name}」合并未完成：{done}/{total} 个副本处理成功，详见操作日志', { name: g.folder, done: r.total - r.failed, total: r.total }), 'err');
  }
  closeModal('modal-dups');
  scan();
});

async function performMerge(g, keepIdx) {
  const keep = g.copies[keepIdx];
  const others = g.copies.filter((c, i2) => i2 !== keepIdx);
  let linked = 0;
  let synced = 0;
  let failed = 0;
  for (const c of others) {
    const toProject = isProjectTarget(c.parentDir);
    if (toProject) {
      const cp = await api.invoke('skill:copy', {
        srcPath: keep.absPath,
        type: 'folder',
        destDir: c.parentDir,
        folderName: c.folder,
        onConflict: 'overwrite',
        mode: 'copy',
      });
      if (cp.ok) synced++;
      else {
        failed++;
        toast(tf('同步项目副本失败（{p}）：{e}', { p: shortPath(c.parentDir), e: cp.error || cp.reason || '' }), 'err');
      }
      continue;
    }
    const tr = await api.invoke('skill:trash', { path: c.absPath });
    if (!tr.ok) {
      failed++;
      toast(tf('移除旧副本失败：{p}{e}', { p: shortPath(c.absPath), e: tr.error ? '（' + tr.error + '）' : '' }), 'err');
      continue;
    }
    const linkArgs = {
      srcPath: keep.absPath,
      type: 'folder',
      destDir: c.parentDir,
      folderName: keep.folder,
      onConflict: 'rename',
      mode: 'link',
      agentId: c.agentIds[0],
    };
    let l = await api.invoke('skill:copy', linkArgs);
    if (!l.ok) {
      await new Promise((r) => setTimeout(r, 450));
      l = await api.invoke('skill:copy', linkArgs);
    }
    if (l.ok) {
      linked++;
    } else {
      toast(tf('创建链接失败（{e}），已改为复制副本', { e: l.error || l.reason || '' }));
      const cp = await api.invoke('skill:copy', { ...linkArgs, mode: 'copy' });
      if (cp.ok) linked++;
      else {
        failed++;
        toast(tf('复制副本也失败：{e}', { e: cp.error || cp.reason || '' }), 'err');
      }
    }
  }
  return { linked, synced, failed, total: others.length };
}

// ------------------------------ 新建 SKILL ------------------------------------
function openNewModal() {
  $('#new-name').value = '';
  $('#new-desc').value = '';
  fillTargetPicker($('#new-dir'));
  openModal('modal-new');
  setTimeout(() => $('#new-name').focus(), 50);
}

$('#btn-new-go').addEventListener('click', async () => {
  const name = $('#new-name').value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(name)) {
    toast(t('SKILL 名称只能包含英文、数字、- 和 _，且不超过 64 字符'), 'err');
    return;
  }
  const destDir = pickerValue($('#new-dir'));
  const r = await api.invoke('skill:create', {
    destDir,
    folder: name,
    name,
    description: $('#new-desc').value.trim(),
  });
  if (r.ok) {
    toast(tf('已创建 {name} ✓', { name }), 'ok');
    closeModal('modal-new');
    await scan();
    const created = state.view.find((s) => s.key === r.dest);
    if (created) {
      if (isProjectTarget(destDir)) {
        const proj = state.projects.find((p) => destDir.startsWith(p.dir));
        if (proj) setFilter('project:' + proj.id);
      }
      openDetail(created);
    }
  } else if (r.reason === 'exists') {
    toast(t('目标目录已存在同名 SKILL'), 'err');
  } else {
    toast(t('创建失败：') + (r.error || ''), 'err');
  }
});

// ------------------------------ 导入 SKILL ------------------------------------
async function inspectImport(source) {
  const r = await api.invoke('import:inspect', { source });
  if (!r.ok) {
    $('#import-preview').classList.add('hidden');
    $('#import-form').classList.add('hidden');
    $('#btn-import-go').disabled = true;
    state.importSrc = null;
    toast(r.reason === 'no-skill' ? t('未在其中找到 SKILL.md，请确认是 SKILL 文件夹/压缩包') : t('读取失败：') + (r.error || ''), 'err');
    return;
  }
  state.importSrc = r;
  $('#import-preview').classList.remove('hidden');
  $('#import-preview').innerHTML = `
    <div class="ip-name">${esc(r.name)}</div>
    <div class="ip-desc">${esc(r.description) || '（无描述）'}</div>
    <div class="ip-path">${esc(r.skillRoot)} · ${r.fileCount} ${t('个文件')}</div>`;
  $('#import-form').classList.remove('hidden');
  $('#btn-import-go').disabled = false;
}

$('#btn-pick-folder').addEventListener('click', async () => {
  const p2 = await api.invoke('dialog:pickFolder');
  if (p2) inspectImport(p2);
});
$('#btn-pick-zip').addEventListener('click', async () => {
  const p2 = await api.invoke('dialog:pickZip');
  if (p2) inspectImport(p2);
});

$('#btn-import-go').addEventListener('click', async () => {
  if (!state.importSrc) return;
  const destDir = pickerValue($('#import-target'));
  const r = await api.invoke('skill:copy', {
    srcPath: state.importSrc.skillRoot,
    type: 'folder',
    destDir,
    folderName: state.importSrc.folder,
    onConflict: $('input[name=import-conflict]:checked').value,
  });
  if (r.ok) {
    toast(isProjectTarget(destDir) ? t('已导入到项目 ✓') : t('导入成功 ✓'), 'ok');
    closeModal('modal-import');
    state.importSrc = null;
    await scan();
    if (isProjectTarget(destDir)) {
      const proj = state.projects.find((p) => destDir.startsWith(p.dir));
      if (proj) setFilter('project:' + proj.id);
    }
  } else if (r.reason === 'exists') {
    toast(t('目标已存在同名 SKILL，请选择覆盖或自动重命名'), 'err');
  } else {
    toast(t('导入失败：') + (r.error || ''), 'err');
  }
});

// ------------------------------ WebDAV 云同步 ---------------------------------
const WD_STATUS_HINT = '备份内容 = 全局 + 项目内所有实体 SKILL（链接不会上传）；密码保存在本机配置文件中，请注意磁盘安全。';
const wdResetStatus = () => {
  $('#wd-status').textContent = t(WD_STATUS_HINT);
};

function fillWebdavInputs(w) {
  w = w || {};
  $('#wd-url').value = w.url || '';
  $('#wd-user').value = w.username || '';
  $('#wd-pass').value = w.password || '';
  $('#wd-auto').checked = !!w.autoBackup;
  $('#wd-freq').value = w.autoBackupFreq || 'startup';
  wdResetStatus();
}

function wdReadInputs() {
  return {
    url: $('#wd-url').value.trim(),
    username: $('#wd-user').value.trim(),
    password: $('#wd-pass').value,
    autoBackup: $('#wd-auto').checked,
    autoBackupFreq: $('#wd-freq').value,
  };
}
async function wdSave() {
  // 只在设置弹窗开着时才有「刚填的表单」可言。总览 / 机器档案那条路上表单从没填过（全空白），
  // 一保存就会把用户配好的 WebDAV 连密码一起抹掉 —— 真机踩过：点「恢复」之后配置直接空了。
  // 所以设置页之外的入口在这里直接短路，用的一律是已保存的配置
  if ($('#modal-settings').classList.contains('hidden')) return true;
  const r = await api.invoke('sync:setConfig', { webdav: wdReadInputs() });
  if (r.ok) {
    state.webdav = wdReadInputs();
    // 换了服务器 / 目录，总览上那份机器列表就不是这一处的了
    invalidateMachines();
  }
  return r.ok;
}
$('#btn-wd-save').addEventListener('click', async () => {
  (await wdSave()) ? toast(t('WebDAV 配置已保存 ✓'), 'ok') : toast(t('保存失败'), 'err');
});
$('#btn-wd-test').addEventListener('click', async () => {
  if (!(await wdSave())) return;
  $('#wd-status').textContent = t('正在测试连接…');
  const r = await api.invoke('sync:test');
  if (r.ok) {
    const detail = r.created ? t('，远程目录不存在，已自动创建') : t('，远程目录已存在');
    $('#wd-status').textContent = '✓ ' + t('连接成功') + detail;
    toast(t('WebDAV 连接成功 ✓'), 'ok');
  } else {
    $('#wd-status').textContent = '✗ ' + t('连接失败：') + r.error;
    toast(t('WebDAV 连接失败：') + r.error, 'err');
  }
});
$('#btn-wd-backup').addEventListener('click', async () => {
  if (!(await wdSave())) return;
  const okBackup = await confirmModal({
    title: t('上传到云端'),
    message: t('将所有实体 SKILL（全局 + 项目）打包备份到 WebDAV？\n（链接本身不上传，恢复时会按记录重建）'),
    confirmLabel: t('开始上传'),
    danger: false,
  });
  if (!okBackup) return;
  $('#wd-status').textContent = t('正在打包并上传…');
  const r = await api.invoke('sync:backup');
  if (r.ok) {
    const kb = r.size < 1048576 ? (r.size / 1024).toFixed(0) + ' KB' : (r.size / 1048576).toFixed(1) + ' MB';
    $('#wd-status').textContent = '✓ ' + tf('{name}（{count} 个 SKILL / {size}）', { name: r.name, count: r.count, size: kb });
    toast(t('已备份到云端 ✓'), 'ok');
    invalidateMachines(); // 刚写了一份新快照，总览上「最后备份」那一行已经过期
  } else {
    $('#wd-status').textContent = '✗ ' + t('备份失败：') + r.error;
    toast(t('备份失败：') + r.error, 'err');
  }
});
// ------------------------------ 机器与配置 ------------------------------------
// 身份（machineId）与名字都在主进程配置里，这里只负责展示与操作。
// 名字分两层：本机改的是自己的名字（随备份上传），给别人改的是本机别名（只影响本机显示）。
// 身份本身不靠猜——重装系统后由用户在恢复弹窗里勾「这就是这台电脑」认领（见 src/webdav.js）。
function renderMachineLine() {
  $('#mc-name').textContent = state.machine.name || t('（未命名，用 hostname）');
  $('#mc-id').textContent = state.machine.id || '—';
  $('#mc-id').title = state.machine.id || '';
}

async function refreshMachine() {
  const p = await api.invoke('app:paths');
  state.machine = { id: p.machineId || '', name: p.machineName || '', hostname: p.hostname || '' };
  renderMachineLine();
}

// 改名弹窗：本机与云端档案共用——都是「给一台机器起个名字」
function openRenameModal(machine) {
  state.renameTarget = machine;
  $('#rn-input').value = machine.alias || (machine.self ? state.machine.name : machine.name) || '';
  $('#rn-hint').textContent = machine.self
    ? t('本机的名字会随备份上传，别的机器看到的就是它；留空则回落到 hostname。')
    : t('给别的机器起的名字只在本机显示，不会写回云端——那台机器下次备份会用自己的名字覆盖掉。');
  openModal('modal-rename');
  $('#rn-input').focus();
  $('#rn-input').select();
}

$('#btn-rename-go').addEventListener('click', async () => {
  const target = state.renameTarget;
  if (!target) return;
  const r = await api.invoke('sync:renameMachine', { machineId: target.machineId, name: $('#rn-input').value });
  if (!r.ok) return toast(r.error || t('改名失败'), 'err');
  closeModal('modal-rename');
  toast(t('已改名 ✓'), 'ok');
  await refreshMachine();
  if (!$('#modal-machines').classList.contains('hidden')) await loadMachines();
  // 名字写回了云端（本机名）或本机别名，总览那块上的名字跟着换
  else invalidateMachines();
});

// 这个弹窗就是为了敲一个名字，回车即保存（和市场里的几个输入框一致）。
// 弹窗关掉之后焦点可能还停在输入框上，所以要挡一道：别拿着旧目标又改一次名
$('#rn-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if ($('#modal-rename').classList.contains('hidden')) return;
  $('#btn-rename-go').click();
});

$('#btn-mc-rename').addEventListener('click', () => openRenameModal({ machineId: state.machine.id, self: true, name: state.machine.name, alias: '' }));

$('#btn-mc-reset').addEventListener('click', async () => {
  const ok = await confirmModal({
    title: t('重置本机标识'),
    message: t('换一个新的机器标识？\n云端旧档案与它的备份都留在原处，之后本机不再认领它们（需要时可以再从「云端机器档案」里认领回来）。'),
    confirmLabel: t('重置'),
  });
  if (!ok) return;
  const r = await api.invoke('sync:resetMachine');
  if (!r.ok) return toast(r.error || t('重置失败'), 'err');
  await refreshMachine();
  invalidateMachines(); // 换了标识，「本机」那一行该落到新档案上
  toast(t('已重置本机标识 ✓'), 'ok');
});

// ------------------------------ 配置文件 导出 / 导入 --------------------------
$('#btn-cfg-export').addEventListener('click', async () => {
  const includePassword = $('#cfg-include-pass').checked;
  const r = await api.invoke('config:exportFile', { includePassword });
  if (r.canceled) return;
  if (!r.ok) return toast(r.error || t('导出失败'), 'err');
  const msg = tf('已导出 {n} 个 Agent / {m} 个项目', { n: r.agents, m: r.projects });
  toast(includePassword ? msg + t('（含 WebDAV 密码）') : msg, 'ok');
});

$('#btn-cfg-import').addEventListener('click', async () => {
  const r = await api.invoke('config:importFile');
  if (r.canceled) return;
  if (!r.ok) return toast(r.error || t('导入失败'), 'err');
  const s = r.summary || {};
  // 先把后果说清楚：Agent 与项目是替换，不是合并
  const source = s.machineName ? tf('来自「{n}」的配置', { n: s.machineName }) : t('选中的配置文件');
  const when = s.exportedAt ? new Date(s.exportedAt) : null;
  const lines = [
    (when && !isNaN(when) ? tf('{s}（导出于 {d}）', { s: source, d: when.toLocaleString() }) : source) + t('：'),
    tf('用文件里的 {n} 个 Agent / {m} 个项目替换本机的 {a} 个 / {b} 个？', {
      n: s.agents,
      m: s.projects,
      a: (state.agents || []).length,
      b: (state.projects || []).length,
    }),
    t('界面偏好会合并保留；本机已起过的机器名不会被覆盖。'),
  ];
  if (s.webdav) {
    const mine = String((state.webdav && state.webdav.url) || '');
    const moved = String(s.webdavUrl || '') !== mine;
    if (!s.password && moved && state.webdav && state.webdav.password) {
      // 最该说清的一种：地址换了、密码还在本机 —— 不清掉的话下一次备份就把本机密码发到那个地址去了
      lines.push(tf('注意：本机的 WebDAV 地址会被改成 {u}，与本机密码不是一对，所以密码会被清空（需要重新填写）。', { u: s.webdavUrl || t('文件里的地址') }));
    } else if (!s.password && moved) {
      lines.push(tf('本机的 WebDAV 地址会被改成 {u}（文件里没带密码）。', { u: s.webdavUrl || t('文件里的地址') }));
    } else if (s.password) {
      lines.push(t('文件里带了 WebDAV 设置与密码，会一并导入。'));
    } else {
      lines.push(t('文件里带了 WebDAV 设置（不含密码），会一并导入，地址不变时密码保留本机的。'));
    }
  }
  const ok = await confirmModal({ title: t('从文件导入配置'), message: lines.join('\n'), confirmLabel: t('导入'), danger: false });
  if (!ok) return;

  const applied = await api.invoke('config:importApply', { payload: r.payload, includeWebdav: !!s.webdav });
  if (!applied.ok) return toast(applied.error || t('导入失败'), 'err');
  await refreshMachine();
  await scan();
  // 文件里可能带了新的 WebDAV 地址：换一台服务器后，旧服务器那份机器列表（连同远程路径）
  // 一直挂在总览上是错的 —— 与「保存配置」那条路对齐（见 wdSave）
  invalidateMachines();
  toast(applied.passwordCleared ? t('配置已导入 ✓（WebDAV 密码已清空，请重新填写）') : t('配置已导入 ✓'), applied.passwordCleared ? '' : 'ok');
});

// ------------------------------ 云端机器档案 ----------------------------------
/**
 * 拉一次云端档案，喂给「总览那块机器列表」和「云端机器档案」弹窗两处 ——
 * 同一份远程数据不该拉两遍。
 *
 * 成功与失败都记「问过了」：失败若不记，WebDAV 地址写错或断网时，搜索框每敲一个字
 * 都会重发一次 PROPFIND（而这条路上没有任何东西能拦住它）。要看最新的点「刷新」，
 * 云端真变了的地方会调 invalidateMachines() 作废。
 */
async function fetchMachines() {
  state.machinesLoading = true;
  const r = await api.invoke('sync:machines');
  state.machinesLoading = false;
  state.machinesTried = true;
  if (r && r.ok) {
    state.machines = r.machines || [];
    state.machinesRemote = r.remote || '';
    state.machinesError = '';
  } else {
    state.machines = [];
    state.machinesError = (r && r.error) || t('读取失败');
  }
  return r;
}

/** 弹窗入口：每次打开都重新拉（用户点开档案就是想看最新的），结果同步刷到总览那块 */
async function loadMachines() {
  $('#mc-status').textContent = t('正在读取云端档案…');
  const r = await fetchMachines();
  renderDashboardMachines();
  if (!r || !r.ok) {
    $('#mc-list').innerHTML = '';
    $('#mc-status').textContent = '✗ ' + state.machinesError;
    return r;
  }
  state.machines = r.machines || [];
  $('#mc-status').textContent = r.remote ? tf('远程目录：{p}', { p: r.remote }) : '';
  renderMachines();
  return r;
}

async function openMachines() {
  openModal('modal-machines');
  await loadMachines();
}

function machineBackupLine(m) {
  if (m.unreadable && !m.backups.length) return t('这个目录里没有档案也没有备份');
  if (!m.backups.length) return t('云端还没有这台机器的备份');
  const latest = m.latest || {};
  const when = latest.created ? new Date(latest.created).toLocaleString() : '—';
  if (latest.entries) return tf('最后备份 {t} · {n} 个 SKILL · {s}', { t: when, n: latest.entries, s: fmtSize(latest.size) });
  return tf('最后备份 {t}', { t: when });
}

/** 一台机器的那份备份列表（展开后才拉）：恢复 / 删除都按具体某一份来 */
function machineBackupsHTML(m) {
  return `<div class="mc-backups">
    ${m.backups
      .slice()
      .reverse()
      .map((b) => {
        const when = b.created ? new Date(b.created).toLocaleString() : b.name;
        const newest = m.latest && m.latest.name === b.name && m.latest.entries;
        const detail = newest ? tf(' · {n} 个 SKILL · {s}', { n: m.latest.entries, s: fmtSize(m.latest.size) }) : '';
        return `<div class="mc-backup">
          <span class="mc-backup-time mono">${esc(when)}</span><span class="hint">${esc(detail)}</span>
          <span class="mc-acts">
            ${btnHTML('useBackup', { dir: m.dir, name: b.name }, t('恢复'), ' primary')}
            ${btnHTML('deleteBackup', { dir: m.dir, name: b.name }, t('删除'), ' danger')}
          </span>
        </div>`;
      })
      .join('')}
  </div>`;
}

function machineRowHTML(m, open) {
  const acts = [];
  // 「立即备份」是本机那一行专属的：备份是这台机器自己的动作，别人的行没有它
  if (m.self) acts.push(btnHTML('backup', { dir: m.dir }, t('立即备份'), ' primary'));
  // 恢复：本机那份回来的是「全局 + 项目」，别人的只回全局 —— 提示语在确认弹窗里说清楚
  if (m.backups.length) acts.push(btnHTML('useBackup', { dir: m.dir, name: m.latest.name }, t('恢复'), ' primary'));
  if (m.backups.length) acts.push(btnHTML('toggle', { dir: m.dir }, open ? t('收起') : tf('备份 {n} 份', { n: m.backups.length })));
  // 读不出标识的坏档案只能删——改名/认领都要有 id 才成立
  if (m.machineId) acts.push(btnHTML('rename', { id: m.machineId }, t('改名')));
  if (m.self) {
    acts.push(`<span class="mc-tag">${esc(t('本机'))}</span>`);
  } else {
    if (m.machineId) acts.push(btnHTML('adopt', { id: m.machineId }, t('设为我的机器标识')));
    acts.push(btnHTML('deleteMachine', { dir: m.dir, n: m.backups.length }, t('删除机器'), ' danger'));
  }
  // 认不出标识时只剩目录名可显示，那就别在标题下面再重复一遍同一个名字
  const sub = [m.hostname, m.machineId ? m.machineId.slice(0, 8) : m.dir === m.name ? '' : m.dir].filter(Boolean).join('   ');
  return `<div class="mc-row${m.self ? ' mc-row-self' : ''}">
    <div class="mc-main">
      <div class="mc-title">${esc(m.name)}${m.unreadable ? ' ⚠' : ''}</div>
      ${sub ? `<div class="mc-sub">${esc(sub)}</div>` : ''}
      <div class="mc-detail">${esc(machineBackupLine(m))}</div>
    </div>
    <div class="mc-acts">${acts.join('')}</div>
  </div>${open && m.backups.length ? machineBackupsHTML(m) : ''}`;
}

/** 一行里的动作按钮：dataset 带上动作与目标，事件代理统一处理 */
function btnHTML(act, data, label, extraClass = '') {
  const attrs = Object.entries(data)
    .map(([k, v]) => ` data-${k}="${esc(v)}"`)
    .join('');
  return `<button class="btn sm mc-act${extraClass}" data-act="${act}"${attrs}>${esc(label)}</button>`;
}

function renderMachines() {
  $('#mc-list').innerHTML = state.machines.map((m) => machineRowHTML(m, state.machinesOpen === m.dir)).join('');
}

async function onMachineAction(e) {
  const btn = e.target.closest('.mc-act');
  if (!btn) return;
  const { act, id, dir, name } = btn.dataset;
  const m = state.machines.find((x) => x.dir === dir || (id && x.machineId === id));
  if (act === 'rename') {
    if (m) openRenameModal(m);
    return;
  }
  // 展开/收起是纯本机动作，不碰云端也不弹确认框
  if (act === 'toggle') {
    state.machinesOpen = state.machinesOpen === dir ? '' : dir;
    renderMachines();
    return;
  }
  // 备份是本机那一行专属的动作：完成后原地重拉，新副本立刻出现在展开的列表里
  if (act === 'backup') {
    if (await runBackup(btn)) await loadMachines();
    return;
  }
  // 恢复：先把机器档案收掉，再开恢复弹窗 —— 两个弹窗叠在一起会挡住确认按钮
  if (act === 'useBackup') {
    closeModal('modal-machines');
    await openRestore({ dir, name });
    return;
  }
  let ask = null;
  let run = null;
  if (act === 'adopt') {
    ask = {
      title: t('设为我的机器标识'),
      message: tf('把本机标识改成「{n}」，从而认领它的备份？\n本机现在的标识会被替换掉，之后「本机的备份」指的就是这一台了。', { n: (m && m.name) || id }),
      confirmLabel: t('认领'),
      danger: false,
    };
    run = () => api.invoke('sync:adoptMachine', { machineId: id });
  } else if (act === 'deleteMachine') {
    const n = Number(btn.dataset.n) || 0;
    ask = {
      title: t('删除机器'),
      // 删的是一个目录，确认框里把份数说清楚：这份数点下去就再也数不出来了
      message: n
        ? tf('从云端永久删除这台机器的整个目录，连同里面 {n} 份备份？\n这个操作不可撤销。', { n })
        : t('从云端永久删除这台机器的整个目录？\n这个操作不可撤销。'),
      confirmLabel: t('删除'),
    };
    run = () => api.invoke('sync:deleteMachine', { dir });
  } else if (act === 'deleteBackup') {
    ask = {
      title: t('删除备份'),
      message: tf('从云端永久删除 {n}？\n这个操作不可撤销。', { n: name }),
      confirmLabel: t('删除'),
    };
    run = () => api.invoke('sync:deleteBackup', { dir, name });
  }
  if (!ask || !run) return;
  if (!(await confirmModal(ask))) return;
  btn.disabled = true;
  const r = await run();
  btn.disabled = false;
  if (!r.ok) return toast(r.error || t('操作失败'), 'err');
  if (act === 'adopt') {
    await refreshMachine();
    toast(t('已认领这台机器 ✓'), 'ok');
  } else {
    toast(t('已完成 ✓'), 'ok');
  }
  await loadMachines();
}

$('#mc-list').addEventListener('click', onMachineAction);
$('#btn-mc-machines').addEventListener('click', openMachines);

// 点击「从云端下载」：弹窗先行（瞬间可见）→ 后台只取廉价元数据 → 用户点确认后才真正下载整包
let restoreSeq = 0;

const RESTORE_FIELDS = ['#rv-machine', '#rv-host', '#rv-time', '#rv-remote', '#rv-size', '#rv-content', '#rv-source'];

// 这一份备份是不是本机的。认领是「恢复时才做的断言」，勾上之后项目级 SKILL 才算数 ——
// 所以这个判断要跟着勾选框走，不能只看 info.sameMachine（那是勾之前的结论）
function restoreSameMachine(info) {
  if (info.sameMachine) return true;
  const row = $('#rv-adopt-row');
  return !row.classList.contains('hidden') && $('#rv-adopt').checked;
}

// 恢复范围：按 Agent 勾选要重建哪些全局 SKILL，默认全选。
// 侧车缺失（上传中断或它已被清理）时拿不到 Agent 明细，只能整包恢复（此时不渲染勾选框）。
function renderRestoreScope(info) {
  const agents = Array.isArray(info.agents) ? info.agents : [];
  const list = $('#rv-agents');
  $('#rv-scope').hidden = !agents.length;
  list.innerHTML = agents
    .map(
      (a) => `<label class="rs-item">
        <input type="checkbox" class="rs-check" value="${esc(a.id)}" checked>
        <span class="rs-name">${esc(a.name)}</span>
        <span class="rs-dirs mono">${esc((a.dirs || []).join('   '))}</span>
        <span class="rs-n">${tf('{n} 个 SKILL', { n: a.count })}</span>
      </label>`
    )
    .join('');
  list.querySelectorAll('.rs-check').forEach((el) => el.addEventListener('change', syncRestoreSelection));
  renderRestoreNotes(info);
  syncRestoreSelection();
}

/**
 * 范围下面那几行提示。单独拆出来，是因为勾「这就是这台电脑」会改变项目级 SKILL 的归属 ——
 * 那时只能重画提示，绝不能顺手把上面那组勾选框重建一遍：用户取消掉的 Agent 会被悄悄勾回来。
 */
function renderRestoreNotes(info) {
  const agents = Array.isArray(info.agents) ? info.agents : [];
  const skip = $('#rv-skip');
  const notes = [];
  const projectCount = Number(info.projectCount) || 0;
  // 项目级 SKILL 只在「这份备份是本机的」时才回来：项目路径是机器相关的，别台机器恢复过来的
  // 一串路径基本全是错的。勾「这就是这台电脑」就是在说「这份备份是本机的」
  if (projectCount) {
    notes.push(
      restoreSameMachine(info)
        ? tf('另有 {n} 个项目 SKILL 会一并恢复到本机的项目里', { n: projectCount })
        : tf('另有 {n} 个项目 SKILL 不会恢复：这份备份不是本机的（勾下面的认领可以把它认回来）', { n: projectCount })
    );
  }
  if (info.detailed && !agents.length) notes.push(t('这份备份没有 Agent 明细（上传时侧车没写成功），只能整包恢复'));
  skip.textContent = notes.join('\n');
  skip.hidden = !notes.length;
}

function syncRestoreSelection() {
  const checks = [...$('#rv-agents').querySelectorAll('.rs-check')];
  const picked = checks.filter((el) => el.checked).map((el) => el.value);
  // 没有勾选框（旧版备份拿不到 Agent 明细）时必须是 null 而不是 []：
  // 空数组到了后端是「一个 Agent 都不选」，会让恢复什么都不做
  state.restoreAgents = checks.length ? picked : null;
  // 有勾选项却一个都没选时，恢复会什么都不做——直接禁用按钮，别让用户白等一次下载
  $('#btn-restore-confirm').disabled = checks.length > 0 && picked.length === 0;
}

/**
 * 打开恢复弹窗。
 * pick 带 { dir, name } = 恢复指定机器的指定一份（机器档案里挑出来的）；
 * pick 为空 = 先看本机目录里有没有备份：有就用本机最新那份，没有就让用户先挑机器 ——
 * 不再静默退回「云端最新一条」，那等于替用户决定「你要恢复的就是这台陌生的机器」。
 */
async function openRestore(pick = {}) {
  const seq = ++restoreSeq;
  const btn = $('#btn-restore-confirm');
  // 本次弹窗是否已被取消 / 被更新的一次点击取代；过期结果一律丢弃
  const stale = () => seq !== restoreSeq || $('#modal-restore').classList.contains('hidden');

  openModal('modal-restore');
  btn.disabled = true;
  RESTORE_FIELDS.forEach((id) => {
    $(id).textContent = t('读取中…');
  });
  $('#rv-status').textContent = t('正在获取云端备份信息…');
  wdResetStatus();

  const fail = (msg) => {
    if (!stale()) {
      closeModal('modal-restore');
      toast(msg, 'err');
    }
  };
  // 这里绝不能 wdSave()：这个入口除了设置页那个按钮，还有总览与机器档案里的「恢复」——
  // 那两条路上设置表单根本没填过（全是空白），一保存就会把用户配好的 WebDAV 整个抹掉。
  // 「把刚填的存下来再恢复」是设置页按钮自己的事，见 #btn-wd-restore
  if (!pick.dir) {
    const list = await api.invoke('sync:machines');
    if (stale()) return;
    const mine = list && list.ok ? list.machines.find((m) => m.self && m.backups.length) : null;
    if (!mine) {
      // 本机还没有备份：交给用户挑机器（机器档案里每台都能展开挑副本）
      restoreSeq++; // 作废这一次，别让后到的结果把弹窗又填回来
      closeModal('modal-restore');
      toast(t('本机还没有云端备份 —— 请先选一台机器，再挑它的备份'), '');
      await openMachines();
      return;
    }
    pick = { dir: mine.dir };
  }
  const info = await api.invoke('sync:restoreInfo', { dir: pick.dir, name: pick.name });
  if (stale()) return;
  if (!info.ok) return fail(info.error);

  state.restoreDir = info.dir || '';
  state.restoreName = info.name;
  state.restoreInfo = info;
  const d = new Date(info.uploadedAt);
  $('#rv-machine').textContent = [info.machineName || info.hostname || t('（没有档案）'), info.dir].filter(Boolean).join('  ·  ');
  $('#rv-host').textContent = info.hostname || '—';
  $('#rv-time').textContent = info.uploadedAt ? (isNaN(d) ? info.uploadedAt : d.toLocaleString()) : '—';
  $('#rv-remote').textContent = info.remote;
  $('#rv-size').textContent = info.size ? fmtSize(info.size) : '—';
  $('#rv-content').textContent = info.detailed ? tf('{n} 个 SKILL + config.json', { n: info.entries }) : t('—（这份备份没带元数据）');
  // 备份来源：本机目录里那份，还是从别的机器挑的
  $('#rv-source').textContent = info.source === 'local' ? t('本机目录里的备份') : t('另一台机器的备份');
  // 认领行要先摆好：它会把勾选框重置成未勾选，而下面那段提示要按「勾没勾」来说话 ——
  // 反过来的话，提示读到的还是上一个弹窗留下的勾选状态
  renderAdoptRow(info);
  // 按钮的可用状态由 syncRestoreSelection 决定（全选/未选/拿不到勾选框三种情况都已覆盖）
  renderRestoreScope(info);
  $('#rv-status').textContent = '';
}

// 设置页里的「从云端下载」：表单就在眼前，先把刚填的存下来再恢复 —— 这是这条入口独有的，
// 总览 / 机器档案那几条入口不带表单，绝不能走这一步（见 openRestore 里的注释）
$('#btn-wd-restore').addEventListener('click', async () => {
  if (!(await wdSave())) return toast(t('保存失败'), 'err');
  openRestore();
});

// 恢复弹窗里换一份：收起它，去机器档案里挑（那里能挑机器，也能挑历史副本）
$('#btn-restore-switch').addEventListener('click', async () => {
  restoreSeq++; // 让还在飞的那次 restoreInfo 作废，别回来把弹窗重新填一遍
  closeModal('modal-restore');
  await openMachines();
});

// 认领开关：备份来自别的机器时才有可勾的东西（重装系统后就靠它把项目一起认回来）。
// 拿不到对方标识（侧车没写成功）就无从认领——那种情况不显示这一行。
//
// 切显示必须走 .hidden 类，不能用 hidden 属性：.adopt-row 自己声明了 display:grid，
// 作者样式压过 UA 样式表的 [hidden]{display:none}，元素会一直可见——而 hidden 属性读回来
// 还是 true，于是用户勾的是一个「看得见、却被静默忽略」的框。
function renderAdoptRow(info) {
  const canAdopt = !!info.machineId && !info.sameMachine;
  $('#rv-adopt-row').classList.toggle('hidden', !canAdopt);
  $('#rv-adopt').checked = false;
  if (!canAdopt) return;
  const label = info.machineName || info.hostname || t('另一台电脑');
  $('#rv-adopt-text').textContent = tf(
    '这份备份来自「{name}」，不是本机。勾上表示这就是这台电脑（例如刚重装过系统），项目配置与它名下的项目 SKILL 会一并还原。',
    {
      name: label,
    }
  );
}

// 勾「这就是这台电脑」会改变项目级 SKILL 的归属，上面那段提示得跟着换 —— 否则用户勾完
// 看到的还是「不会恢复」。只重画提示：整块重画会把用户取消掉的 Agent 又勾回去
$('#rv-adopt').addEventListener('change', () => {
  if (state.restoreInfo) renderRestoreNotes(state.restoreInfo);
});

// 备份包里有 SKILL 落在「本机配置之外的目录」时绝不默认写入 —— 那些路径来自被恢复的那份包，
// 由它自己决定往哪儿写，等于让外来文件自己发通行证。办法是把具体路径摆给用户看，
// 用户点头（allowExternalDirs）之后再恢复一次。
async function confirmExternalDirs(prev) {
  const dirs = prev.externalDirs || [];
  const n = dirs.reduce((s, x) => s + x.count, 0);
  const shown = dirs.slice(0, 5).map((x) => `· ${x.dir}（${tf('{n} 个 SKILL', { n: x.count })}）`);
  if (dirs.length > 5) shown.push(tf('· 还有 {n} 个目录…', { n: dirs.length - 5 }));
  const ok = await confirmModal({
    title: t('这些目录要写入吗？'),
    message: tf(
      '备份里有 {n} 个 SKILL 位于本机配置之外的目录：\n{p}\n\n它们不在本机配置里，所以刚才没有写入。确认这些目录属于本机（而不是别的电脑的路径）之后才写入。',
      { n, p: shown.join('\n') }
    ),
    confirmLabel: t('确认并写入'),
  });
  if (!ok) return;
  $('#rv-status').textContent = t('正在写入本机配置之外的目录…');
  const again = await api.invoke('sync:restoreApply', {
    dir: state.restoreDir,
    name: state.restoreName,
    agentIds: state.restoreAgents,
    // 认领在上一轮已经落盘，这一轮不必再传（传了也只是空操作）
    adoptMachine: false,
    allowExternalDirs: true,
  });
  if (!again.ok) return toast(again.error || t('恢复失败'), 'err');
  toast(tf('已从云端恢复 {n} 个 SKILL ✓', { n: again.restored }), 'ok');
  await scan();
}

$('#btn-restore-confirm').addEventListener('click', async () => {
  const btn = $('#btn-restore-confirm');
  btn.disabled = true;
  $('#rv-status').textContent = t('正在下载并恢复…');
  try {
    const adoptMachine = !$('#rv-adopt-row').classList.contains('hidden') && $('#rv-adopt').checked;
    const r = await api.invoke('sync:restoreApply', {
      dir: state.restoreDir,
      name: state.restoreName,
      agentIds: state.restoreAgents,
      adoptMachine,
    });
    if (!r.ok) {
      $('#rv-status').textContent = '✗ ' + r.error;
      return toast(r.error, 'err');
    }
    toast(tf('已从云端恢复 {n} 个 SKILL ✓', { n: r.restored }), 'ok');
    if (r.restoredProjects) toast(tf('同时恢复了 {n} 个项目 SKILL ✓', { n: r.restoredProjects }), 'ok');
    if (r.adoptedMachine) {
      await refreshMachine();
      toast(t('已认领这台机器，本机标识已更新 ✓'), 'ok');
    }
    // 下面几条是设计如此（不算失败），用中性级别，免得跟真正的错误混在一起
    if (r.skippedProjects) toast(tf('未恢复 {n} 个项目 SKILL：这份备份不是本机的（勾「这就是这台电脑」可以认回来）', { n: r.skippedProjects }), '');
    // 这句话负责指路：同类情形下用户可以重新打开弹窗勾「这就是这台电脑」再来一次
    if (r.projectConfigSkipped) {
      toast(
        tf('未恢复 {n} 个项目配置：这份备份不算本机的。若这就是本机（例如刚重装过系统），重新打开弹窗勾选「这就是这台电脑」再来一次。', {
          n: r.projectConfigSkipped,
        }),
        ''
      );
    }
    if (r.skippedAgents) toast(tf('未恢复 {n} 个未勾选 Agent 的 SKILL', { n: r.skippedAgents }), '');
    if (r.skippedInvalid) toast(tf('跳过 {n} 个路径非法的条目', { n: r.skippedInvalid }), 'err');
    if (r.appliedConfig) toast(t('配置也已恢复 ✓'), 'ok');
    // 刚恢复的这份备份可能就是本机认领回来的那一台，总览上那几行已经不准了
    invalidateMachines();
    // 备份里的地址与本机不同、包又不带密码 → 本机密码已清空，得让用户知道要重填
    if (r.passwordCleared) toast(t('WebDAV 地址来自备份，与本机密码不是一对，密码已清空 —— 请在设置里重新填写'), '');
    closeModal('modal-restore');
    // 备份里带了设置，界面偏好（含遮罩）要跟着刷新
    if (r.appliedConfig) {
      const p = await api.invoke('app:paths');
      state.ui = p.ui || state.ui;
      applyOverlay(state.ui);
    }
    closeModal('modal-settings');
    state.filter = 'dashboard';
    $('#main-title').textContent = t('总览');
    await scan();
    i18n.apply(document);
    // 放在最后：它要再开一个确认弹窗，得等恢复弹窗先收掉，别叠在一起
    if (r.externalDirs?.length) await confirmExternalDirs(r);
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------ 设置 -----------------------------------------
// 弹窗遮罩的毛玻璃 / 变暗程度：写进 CSS 变量，设置页里拖动即时预览
const OVERLAY_BLUR_MAX = 40;
const OVERLAY_DIM_MAX = 0.8;

function applyOverlay(ui) {
  const blur = Math.min(OVERLAY_BLUR_MAX, Math.max(0, Number(ui && ui.overlayBlur) || 0));
  const dim = Math.min(OVERLAY_DIM_MAX, Math.max(0, Number(ui && ui.overlayDim) || 0));
  const root = document.documentElement.style;
  root.setProperty('--overlay-filter', blur > 0 ? `blur(${blur}px) saturate(130%)` : 'none');
  root.setProperty('--overlay-dim', String(dim));
}

/** 把滑杆值同步到界面与预览 */
function fillOverlayInputs(ui) {
  const blur = Number(ui && ui.overlayBlur);
  const dim = Number(ui && ui.overlayDim);
  const b = Number.isFinite(blur) ? blur : 24;
  const d = Number.isFinite(dim) ? dim : 0.3;
  $('#set-overlay-blur').value = String(b);
  $('#set-overlay-dim').value = String(Math.round(d * 100));
  $('#set-overlay-blur-val').textContent = b + 'px';
  $('#set-overlay-dim-val').textContent = Math.round(d * 100) + '%';
}

const readOverlayInputs = () => ({
  overlayBlur: Number($('#set-overlay-blur').value),
  overlayDim: Number($('#set-overlay-dim').value) / 100,
});

// 取消时用它把预览还原回已保存的值
let overlaySnapshot = null;
let themeSnapshot = null;

// ------------------------------ 主题 -----------------------------------------
// 配色本身在 styles.css 的 [data-theme] 块里（见 renderer/theme.js），这里只负责：
// 把选择写到 DOM、同步给主进程（窗口底色，免得切深色后重载闪一下白）、驱动设置面板的选中态。
// 启动时 theme.js 已经用 localStorage 的缓存同步套过一次，这一步是用配置里的权威值覆盖。
function applyTheme(ui) {
  const themeId = theme.apply(ui);
  api.invoke('win:setBackground', { theme: themeId }).catch(() => {});
}

const currentThemeSel = () => ({
  theme: (state.ui && state.ui.theme) || 'light',
  accent: (state.ui && state.ui.accent) || 'auto',
});

// 预设色块按 theme.ACCENTS 生成，配色清单只维护一处。
// 用 DocumentFragment 一次性插入：逐个 insertBefore(auto.nextSibling) 会把顺序倒过来。
function renderAccentChips() {
  const box = $('#set-accent');
  if (!box || box.dataset.ready) return;
  const frag = document.createDocumentFragment();
  for (const hex of theme.ACCENTS) {
    const b = document.createElement('button');
    b.className = 'accent-opt';
    b.dataset.accent = hex;
    b.style.setProperty('--sw', hex);
    b.title = hex;
    frag.appendChild(b);
  }
  box.insertBefore(frag, $('.accent-opt.custom', box));
  box.dataset.ready = '1';
}

function fillThemeInputs(ui) {
  const themeId = (ui && ui.theme) || 'light';
  const accent = (ui && ui.accent) || 'auto';
  $$('#set-theme .theme-opt').forEach((b) => b.classList.toggle('active', b.dataset.themeId === themeId));
  $$('#set-accent .accent-opt').forEach((b) => b.classList.toggle('active', (b.dataset.accent || '') === accent));
  // 取色器的初值：没选自定义色时，用当前生效的强调色（可能来自主题本身）
  const live = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const custom = $('#set-accent-custom');
  if (custom) custom.value = theme.isHex(accent) ? accent : theme.isHex(live) ? live : '#0071e3';
}

const readThemeInputs = () => {
  const t1 = $('#set-theme .theme-opt.active');
  const a1 = $('#set-accent .accent-opt.active');
  return { theme: t1 ? t1.dataset.themeId : 'light', accent: a1 ? a1.dataset.accent : 'auto' };
};

// 点选即预览：只改 DOM，不落盘；取消时按打开设置时的快照还原
const previewTheme = (themeId, accent) => {
  applyTheme({ theme: themeId, accent });
  fillThemeInputs({ theme: themeId, accent });
};

$('#set-theme').addEventListener('click', (e) => {
  const btn = e.target.closest('.theme-opt');
  if (btn) previewTheme(btn.dataset.themeId, readThemeInputs().accent);
});
$('#set-accent').addEventListener('click', (e) => {
  const btn = e.target.closest('.accent-opt[data-accent]');
  if (btn) previewTheme(readThemeInputs().theme, btn.dataset.accent);
});
$('#set-accent-custom').addEventListener('input', (e) => previewTheme(readThemeInputs().theme, e.target.value));

// 设置面板按类别分页：配置项越来越多，一屏一类才找得到。
// 页签在 modal-body 之外，内容滚动时分类栏不跟着走（见 index.html）
const SET_TABS = ['appear', 'sync', 'machine', 'config', 'net', 'market'];

function showSettingsTab(key) {
  if (!SET_TABS.includes(key)) key = SET_TABS[0];
  state.settingsTab = key;
  $$('#set-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.setTab === key));
  SET_TABS.forEach((k) => $('#set-pane-' + k).classList.toggle('hidden', k !== key));
  // 换一类就从头看：否则从「外观」滚到底再切「云同步」，会停在那一类的半截处
  $('#modal-settings .modal-body').scrollTop = 0;
}

$('#set-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) showSettingsTab(btn.dataset.setTab);
});

function openSettings(tab) {
  fillWebdavInputs(state.webdav);
  $('#set-lang').value = (state.ui && state.ui.lang) || 'auto';
  fillOverlayInputs(state.ui);
  overlaySnapshot = readOverlayInputs();
  renderAccentChips();
  fillThemeInputs(currentThemeSel());
  themeSnapshot = readThemeInputs();
  fillProxyInputs(state.proxy);
  // 市场的 GitHub Token 迁到设置里：市场页不再放凭据输入框
  $('#set-gh-token').value = (state.marketCfg && state.marketCfg.token) || '';
  renderMachineLine();
  // 默认停在上次看过的那一类（调用方要直达某一类时才传 key，如市场的「检查代理设置」）
  showSettingsTab(tab || state.settingsTab);
  openModal('modal-settings');
}

function closeSettings(revertPreview) {
  if (revertPreview && overlaySnapshot) applyOverlay(overlaySnapshot);
  if (revertPreview && themeSnapshot) {
    applyTheme(themeSnapshot);
    fillThemeInputs(themeSnapshot);
  }
  closeModal('modal-settings');
}

// 拖动即时预览（不落盘，保存时才写配置）
['#set-overlay-blur', '#set-overlay-dim'].forEach((sel) => {
  $(sel).addEventListener('input', () => {
    const o = readOverlayInputs();
    applyOverlay(o);
    fillOverlayInputs(o);
  });
});
$('#set-close').addEventListener('click', () => closeSettings(true));
$('#set-cancel').addEventListener('click', () => closeSettings(true));
$('#modal-settings').addEventListener('mousedown', (e) => {
  if (e.target === e.currentTarget) closeSettings(true);
});

// ------------------------------ 网络代理 -------------------------------------
// 代理生效在 main 进程（session.setProxy），这里只管收集输入与测试。
// 测试按钮用「界面上刚填的值」而不是已保存的值：否则改了地址点测试，测的还是旧代理。
function fillProxyInputs(proxy) {
  const p = proxy || { mode: 'system', url: '', bypass: '' };
  $('#px-mode').value = p.mode || 'system';
  $('#px-url').value = p.url || '';
  $('#px-bypass').value = p.bypass || '';
  $('#px-status').textContent = '';
  $('#px-status').style.color = '';
  syncProxyInputs();
}

function syncProxyInputs() {
  const manual = $('#px-mode').value === 'manual';
  $('#px-url').disabled = !manual;
  $('#px-bypass').disabled = !manual;
  $('#px-url').style.opacity = manual ? '' : '0.5';
  $('#px-bypass').style.opacity = manual ? '' : '0.5';
}

const readProxyInputs = () => ({ mode: $('#px-mode').value, url: $('#px-url').value.trim(), bypass: $('#px-bypass').value.trim() });

$('#px-mode').addEventListener('change', syncProxyInputs);

$('#btn-px-test').addEventListener('click', async () => {
  const st = $('#px-status');
  st.style.color = '';
  st.textContent = t('测试中…');
  const r = await api.invoke('proxy:test', { proxy: readProxyInputs() });
  // 测试目标是 github.com 主站：拿到 HTTP 响应 = 链路通；主站不会像 API 端点那样
  // 对匿名请求按出口 IP 限流，所以不需要再拿 Token 出来说事——代理测试只管链路。
  if (r.ok && r.httpStatus) {
    st.style.color = 'var(--warn-text)';
    st.textContent = tf('链路通（{ms} ms），目标返回 HTTP {s}', { ms: r.ms, s: r.httpStatus });
    return;
  }
  st.style.color = r.ok ? 'var(--ok-text)' : 'var(--err-text)';
  st.textContent = r.ok ? tf('连接正常（{ms} ms）', { ms: r.ms }) : t('连接失败：') + (r.error || '');
});

$('#btn-save-settings').addEventListener('click', async () => {
  if (!(await wdSave())) return;
  const lang = $('#set-lang').value;
  const r = await api.invoke('config:set', { ui: { lang, ...readOverlayInputs(), ...readThemeInputs() } });
  if (r.ok) {
    state.ui = r.ui || { lang };
    // 代理单独走一条通道：它要顺带把配置应用到 session，不像 ui 只是存个偏好
    const px = await api.invoke('proxy:set', { proxy: readProxyInputs() });
    if (px.ok) state.proxy = px.proxy;
    // GitHub Token 与代理同属网络类配置：这里落盘，市场检索时主进程来读
    const mk = await api.invoke('market:setConfig', { token: $('#set-gh-token').value.trim() });
    if (mk.ok) state.marketCfg = mk.market;
    applyOverlay(state.ui);
    applyTheme(state.ui);
    theme.cache(state.ui); // 供下次启动首帧前套用，避免闪一下默认配色
    overlaySnapshot = readOverlayInputs();
    themeSnapshot = readThemeInputs();
    i18n.setLang(lang);
    i18n.apply(document);
    toast(t('设置已保存 ✓'), 'ok');
    closeModal('modal-settings');
    state.filter = 'dashboard';
    $('#main-title').textContent = t('总览');
    scan();
  } else toast(t('保存失败'), 'err');
});

$('#btn-reset-agents').addEventListener('click', async () => {
  const okReset = await confirmModal({
    title: t('恢复默认配置'),
    message: t('恢复为默认的 Agent、目录与项目配置？（项目列表会被清空）'),
    confirmLabel: t('恢复默认'),
  });
  if (!okReset) return;
  const r = await api.invoke('config:reset');
  if (r.ok) {
    state.agents = r.agents;
    state.projects = r.projects || [];
    toast(t('已恢复默认 ✓'), 'ok');
    closeModal('modal-settings');
    scan();
  }
});

// ------------------------------ 顶栏 / 快捷键 --------------------------------
$('#wc-min').addEventListener('click', () => api.invoke('win:minimize'));
$('#wc-max').addEventListener('click', () => api.invoke('win:maximize'));
$('#wc-close').addEventListener('click', () => api.invoke('win:close'));
$('#btn-rescan').addEventListener('click', () => {
  scan();
  toast(t('已重新扫描'));
});
$('#btn-dups').addEventListener('click', openDupsModal);
$('#btn-logs').addEventListener('click', openLogs);
$('#btn-new').addEventListener('click', openNewModal);
$('#btn-settings').addEventListener('click', () => openSettings());
$('#btn-open-logfile').addEventListener('click', () => {
  if (state.logFile) api.invoke('shell:openPath', { path: state.logFile });
});
$('#btn-clear-logs').addEventListener('click', () => {
  state.logs = [];
  state.unreadErrors = 0;
  updateLogBadge();
  renderLogs();
});
// 侧栏静态导航项（总览）在这里绑定；Agent/项目 列表在各自渲染函数中绑定
$$('#sidebar > .nav-item').forEach((el) => el.addEventListener('click', () => setFilter(el.dataset.filter)));

$('#btn-import').addEventListener('click', () => {
  state.importSrc = null;
  $('#import-preview').classList.add('hidden');
  $('#import-form').classList.add('hidden');
  $('#btn-import-go').disabled = true;
  fillTargetPicker($('#import-target'));
  openModal('modal-import');
});

$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderGrid();
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    $('#search').focus();
  }
  if (e.key === 'Escape') {
    $$('.modal-overlay').forEach((ov) => ov.classList.add('hidden'));
    clearRefStack();
  }
});

// ------------------------------ SKILL 市场（侧栏页） --------------------------
// 一个搜索框，一次检索，聚合所有来源（skills.sh / SkillsMP / GitHub / 自定义索引）。
// 来源只是行上的徽章：列表统一渲染、统一进详情弹窗；链接安装（仓库 / zip 直链）与
// Token / 索引地址收进「高级选项」。搜索与下载都在主进程做，走同一套代理配置。
// 市场页是重画型页面：用户随时可能切去别的页，把这套 DOM 整个换掉。市场里的异步
// 回调（检索/回填/安装）晚一步回来时，绝不能因为元素不在了就抛错（实测踩过：
// 回总览后弹「Cannot set properties of null (setting 'textContent')」）。
// 写市场 DOM 的每个入口都必须先确认页面还活着。
const mkAlive = () => !!$('#mk-status');
const mkStatus = (s) => {
  const el = $('#mk-status');
  if (el) el.textContent = s || '';
};

function showMkStep(step) {
  if (!$('#mk-find')) return;
  state.market.step = step;
  $('#mk-find').classList.toggle('hidden', step !== 'find');
  // 结果网格与节标题长在控制卡外面（页面底色上的卡片网格），跟「找」这一步一起显隐；
  // 安装按钮长在勾选卡（mk-pick-foot）里，随勾选卡一起显隐
  $('#mk-results').classList.toggle('hidden', step !== 'find');
  $('#mk-sec-head').classList.toggle('hidden', step !== 'find');
  $('#mk-pick').classList.toggle('hidden', step !== 'pick');
  updateMkSecHead();
}

// 节标题（「热门 SKILL」/「检索结果」）有内容且在「找」这步才露头，否则整条收起
function updateMkSecHead() {
  const head = $('#mk-sec-head');
  if (!head) return;
  const show = state.market && state.market.step === 'find' && $('#mk-sec-title').textContent;
  head.classList.toggle('hidden', !show);
}

function mkSectionTitle(text) {
  const el = $('#mk-sec-title');
  if (!el) return;
  el.textContent = text || '';
  updateMkSecHead();
}

// 结果列表一次最多画多少行：站点一页能给九十多条，全画又长又费（每行都要取头像）
// 每页展示多少行：先展示这些，剩余的由「加载更多」展开/翻页
const MK_PAGE = 30;

// 市场指标用紧凑数字（407450 → 40.7万 / 407.5K），Intl 按系统 locale 自行选择
function fmtMkNum(n) {
  try {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maxSignificantDigits: 3 }).format(n);
  } catch (_) {
    return String(n);
  }
}

function defaultMkState() {
  // 一个搜索框搜所有来源，不再区分「来源/站点」；上次的结果与装到一半的勾选页照旧恢复
  return { step: 'find', skills: [], selected: new Set(), results: null, source: '', category: '', sortBy: 'popular' };
}

/** 市场页与总览同模式：每次进入都重画；mk-* 事件由 bindMarketPage 重挂，上次的结果还在就还给他 */
function renderMarketPage() {
  state.market ||= defaultMkState();
  $('#main-hint').textContent = '';
  const m = state.market;
  $('#grid').innerHTML = `
    <section class="dash-card mk-page">
      <div class="mk-hero">
        <div class="mk-hero-sub">${t('发现并安装社区 SKILL，一次检索，聚合所有来源')}</div>
      </div>
      <div id="mk-find">
        <div class="mk-bar">
          <input id="mk-query" class="input" data-i18n-ph="搜索 SKILL，如 commit / pdf / web-search" />
          <button class="btn primary" id="mk-go" data-i18n="搜索">搜索</button>
          <!-- 链接安装收成一颗按钮：高级选项的折叠区没了，这是从仓库装 SKILL 的唯一入口 -->
          <button class="btn" id="mk-gh" data-i18n="从 GitHub 安装">从 GitHub 安装</button>
        </div>
        <div class="mk-tags" id="mk-tags"></div>
        <div class="mk-cats" id="mk-cats"></div>
      </div>
      <div id="mk-pick" class="hidden">
        <div class="mk-pick-head">
          <button class="btn sm" id="mk-back" data-i18n="返回">返回</button>
          <span class="hint" id="mk-source"></span>
        </div>
        <div class="mk-pick-body">
          <ul class="mk-list" id="mk-list"></ul>
          <div class="mk-preview md" id="mk-preview"></div>
        </div>
        <div class="mk-pick-foot">
          <label data-i18n="安装到">安装到</label>
          <div id="mk-target" class="picker"></div>
          <!-- 安装按钮必须长在勾选卡里：节标题在「装」这步是隐藏的，放那儿等于没有按钮 -->
          <button class="btn primary" id="mk-install" data-i18n="安装选中的 SKILL">安装选中的 SKILL</button>
        </div>
      </div>
    </section>
    <div class="mk-sec-head hidden" id="mk-sec-head">
      <span class="mk-sec-title" id="mk-sec-title"></span>
      <span class="hint" id="mk-status"></span>
    </div>
    <div id="mk-results" class="hidden"></div>
    <button class="mk-top hidden" id="mk-top" data-i18n-title="回到顶部" title="回到顶部">↑</button>
  `;
  bindMarketPage();
  // 先定步骤再恢复数据：结果网格长在控制卡外，显隐由 showMkStep 一并管
  showMkStep(m.skills.length ? 'pick' : 'find');
  // 上次搜过的结果还在：还给他，省一次重复检索
  if (m.results) renderMkResults(m.results);
  // 装到一半的勾选页也要原样回来
  if (m.skills.length) {
    $('#mk-source').textContent = m.source || '';
    showMkStep('pick');
    renderMkList();
    fillTargetPicker($('#mk-target'));
  }
  // 首次进页自动拉热门：像市场官网那样，进来就有内容可逛。
  // 有来源成功才落 featuredTried —— 全挂（断网等）下次进页重试
  if (!m.results && !m.featuredTried) mkSearch('');
  // 分类/排序 chips 不依赖网络，进页立即渲染
  renderMkCats();
  // 快捷标签 = 各站注册的检索建议词，合并去重后渲染（数据回来才渲染，晚一点无妨）
  api.invoke('market:listBuiltin').then((r) => {
    if (r && r.ok) {
      state.marketSites = r.markets;
      renderMkTags();
    }
  });
}

// 快捷标签 = 各站注册的检索建议词，合并去重 —— 点标签就是按那个词做一次聚合检索
function renderMkTags() {
  const box = $('#mk-tags');
  if (!box) return;
  const tags = [];
  const seen = new Set();
  for (const site of state.marketSites || []) {
    for (const tag of (site && site.featured ? site.featured.tags : []) || []) {
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
  }
  box.innerHTML =
    tags.map((q) => `<button class="mk-tag" data-q="${esc(q)}">${esc(q)}</button>`).join('') || `<span class="hint">${t('输入关键词开始检索')}</span>`;
}

// 分类与排序（学 skillhub-desktop 的「发现」）：分类浏览只走 SkillHub 目录，
// 关键词检索时分类不参与（各来源没有统一的分类体系）
const MK_CATEGORIES = [
  ['', '全部'],
  ['collections', '合集'],
  ['development', '开发'],
  ['devops', '运维'],
  ['testing', '测试'],
  ['documentation', '文档'],
  ['ai-ml', 'AI / ML'],
  ['frontend', '前端'],
  ['backend', '后端'],
  ['security', '安全'],
];
const MK_SORTS = [
  ['popular', '热门'],
  ['newest', '最新'],
  ['stars', '星标最多'],
  ['name', '名称 A-Z'],
];

function renderMkCats() {
  const box = $('#mk-cats');
  if (!box) return;
  const m = state.market;
  const chip = (active, attrs, label) => `<button class="mk-tag${active ? ' active' : ''}" ${attrs}>${esc(label)}</button>`;
  const cats = MK_CATEGORIES.map(([id, label]) => chip(m.category === id, `data-cat="${esc(id)}"`, t(label))).join('');
  const sorts = MK_SORTS.map(([id, label]) => chip(m.sortBy === id, `data-sort="${esc(id)}"`, t(label))).join('');
  box.innerHTML = `<div class="mk-cats-row">${cats}</div><div class="mk-cats-row">${sorts}</div>`;
}

// mk-* 的事件挂载集中在这里：市场页每次进入都重画，绑定必须跟着重画走
// 滚动监听只绑一次：#main 是常驻 DOM，市场页重画不会重复挂；按钮节点每次重画后由选择器现查
let mkScrollBound = false;
function mkBindScrollTop() {
  if (mkScrollBound) return;
  mkScrollBound = true;
  const update = () => {
    const btn = $('#mk-top');
    if (!btn) return;
    btn.classList.toggle('hidden', $('#main').scrollTop < 300);
  };
  $('#main').addEventListener('scroll', update, { passive: true });
}

function bindMarketPage() {
  $('#mk-go').addEventListener('click', () => mkSearch());
  $('#mk-query').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') mkSearch();
  });
  $('#mk-tags').addEventListener('click', (e) => {
    const tag = e.target.closest('.mk-tag');
    if (!tag) return;
    $('#mk-query').value = tag.dataset.q;
    mkSearch(tag.dataset.q);
  });
  // 分类 / 排序：只影响 SkillHub 目录（catalog），点完就地重拉；输入了关键词就照常全源检索
  $('#mk-cats').addEventListener('click', (e) => {
    const cat = e.target.closest('[data-cat]');
    if (cat) {
      state.market.category = cat.dataset.cat;
      renderMkCats();
      mkSearch('');
      return;
    }
    const sort = e.target.closest('[data-sort]');
    if (sort) {
      state.market.sortBy = sort.dataset.sort;
      renderMkCats();
      if (!state.market.results || !state.market.results.q) mkSearch('');
    }
  });
  $('#mk-gh').addEventListener('click', () => {
    $('#mkgh-status').textContent = '';
    openModal('modal-mkgh');
  });
  $('#mk-back').addEventListener('click', () => {
    showMkStep('find');
    mkStatus('');
  });
  $('#mk-install').addEventListener('click', mkInstall);
  $('#mk-list').addEventListener('click', (e) => {
    const li = e.target.closest('.mk-item');
    if (!li) return;
    const p = li.dataset.path;
    // 勾选框只管勾选，点行本身只看预览——两个动作别混在一起
    if (e.target.tagName === 'INPUT') {
      if (e.target.checked) state.market.selected.add(p);
      else state.market.selected.delete(p);
      updateMkInstall();
      return;
    }
    $$('#mk-list .mk-item').forEach((el) => el.classList.toggle('active', el === li));
    const skill = state.market.skills.find((s) => s.absPath === p);
    if (skill) mkPreview(skill);
  });
  // 点行（含行上的「安装」按钮）都进详情弹窗：详情里看 SKILL.md、选安装位置、一键装。
  // 不再往外跳浏览器 —— 详情、安装都留在应用内
  // 回到顶部：滚过一屏才现身；市场页每次进都重画，滚动监听只绑一次（绑在常驻的 #main 上）
  $('#mk-top').addEventListener('click', () => {
    $('#main').scrollTo({ top: 0, behavior: 'smooth' });
  });
  mkBindScrollTop();
  $('#mk-results').addEventListener('click', (e) => {
    // 「加载更多」先于行点击判定：它长在列表里，但不该触发行详情
    if (e.target.closest('.mk-more')) {
      mkMore();
      return;
    }
    const row = e.target.closest('.mk-row');
    if (!row) return;
    mkOpenDetail(Number(row.dataset.i));
  });
}

// 网络类失败给一条出路：直接把用户送到代理设置（市场连不上，十有八九是代理没配）
function mkFail(r) {
  mkStatus('');
  const err = (r && r.error) || t('未知错误');
  const netish = /超时|HTTP (4\d\d|5\d\d)|fetch failed|ENOTFOUND|ECONN|network|SSL|socket/i.test(err);
  const hint = /403/.test(err) ? t('可能是 GitHub 匿名额度用尽（每小时 60 次），在「设置 → SKILL 市场」里配一个 GitHub Token 再试。') : '';
  const box = $('#mk-results');
  if (!box) return; // 页面已被切走：失败信息无处可写，也别抛错
  box.innerHTML = `<div class="mk-empty">${esc(t('失败：') + err)}${hint ? '<br>' + esc(hint) : ''}
    ${netish ? `<br><button class="btn sm" id="mk-fix-proxy">${t('检查代理设置')}</button>` : ''}</div>`;
  const btn = $('#mk-fix-proxy');
  if (btn) {
    btn.addEventListener('click', () => {
      openSettings('net');
      setTimeout(() => $('#px-mode').focus(), 60);
    });
  }
}

// --------------------- 从 GitHub 安装（弹窗，模板在 index.html） ---------------
// 弹窗是静态 DOM，绑定挂一次就够；#mk-gh 在市场页模板里，随 bindMarketPage 重挂
$('#mkgh-go').addEventListener('click', async () => {
  const raw = $('#mkgh-url').value.trim();
  if (!raw) return;
  const st = $('#mkgh-status');
  const btn = $('#mkgh-go');
  btn.disabled = true;
  st.classList.remove('err');
  st.textContent = t('下载并解压中…（仓库大时会久一点）');
  // 不在渲染层解析：认不出来的地址由主进程给出统一的错误，避免两份解析器漂移
  const r = await api.invoke('market:inspect', { raw });
  btn.disabled = false;
  if (!r.ok) {
    st.classList.add('err');
    st.textContent = t('读取失败：') + (r.error || r.reason || t('未知错误'));
    return;
  }
  closeModal('modal-mkgh');
  $('#mkgh-url').value = '';
  mkShowPick(r, raw);
  mkStatus(state.market.skills.length ? tf('共 {n} 个 SKILL，默认全选', { n: state.market.skills.length }) : '');
});
$('#mkgh-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#mkgh-go').click();
});
// Token 快捷入口：从弹窗直达「设置 → SKILL 市场」，填完点保存设置再回来读取
$('#mkgh-token').addEventListener('click', () => {
  closeModal('modal-mkgh');
  openSettings('market');
  setTimeout(() => $('#set-gh-token').focus(), 60);
});

// ------------------------------ 市场详情弹窗 --------------------------------
// 点一行 → 应用内弹窗：SKILL.md 正文 + 文件数 + 安装位置选择 + 一键安装。
// 安装只取回这一个 SKILL 的目录（main 里按 tree 清单逐个 raw 下载），
// 不再为了装一个 SKILL 去下整仓 zip —— 大仓库那是几十上百 MB。
let mkdCurrent = null; // 当前展示的条目，用来丢弃「加载中又点了别的行」的迟到结果
let mkdBodySeq = 0; // 正文加载序号：仓库模式下点不同 SKILL，迟到的正文作废

/** 统一条目（kind: skill/repo/zip）→ 详情弹窗数据。仓库结果先列 SKILL 清单，
    zip 条目点「安装」时转交给链接安装流程（mkInspect → 勾选页）。 */
function mkDetailView(it) {
  const metric = it.installs ? `⬇ ${fmtMkNum(it.installs)}` : it.stars ? `★ ${fmtMkNum(it.stars)}` : '';
  return {
    kind: it.kind,
    name: it.name,
    owner: it.owner || '',
    repo: it.repo || '',
    skillId: it.skillId || '',
    path: it.path || '',
    description: it.description || '',
    metric,
    srcName: it.srcName || '',
    source: it.source || null,
    url: mkEntryUrl(it) || (it.owner && it.repo ? `https://github.com/${it.owner}/${it.repo}` : ''),
  };
}

/** 仓库模式第一步：列出仓库里的 SKILL 清单，点一个再进正文（正文加载走 loadSkillBody） */
function renderRepoSkillList(v) {
  const list = v.repoSkills || [];
  const total = v.total || list.length;
  $('#mkd-files').textContent = list.length ? tf('{n} 个 SKILL', { n: total }) : '';
  if (!list.length) {
    $('#mkd-md').innerHTML = `<div class="hint">${t('没有在仓库里找到 SKILL.md')}</div>`;
    return;
  }
  // 清单有截断（大仓只列前 20）：总数照实说，别让人以为就这几个
  const truncated = total > list.length ? tf('（共 {total} 个，仅列出前 {n} 个）', { total, n: list.length }) : '';
  $('#mkd-md').innerHTML = `<div class="mkd-skill-list">${list
    .map(
      (s, j) => `<button class="mkd-skill-item" data-j="${j}">
        <span class="mkd-skill-name">${esc(s.name)}</span>
        <span class="mkd-skill-desc">${esc(s.description || t('暂无描述'))}</span>
      </button>`
    )
    .join('')}</div>${truncated ? `<div class="hint" style="padding:8px 2px">${esc(truncated)}</div>` : ''}`;
}

/** 加载某个 SKILL 目录的正文与文件清单（skill 模式详情、仓库模式点选后共用） */
async function loadSkillBody(v) {
  const seq = ++mkdBodySeq;
  $('#mkd-install').classList.remove('hidden');
  $('#mkd-md').innerHTML = `<div class="hint">${t('读取 SKILL.md…')}</div>`;
  $('#mkd-files').textContent = '';
  const r = await api.invoke('market:skillDetail', { owner: v.owner, repo: v.repo, skillId: v.skillId, path: v.path });
  if (seq !== mkdBodySeq || mkdCurrent !== v) return; // 期间点了别的行/别的 SKILL，这份作废
  if (!r.ok) {
    $('#mkd-md').innerHTML = `<div class="hint">${esc(r.error || t('读取失败'))}</div>`;
    return;
  }
  v.path = r.path;
  v.files = r.files || [];
  if (r.description) {
    v.description = r.description;
    $('#mkd-desc').textContent = r.description;
  }
  $('#mkd-files').textContent = tf('{n} 个文件', { n: v.files.length });
  $('#mkd-md').innerHTML = api.md(r.body || '') || `<div class="hint">${t('SKILL.md 是空的')}</div>`;
  mkdStatus('');
}

async function mkOpenDetail(i) {
  const box = state.market.results;
  const item = box && box.items ? box.items[i] : null;
  if (!item) return;
  const v = mkDetailView(item);
  mkdCurrent = v;
  $('#mkd-name').textContent = v.name;
  const av = $('#mkd-avatar');
  av.textContent = (v.name || '?').slice(0, 1).toUpperCase();
  av.style.setProperty('--h', mkHue(v.name));
  av.querySelector('.mk-avatar-img')?.remove();
  $('#mkd-sub').innerHTML = [v.owner && v.repo ? esc(v.owner + '/' + v.repo) : '', v.metric, v.srcName].filter(Boolean).join(' · ');
  $('#mkd-desc').textContent = v.description || t('暂无描述');
  $('#mkd-files').textContent = '';
  $('#mkd-github').classList.toggle('hidden', !v.url);
  fillTargetPicker($('#mkd-target'));
  openModal('modal-mk-detail');
  if (v.owner) {
    const img = document.createElement('img');
    img.className = 'mk-avatar-img';
    av.appendChild(img);
    // 不 await：头像慢不能拖住详情正文（限流网络下会等很久），回来时对号入座
    api.invoke('market:avatar', { owner: v.owner }).then((r) => {
      if (r && r.ok && mkdCurrent === v && img.isConnected) img.src = r.dataUrl;
    });
  }
  // 仓库结果：先列仓库里的 SKILL 清单（点一个才加载正文与安装按钮）
  if (v.kind === 'repo') {
    $('#mkd-install').classList.add('hidden');
    $('#mkd-md').innerHTML = `<div class="hint">${t('读取仓库 SKILL 清单…')}</div>`;
    const r = await api.invoke('market:repoSkills', { owner: v.owner, repo: v.repo });
    if (mkdCurrent !== v) return; // 期间又点了别的行，这份结果作废
    if (!r.ok) {
      $('#mkd-md').innerHTML = `<div class="hint">${esc(r.error || t('读取失败'))}</div>`;
      return;
    }
    v.repoSkills = r.skills;
    renderRepoSkillList(v);
    return;
  }
  // zip 条目：正文区说明安装方式，点「安装」转交链接安装流程
  if (v.kind === 'zip') {
    $('#mkd-install').classList.remove('hidden');
    $('#mkd-md').innerHTML = `<div class="hint">${tf('「{name}」来自 zip 直链：点「安装」去选安装位置。', { name: v.name })}</div>`;
    return;
  }
  await loadSkillBody(v);
}

/** 弹窗内的进度/错误提示：mkStatus 写在页面状态栏上，隔着弹窗遮罩根本看不见 */
function mkdStatus(s) {
  const el = $('#mkd-status');
  if (el) el.textContent = s || '';
}

async function mkInstallDetail() {
  const v = mkdCurrent;
  if (!v) return;
  // zip 条目：转交链接安装流程（勾选页：选位置 → 确认 → 复制）
  if (v.kind === 'zip') {
    closeModal('modal-mk-detail');
    mkInspect({ source: v.source }, v.srcName || 'ZIP');
    return;
  }
  if (!v.owner || !v.repo) return;
  const destDir = pickerValue($('#mkd-target'));
  if (!destDir) return toast(t('请先选择安装位置'), 'err');
  // 装的是别人写的 SKILL：说明与脚本会被 AI 助手读取，这一步必须让人明确确认
  const okGo = await confirmModal({
    title: t('安装 SKILL'),
    message: tf('把「{name}」从 {src} 安装到：\n{dest}\n\nSKILL 里的说明与脚本会被 AI 助手读取并可能执行，请确认来源可信。', {
      name: v.name,
      src: v.owner + '/' + v.repo,
      dest: destDir,
    }),
    confirmLabel: t('安装'),
  });
  if (!okGo) return;

  const btn = $('#mkd-install');
  btn.disabled = true;
  mkdStatus('');
  const folderOf = (relPath) =>
    String(relPath || '')
      .split('/')
      .filter(Boolean)
      .pop() ||
    v.repo ||
    v.name;
  let folder = folderOf(v.path);
  try {
    // 快路：只取回这一个 SKILL 的目录（几 KB，秒级）
    mkdStatus(t('取回 SKILL 中…'));
    const r = await api.invoke('market:fetchSkill', { owner: v.owner, repo: v.repo, path: v.path });
    if (!r.ok) throw new Error(r.error || '');
    const c = await api.invoke('skill:copy', { srcPath: r.dir, type: 'folder', destDir, folderName: folder, onConflict: 'rename' });
    if (!c.ok) throw new Error(c.error || c.reason || '');
    mkdStatus('');
    closeModal('modal-mk-detail');
    toast(tf('已安装「{name}」✓', { name: v.name }), 'ok');
    await scan();
    return;
  } catch (fastErr) {
    log(t('单技能取回失败：') + (fastErr.message || ''), 'err');
  }
  // 慢路：整仓取回。人留在弹窗里等（进度写在弹窗内），装完自动继续 —— 不再把人甩到勾选页
  try {
    mkdStatus(t('单技能取回失败，改用整仓方式取回…（仓库大时会久一点）'));
    const r = await api.invoke('market:inspect', { source: { kind: 'github', owner: v.owner, repo: v.repo, ref: '', path: v.path } });
    if (!r.ok) throw new Error(r.error || '');
    // 认回目标 SKILL：优先「目录名与 skillId 同名」的（层级浅者优先），其次 frontmatter
    // name 同名且不在仓库根的 —— 根目录的 SKILL.md 常是"仓库本身就是个 SKILL"，
    // 名字撞车时会把整仓内容当成目标装出去（larksuite/cli 实测踩过）。都不中才接受唯一 SKILL。
    const cands = r.skills || [];
    const dirName = (s) =>
      String(s.relPath || '')
        .split('/')
        .filter(Boolean)
        .pop() || '';
    const byDir = cands
      .filter((s) => s.relPath && dirName(s) === v.skillId)
      .sort((a, b) => a.relPath.split('/').filter(Boolean).length - b.relPath.split('/').filter(Boolean).length);
    const byName = cands.filter((s) => s.name === v.skillId && s.relPath);
    const hit = byDir[0] || byName[0] || (cands.length === 1 ? cands[0] : null);
    if (!hit) throw new Error(t('整仓里没有找到这个 SKILL'));
    // 文件夹名跟着 SKILL 走（skillId），不能用仓库名 —— 勾选页同一套规则（relPath 的尾段）
    folder = v.skillId || folderOf(hit.relPath) || v.repo;
    mkdStatus(t('正在安装到所选位置…'));
    const c = await api.invoke('skill:copy', { srcPath: hit.absPath, type: 'folder', destDir, folderName: folder, onConflict: 'rename' });
    if (!c.ok) throw new Error(c.error || c.reason || '');
    mkdStatus('');
    closeModal('modal-mk-detail');
    toast(tf('已安装「{name}」✓', { name: v.name }), 'ok');
    await scan();
  } catch (err) {
    // 两条路都失败：错误写在弹窗里（关掉弹窗就看不见了），按钮恢复可点可重试
    mkdStatus(t('安装失败：') + (err.message || t('未知错误')));
    toast(t('安装失败：') + (err.message || t('未知错误')), 'err');
    log(t('安装失败：') + (err.message || ''), 'err');
  } finally {
    btn.disabled = false;
  }
}

// 详情弹窗的两个动作按钮。绑一次即可：弹窗是常驻 DOM，不像市场页每次进都重画
$('#mkd-install').addEventListener('click', mkInstallDetail);
// 仓库模式：弹窗正文区是 SKILL 清单，点一条加载它的正文与安装按钮（弹窗常驻 DOM，绑一次）
$('#mkd-md').addEventListener('click', (e) => {
  const b = e.target.closest('.mkd-skill-item');
  if (!b || !mkdCurrent || !mkdCurrent.repoSkills) return;
  const s = mkdCurrent.repoSkills[Number(b.dataset.j)];
  if (!s) return;
  mkdCurrent.skillId = s.name;
  mkdCurrent.path = s.path;
  loadSkillBody(mkdCurrent);
});
$('#mkd-github').addEventListener('click', () => {
  if (mkdCurrent && mkdCurrent.url) api.invoke('shell:openUrl', { url: mkdCurrent.url });
});

// 市场检索入口：一个搜索框，一次请求（market:searchAll 聚合 skills.sh / SkillsMP /
// GitHub / 自定义索引），一次渲染。竞态守卫：只有「最新发起」的检索才有资格渲染 ——
// 实测热门自动加载与手动搜索并发时，迟到的结果会把列表顶掉。
let mkSearchSeq = 0;

async function mkSearch(query) {
  const seq = ++mkSearchSeq;
  // 无参调用（搜索按钮 / 回车）读输入框；显式传空串 = 进页自动拉热门
  const q = String(query === undefined ? $('#mk-query').value : query).trim();
  mkStatus(t('搜索中…'));
  // 等待不空屏：转圈立即可见，结果回来整体替换
  const box = $('#mk-results');
  if (box) box.innerHTML = `<div class="mk-loading"><span class="mk-spin"></span></div>`;
  // 自定义索引入口已从界面收掉：显式传空 = 不启用（能力仍保留在主进程，见 src/market.js）
  const r = await api.invoke('market:searchAll', {
    query: q,
    indexUrl: '',
    category: state.market.category,
    sortBy: state.market.sortBy,
  });
  if (seq !== mkSearchSeq) return; // 期间又发起了新检索，这份结果作废
  if (!r.ok) {
    if (box) box.innerHTML = '';
    return mkFail(r);
  }
  // 有来源成功才落 featuredTried —— 全挂（断网等）下次进页重试
  if (!q && (r.items.length || (r.sources || []).some((s) => s.ok))) state.market.featuredTried = true;
  state.market.results = { q, items: r.items, sources: r.sources, page: 1, hasMore: true };
  state.market.shownCount = MK_PAGE;
  renderMkResults(state.market.results);
}
// 点卡片 = 立即打开 GitHub 详情页（不下载）；「安装」才真正取回。
// URL 只由已校验的 owner/repo/ref/path 组件拼出，zip 直链则要求 https
function mkEntryUrl(entry) {
  const s = entry && entry.source;
  if (!s) return '';
  if (s.kind === 'github' && s.owner && s.repo) {
    const p = s.path ? '/' + s.path : '';
    return `https://github.com/${s.owner}/${s.repo}${s.ref ? '/tree/' + s.ref + p : ''}`;
  }
  if (s.kind === 'zip' && /^https:\/\//i.test(s.url || '')) return s.url;
  return '';
}

// 结果列表的统一行模板（SkillHub 式：彩色图标 + 名称/徽章 + 描述 + 右侧指标与安装按钮）。
// 三种来源（GitHub 检索 / 内置市场 / 自定义索引）共用，徽章与指标的取值各自传。
// 图标颜色由名字哈希出 0-359 色相（--h 交给 CSS 上色），同一 SKILL 每次颜色稳定。
function mkHue(s) {
  let h = 0;
  for (const c of String(s || '')) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

function mkRowHtml({ i, avatar, name, chip, tags = [], desc, metric, owner, srcName, dup = false }) {
  const tagChips = (tags || []).map((tg) => `<span class="chip">${esc(tg)}</span>`).join('');
  // 首字母图标打底，owner 头像取回来就盖在上面（拿不到就留字母，不留破图）
  const img = owner ? `<img class="mk-avatar-img" alt="" data-owner="${esc(owner)}" />` : '';
  return `<div class="mk-row" ${i !== undefined ? `data-i="${i}"` : ''}>
      <span class="mk-avatar" style="--h:${mkHue(name)}">${esc(avatar || '?')}${img}</span>
      <div class="mk-row-main">
        <div class="mk-row-top">
          <span class="mk-row-name">${esc(name || '?')}</span>
          ${chip ? `<span class="mk-row-chip" title="${esc(chip)}">${esc(chip)}</span>` : ''}
          ${tagChips}
          ${dup ? `<span class="mk-dup" title="${t('本机已有同名 SKILL，不一定是同一个')}">${t('同名已存在')}</span>` : ''}
        </div>
        <div class="mk-row-desc">${esc(desc || '') || t('暂无描述')}</div>
      </div>
      <div class="mk-row-side">
        ${metric ? `<span class="mk-metric">${esc(metric)}</span>` : ''}
        ${srcName ? `<span class="mk-row-src">${esc(srcName)}</span>` : ''}
        <button class="btn sm mk-act-install">${t('安装')}</button>
      </div>
    </div>`;
}

/** 列表画完后异步贴 owner 头像：主进程有缓存，重复渲染不会重复拉 */
function mkLoadAvatars() {
  $$('#mk-results .mk-avatar-img').forEach(async (img) => {
    const r = await api.invoke('market:avatar', { owner: img.dataset.owner });
    if (r && r.ok && img.isConnected) img.src = r.dataUrl;
  });
}

/** 聚合列表渲染：列表只等站点接口（秒级），描述不阻塞渲染 —— 行先画出来，
    描述由 mkBackfillDescs 按行回填（四源竞速，不占 GitHub 配额）。行高固定，
    回填只改一行文字，没有布局跳动。状态行说明总数与来源构成。 */
function renderMkResults(res) {
  const featured = !res.q;
  mkSectionTitle(featured ? t('热门 SKILL') : t('检索结果'));
  const box = $('#mk-results');
  if (!box) return; // 页面已被切走：状态留原处，回来时按 state 重画
  const items = res.items || [];
  if (!items.length) {
    box.innerHTML = `<div class="mk-empty">${t('没有找到 SKILL。<br>换个关键词，或点「从 GitHub 安装」粘贴仓库链接直接读取。')}</div>`;
    mkStatus('');
    return;
  }
  const shown = items.slice(0, state.market.shownCount || MK_PAGE);
  // 状态行 = 已加载数 + 来源构成：用户不用数行数也能知道这次聚合到了什么
  const head = items.length > shown.length ? tf('已显示 {m} / 共 {n} 个', { n: items.length, m: shown.length }) : '';
  const srcParts = (res.sources || []).map((s) => (s.ok ? `${s.name} ×${s.count}` : `${s.name} ${t('未返回')}`));
  mkStatus([head, srcParts.join(' · ')].filter(Boolean).join(' · '));
  let html = '';
  let repoDiv = false;
  // 本机已装过的名字集合：与勾选页的「同名已存在」同一套判据与视觉
  const localNames = new Set(state.skills.map((s) => s.name));
  shown.forEach((it, i) => {
    // SKILL 在前、仓库在后：仓库条目插一条分隔行，列表结构一眼可读
    if (it.kind === 'repo' && !repoDiv) {
      repoDiv = true;
      if (shown.some((x) => x.kind !== 'repo')) html += `<div class="mk-row-kind">${t('相关仓库（整仓安装）')}</div>`;
    }
    const chip = it.kind === 'repo' ? '' : it.owner && it.repo ? it.owner + '/' + it.repo : '';
    html += mkRowHtml({
      i,
      avatar: (it.name || '?').slice(0, 1).toUpperCase(),
      name: it.name,
      chip,
      tags: it.tags,
      desc: it.description,
      metric: it.installs ? `⬇ ${fmtMkNum(it.installs)}` : it.stars ? `★ ${fmtMkNum(it.stars)}` : '',
      owner: it.owner,
      srcName: it.srcName,
      dup: it.kind === 'skill' && localNames.has(it.name),
    });
  });
  // 分页脚注：本地还有存货就直接展开；本地耗尽就拉下一页；确认没有更多就明说
  if (items.length > shown.length || res.hasMore !== false) {
    html += `<div class="mk-more-wrap">${
      res.hasMore === false && items.length <= shown.length
        ? `<span class="hint">${t('没有更多了')}</span>`
        : `<button class="btn sm mk-more">${t('加载更多')}</button>`
    }</div>`;
  }
  box.innerHTML = html;
  mkLoadAvatars();
  mkBackfillDescs(res);
}

/** 条目的稳定 key：跨页合并时识别同一条目，避免「加载更多」装进重复行 */
function mkItemKey(it) {
  if (it.kind === 'repo') return 'repo:' + (it.owner || '') + '/' + (it.repo || '');
  if (it.kind === 'zip') return 'zip:' + ((it.source && it.source.url) || it.name);
  return (it.owner || '') + '/' + (it.repo || '') + '|' + (it.path || it.skillId || it.name);
}

/** 加载更多：先看本地池里还有没有没展示的（零网络），耗尽才按页拉下一页并去重合并。
    拉回来全是重复 = 真的没有更多了，按钮就此消失。 */
async function mkMore() {
  const res = state.market.results;
  if (!res || res.hasMore === false) return;
  const seq = mkSearchSeq;
  const cur = state.market.shownCount || MK_PAGE;
  // 本地还有存货：直接展开，零网络
  if (res.items.length > cur) {
    state.market.shownCount = cur + MK_PAGE;
    renderMkResults(res);
    return;
  }
  const btn = $('#mk-results .mk-more');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="mk-spin sm"></span>${t('加载中…')}`;
  }
  // 自定义索引入口已从界面收掉：显式传空 = 不启用
  const r = await api.invoke('market:searchAll', {
    query: res.q,
    indexUrl: '',
    category: state.market.category,
    sortBy: state.market.sortBy,
    page: (res.page || 1) + 1,
  });
  if (seq !== mkSearchSeq) return; // 期间发起了新检索，这次翻页作废
  if (!r.ok) {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = t('加载更多');
    }
    return;
  }
  const seen = new Set(res.items.map(mkItemKey));
  const fresh = (r.items || []).filter((it) => !seen.has(mkItemKey(it)));
  res.page = (res.page || 1) + 1;
  if (!fresh.length) {
    res.hasMore = false;
    renderMkResults(res);
    return;
  }
  res.items = res.items.concat(fresh);
  state.market.shownCount = cur + MK_PAGE;
  renderMkResults(res);
}

/** 描述回填：只补已展示行里没有描述的 SKILL 条目，并发 6 按行填充。
    主进程四源竞速取 SKILL.md（skillCache 缓存 24h），不占 api.github.com 配额；
    新检索发起后（seq 变化）立刻停手，迟到的回填不会写进新列表。 */
async function mkBackfillDescs(res) {
  const seq = mkSearchSeq;
  const items = (res.items || []).slice(0, state.market.shownCount || MK_PAGE);
  const jobs = [];
  items.forEach((it, i) => {
    if (it.kind === 'skill' && it.owner && !it.description) jobs.push({ it, i });
  });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(6, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      if (seq !== mkSearchSeq) return; // 新检索已发起，这轮回填作废
      const { it, i } = jobs[cursor++];
      const r = await api.invoke('market:resolveOne', { owner: it.owner, repo: it.repo, skillId: it.skillId, path: it.path });
      if (seq !== mkSearchSeq || !r || !r.ok || !r.description) continue;
      it.description = r.description;
      if (r.path) it.path = r.path;
      const row = document.querySelector(`#mk-results .mk-row[data-i="${i}"]`);
      const el = row && row.querySelector('.mk-row-desc');
      if (el && el.textContent === t('暂无描述')) el.textContent = r.description;
    }
  });
  await Promise.all(workers);
}

// payload 直接交给 主进程：链接怎么解析只在 src/market.js 里有一份实现
async function mkInspect(payload, label, { preferSkillId } = {}) {
  mkStatus(t('下载并解压中…（仓库大时会久一点）'));
  const r = await api.invoke('market:inspect', payload);
  if (!r.ok) return mkFail(r);
  mkShowPick(r, label, { preferSkillId });
}

// 拿到 inspect 结果后的勾选页渲染：市场页与「从 GitHub 安装」弹窗共用，
// 弹窗那条路已经下载过一次，绝不能让它再下一遍
function mkShowPick(r, label, { preferSkillId } = {}) {
  state.market.skills = r.skills || [];
  // 默认全选：用户是冲着这个来源点进来的，一个个勾太啰嗦；底部会显示已选数量
  state.market.selected = new Set(state.market.skills.map((s) => s.absPath));
  // 内置市场点的是站里的一条：只预选站里那条对应的 SKILL，同仓的其余照旧可勾
  if (preferSkillId) {
    const hit = state.market.skills.find((s) => s.name === preferSkillId || (s.relPath || '').split('/').pop() === preferSkillId);
    if (hit) state.market.selected = new Set([hit.absPath]);
  }
  state.market.active = null;
  state.market.source = label || r.label || '';
  if (!mkAlive()) return; // 先落 state 再画 DOM：页面不在就到此为止，回来时按 state 恢复
  $('#mk-source').textContent = state.market.source;
  $('#mk-preview').innerHTML = '';
  showMkStep('pick');
  renderMkList();
  // 安装位置选择器必须在这里填：勾选页每次进都重画，恢复路径之外这是唯一入口。
  // 漏了它「安装选中的 SKILL」会永远提示「请先选择安装位置」（实测踩过）。
  fillTargetPicker($('#mk-target'));
  mkStatus(state.market.skills.length ? tf('共 {n} 个 SKILL，默认全选', { n: state.market.skills.length }) : '');
}

function renderMkList() {
  // 只按名字比对：本机可能有别的 Agent 下的同名 SKILL，未必是同一个，所以徽章写「同名」
  // 而不是「已安装」——后者会让人以为装过了、从而跳过安装
  const sameName = new Set(state.skills.map((s) => s.name));
  const list = $('#mk-list');
  if (!list) return; // 页面已被切走
  if (!state.market.skills.length) {
    list.innerHTML = `<li class="mk-empty">${t('这个来源里没有找到 SKILL.md。')}</li>`;
    updateMkInstall();
    return;
  }
  list.innerHTML = state.market.skills
    .map(
      (s) => `<li class="mk-item" data-path="${esc(s.absPath)}">
      <input type="checkbox" ${state.market.selected.has(s.absPath) ? 'checked' : ''} />
      <div class="mk-item-main">
        <div class="mk-item-name">${esc(s.name)}${sameName.has(s.name) ? `<span class="mk-dup" title="${t('本机已有同名 SKILL，不一定是同一个')}">${t('同名已存在')}</span>` : ''}</div>
        <div class="mk-item-desc" title="${s.description ? esc(s.description) : ''}">${esc(s.description) || t('（无描述）')} · ${s.fileCount} ${t('个文件')}</div>
      </div>
    </li>`
    )
    .join('');
  updateMkInstall();
  // 右侧预览别空着：没有选中项就预览第一个；从别的页面回来（active 还在）也要把预览画回来
  if (state.market.skills.length) {
    const active = state.market.skills.find((s) => s.absPath === state.market.active) || state.market.skills[0];
    state.market.active = active.absPath;
    const li = $(`#mk-list .mk-item[data-path="${CSS.escape(active.absPath)}"]`);
    if (li) li.classList.add('active');
    if (!$('#mk-preview').innerHTML) mkPreview(active);
  }
}

function updateMkInstall() {
  const btn = $('#mk-install');
  if (!btn) return;
  const n = state.market.selected.size;
  btn.disabled = n === 0;
  btn.textContent = n ? tf('安装选中的 {n} 个', { n }) : t('安装选中的 SKILL');
}

async function mkPreview(skill) {
  const box = $('#mk-preview');
  if (!box) return;
  box.innerHTML = `<div class="hint">${t('读取中…')}</div>`;
  const r = await api.invoke('skill:read', { path: skill.skillMdPath });
  if (!box.isConnected) return; // 等正文读回来时页面可能已被切走
  box.innerHTML = r.ok ? api.md(r.body) : `<div class="hint">${t('读取失败：')}${esc(r.error || '')}</div>`;
}

async function mkInstall() {
  const destDir = pickerValue($('#mk-target'));
  if (!destDir) return toast(t('请先选择安装位置'), 'err');
  const picked = state.market.skills.filter((s) => state.market.selected.has(s.absPath));
  if (!picked.length) return;
  // 装的是别人写的 SKILL：说明与脚本会被 AI 助手读取，这一步必须让人明确确认
  const okGo = await confirmModal({
    title: t('安装 SKILL'),
    message: tf('把 {n} 个 SKILL 从「{src}」复制到：\n{dest}\n\nSKILL 里的说明与脚本会被 AI 助手读取并可能执行，请确认来源可信。', {
      n: picked.length,
      src: $('#mk-source').textContent || '',
      dest: destDir,
    }),
    confirmLabel: t('安装'),
  });
  if (!okGo) return;

  // 安装期间禁掉按钮：连点会各跑一遍循环，配合 onConflict:'rename' 装出 foo-2、foo-3
  const btn = $('#mk-install');
  btn.disabled = true;
  mkStatus(t('安装中…'));
  let done = 0;
  const failed = [];
  try {
    for (const s of picked) {
      const folder =
        String(s.relPath || '')
          .split('/')
          .filter(Boolean)
          .pop() || s.name;
      const r = await api.invoke('skill:copy', { srcPath: s.absPath, type: 'folder', destDir, folderName: folder, onConflict: 'rename' });
      if (r.ok) done++;
      else failed.push(`${s.name}：${r.error || r.reason || ''}`);
    }
  } finally {
    btn.disabled = false;
    updateMkInstall();
  }
  await scan();
  if (failed.length) {
    mkStatus('');
    toast(tf('已安装 {n} 个，{m} 个失败', { n: done, m: failed.length }), 'err');
    failed.slice(0, 3).forEach((f) => log(t('安装失败：') + f, 'err'));
    return;
  }
  toast(tf('已安装 {n} 个 SKILL ✓', { n: done }), 'ok');
  // 回到「找」那一步：结果列表还在原地，可以接着挑下一个来源装
  showMkStep('find');
  mkStatus('');
  if (isProjectTarget(destDir)) {
    const proj = state.projects.find((p) => destDir.startsWith(p.dir));
    if (proj) setFilter('project:' + proj.id);
  }
}

// ------------------------------ 启动 -----------------------------------------
// 自动备份的结果由主进程推送。**必须最先注册**：主进程在窗口 did-finish-load 后才起调度，
// 而这里下面有几个 await，注册晚了就可能漏掉启动那一轮的通知。
// 回调体只用到下面几个 await 之后的 state，等事件真到了再读也不迟。
api.onSyncAuto?.((r) => {
  if (r.error) return toast(t('自动备份失败：') + r.error, 'err');
  if (r.skipped === 'needs-first-backup') {
    return toast(t('自动备份已暂停：本机还没有备份过，请先手动备份一次'), 'err');
  }
  toast(tf('已自动备份 {n} 个 SKILL ✓', { n: r.count }), 'ok');
  api.invoke('sync:getConfig').then((c) => {
    if (c && c.ok) state.webdav = c.webdav;
    // 刚自动备份过一份，总览上的「最后备份 …」已经过期（手动备份那条路同理，见 btn-wd-backup）
    invalidateMachines();
  });
});

(async () => {
  // 先置位再干活：boot-guard 只需要知道「app.js 跑起来了」，不能等首次扫描——
  // 目录多的时候扫描可能超过它的 6 秒，那会误报「界面初始化失败」
  window.__appBooted = true;
  try {
    i18n.apply(document);
    const p = await api.invoke('app:paths');
    state.HOME = p.home || '';
    state.logFile = p.logFile || '';
    state.ui = p.ui || { lang: 'auto' };
    state.proxy = p.proxy || state.proxy;
    state.marketCfg = p.market || state.marketCfg;
    state.machine = { id: p.machineId || '', name: p.machineName || '', hostname: p.hostname || '' };
    // 让样式表知道平台：macOS 用系统红绿灯，需要隐藏自绘窗口按钮并给左上角留位
    document.body.dataset.platform = p.platform || '';
    applyOverlay(state.ui);
    // 配置里的主题是权威值：覆盖掉 theme.js 启动时用的缓存，并把缓存刷新成它
    applyTheme(state.ui);
    theme.cache(state.ui);
    i18n.setLang(state.ui.lang || 'auto');
    i18n.apply(document);
    await scan();
  } catch (err) {
    // 启动阶段任何异常都必须落到可见的错误态上：静默留白等于让用户无路可走
    renderFatal(t('界面初始化失败：') + String((err && err.message) || err), () => location.reload());
  } finally {
    // boot-guard.js 据此判断界面是否已经起来了
    window.__appReady = true;
  }
})();
