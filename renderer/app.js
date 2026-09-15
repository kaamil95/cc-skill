/* CC Skill 渲染进程：全部 UI 逻辑 */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const svgIcon = (paths, size = 14, sw = 1.7) =>
  `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const FOLDER_SVG = svgIcon('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>', 15);
const FILE_SVG = svgIcon('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>', 15);
const FOLDER_BIG = svgIcon('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>', 46, 1.2);
const SEARCH_BIG = svgIcon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 46, 1.2);
const CHECK_BIG = svgIcon('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 5-5.5"/>', 40, 1.4);

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
  importSrc: null,
  logs: [],
  unreadErrors: 0,
  restoreToken: null,
  dupGroups: [],
  editingAgents: null,
  editingProjects: null,
  ui: { lang: 'auto' },
  logFile: '',
};

const expand = (p) => (p && p.startsWith('~') ? state.HOME + p.slice(1) : p);
const shortPath = (p) => (state.HOME && p && p.toLowerCase().startsWith(state.HOME.toLowerCase()) ? '~' + p.slice(state.HOME.length) : p);
const toTilde = (p) => {
  if (!state.HOME || !p || !p.toLowerCase().startsWith(state.HOME.toLowerCase())) return p;
  const rest = p.slice(state.HOME.length).split(String.fromCharCode(92)).filter(Boolean).join('/');
  return '~/' + rest.split('/').filter(Boolean).join('/');
};
const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const isProjectTarget = (v) => {
  const norm = String(v || '').replace(/[\\/]+/g, '/').toLowerCase();
  return state.projects.some((p) => norm.startsWith(String(p.dir).replace(/[\\/]+/g, '/').toLowerCase()));
};
const agentById = (id) => state.agents.find((a) => a.id === id);

// ------------------------------ 日志 / Toast ---------------------------------
function log(msg, type = '') {
  state.logs.unshift({ time: new Date(), type, msg });
  if (state.logs.length > 500) state.logs.pop();
  if (!$('#modal-logs').classList.contains('hidden')) renderLogs();
  else if (type === 'err') { state.unreadErrors++; updateLogBadge(); }
  api.invoke('log:append', { type, msg }).catch(() => {});
}

function toast(msg, type = '') {
  log(msg, type);
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  if (type === 'err') {
    el.title = t('点击查看操作日志');
    el.addEventListener('click', () => { el.remove(); openLogs(); });
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
    .map((e) => `
    <li class="log-item ${e.type}">
      <span class="log-time">${e.time.toLocaleTimeString('zh-CN', { hour12: false })}</span>
      <span class="log-type">${tag(e.type)}</span>
      <span class="log-msg">${esc(e.msg)}</span>
    </li>`)
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

// ------------------------------ 弹窗 ----------------------------------------
const openModal = (id) => $('#' + id).classList.remove('hidden');
const closeModal = (id) => $('#' + id).classList.add('hidden');
$$('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.dataset.close)));
$$('.modal-overlay').forEach((ov) =>
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.classList.add('hidden'); })
);

// ------------------------------ 扫描 / 渲染 ---------------------------------
async function scan() {
  const r = await api.invoke('scan');
  state.skills = r.skills;
  state.agents = r.agents;
  state.projects = r.projects || [];
  state.webdav = r.webdav || {};
  state.missing = r.missingDirs || [];
  state.view = buildDisplayList();
  i18n.apply(document);
  renderSidebar();
  renderGrid();
  updateDupsButton();
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
  nav.innerHTML = state.agents
    .map((a) => {
      const n = state.view.filter((s) => !s.project && s.allAgentIds.includes(a.id)).length;
      return `<div class="nav-item ${state.filter === a.id ? 'active' : ''}" data-filter="${esc(a.id)}">
        <span class="nav-dot" style="background:${esc(a.color)}"></span>
        <span class="nav-name">${esc(a.name)}</span>
        <span class="nav-count">${n}</span>
      </div>`;
    })
    .join('') + `<div class="nav-item nav-add" id="nav-add-agent" title="${esc(t('添加自定义 Agent'))}">
        <span class="nav-icon">＋</span>
        <span class="nav-name">${t('添加 Agent')}</span>
      </div>`;
  $('#sidebar-foot').innerHTML = tf('{gn} 个 SKILL · {dn} 个 SKILL 目录 · {pn} 个项目', {
    gn: state.view.length,
    dn: state.agents.reduce((n, a) => n + (a.dirs || []).length, 0),
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
  el.innerHTML = state.projects
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
  $$('#project-nav .nav-item:not(.nav-add)').forEach((el2) =>
    el2.addEventListener('click', () => setFilter(el2.dataset.filter))
  );
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
  const name = dir.split(/[\\/]+/).filter(Boolean).pop() || dir;
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
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
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
function cardHTML(s) {
  const chips = (s.project ? [`<span class="chip proj-chip" title="${esc(t('项目 SKILL') + ' · ' + s.project.name)}">${esc(s.project.name)}</span>`] : [])
    .concat(
      s.allAgentIds.map((id) => {
        const a = agentById(id);
        return a ? `<span class="chip"><span class="dot" style="background:${esc(a.color)}"></span>${esc(a.name)}</span>` : '';
      })
    )
    .join('');
  const type = s.type === 'file' ? `<span class="card-type">${t('单文件')}</span>` : '';
  const linkBadge = s.dangling
    ? `<span class="card-type warn" title="${t('源 SKILL 已被删除或移动')}">⚠ ${t('失效链接')}</span>`
    : s.linked
      ? `<span class="card-type link" title="${t('链接：只存一份，源更新即时生效')}">🔗 ${t('链接')}</span>`
      : s.linkCount
        ? `<span class="card-type link" title="${tf('{n} 个 Agent 通过链接共用此唯一副本', { n: s.linkCount })}">🔗×${s.linkCount}</span>`
        : '';
  const dirName = s.type === 'file' ? s.folder + '.md' : s.folder;
  const pathText = s.dangling ? t('源已丢失') : s.linked ? '→ ' + shortPath(s.linkTarget || s.absPath) : dirName;
  const pathTip = s.linked ? (s.linkTarget || s.absPath) : s.absPath;
  return `<div class="card" data-key="${esc(s.key)}">
    <div class="card-top">
      <div class="card-name">${esc(s.name)}${type}${linkBadge}</div>
    </div>
    <div class="card-desc" title="${esc(s.description)}">${esc(s.description) || '<span style="opacity:.55">' + t('（无描述）') + '</span>'}</div>
    <div class="card-foot">
      <div style="display:flex;gap:5px;overflow:hidden">${chips}</div>
      <span class="card-path" title="${esc(pathTip)}">${esc(pathText)}</span>
      <div class="card-actions">
        <button class="btn sm act-copy" title="${t('安装到其他 Agent（复制副本或创建链接）')}">${t('安装到…')}</button>
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
    $('.act-copy', card).addEventListener('click', (e) => { e.stopPropagation(); openCopyModal(s); });
    $('.act-del', card).addEventListener('click', (e) => { e.stopPropagation(); deleteSkill(s); });
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
      const dirs = (a.dirs || [])
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

  if (!state.view.length) {
    grid.innerHTML = `<div class="empty"><div class="big">${FOLDER_BIG}</div>
      ${t('还没有扫描到任何 SKILL。<br>点击右上角「设置」检查各 Agent 的 SKILL 目录，或「新建 SKILL」「导入 SKILL」。')}</div>`;
    return;
  }
  if (!total) {
    grid.innerHTML = `<div class="empty"><div class="big">${SEARCH_BIG}</div>${
      q ? tf('没有匹配「{q}」的 SKILL', { q: esc(q) }) : t('当前筛选下暂无 SKILL')
    }</div>`;
    return;
  }

  grid.innerHTML = cfgCard + sections
    .map(
      (sec) => `
    ${sec.title ? `<div class="section-head"><h3>${esc(sec.title)}</h3>${sec.tag ? `<span class="chip proj-chip">${esc(sec.tag)}</span>` : ''}<span class="hint">${tf('{n} 个', { n: sec.items.length })}</span></div>` : ''}
    <div class="grid">${sec.items.map(cardHTML).join('')}</div>`
    )
    .join('');

  bindCards();

  const gridEl = $('#grid');
  gridEl.onclick = async (e) => {
    const rmDir = e.target.closest('.cfg-dir-rm');
    if (rmDir) {
      await saveAgentDirs(state.filter, (agentById(state.filter).dirs || []).filter((d) => d !== rmDir.dataset.dir));
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
      if (!confirm(tf('移除项目「{name}」？\n（只影响 CC Skill 的管理范围，不会删除磁盘上的任何文件）', { name: delProj.dataset.name }))) return;
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
        .slice(0, 6)
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
  const totalListed = sections.reduce((n, sec) => n + sec.items.length, 0);

  $('#main-hint').textContent = '';
  $('#grid').innerHTML = `
    <div class="stat-grid">
      ${tiles.map((tl) => `<div class="stat-tile"><div class="stat-n ${tl.warn ? 'warn' : ''}">${tl.n}</div><div class="stat-label">${tl.label}</div></div>`).join('')}
    </div>
    <div class="dash-actions">
      <button class="btn" id="dash-rescan">${t('⟳ 重新扫描')}</button>
      <button class="btn tinted" id="dash-dups">${t('合并重复')}</button>
      <button class="btn" id="dash-new">${t('＋ 新建 SKILL')}</button>
      <button class="btn" id="dash-import">${t('导入 SKILL')}</button>
    </div>
    <div class="dash-cols">
      <div class="agent-block">
        <div class="dash-sec">${t('AGENT 分布')}</div>
        ${agentRows || '<div class="hint">' + t('无') + '</div>'}
      </div>
      <div class="agent-block">
        <div class="dash-sec">${t('项目分布')}</div>
        ${projRows}
      </div>
    </div>
    <div class="agent-block">
      <div class="dash-sec">${t('最近动态')} <span class="hint">（${tf('共 {n} 条', { n: state.logs.length })}，${t('详见操作日志')}）</span></div>
      ${logRows}
    </div>
    ${dangling ? `<div class="link-hint warn">${tf('⚠ 检测到 {n} 个失效链接（源已被删除），可在列表中筛选清理。', { n: dangling })}</div>` : ''}
    ${sections
      .map(
        (sec) => `
      <div class="section-head"><h3>${esc(sec.title)}</h3>${sec.tag ? `<span class="chip proj-chip">${esc(sec.tag)}</span>` : ''}<span class="hint">${tf('{n} 个', { n: sec.items.length })}</span></div>
      <div class="grid">${sec.items.map(cardHTML).join('')}</div>`
      )
      .join('')}
  `;
  bindCards();
  $('#dash-rescan').addEventListener('click', () => { scan(); toast(t('已重新扫描')); });
  $('#dash-dups').addEventListener('click', openDupsModal);
  $('#dash-new').addEventListener('click', openNewModal);
  $('#dash-import').addEventListener('click', () => $('#btn-import').click());
}

// ------------------------------ 详情 ----------------------------------------
function openDetail(s) {
  state.detail = s;
  $('#detail-title').textContent = s.name;
  const chips = (s.project ? [`<span class="chip proj-chip">${esc(s.project.name)}</span>`] : [])
    .concat(
      s.allAgentIds.map((id) => {
        const a = agentById(id);
        return a ? `<span class="chip"><span class="dot" style="background:${esc(a.color)}"></span>${esc(a.name)}</span>` : '';
      })
    )
    .join('');
  $('#detail-meta').innerHTML = chips + `<span class="path" title="${esc(s.absPath)}">${esc(s.absPath)}</span>`;
  $('#btn-detail-copy').textContent = s.project ? t('提取到全局…') : t('复制到其他 Agent…');
  const hint = $('#detail-hint');
  if (s.dangling) {
    hint.className = 'link-hint warn';
    hint.textContent = t('⚠ 此条目是失效链接：源 SKILL 已被删除或移动，可安全清理。');
  } else if (s.linked) {
    hint.className = 'link-hint';
    hint.textContent = tf('🔗 此条目是链接，唯一副本位于 {p}，在这里编辑即修改唯一副本。', { p: shortPath(s.linkTarget || '') });
  } else if (s.linkCount) {
    hint.className = 'link-hint';
    hint.textContent = tf('🔗 此副本是唯一实体，另有 {n} 个 Agent 通过链接共用它；在这里更新，所有 Agent 即时生效。', { n: s.linkCount });
  } else {
    hint.className = 'hidden';
    hint.textContent = '';
  }
  $('#panel-preview').classList.remove('hidden');
  $('#panel-edit').classList.add('hidden');
  $('#panel-files').classList.add('hidden');
  $('#panel-links').classList.add('hidden');
  $$('.tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === 'preview'));
  $('#detail-editor').value = t('加载中…');
  $('#detail-files').innerHTML = '<li>' + t('加载中…') + '</li>';
  openModal('modal-detail');

  api.invoke('skill:read', { path: s.skillMdPath }).then((r) => {
    if (r.ok) {
      $('#detail-md').innerHTML = api.md(r.body);
      $('#detail-editor').value = r.content;
    } else {
      $('#detail-md').textContent = t('读取失败：') + (r.error || '');
    }
  });
  api.invoke('skill:files', { dir: s.type === 'folder' ? s.absPath : s.parentDir, type: s.type }).then((r) => {
    if (!r.ok || !r.files.length) {
      $('#detail-files').innerHTML = `<li style="color:var(--muted)">${s.type === 'file' ? t('单文件 SKILL（') + esc(s.folder) + '.md）' : t('空目录')}</li>`;
      return;
    }
    $('#detail-files').innerHTML = r.files
      .map((f) => `<li>${f.isDir ? FOLDER_SVG : FILE_SVG}<span>${esc(f.name)}</span><span class="fsize">${f.isDir ? t('目录') : fmtSize(f.size)}</span></li>`)
      .join('');
  });
  renderDetailLinks(s);
  $('#btn-add-link').onclick = () => openCopyModal(s, true);
}

function renderDetailLinks(s) {
  const box = $('#detail-links');
  if (s.type !== 'folder') {
    box.innerHTML = '<div class="log-empty" style="padding:26px">' + t('单文件 SKILL 暂不支持链接安装') + '</div>';
    $('#btn-add-link').disabled = true;
    return;
  }
  $('#btn-add-link').disabled = false;
  if (!s.links || !s.links.length) {
    box.innerHTML = '<div class="log-empty" style="padding:30px">' + t('还没有安装任何链接') + '<br><span class="hint">' + t('点下方「安装链接到其他 Agent」，即可让其他 Agent 共用这份唯一副本') + '</span></div>';
    return;
  }
  box.innerHTML = s.links
    .map(
      (l) => `
    <div class="link-row" data-path="${esc(l.absPath)}" data-dir="${esc(l.parentDir)}" data-name="${esc(l.name)}" data-canon-key="${esc(s.key)}">
      <span class="link-tag ${l.dangling ? 'bad' : ''}">${l.dangling ? '⚠ ' + t('失效') : t('正常')}</span>
      <span class="dup-agents">${l.agentIds
        .map((id) => {
          const a = agentById(id);
          return a ? `<span class="chip"><span class="dot" style="background:${esc(a.color)}"></span>${esc(a.name)}</span>` : '';
        })
        .join(' ')}</span>
      <span class="link-path" title="${esc(l.absPath)}">${esc(shortPath(l.absPath))}</span>
      <span class="link-actions">
        <button class="btn sm act-link-open">${t('打开')}</button>
        <button class="btn sm danger act-link-uninstall">${t('卸载')}</button>
      </span>
    </div>`
    )
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
  if (!confirm(tf('卸载链接「{name}」？\n仅移除链接，唯一副本不受影响：\n{path}', { name: row.dataset.name, path: row.dataset.path }))) return;
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

$$('.tab').forEach((el) =>
  el.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === el));
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
  api.invoke('shell:openPath', { path: state.detail.type === 'folder' ? state.detail.absPath : state.detail.parentDir });
});

$('#btn-detail-delete').addEventListener('click', () => deleteSkill(state.detail, true));
$('#btn-detail-copy').addEventListener('click', () => openCopyModal(state.detail));

async function deleteSkill(s, closeAfter = false) {
  let msg;
  if (s.dangling) {
    msg = tf('清理失效链接「{name}」？\n仅删除残留链接（源 SKILL 已不存在）：\n{path}', { name: s.name, path: s.absPath });
  } else if (s.linked) {
    msg = tf('移除链接「{name}」？\n仅移除链接，唯一副本（{p}）不受影响。', { name: s.name, p: shortPath(s.linkTarget || '') });
  } else if (s.linkCount) {
    msg = tf('确定删除 SKILL「{name}」？\n注意：{n} 个 Agent 通过链接共用此唯一副本，删除后这些链接将失效。\n{path}', { name: s.name, n: s.linkCount, path: s.absPath });
  } else {
    msg = tf('确定删除 SKILL「{name}」吗？\n将移入回收站：\n{path}', { name: s.name, path: s.absPath });
  }
  if (!confirm(msg)) return;
  const r = await api.invoke('skill:trash', { path: s.absPath });
  if (r.ok) {
    toast(r.linkRemoved ? t('已移除链接（唯一副本保留）🗑') : t('已移入回收站 🗑'), 'ok');
    if (closeAfter) closeModal('modal-detail');
    scan();
  } else toast(t('删除失败：') + (r.error || ''), 'err');
}

// --------------------------- 目标目录选择（公用） ----------------------------
function fillTargetSelect(sel, preferValue) {
  const globalOpts = [];
  for (const a of state.agents) {
    for (const d of a.dirs || []) globalOpts.push({ v: d, label: `${d} · ${a.name}` });
  }
  const projectOpts = [];
  for (const p of state.projects) {
    for (const sub of ['.claude', '.agents', '.zcode', '.codex', '.qoder']) {
      projectOpts.push({ v: `${p.dir.replace(/[\\/]+$/, '')}/${sub}/skills`, label: `${sub}/skills · ${p.name}` });
    }
  }
  const opt = (o) => `<option value="${esc(o.v)}">${esc(o.label)}</option>`;
  sel.innerHTML =
    `<optgroup label="${esc(t('全局 · Agent 目录'))}">${globalOpts.map(opt).join('')}</optgroup>` +
    (projectOpts.length ? `<optgroup label="${esc(t('项目'))}">${projectOpts.map(opt).join('')}</optgroup>` : '');
  if (preferValue && [...sel.querySelectorAll('option')].some((o) => o.value === preferValue)) {
    sel.value = preferValue;
  }
}
// --------------------------- 安装（复制 / 链接） -----------------------------
function openCopyModal(s, preferLink = false) {
  const fromProject = !!s.project;
  $('#copy-src').innerHTML =
    tf(s.type === 'folder' ? '将安装 {name}（整目录）' : '将安装 {name}（单文件）', { name: esc(s.name) }) +
    (fromProject ? ` <span class="chip proj-chip">${esc(s.project.name)}</span>` : '');
  const linkAllowed = s.type === 'folder';
  $('#copy-link-label').style.display = linkAllowed ? '' : 'none';
  if (linkAllowed && preferLink) $('#copy-mode-link').checked = true;
  else $('#copy-mode-copy').checked = true;
  const prefer = fromProject ? ((agentById(s.agentIds[0]) || {}).dirs || [])[0] : null;
  fillTargetSelect($('#copy-dir'), prefer);
  openModal('modal-copy');
  $('#btn-copy-go').onclick = () => doInstall(s, false);
}
async function doInstall(s, forceCopy) {
  let mode = forceCopy ? 'copy' : $('input[name=copy-mode]:checked').value;
  const destDir = $('#copy-dir').value;
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
        .map((c, ci) => `
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
        </div>`)
        .join('')}
      <button class="btn sm primary act-merge" data-gi="${gi}">${g.hasProject ? t('合并 / 同步（项目侧覆盖为保留副本内容）') : t('合并：其余替换为链接')}</button>
    </div>`
    )
    .join('');
  openModal('modal-dups');
  for (const [gi, g] of groups.entries()) {
    const results = await Promise.all(
      g.copies.slice(1).map((c) => api.invoke('skill:compare', { pathA: g.copies[0].absPath, pathB: c.absPath }))
    );
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
    ? tf('以 {p} 中的副本为准：\n· 其余全局目录中的副本 → 移入回收站并替换为链接\n· 项目目录中的副本 → 用保留副本的内容覆盖同步（Git 仓库不建链接）', { p: shortPath(keep.parentDir) }) + warn
    : tf('保留 {p} 中的副本作为唯一实体，\n其余 {n} 份移入回收站并替换为链接。', { p: shortPath(keep.parentDir), n: others.length }) + warn;
  if (!confirm(tf('合并「{name}」：\n{action}\n\n继续？', { name: g.folder, action }))) return;
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
  fillTargetSelect($('#new-dir'));
  openModal('modal-new');
  setTimeout(() => $('#new-name').focus(), 50);
}

$('#btn-new-go').addEventListener('click', async () => {
  const name = $('#new-name').value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(name)) {
    toast(t('SKILL 名称只能包含英文、数字、- 和 _，且不超过 64 字符'), 'err');
    return;
  }
  const destDir = $('#new-dir').value;
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
  const destDir = $('#import-target').value;
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
function fillWebdavInputs(w) {
  w = w || {};
  $('#wd-url').value = w.url || '';
  $('#wd-user').value = w.username || '';
  $('#wd-pass').value = w.password || '';
  $('#wd-path').value = w.remotePath || 'cc-skill-sync';
  $('#wd-auto').checked = !!w.autoBackup;
  $('#wd-freq').value = w.autoBackupFreq || 'startup';
  $('#wd-status').textContent = t('备份内容 = 全局 + 项目内所有实体 SKILL（链接不会上传）；密码保存在本机配置文件中，请注意磁盘安全。');
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
  if (!confirm(t('将所有实体 SKILL（全局 + 项目）打包备份到 WebDAV？\n（链接本身不上传，恢复时会按记录重建）'))) return;
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
$('#btn-wd-restore').addEventListener('click', async () => {
  if (!(await wdSave())) return;
  $('#wd-status').textContent = t('正在下载并恢复…');
  const r = await api.invoke('sync:restorePreview', {});
  if (!r.ok) {
    $('#wd-status').textContent = '✗ ' + r.error;
    return toast(r.error, 'err');
  }
  state.restoreToken = r.tmpToken;
  $('#rv-host').textContent = r.hostname;
  $('#rv-time').textContent = (r.uploadedAt || '').replace('T', ' ').slice(0, 19).replace(/-/g, '/');
  $('#rv-remote').textContent = r.remote;
  $('#rv-content').textContent = tf('{n} 个 SKILL + config.json', { n: r.entries });
  openModal('modal-restore');
});

$('#btn-restore-confirm').addEventListener('click', async () => {
  const btn = $('#btn-restore-confirm');
  btn.disabled = true;
  try {
    const r = await api.invoke('sync:restoreApply', { tmpToken: state.restoreToken });
    if (!r.ok) return toast(r.error, 'err');
    toast(tf('已从云端恢复 {n} 个 SKILL ✓', { n: r.restored }), 'ok');
    if (r.appliedConfig) toast(t('配置也已恢复 ✓'), 'ok');
    closeModal('modal-restore');
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
function openSettings() {
  fillWebdavInputs(state.webdav);
  $('#set-lang').value = (state.ui && state.ui.lang) || 'auto';
  openModal('modal-settings');
}

$('#btn-save-settings').addEventListener('click', async () => {
  if (!(await wdSave())) return;
  const r = await api.invoke('config:set', { ui: { lang: $('#set-lang').value } });
  if (r.ok) {
    toast(t('设置已保存 ✓'), 'ok');
    closeModal('modal-settings');
    state.filter = 'dashboard';
    $('#main-title').textContent = t('总览');
    scan();
  } else toast(t('保存失败'), 'err');
});

$('#btn-reset-agents').addEventListener('click', async () => {
  if (!confirm(t('恢复为默认的 Agent、目录与项目配置？（项目列表会被清空）'))) return;
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
$('#btn-rescan').addEventListener('click', () => { scan(); toast(t('已重新扫描')); });
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

$('#btn-import').addEventListener('click', () => {
  state.importSrc = null;
  $('#import-preview').classList.add('hidden');
  $('#import-form').classList.add('hidden');
  $('#btn-import-go').disabled = true;
  fillTargetSelect($('#import-target'));
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
  if (e.key === 'Escape') $$('.modal-overlay').forEach((ov) => ov.classList.add('hidden'));
});

// ------------------------------ 启动 -----------------------------------------
(async () => {
  i18n.apply(document);
  const p = await api.invoke('app:paths');
  state.HOME = p.home || '';
  state.logFile = p.logFile || '';
  state.ui = p.ui || { lang: 'auto' };
  i18n.setLang(state.ui.lang || 'auto');
  i18n.apply(document);
  await scan();
})();
