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
const PALETTE = ['#e07a4f', '#19b39a', '#f0a35c', '#4f8ef7', '#8b5cf6', '#e2556e', '#38bdf8', '#a3e635'];

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
  editingAgents: null,
  editingProjects: null,
  logs: [],
  unreadErrors: 0,
};

const PROJECT_SUBS = ['.claude', '.agents', '.zcode', '.codex', '.qoder'];

const expand = (p) => (p && p.startsWith('~') ? state.HOME + p.slice(1) : p);
const toTilde = (p) => {
  if (!state.HOME || !p || !p.toLowerCase().startsWith(state.HOME.toLowerCase())) return p;
  const rest = p.slice(state.HOME.length).split(String.fromCharCode(92)).filter(Boolean).join('/');
  return '~/' + rest.split('/').filter(Boolean).join('/');
};
const shortPath = (p) => (state.HOME && p && p.startsWith(state.HOME) ? '~' + p.slice(state.HOME.length) : p);
const agentById = (id) => state.agents.find((a) => a.id === id);
const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

// ------------------------------ 日志 / Toast ---------------------------------
// 所有提示都会进入内存日志（新→旧，最多 500 条），并同步一份到磁盘 cc-skill.log
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
  // 错误提示停留 10 秒，普通提示 2.8 秒
  setTimeout(() => el.remove(), type === 'err' ? 10000 : 2800);
}

function renderLogs() {
  const list = $('#log-list');
  if (!state.logs.length) {
    list.innerHTML = '<li class="log-empty">' + t('暂无日志') + '</li>';
    return;
  }
  const tag = (t) => (t === 'err' ? t('错误') : t === 'ok' ? t('成功') : t('信息'));
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

// 捕获程序异常，避免出错却无提示
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
  renderSidebar();
  renderGrid();
  updateDupsButton();
}

// 把链接条目归并到唯一副本上：网格里每个 SKILL 只显示一张卡，
// 链接信息挂在 canon.links，allAgentIds = 直接关联 + 通过链接可用的 Agent
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
      // Agent 侧栏只统计全局 SKILL；项目 SKILL 归项目侧栏
      const n = state.view.filter((s) => !s.project && s.allAgentIds.includes(a.id)).length;
      return `<div class="nav-item ${state.filter === a.id ? 'active' : ''}" data-filter="${esc(a.id)}">
        <span class="nav-dot" style="background:${esc(a.color)}"></span>
        <span class="nav-name">${esc(a.name)}</span>
        <span class="nav-count">${n}</span>
      </div>`;
    })
    .join('');
  $('#sidebar-foot').innerHTML = tf('{gn} 个 SKILL · {dn} 个 SKILL 目录 · {pn} 个项目', { gn: state.view.length, dn: state.agents.reduce((n, a) => n + (a.dirs || []).length, 0), pn: state.projects.length });
  $$('#agent-nav .nav-item').forEach((el) =>
    el.addEventListener('click', () => setFilter(el.dataset.filter))
  );
  renderProjectNav();
}

function renderProjectNav() {
  const section = $('#project-section');
  const el = $('#project-nav');
  if (!state.projects.length) {
    section.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  section.style.display = '';
  const items = state.projects
    .map((p) => {
      const n = state.view.filter((s) => s.project && s.project.id === p.id).length;
      const key = 'project:' + p.id;
      return `<div class="nav-item ${state.filter === key ? 'active' : ''}" data-filter="${esc(key)}" title="${esc(p.dir)}">
        <span class="nav-icon">${FOLDER_SVG}</span>
        <span class="nav-name">${esc(p.name)}</span>
        <span class="nav-count">${n}</span>
      </div>`;
    })
    .join('');
  // 常驻「添加项目」入口：无需进设置即可登记新项目
  el.innerHTML =
    items +
    `<div class="nav-item nav-add" id="nav-add-project" title="选择一个项目目录，扫描其中的 SKILL">
      <span class="nav-icon">＋</span>
      <span class="nav-name">${t('添加项目')}</span>
    </div>`;
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
  toast(`已添加项目「${name}」 ✓`, 'ok');
  await scan();
  setFilter('project:' + added.id);
}

function setFilter(f) {
  state.filter = f;
  $$('#sidebar .nav-item').forEach((el) => el.classList.toggle('active', el.dataset.filter === f));
  $$('#agent-nav .nav-item').forEach((el) => el.classList.toggle('active', el.dataset.filter === f));
  $$('#project-nav .nav-item').forEach((el) => el.classList.toggle('active', el.dataset.filter === f));
  if (f === 'dashboard') {
    $('#main-title').textContent = t('总览');
    renderGrid();
    return;
  }
  if (String(f).startsWith('project:')) {
    const proj = state.projects.find((p) => p.id === f.slice(8));
    $('#main-title').textContent = proj ? tf('{name} · SKILL', { name: proj.name }) : t('项目 SKILL');
  } else {
    const a = agentById(f);
    $('#main-title').textContent = a ? tf('{name} 的 SKILL', { name: a.name }) : t('全部 SKILL');
  }
  renderGrid();
}

function cardHTML(s) {
  const chips = (s.project
    ? [`<span class="chip proj-chip" title="项目 SKILL · ${esc(s.project.name)}">${esc(s.project.name)}</span>`]
    : []
  )
    .concat(
      s.allAgentIds.map((id) => {
        const a = agentById(id);
        return a ? `<span class="chip"><span class="dot" style="background:${esc(a.color)}"></span>${esc(a.name)}</span>` : '';
      })
    )
    .join('');
  const type = s.type === 'file' ? '<span class="card-type">' + t('单文件') + '</span>' : '';
  const linkBadge = s.dangling
    ? '<span class="card-type warn" title="' + t('源 SKILL 已被删除或移动') + '">' + t('⚠ 失效链接') + '</span>'
    : s.linked
      ? '<span class="card-type link" title="' + t('链接：只存一份，源更新即时生效') + '">' + t('🔗 链接') + '</span>'
      : s.linkCount
        ? `<span class="card-type link" title="${s.linkCount} 个 Agent 通过链接共用此唯一副本">🔗×${s.linkCount}</span>`
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
        <button class="btn sm act-copy" title="安装到其他 Agent（复制副本或创建链接）">安装到…</button>
        <button class="btn sm danger act-del" title="删除（移入回收站）">删除</button>
      </div>
    </div>
  </div>`;
}

// ------------------------------ 总览仪表盘 ------------------------------------
function renderDashboard() {
  const global = state.view.filter((s) => !s.project);
  const projSkills = state.view.filter((s) => s.project);
  const links = state.skills.filter((s) => s.linked && !s.dangling).length;
  const dangling = state.skills.filter((s) => s.dangling).length;
  const dupGroups = buildDupGroups().length;
  const files = state.skills.reduce((n, s) => n + (s.fileCount || 0), 0);

  const tiles = [
    { n: global.length, label: t('全局 SKILL') },
    { n: projSkills.length, label: t('项目 SKILL') },
    { n: state.agents.length, label: 'Agent' },
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
        <span class="dash-sub">${miss ? `<span class="dash-warn">⚠ ${tf('{n} 个目录缺失', { n: miss })}</span>` : tf('{n} 个目录', { n: a.dirs.length })}</span>
        <span class="dash-n">${n}</span>
      </div>`;
    })
    .join('');
  const projRows = state.projects.length
    ? state.projects
        .map((p) => {
          const n = projSkills.filter((s) => s.project.id === p.id).length;
          return `<div class="dash-row">
            <span class="nav-icon" style="color:var(--text-3)">${FOLDER_SVG}</span>
            <span class="dash-name">${esc(p.name)}</span>
            <span class="dash-sub" title="${esc(p.dir)}">${esc(shortPath(p.dir))}</span>
            <span class="dash-n">${n}</span>
          </div>`;
        })
        .join('')
    : '<div class="hint" style="padding:8px 2px">' + t('还没有添加项目，可在「设置 → 项目」中添加。') + '</div>';
  const logRows = state.logs.length
    ? state.logs
        .slice(0, 6)
        .map(
          (e) => `<div class="dash-row">
            <span class="log-time">${e.time.toLocaleTimeString('zh-CN', { hour12: false })}</span>
            <span class="log-type ${e.type === 'err' ? 'err' : e.type === 'ok' ? 'ok' : ''}">${e.type === 'err' ? t('错误') : e.type === 'ok' ? t('成功') : t('信息')}</span>
            <span class="dash-sub" style="flex:1;white-space:normal">${esc(e.msg)}</span>
          </div>`
        )
        .join('')
    : '<div class="hint" style="padding:8px 2px">' + t('暂无操作记录；安装 / 合并 / 删除的结果都会记录在「操作日志」中。') + '</div>';

  const q = state.search.trim().toLowerCase();
  const match = (s) => !q || (s.name + ' ' + (s.description || '') + ' ' + s.folder).toLowerCase().includes(q);
  const sections = [{ title: t('全局 SKILL'), tag: '', items: state.view.filter((s) => !s.project && match(s)) }]
    .concat(
      state.projects.map((p) => ({
        title: p.name,
        tag: t('项目'),
        dir: p.dir,
        items: state.view.filter((s) => s.project && s.project.id === p.id && match(s)),
      }))
    )
    .filter((sec) => sec.items.length);
  const totalListed = sections.reduce((n, sec) => n + sec.items.length, 0);
  $('#main-hint').textContent = tf('共 {n} 个 SKILL', { n: totalListed });
  $('#grid').innerHTML = `
    <div class="stat-grid">
      ${tiles.map((t) => `<div class="stat-tile"><div class="stat-n ${t.warn ? 'warn' : ''}">${t.n}</div><div class="stat-label">${t.label}</div></div>`).join('')}
    </div>
    <div class="dash-actions">
id="dash-rescan">${t('⟳ 重新扫描')}</button>
id="dash-dups">${t('合并重复')}</button>
id="dash-new">${t('＋ 新建 SKILL')}</button>
id="dash-import">${t('导入 SKILL')}</button>
    </div>
    <div class="dash-cols">
      <div class="agent-block">
        <div class="dash-sec">${t('AGENT 分布')}</div>
        ${agentRows || t('<div class="hint">无</div>')}
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
    ${q && !totalListed
      ? `<div class="empty"><div class="big">${SEARCH_BIG}</div>没有匹配「${esc(q)}」的 SKILL</div>`
      : sections
          .map(
            (sec) => `
      <div class="section-head"><h3>${esc(sec.title)}</h3>${sec.tag ? `<span class="chip proj-chip">${esc(sec.tag)}</span>` : ''}${sec.dir ? `<span class="sec-path" title="${esc(sec.dir)}">${esc(shortPath(sec.dir))}</span>` : ''}<span class="hint">${tf('{n} 个', { n: sec.items.length })}</span></div>
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

function renderGrid() {
  // 侧栏「总览」：统计磁贴 + 分布 + 最近动态
  if (state.filter === 'dashboard') return renderDashboard();

  const q = state.search.trim().toLowerCase();
  const match = (s) =>
    !q || (s.name + ' ' + (s.description || '') + ' ' + s.folder).toLowerCase().includes(q);

  // 「全部」视图按 全局 / 各项目 分区展示；其他过滤条件为单一大区
  let sections;
  if (state.filter === 'all') {
    sections = [{ title: t('全局'), tag: '', items: state.view.filter((s) => !s.project && match(s)) }]
      .concat(
        state.projects.map((p) => ({
          title: p.name,
          tag: t('项目'),
          items: state.view.filter((s) => s.project && s.project.id === p.id && match(s)),
        }))
      )
      .filter((sec) => sec.items.length);
  } else {
    const items = state.view.filter((s) => {
      if (String(state.filter).startsWith('project:')) {
        return s.project && s.project.id === state.filter.slice(8) && match(s);
      }
      // Agent 过滤只看全局 SKILL
      return !s.project && s.allAgentIds.includes(state.filter) && match(s);
    });
    sections = [{ title: '', tag: '', items }];
  }

  const grid = $('#grid');
  const total = sections.reduce((n, sec) => n + sec.items.length, 0);
  $('#main-hint').textContent = `共 ${total} 个 SKILL`;

  if (!state.view.length) {
    grid.innerHTML = `<div class="empty"><div class="big">${FOLDER_BIG}</div>
      t('还没有扫描到任何 SKILL。<br>点击右上角「设置」检查各 Agent 的 SKILL 目录，或「新建 SKILL」「导入 SKILL」。')</div>`;
    return;
  }
  if (!total) {
    grid.innerHTML = `<div class="empty"><div class="big">${SEARCH_BIG}</div>${
      q ? `没有匹配「${esc(q)}」的 SKILL` : t('当前筛选下暂无 SKILL')
    }</div>`;
    return;
  }

  grid.innerHTML = sections
    .map(
      (sec) => `
    ${sec.title ? `<div class="section-head"><h3>${esc(sec.title)}</h3>${sec.tag ? `<span class="chip proj-chip">${esc(sec.tag)}</span>` : ''}<span class="hint">${tf('{n} 个', { n: sec.items.length })}</span></div>` : ''}
    <div class="grid">${sec.items.map(cardHTML).join('')}</div>`
    )
    .join('');

  bindCards();
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
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'preview'));
  $('#detail-editor').value = t('加载中…');
  $('#detail-files').innerHTML = t('<li>加载中…</li>');
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

// 渲染「链接」页：唯一副本被哪些 Agent 通过链接共用，支持打开/卸载/新增
function renderDetailLinks(s) {
  const box = $('#detail-links');
  if (s.type !== 'folder') {
    box.innerHTML = t('<div class="log-empty" style="padding:26px">单文件 SKILL 暂不支持链接安装</div>');
    $('#btn-add-link').disabled = true;
    return;
  }
  $('#btn-add-link').disabled = false;
  if (!s.links || !s.links.length) {
    box.innerHTML = `<div class="log-empty" style="padding:30px">还没有安装任何链接<br>
      <span class="hint">点下方「安装链接到其他 Agent」，即可让其他 Agent 共用这份唯一副本</span></div>`;
    return;
  }
  box.innerHTML = s.links
    .map((l) => `
    <div class="link-row" data-path="${esc(l.absPath)}" data-dir="${esc(l.parentDir)}" data-name="${esc(l.name)}" data-canon-key="${esc(s.key)}">
      <span class="link-tag ${l.dangling ? 'bad' : ''}">${l.dangling ? t('⚠ 失效') : t('正常')}</span>
      <span class="dup-agents">${l.agentIds
        .map((id) => {
          const a = agentById(id);
          return a ? `<span class="chip"><span class="dot" style="background:${esc(a.color)}"></span>${esc(a.name)}</span>` : '';
        })
        .join(' ')}</span>
      <span class="link-path" title="${esc(l.absPath)}">${esc(shortPath(l.absPath))}</span>
      <span class="link-actions">
        <button class="btn sm act-link-open">打开</button>
        <button class="btn sm danger act-link-uninstall">卸载</button>
      </span>
    </div>`)
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
  if (!confirm(`卸载链接「${row.dataset.name}」？\n仅移除链接，唯一副本不受影响：\n${row.dataset.path}`)) return;
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

$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    ['preview', 'edit', 'files', 'links'].forEach((p) => $('#panel-' + p).classList.add('hidden'));
    $('#panel-' + t.dataset.tab).classList.remove('hidden');
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
    msg = `清理失效链接「${s.name}」？\n仅删除残留链接（源 SKILL 已不存在）：\n${s.absPath}`;
  } else if (s.linked) {
    msg = `移除链接「${s.name}」？\n仅移除链接，唯一副本（${shortPath(s.linkTarget || '')}）不受影响。`;
  } else if (s.linkCount) {
    msg = `确定删除 SKILL「${s.name}」？\n注意：${s.linkCount} 个 Agent 通过链接共用此唯一副本，删除后这些链接将失效。\n${s.absPath}`;
  } else {
    msg = `确定删除 SKILL「${s.name}」吗？\n将移入回收站：\n${s.absPath}`;
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
// 一个分组下拉同时覆盖两种方向：安装到全局（提取到全局 / 全局互装）与安装到项目（项目化）
function fillTargetSelect(sel, preferValue) {
  const globalOpts = [];
  for (const a of state.agents) {
    for (const d of a.dirs || []) globalOpts.push({ v: d, label: `${d} · ${a.name}` });
  }
  const projectOpts = [];
  for (const p of state.projects) {
    for (const sub of PROJECT_SUBS) {
      projectOpts.push({ v: `${p.dir.replace(/[\\/]+$/, '')}/${sub}/skills`, label: `${sub}/skills · ${p.name}` });
    }
  }
  const opt = (o) => `<option value="${esc(o.v)}">${esc(o.label)}</option>`;
  sel.innerHTML =
    `<optgroup label="全局 · Agent 目录">${globalOpts.map(opt).join('')}</optgroup>` +
    (projectOpts.length ? `<optgroup label="项目">${projectOpts.map(opt).join('')}</optgroup>` : '');
  if (preferValue && [...sel.querySelectorAll('option')].some((o) => o.value === preferValue)) {
    sel.value = preferValue;
  }
}
const isProjectTarget = (v) => { const norm = String(v || '').replace(/[\\/]+/g, '/').toLowerCase(); return state.projects.some((p) => norm.startsWith(String(p.dir).replace(/[\\/]+/g, '/').toLowerCase())); };

// --------------------------- 复制到其他 Agent --------------------------------
function openCopyModal(s, preferLink = false) {
  const fromProject = !!s.project;
  $('#copy-src').innerHTML =
    `将安装 <b>${esc(s.name)}</b>（${s.type === 'folder' ? t('整目录') : t('单文件')}）` +
    (fromProject ? ` <span class="chip proj-chip">${esc(s.project.name)}</span>` : '');
  const linkAllowed = s.type === 'folder';
  $('#copy-link-label').style.display = linkAllowed ? '' : 'none';
  if (linkAllowed && preferLink) $('#copy-mode-link').checked = true;
  else $('#copy-mode-copy').checked = true;
  // 项目 SKILL 默认提取到「同一 Agent 的全局目录」
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
    toast(`已创建 ${name} ✓`, 'ok');
    closeModal('modal-new');
    await scan();
    const created = state.view.find((s) => s.key === r.dest);
    if (created) {
      if (isProjectTarget(destDir)) setFilter('project:' + created.project.id);
      openDetail(created);
    }
  } else if (r.reason === 'exists') {
    toast(t('目标目录已存在同名 SKILL'), 'err');
  } else {
    toast(t('创建失败：') + (r.error || ''), 'err');
  }
});

// ------------------------------ 导入技能 ------------------------------------
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
    <div class="ip-desc">${esc(r.description) || t('（无描述）')}</div>
    <div class="ip-path">${esc(r.skillRoot)} · ${r.fileCount} 个文件</div>`;
  $('#import-form').classList.remove('hidden');
  $('#btn-import-go').disabled = false;
}

$('#btn-pick-folder').addEventListener('click', async () => {
  const p = await api.invoke('dialog:pickFolder');
  if (p) inspectImport(p);
});
$('#btn-pick-zip').addEventListener('click', async () => {
  const p = await api.invoke('dialog:pickZip');
  if (p) inspectImport(p);
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

// ------------------------------ 设置 -----------------------------------------
const slugify = (s) =>
  (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent');

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

function openSettings() {
  state.editingAgents = JSON.parse(JSON.stringify(state.agents));
  state.editingProjects = JSON.parse(JSON.stringify(state.projects));
  fillWebdavInputs(state.webdav);
  $('#wd-status').textContent = t('备份内容 = 全局 + 项目内所有实体 SKILL（链接不会上传）；密码保存在本机配置文件中，请注意磁盘安全。');
  renderSettings();
  renderSettingsProjects();
  openModal('modal-settings');
}

// --------------------------- 设置 · WebDAV 云同步 ----------------------------
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
    const detail = r.created
      ? t('，远程目录不存在，已自动创建')
      : r.needsManual
        ? t('；但该服务不支持通过 WebDAV 建目录——请到网盘网页端手动创建该文件夹（一次性），完成后即可备份')
        : t('，远程目录已存在');
    $('#wd-status').textContent = t('✓ 连接成功') + detail;
    toast(t('WebDAV 连接成功 ✓'), 'ok');
  } else {
    $('#wd-status').textContent = t('✗ 连接失败：') + r.error;
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
    $('#wd-status').textContent = `✓ 已上传 ${r.name}（${r.count} 个 SKILL / ${kb}）`;
    toast(`已备份 ${r.count} 个 SKILL 到云端 ✓`, 'ok');
  } else {
    $('#wd-status').textContent = t('✗ 备份失败：') + r.error;
    toast(t('备份失败：') + r.error, 'err');
  }
});
$('#btn-wd-restore').addEventListener('click', async () => {
  if (!(await wdSave())) return;
  if (!confirm(t('从云端恢复最近一次备份？\n注意：与备份同名的本地 SKILL 将被云端版本覆盖！'))) return;
  $('#wd-status').textContent = t('正在下载并恢复…');
  const r = await api.invoke('sync:restore');
  if (r.ok) {
    $('#wd-status').textContent = `✓ 已恢复 ${r.name}（${r.restored} 个 SKILL → ${r.dests.length} 个目录）`;
    toast(`已从云端恢复 ${r.restored} 个 SKILL ✓`, 'ok');
    if (r.settings && confirm(t('备份中包含设置（Agents / 项目 / WebDAV）。是否一并恢复？'))) {
      const c = r.settings;
      const r1 = await api.invoke('config:set', { agents: c.agents || [], projects: c.projects || [] });
      if (c.webdav) await api.invoke('sync:setConfig', { webdav: c.webdav });
      if (r1.ok) {
        toast(t('设置也已恢复 ✓'), 'ok');
        state.editingAgents = JSON.parse(JSON.stringify(c.agents || []));
        state.editingProjects = JSON.parse(JSON.stringify(c.projects || []));
        renderSettings(); renderSettingsProjects(); fillWebdavInputs(state.webdav);
      }
    }
    scan();
  } else {
    $('#wd-status').textContent = t('✗ 恢复失败：') + r.error;
    toast(t('恢复失败：') + r.error, 'err');
  }
});

function renderSettings() {
  $('#settings-agents').innerHTML = state.editingAgents
    .map((a, i) => {
      const dirs = (a.dirs || [])
        .map((d, j) => {
          const missing = state.missing.some((m) => m.dir === expand(d));
          return `<span class="dir-chip ${missing ? 'warn' : ''}" title="${esc(expand(d))}${missing ? t('（目录不存在，安装时将自动创建）') : ''}">
            ${missing ? '<span class="warn-ico">⚠</span>' : ''}${esc(d)}<span class="rm" data-i="${i}" data-j="${j}">×</span></span>`;
        })
        .join('') || t('<span class="hint">暂无目录</span>');
      return `<div class="agent-block" data-i="${i}">
        <div class="agent-block-head">
          <span class="dot" style="background:${esc(a.color)}"></span>
          <input class="input agent-name-input" style="width:170px;height:28px" data-i="${i}" value="${esc(a.name)}" />
          <span class="agent-id">#${esc(a.id)}</span>
          <span class="spacer"></span>
          <button class="btn sm danger act-del-agent" data-i="${i}">${t('移除')}</button>
        </div>
        <div class="dir-chips">${dirs}</div>
        <div class="agent-add-dir"><button class="btn sm act-add-dir" data-i="${i}">${t('＋ 添加 SKILL 目录')}</button></div>
      </div>`;
    })
    .join('');
}

$('#settings-agents').addEventListener('input', (e) => {
  const inp = e.target.closest('.agent-name-input');
  if (inp) state.editingAgents[+inp.dataset.i].name = inp.value;
});
$('#settings-agents').addEventListener('click', async (e) => {
  const rm = e.target.closest('.dir-chip .rm');
  if (rm) {
    state.editingAgents[+rm.dataset.i].dirs.splice(+rm.dataset.j, 1);
    renderSettings();
    return;
  }
  const add = e.target.closest('.act-add-dir');
  if (add) {
    const p = await api.invoke('dialog:pickFolder');
    if (p) {
      state.editingAgents[+add.dataset.i].dirs.push(p);
      renderSettings();
    }
    return;
  }
  const del = e.target.closest('.act-del-agent');
  if (del) {
    const a = state.editingAgents[+del.dataset.i];
    if (confirm(`移除 Agent「${a.name}」？\n（只影响 CC Skill 的管理范围，不会删除磁盘上的 SKILL 文件）`)) {
      state.editingAgents.splice(+del.dataset.i, 1);
      renderSettings();
    }
  }
});

$('#btn-add-agent').addEventListener('click', () => {
  state.editingAgents.push({
    id: 'agent-' + Date.now(),
    name: t('新 Agent'),
    color: PALETTE[state.editingAgents.length % PALETTE.length],
    dirs: [],
  });
  renderSettings();
});

// --------------------------- 设置 · 项目管理 ---------------------------------
function renderSettingsProjects() {
  const el = $('#settings-projects');
  el.innerHTML = (state.editingProjects || [])
    .map(
      (p, i) => `
    <div class="agent-block" data-pi="${i}">
      <div class="agent-block-head">
        <span class="nav-icon" style="color:var(--text-2)">${FOLDER_SVG}</span>
        <input class="input proj-name-input" style="width:210px;height:28px" data-i="${i}" value="${esc(p.name)}" />
        <span class="agent-id" title="${esc(p.dir)}">${esc(shortPath(p.dir))}</span>
        <span class="spacer"></span>
        <button class="btn sm danger act-del-project" data-i="${i}">${t('移除')}</button>
      </div>
      <div class="hint" style="padding:0 2px">扫描其中的 .claude / .agents / .zcode / .codex / .qoder 下的 skills 目录</div>
    </div>`
    )
    .join('') ||
    t('<div class="hint" style="margin-top:6px">还没有添加项目：点击左侧栏「项目 SKILL」下方的「＋ 添加项目」即可登记，或在此处添加。</div>');
}

$('#btn-add-project').addEventListener('click', async () => {
  const dir = toTilde(await api.invoke('dialog:pickFolder'));
  if (!dir) return;
  if (state.editingProjects.some((p) => p.dir.toLowerCase() === dir.toLowerCase())) {
    toast(t('该项目已在列表中'), 'err');
    return;
  }
  const name = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
  state.editingProjects.push({ id: 'proj-' + Date.now(), name, dir });
  renderSettingsProjects();
});

$('#settings-projects').addEventListener('input', (e) => {
  const inp = e.target.closest('.proj-name-input');
  if (inp) state.editingProjects[+inp.dataset.i].name = inp.value;
});
$('#settings-projects').addEventListener('click', (e) => {
  const del = e.target.closest('.act-del-project');
  if (!del) return;
  const p = state.editingProjects[+del.dataset.i];
  if (confirm(`移除项目「${p.name}」？\n（只影响 CC Skill 的管理范围，不会删除磁盘上的任何文件）`)) {
    state.editingProjects.splice(+del.dataset.i, 1);
    renderSettingsProjects();
  }
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

$('#btn-save-settings').addEventListener('click', async () => {
  const used = new Set();
  const agents = state.editingAgents.map((a) => {
    let id = a.id.startsWith('agent-') ? slugify(a.name) : a.id;
    while (used.has(id)) id += '-2';
    used.add(id);
    return { id, name: a.name.trim() || id, color: a.color, dirs: (a.dirs || []).map((d) => d.trim()).filter(Boolean) };
  });
  const projects = state.editingProjects
    .map((p) => ({ id: p.id, name: (p.name || '').trim() || t('项目'), dir: p.dir }))
    .filter((p) => p.dir);
  const r = await api.invoke('config:set', { agents, projects });
  if (r.ok) {
    toast(t('设置已保存 ✓'), 'ok');
    closeModal('modal-settings');
    state.filter = 'dashboard';
    $('#main-title').textContent = t('总览');
    scan();
  } else toast(t('保存失败'), 'err');
});

// ------------------------------ 合并重复 -------------------------------------
// 找出「同名 SKILL 在多个目录各有一份实体副本」的分组（链接条目与项目 SKILL 不参与：
// 项目通常是 Git 仓库，用链接替换有误提交风险）
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
    list.innerHTML = `<div class="empty" style="padding:34px"><div class="big">${CHECK_BIG}</div>没有发现重复的 SKILL，很好 ✨</div>`;
    openModal('modal-dups');
    return;
  }
  list.innerHTML = groups
    .map((g, gi) => `
    <div class="dup-group" data-gi="${gi}">
      <div class="dup-head"><b>${esc(g.folder)}</b><span class="dup-tag" id="dup-tag-${gi}">比对中…</span></div>
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
          <span class="dup-files">${c.fileCount} 个文件</span>
        </div>`)
        .join('')}
      <button class="btn sm primary act-merge" data-gi="${gi}">${g.hasProject ? t('合并 / 同步（项目侧覆盖为保留副本内容）') : t('合并：其余替换为链接')}</button>
    </div>`)
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
  const others = g.copies.filter((c, i) => i !== keepIdx);
  const hasProject = others.some((c) => isProjectTarget(c.parentDir));
  const warn = g.same === false ? t('\n\n注意：各副本内容不同，未选中的全局副本将进入回收站（可找回）。') : '';
  const action = hasProject
    ? `以 ${shortPath(keep.parentDir)} 中的副本为准：\n· 其余全局目录中的副本 → 移入回收站并替换为链接\n· 项目目录中的副本 → 用保留副本的内容覆盖同步（Git 仓库不建链接）${warn}`
    : `保留 ${shortPath(keep.parentDir)} 中的副本作为唯一实体，\n其余 ${others.length} 份移入回收站并替换为链接。${warn}`;
  if (!confirm(`合并「${g.folder}」：\n${action}\n\n继续？`)) return;
  await finishMerge(g, keepIdx, others.length);
});

// 执行合并：全局目录侧替换为链接；项目目录侧（Git 仓库）以保留副本覆盖同步
async function performMerge(g, keepIdx) {
  const keep = g.copies[keepIdx];
  const others = g.copies.filter((c, i) => i !== keepIdx);
  let linked = 0;
  let synced = 0;
  let failed = 0;
  for (const c of others) {
    const toProject = isProjectTarget(c.parentDir);
    if (toProject) {
      // 项目副本：覆盖同步（内容以保留副本为准，不建链接）
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
        toast(`同步项目副本失败（${shortPath(c.parentDir)}）：${cp.error || cp.reason || ''}`, 'err');
      }
      continue;
    }
    const t = await api.invoke('skill:trash', { path: c.absPath });
    if (!t.ok) {
      failed++;
      toast(`移除旧副本失败：${shortPath(c.absPath)}${t.error ? '（' + t.error + '）' : ''}`, 'err');
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
    // 回收站操作可能短暂锁定目录导致建链失败：先重试一次
    let l = await api.invoke('skill:copy', linkArgs);
    if (!l.ok) {
      await new Promise((r) => setTimeout(r, 450));
      l = await api.invoke('skill:copy', linkArgs);
    }
    if (l.ok) {
      linked++;
    } else {
      // 兜底：宁可变回副本，也绝不让这个 Agent 目录里缺了这份 SKILL
      toast(`创建链接失败（${l.error || l.reason || ''}），已改为复制副本`);
      const cp = await api.invoke('skill:copy', { ...linkArgs, mode: 'copy' });
      if (cp.ok) linked++;
      else {
        failed++;
        toast(`复制副本也失败：${cp.error || cp.reason || ''}`, 'err');
      }
    }
  }
  return { linked, synced, failed, total: others.length };
}

async function finishMerge(g, keepIdx, othersCount) {
  const r = await performMerge(g, keepIdx);
  if (r.failed === 0) {
    const parts = [t('1 份唯一副本')];
    if (r.linked) parts.push(r.linked + t(' 个链接'));
    if (r.synced) parts.push(r.synced + t(' 个项目同步'));
    toast(`已合并「${g.folder}」：${parts.join(' + ')} ✓`, 'ok');
  } else {
    toast(`「${g.folder}」合并未完成：${r.total - r.failed}/${r.total} 个副本处理成功，详见操作日志`, 'err');
  }
  closeModal('modal-dups');
  scan();
}

// --------------------------- 配置导入 / 导出 ---------------------------------
async function applyImportedConfig(payload) {
  const c = (payload && payload.config) || {};
  const r1 = await api.invoke('config:set', { agents: c.agents || [], projects: c.projects || [] });
  let r2 = { ok: true };
  if (c.webdav) r2 = await api.invoke('sync:setConfig', { webdav: c.webdav });
  if (!r1.ok || !r2.ok) return false;
  state.filter = 'dashboard';
  $('#main-title').textContent = t('总览');
  await scan();
  state.editingAgents = JSON.parse(JSON.stringify(state.agents));
  state.editingProjects = JSON.parse(JSON.stringify(state.projects));
  renderSettings(); renderSettingsProjects(); fillWebdavInputs(state.webdav);
  return true;
}

$('#btn-cfg-export').addEventListener('click', async () => {
  if (!confirm(t('导出的文件将包含 Agents、项目与 WebDAV 配置（含密码明文），请妥善保管。继续导出？'))) return;
  const r = await api.invoke('config:exportFile', { includePassword: true });
  if (r.ok) toast(t('配置已导出 ✓ ') + r.path, 'ok');
  else if (!r.canceled) toast(t('导出失败：') + (r.error || ''), 'err');
});

$('#btn-cfg-import').addEventListener('click', async () => {
  const r = await api.invoke('config:importFile');
  if (r.canceled) return;
  if (!r.ok) return toast(t('导入失败：') + r.error, 'err');
  const c = r.payload.config;
  const w = c.webdav || {};
  if (!confirm(`将导入并覆盖当前设置：
· ${c.agents.length} 个 Agent
· ${(c.projects || []).length} 个项目
· WebDAV：${w.url || t('未配置')}${w.password ? t('（含密码）') : ''}

继续？`)) return;
  (await applyImportedConfig(r.payload)) ? toast(t('配置已导入 ✓'), 'ok') : toast(t('导入失败'), 'err');
});

$('#btn-wd-up-cfg').addEventListener('click', async () => {
  if (!(await wdSave())) return;
  if (!confirm(t('将把 Agents、项目与 WebDAV 配置（含密码）上传到云端 cc-skill-config.json（覆盖旧配置），继续？'))) return;
  $('#wd-status').textContent = t('正在上传配置…');
  const r = await api.invoke('sync:uploadConfig', { includePassword: true });
  $('#wd-status').textContent = r.ok ? t('✓ 配置已上传到云端') : t('✗ 上传失败：') + r.error;
  toast(r.ok ? t('配置已上传到云端 ✓') : t('上传失败：') + r.error, r.ok ? 'ok' : 'err');
});

$('#btn-wd-down-cfg').addEventListener('click', async () => {
  if (!confirm(t('将从云端下载配置并覆盖本机全部设置（Agents / 项目 / WebDAV），继续？'))) return;
  $('#wd-status').textContent = t('正在下载配置…');
  const r = await api.invoke('sync:downloadConfig');
  if (!r.ok) {
    $('#wd-status').textContent = t('✗ 恢复失败：') + r.error;
    return toast(t('恢复失败：') + r.error, 'err');
  }
  (await applyImportedConfig(r.payload)) ? ($('#wd-status').textContent = t('✓ 已从云端恢复配置'), toast(t('已从云端恢复配置 ✓'), 'ok')) : toast(t('恢复失败'), 'err');
});

// ------------------------------ 顶栏 / 快捷键 --------------------------------
$('#btn-dups').addEventListener('click', openDupsModal);
$('#btn-logs').addEventListener('click', openLogs);
// 自绘标题栏：窗口控制按钮
$('#wc-min').addEventListener('click', () => api.invoke('win:minimize'));
$('#wc-max').addEventListener('click', () => api.invoke('win:maximize'));
$('#wc-close').addEventListener('click', () => api.invoke('win:close'));
$('#btn-open-logfile').addEventListener('click', () => {
  if (state.logFile) api.invoke('shell:openPath', { path: state.logFile });
});
$('#btn-clear-logs').addEventListener('click', () => {
  state.logs = [];
  state.unreadErrors = 0;
  updateLogBadge();
  renderLogs();
});
// 语言切换：保存偏好 → 翻译静态节点 → 重渲染动态列表
  $('#set-lang').addEventListener('change', (e) => {
    i18n.setLang(e.target.value);
    i18n.apply(document);
    renderSidebar();
    renderGrid();
    updateDupsButton();
    setFilter(state.filter);
  });

// 侧栏静态导航项（总览 / 全部 SKILL）是 HTML 写死的节点，在这里统一绑定点击
$$('#sidebar > .nav-item').forEach((el) =>
  el.addEventListener('click', () => setFilter(el.dataset.filter))
);
$('#btn-rescan').addEventListener('click', () => { scan(); toast(t('已重新扫描')); });
$('#btn-new').addEventListener('click', openNewModal);
$('#btn-settings').addEventListener('click', openSettings);
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
  await scan();
})();
