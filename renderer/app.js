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
  restoreName: null,
  restoreAgents: null,
  dupGroups: [],
  editingAgents: null,
  editingProjects: null,
  ui: { lang: 'auto' },
  proxy: { mode: 'system', url: '', bypass: '' },
  marketCfg: { indexUrl: '', token: '' },
  // 发现弹窗的工作状态：来源页签 / 结果 / 已取回的 SKILL / 勾选集合 / 当前预览项
  market: { src: 'github', skills: [], selected: new Set(), active: null },
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
      const dirs =
        (a.dirs || [])
          .map((d) => {
            const missing = state.missing.some((m2) => m2.dir === expand(d));
            return `<span class="dir-chip ${missing ? 'warn' : ''}" title="${esc(expand(d))}${missing ? '（' + t('目录不存在，安装时将自动创建') + '）' : ''}">
            ${missing ? '<span class="warn-ico">⚠</span>' : ''}${esc(d)}<span class="rm cfg-dir-rm" data-dir="${esc(d)}">×</span></span>`;
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
        <span class="dash-sub">${miss ? `<span class="dash-warn">⚠ ${tf('{n} 个目录缺失', { n: miss })}</span>` : tf('{n} 个目录', { n: (a.dirs || []).length })}</span>
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
  const logRows = state.logs.length
    ? state.logs
        .slice(0, 3)
        .map(
          (e) => `<div class="dash-row">
            <span class="log-time">${e.time.toLocaleTimeString('zh-CN', { hour12: false })}</span>
            <span class="log-type ${e.type}">${e.type === 'err' ? t('错误') : e.type === 'ok' ? t('成功') : t('信息')}</span>
            <span class="dash-sub" style="flex:1;white-space:normal">${esc(e.msg)}</span>
          </div>`
        )
        .join('')
    : '<div class="hint" style="padding:8px 2px">' + t('暂无操作记录；安装 / 合并 / 删除的结果都会记录在「操作日志」中。') + '</div>';

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
  // 概览是一张分组容器里的三段（指标 / 分布 / 动态），靠细分隔线分节。
  // 早先是 6 张独立卡 + 一层嵌套白块 + 一行与顶栏重复的动作按钮，层次全靠阴影堆。
  const overview = `
    <section class="overview">
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
      <div class="ov-activity">
        <div class="ov-sec">${t('最近动态')} <span class="hint">（${tf('共 {n} 条', { n: state.logs.length })}，${t('详见操作日志')}）</span></div>
        ${logRows}
      </div>
    </section>`;
  $('#grid').innerHTML =
    overview +
    (dangling ? `<div class="link-hint warn">${tf('⚠ 检测到 {n} 个失效链接（源已被删除），可在列表中筛选清理。', { n: dangling })}</div>` : '') +
    sections
      .map(
        (sec) => `
      <div class="section-head"><h3>${esc(sec.title)}</h3>${sec.tag ? `<span class="chip proj-chip">${esc(sec.tag)}</span>` : ''}<span class="hint">${tf('{n} 个', { n: sec.items.length })}</span></div>
      <div class="grid">${sec.items.map(cardHTML).join('')}</div>`
      )
      .join('');
  bindCards();
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

/** 目录 → 读它的 Agent 数。>1 就是共用目录（如 ~/.agents/skills），要标出来 */
function dirAgentCounts() {
  const n = new Map();
  for (const a of state.agents) for (const d of a.dirs || []) n.set(d, (n.get(d) || 0) + 1);
  return n;
}

function targetGroups() {
  const counts = dirAgentCounts();
  const groups = [{ title: t('全局 · Agent 目录'), items: [] }];
  for (const a of state.agents) {
    for (const d of a.dirs || []) {
      groups[0].items.push({ value: d, agent: a.name, color: a.color, dir: d, tag: (counts.get(d) || 0) > 1 ? t('共用') : '' });
    }
  }
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

function openPicker(el, focusIdx) {
  closePicker();
  const groups = el._groups || [];
  pickerPop = document.createElement('div');
  pickerPop.className = 'picker-pop';
  pickerPop.setAttribute('role', 'listbox');
  pickerPop.innerHTML = groups.length
    ? groups
        .map(
          (g) =>
            `<div class="picker-group">${esc(g.title)}</div>` +
            g.items
              .map(
                (o) => `<button type="button" class="picker-opt" role="option" data-value="${esc(o.value)}"
          aria-selected="${o.value === pickerValue(el)}">
          ${o.color ? `<span class="dot" style="background:${esc(o.color)}"></span>` : ''}
          <span class="picker-agent">${esc(o.agent)}</span>
          <span class="picker-dir" title="${esc(o.dir)}">${esc(shortPath(o.dir))}</span>
          ${o.tag ? `<span class="picker-tag">${esc(o.tag)}</span>` : ''}
        </button>`
              )
              .join('')
        )
        .join('')
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
  $('#wd-path').value = w.remotePath || 'cc-skill-sync';
  $('#wd-auto').checked = !!w.autoBackup;
  $('#wd-freq').value = w.autoBackupFreq || 'startup';
  wdResetStatus();
}

function wdReadInputs() {
  return {
    url: $('#wd-url').value.trim(),
    username: $('#wd-user').value.trim(),
    password: $('#wd-pass').value,
    remotePath: $('#wd-path').value.trim() || 'cc-skill-sync',
    autoBackup: $('#wd-auto').checked,
    autoBackupFreq: $('#wd-freq').value,
  };
}
async function wdSave() {
  const r = await api.invoke('sync:setConfig', { webdav: wdReadInputs() });
  if (r.ok) state.webdav = wdReadInputs();
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
  } else {
    $('#wd-status').textContent = '✗ ' + t('备份失败：') + r.error;
    toast(t('备份失败：') + r.error, 'err');
  }
});
// 点击「从云端下载」：弹窗先行（瞬间可见）→ 后台只取廉价元数据 → 用户点确认后才真正下载整包
let restoreSeq = 0;
const RESTORE_FIELDS = ['#rv-host', '#rv-time', '#rv-remote', '#rv-size', '#rv-content', '#rv-source'];

// 恢复范围：按 Agent 勾选要重建哪些全局 SKILL，默认全选。
// 旧版备份没有侧车元数据，拿不到 Agent 明细，只能整包恢复（此时不渲染勾选框）。
function renderRestoreScope(info) {
  const agents = Array.isArray(info.agents) ? info.agents : [];
  const list = $('#rv-agents');
  const skip = $('#rv-skip');
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
  const notes = [];
  const projectCount = Number(info.projectCount) || 0;
  if (projectCount) notes.push(tf('另有 {n} 个项目 SKILL 不在恢复范围内（随项目仓库走）', { n: projectCount }));
  // 旧版备份没有 Agent 明细，也就拿不到 ~ 目录声明——只能整包恢复，目录要靠后缀匹配重新映射
  if (info.detailed && !agents.length) notes.push(t('旧版备份的目录按原机器的用户目录记录，恢复时会自动映射到本机'));
  skip.textContent = notes.join('\n');
  skip.hidden = !notes.length;
  syncRestoreSelection();
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

$('#btn-wd-restore').addEventListener('click', async () => {
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
  if (!(await wdSave())) return fail(t('保存失败'));

  const info = await api.invoke('sync:restoreInfo', {});
  if (stale()) return;
  if (!info.ok) return fail(info.error);

  state.restoreName = info.name;
  const d = new Date(info.uploadedAt);
  $('#rv-host').textContent = info.hostname || '—';
  $('#rv-time').textContent = info.uploadedAt ? (isNaN(d) ? info.uploadedAt : d.toLocaleString()) : '—';
  $('#rv-remote').textContent = info.remote;
  $('#rv-size').textContent = info.size ? fmtSize(info.size) : '—';
  $('#rv-content').textContent = info.detailed ? tf('{n} 个 SKILL + config.json', { n: info.entries }) : t('—（旧版备份未附带元数据）');
  // 备份来源：本机备份过就用自己的那份，否则退回云端最新的一条
  $('#rv-source').textContent = info.source === 'local' ? t('本机上次备份') : t('云端最新一条（本机尚未备份过）');
  // 按钮的可用状态由 syncRestoreSelection 决定（全选/未选/旧版无勾选框三种情况都已覆盖）
  renderRestoreScope(info);
  $('#rv-status').textContent = '';
});

$('#btn-restore-confirm').addEventListener('click', async () => {
  const btn = $('#btn-restore-confirm');
  btn.disabled = true;
  $('#rv-status').textContent = t('正在下载并恢复…');
  try {
    const r = await api.invoke('sync:restoreApply', { name: state.restoreName, agentIds: state.restoreAgents });
    if (!r.ok) {
      $('#rv-status').textContent = '✗ ' + r.error;
      return toast(r.error, 'err');
    }
    toast(tf('已从云端恢复 {n} 个 SKILL ✓', { n: r.restored }), 'ok');
    if (r.relocated?.length) toast(tf('{n} 个旧版目录已按本机用户目录重新映射', { n: r.relocated.length }), 'ok');
    // 下面两条是设计如此（不算失败），用中性级别，免得跟真正的错误混在一起
    if (r.skippedProjects) toast(tf('未恢复 {n} 个项目 SKILL（随项目仓库走）', { n: r.skippedProjects }), '');
    if (r.projectConfigSkipped) toast(tf('未恢复 {n} 个项目配置（不同电脑的项目路径不通用）', { n: r.projectConfigSkipped }), '');
    if (r.skippedAgents) toast(tf('未恢复 {n} 个未勾选 Agent 的 SKILL', { n: r.skippedAgents }), '');
    // 这两种是「本该恢复却没恢复成」，必须报出来——静默跳过正是当初那个缺陷的形态
    if (r.skippedExternal?.length) {
      const n = r.skippedExternal.reduce((s, x) => s + x.count, 0);
      toast(tf('未恢复 {n} 个 SKILL：{p} 无法映射到本机目录', { n, p: r.skippedExternal.map((x) => x.dir).join('、') }), 'err');
    }
    if (r.skippedInvalid) toast(tf('跳过 {n} 个路径非法的条目', { n: r.skippedInvalid }), 'err');
    if (r.appliedConfig) toast(t('配置也已恢复 ✓'), 'ok');
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

function openSettings() {
  fillWebdavInputs(state.webdav);
  $('#set-lang').value = (state.ui && state.ui.lang) || 'auto';
  fillOverlayInputs(state.ui);
  overlaySnapshot = readOverlayInputs();
  renderAccentChips();
  fillThemeInputs(currentThemeSel());
  themeSnapshot = readThemeInputs();
  fillProxyInputs(state.proxy);
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
$('#btn-settings').addEventListener('click', openSettings);
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

$('#btn-market').addEventListener('click', openMarket);

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

// ------------------------------ 发现 SKILL（市场） ---------------------------
// 两步：先「找」（GitHub 搜索 / 粘链接 / 索引源），再「装」（列出该来源里的 SKILL、
// 勾选、预览、选目标目录）。搜索与下载都在主进程做，所以走的是同一套代理配置。
const mkStatus = (s) => ($('#mk-status').textContent = s || '');

function showMkStep(step) {
  $('#mk-find').classList.toggle('hidden', step !== 'find');
  $('#mk-pick').classList.toggle('hidden', step !== 'pick');
  $('#mk-install').classList.toggle('hidden', step !== 'pick');
}

function openMarket() {
  state.market = { src: 'github', skills: [], selected: new Set(), active: null };
  $('#mk-query').value = '';
  $('#mk-url').value = '';
  $('#mk-index').value = (state.marketCfg && state.marketCfg.indexUrl) || '';
  $('#mk-token').value = (state.marketCfg && state.marketCfg.token) || '';
  $('#mk-results').innerHTML = '';
  $('#mk-preview').innerHTML = '';
  $('#mk-list').innerHTML = '';
  $('#mk-source').textContent = '';
  mkStatus('');
  selectMkSource('github');
  showMkStep('find');
  fillTargetPicker($('#mk-target'));
  openModal('modal-market');
}

function selectMkSource(src) {
  state.market.src = src;
  $$('#mk-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.mkSrc === src));
  ['github', 'url', 'index'].forEach((s) => $('#mk-pane-' + s).classList.toggle('hidden', s !== src));
  // Token 只对 GitHub 相关来源有意义
  $('#mk-token').style.display = src === 'github' ? '' : 'none';
  mkStatus('');
}

$('#mk-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) selectMkSource(btn.dataset.mkSrc);
});

// 索引地址与 token 都是「填了就该记住」的东西，失焦即存，不用额外点保存
const saveMarketCfg = async () => {
  const r = await api.invoke('market:setConfig', { indexUrl: $('#mk-index').value.trim(), token: $('#mk-token').value.trim() });
  if (r.ok) state.marketCfg = r.market;
};
$('#mk-index').addEventListener('blur', saveMarketCfg);
$('#mk-token').addEventListener('blur', saveMarketCfg);

// 网络类失败给一条出路：直接把用户送到代理设置（市场连不上，十有八九是代理没配）
function mkFail(r) {
  mkStatus('');
  const err = (r && r.error) || t('未知错误');
  const netish = /超时|HTTP (4\d\d|5\d\d)|fetch failed|ENOTFOUND|ECONN|network|SSL|socket/i.test(err);
  const hint = /403/.test(err) ? t('可能是 GitHub 匿名额度用尽（每小时 60 次），填个 Token 再试。') : '';
  $('#mk-results').innerHTML = `<div class="mk-empty">${esc(t('失败：') + err)}${hint ? '<br>' + esc(hint) : ''}
    ${netish ? `<br><button class="btn sm" id="mk-fix-proxy">${t('检查代理设置')}</button>` : ''}</div>`;
  const btn = $('#mk-fix-proxy');
  if (btn) {
    btn.addEventListener('click', () => {
      closeModal('modal-market');
      openSettings();
      setTimeout(() => $('#px-mode').focus(), 60);
    });
  }
}

function renderMkRepos(items, total) {
  mkStatus(total ? tf('共 {n} 个仓库，按 star 排序；点一个查看其中的 SKILL', { n: total }) : '');
  const box = $('#mk-results');
  if (!items.length) {
    box.innerHTML = `<div class="mk-empty">${t('没有找到仓库。<br>换个关键词，或改用「粘贴链接」直接给仓库地址。')}</div>`;
    return;
  }
  box.innerHTML = items
    .map(
      (it) => `<div class="mk-repo" data-owner="${esc(it.owner)}" data-repo="${esc(it.repo)}">
      <div class="mk-repo-name">${esc(it.fullName)}${it.stars ? `<span class="chip">★ ${it.stars}</span>` : ''}</div>
      <div class="mk-repo-desc">${esc(it.description) || t('（无描述）')}</div>
      <div class="mk-repo-meta">${it.updatedAt ? `<span>${t('最近更新')} ${esc(String(it.updatedAt).slice(0, 10))}</span>` : ''}</div>
    </div>`
    )
    .join('');
}

async function mkSearchGithub() {
  const query = $('#mk-query').value.trim();
  if (!query) return;
  await saveMarketCfg();
  mkStatus(t('搜索中…'));
  $('#mk-results').innerHTML = '';
  const r = await api.invoke('market:search', { query });
  if (!r.ok) return mkFail(r);
  renderMkRepos(r.items, r.total);
}

async function mkLoadIndex() {
  const url = $('#mk-index').value.trim();
  if (!url) return toast(t('请先填写索引地址'), 'err');
  await saveMarketCfg();
  mkStatus(t('加载索引中…'));
  $('#mk-results').innerHTML = '';
  const r = await api.invoke('market:index', { url });
  if (!r.ok) return mkFail(r);
  mkStatus(r.name ? tf('索引「{name}」', { name: r.name }) + (r.skipped ? tf('（跳过 {n} 条无效记录）', { n: r.skipped }) : '') : '');
  const box = $('#mk-results');
  if (!r.items.length) {
    box.innerHTML = `<div class="mk-empty">${t('索引里没有可用的条目。')}</div>`;
    return;
  }
  box.innerHTML = r.items
    .map(
      (it, i) => `<div class="mk-repo mk-index-item" data-i="${i}">
      <div class="mk-repo-name">${esc(it.name)}${(it.tags || []).map((tg) => `<span class="chip">${esc(tg)}</span>`).join('')}</div>
      <div class="mk-repo-desc">${esc(it.description) || t('（无描述）')}</div>
      <div class="mk-repo-meta"><span>${esc(it.source.kind === 'github' ? `${it.source.owner}/${it.source.repo}${it.source.path ? '/' + it.source.path : ''}` : it.source.url)}</span></div>
    </div>`
    )
    .join('');
  state.market.indexItems = r.items;
}

// 选中一个来源（仓库 / 索引条目 / 粘贴的链接）→ 下载解压 → 列出其中的 SKILL。
// payload 直接交给主进程：链接怎么解析只在 src/market.js 里有一份实现
async function mkInspect(payload, label) {
  mkStatus(t('下载并解压中…（仓库大时会久一点）'));
  const r = await api.invoke('market:inspect', payload);
  if (!r.ok) return mkFail(r);
  state.market.skills = r.skills || [];
  // 默认全选：用户是冲着这个来源点进来的，一个个勾太啰嗦；底部会显示已选数量
  state.market.selected = new Set(state.market.skills.map((s) => s.absPath));
  state.market.active = null;
  $('#mk-source').textContent = label || r.label || '';
  $('#mk-preview').innerHTML = '';
  showMkStep('pick');
  renderMkList();
  mkStatus(state.market.skills.length ? tf('共 {n} 个 SKILL，默认全选', { n: state.market.skills.length }) : '');
}

function renderMkList() {
  // 只按名字比对：本机可能有别的 Agent 下的同名 SKILL，未必是同一个，所以徽章写「同名」
  // 而不是「已安装」——后者会让人以为装过了、从而跳过安装
  const sameName = new Set(state.skills.map((s) => s.name));
  const list = $('#mk-list');
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
        <div class="mk-item-name">${esc(s.name)}${sameName.has(s.name) ? `<span class="chip" title="${t('本机已有同名 SKILL，不一定是同一个')}">${t('同名已存在')}</span>` : ''}</div>
        <div class="mk-item-desc" title="${esc(s.description)}">${esc(s.description) || t('（无描述）')} · ${s.fileCount} ${t('个文件')}</div>
      </div>
    </li>`
    )
    .join('');
  updateMkInstall();
}

function updateMkInstall() {
  const n = state.market.selected.size;
  const btn = $('#mk-install');
  btn.disabled = n === 0;
  btn.textContent = n ? tf('安装选中的 {n} 个', { n }) : t('安装选中的 SKILL');
}

async function mkPreview(skill) {
  const box = $('#mk-preview');
  box.innerHTML = `<div class="hint">${t('读取中…')}</div>`;
  const r = await api.invoke('skill:read', { path: skill.skillMdPath });
  box.innerHTML = r.ok ? api.md(r.body) : `<div class="hint">${t('读取失败：')}${esc(r.error || '')}</div>`;
}

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

$('#mk-results').addEventListener('click', (e) => {
  const repo = e.target.closest('.mk-repo:not(.mk-index-item)');
  if (repo) {
    const owner = repo.dataset.owner;
    const name = repo.dataset.repo;
    return mkInspect({ source: { kind: 'github', owner, repo: name, ref: '' } }, owner + '/' + name);
  }
  const idx = e.target.closest('.mk-index-item');
  if (idx) {
    const entry = (state.market.indexItems || [])[Number(idx.dataset.i)];
    if (entry) mkInspect({ source: entry.source }, entry.name);
  }
});

$('#mk-go').addEventListener('click', mkSearchGithub);
$('#mk-query').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') mkSearchGithub();
});
$('#mk-go-index').addEventListener('click', mkLoadIndex);
$('#mk-index').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') mkLoadIndex();
});
$('#mk-go-url').addEventListener('click', () => {
  const raw = $('#mk-url').value.trim();
  if (!raw) return;
  // 不在渲染层解析：认不出来的地址由主进程给出统一的错误，避免两份解析器漂移
  mkInspect({ raw }, raw);
});
$('#mk-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#mk-go-url').click();
});
$('#mk-back').addEventListener('click', () => {
  showMkStep('find');
  mkStatus('');
});

$('#mk-install').addEventListener('click', async () => {
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
  closeModal('modal-market');
  if (isProjectTarget(destDir)) {
    const proj = state.projects.find((p) => destDir.startsWith(p.dir));
    if (proj) setFilter('project:' + proj.id);
  }
});

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
