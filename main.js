const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// 默认 Agent 注册表：id / 显示名 / 主题色 / 默认技能目录（~ 开头，运行时展开）
// ~/.agents/skills 是多个 CLI 共享的技能目录（Claude Code 与 ZCode 均会读取）
// ---------------------------------------------------------------------------
const DEFAULT_AGENTS = [
  { id: 'claude-code', name: 'Claude Code', color: '#e07a4f', dirs: ['~/.claude/skills', '~/.agents/skills'] },
  { id: 'codex',       name: 'Codex',       color: '#19b39a', dirs: ['~/.codex/skills'] },
  { id: 'openclaw',    name: 'OpenClaw',    color: '#f0a35c', dirs: ['~/.openclaw/skills'] },
  { id: 'zcode',       name: 'ZCode',       color: '#4f8ef7', dirs: ['~/.zcode/skills', '~/.agents/skills'] },
  { id: 'qoder',       name: 'Qoder',       color: '#8b5cf6', dirs: ['~/.qoder/skills'] },
];

let win = null;
let config = null;

// 固定配置目录为 %APPDATA%\cc-skill（不随 productName 变化），并从历史目录迁移
const CONFIG_DIR = process.env.CC_SKILL_DATA_DIR
  || path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'cc-skill'
  );
try {
  if (!fs.existsSync(path.join(CONFIG_DIR, 'config.json'))) {
    for (const legacy of ['CC Skill', 'skillharbor', 'skillhub']) {
      const oldCfg = path.join(process.env.APPDATA || '', legacy, 'config.json');
      if (fs.existsSync(oldCfg)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.copyFileSync(oldCfg, path.join(CONFIG_DIR, 'config.json'));
        break;
      }
    }
  }
  app.setPath('userData', CONFIG_DIR);
} catch (_) { /* 迁移失败按默认路径运行 */ }

const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// 项目内约定的 SKILL 目录：<project>/<sub>/skills
const PROJECT_SUBDIR_AGENTS = {
  '.claude': ['claude-code'],
  '.agents': ['claude-code', 'zcode'],
  '.zcode': ['zcode'],
  '.codex': ['codex'],
  '.qoder': ['qoder'],
};

// ------------------------------- 配置 -------------------------------------
const toTilde = (p) => {
  const s = String(p || '').trim();
  if (!s) return s;
  const h = os.homedir();
  if (!h || !s.toLowerCase().startsWith(h.toLowerCase())) return s;
  const rest = s.slice(h.length).split(String.fromCharCode(92)).filter(Boolean).join('/');
  return '~/' + rest.split('/').filter(Boolean).join('/');
};
const basenameOf = (p) => String(p || '').split(/[\\/]+/).filter(Boolean).pop() || String(p || '');
// 自愈：项目名若被存成完整路径则回退为目录名；HOME 下的路径统一存 ~ 形式
function normalizeConfigInPlace() {
  for (const a of config.agents || []) {
    a.dirs = (a.dirs || []).map(toTilde).filter(Boolean);
  }
  for (const p of config.projects || []) {
    p.dir = toTilde(String(p.dir || '').trim());
    if (!p.name || /[\\/]/.test(p.name)) p.name = basenameOf(p.dir);
  }
}
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  try {
    if (fs.existsSync(configPath())) {
      fs.copyFileSync(configPath(), path.join(CONFIG_DIR, 'config.backup.json'));
    }
  } catch (_) { /* 备份失败不阻塞保存 */ }
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
}
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (Array.isArray(raw.agents)) {
      config = raw;
      if (!Array.isArray(config.projects)) config.projects = [];
      normalizeConfigInPlace();
      return;
    }
  } catch (_) { /* 首次运行或损坏则重置 */ }
  config = { agents: JSON.parse(JSON.stringify(DEFAULT_AGENTS)), projects: [] };
  saveConfig();
}

// --------------------------- SKILL.md 解析 --------------------------------
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (!m) return { meta: { name: null, description: null }, body: text || '' };
  const fm = m[1];
  const body = text.slice(m[0].length).replace(/^\r?\n/, '');
  const getValue = (key) => {
    const re = new RegExp('^' + key + ':[ \\t]*([\\s\\S]*?)(?=\\n[a-zA-Z_-]+:|\\n---|$)', 'm');
    const v = re.exec(fm);
    if (!v) return null;
    let s = v[1].replace(/\s*\n\s*/g, ' ').trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1);
    }
    return s || null;
  };
  return { meta: { name: getValue('name'), description: getValue('description') }, body };
}

function firstParagraph(body) {
  const lines = (body || '').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('---') || t.startsWith('```')) continue;
    return t.slice(0, 300);
  }
  return '';
}

function makeSkill(absDir, type, folder, agentIds, mdPath) {
  let name = null;
  let description = null;
  let body = '';
  try {
    const p = parseFrontmatter(fs.readFileSync(mdPath, 'utf8'));
    name = p.meta.name;
    description = p.meta.description;
    body = p.body;
    if (!description) description = firstParagraph(body);
  } catch (_) { /* 读不到就用文件夹名 */ }
  let mtime = 0;
  try {
    mtime = fs.statSync(type === 'folder' ? absDir : mdPath).mtimeMs;
  } catch (_) { /* ignore */ }
  return {
    key: absDir,
    absPath: absDir,
    parentDir: path.dirname(absDir),
    folder,
    type,
    skillMdPath: mdPath,
    name: name || folder,
    description: (description || '').slice(0, 300),
    agentIds: [...agentIds],
    mtime,
    linkCount: 0,
    fileCount: type === 'folder' ? countFiles(absDir) : 1,
  };
}

// 识别链接条目（junction / symlink）：linked=是链接，linkTarget=解析后的唯一副本路径，
// dangling=源已丢失；指向自己的按普通目录处理
function applyLinkInfo(skill) {
  let st = null;
  try { st = fs.lstatSync(skill.absPath); } catch (_) { return; }
  if (!st.isSymbolicLink()) return;
  skill.linked = true;
  try {
    const real = fs.realpathSync(skill.absPath);
    if (real.toLowerCase() === skill.absPath.toLowerCase()) {
      skill.linked = false;
      return;
    }
    skill.linkTarget = real;
  } catch (_) {
    skill.dangling = true;
  }
}

// 在解压/选择的目录里定位技能根目录（含 SKILL.md），最多向下找两层
function findSkillRoot(dir) {
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  const queue = [{ d: dir, depth: 0 }];
  while (queue.length) {
    const { d, depth } = queue.shift();
    if (depth >= 2) continue;
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const sub = path.join(d, e.name);
      if (fs.existsSync(path.join(sub, 'SKILL.md'))) return sub;
      queue.push({ d: sub, depth: depth + 1 });
    }
  }
  return null;
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      n++;
      if (e.isDirectory()) walk(path.join(d, e.name));
      if (n > 500) return;
    }
  };
  walk(dir);
  return n;
}

// ------------------------------ 扫描 ---------------------------------------
function scanAll() {
  const dirAgents = new Map(); // 绝对路径 -> Set(agentId)
  for (const a of config.agents) {
    for (const d of a.dirs || []) {
      const abs = expand(d);
      if (!abs) continue;
      if (!dirAgents.has(abs)) dirAgents.set(abs, new Set());
      dirAgents.get(abs).add(a.id);
    }
  }
  const skills = [];
  const missingDirs = [];
  for (const [dir, ids] of dirAgents) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      missingDirs.push({ dir, agentIds: [...ids] });
      continue;
    }
    for (const e of ents) {
      try {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory() || e.isSymbolicLink()) {
          const full = path.join(dir, e.name);
          const md = path.join(full, 'SKILL.md');
          if (fs.existsSync(md)) {
            const sk = makeSkill(full, 'folder', e.name, ids, md);
            applyLinkInfo(sk);
            skills.push(sk);
          } else if (!e.isDirectory() && /\.(md|markdown)$/i.test(e.name)) {
            const folder = e.name.replace(/\.(md|markdown)$/i, '');
            skills.push(makeSkill(dir, 'file', folder, ids, full));
          }
        } else if (/\.(md|markdown)$/i.test(e.name)) {
          const folder = e.name.replace(/\.(md|markdown)$/i, '');
          skills.push(makeSkill(dir, 'file', folder, ids, path.join(dir, e.name)));
        }
      } catch (_) { /* 单个条目损坏不影响整体 */ }
    }
  }
  // 项目级 SKILL：<project>/.claude|agents|zcode|codex|qoder/skills
  for (const proj of config.projects || []) {
    const root = expand(proj.dir);
    for (const [sub, ids] of Object.entries(PROJECT_SUBDIR_AGENTS)) {
      const dir = path.join(root, sub, 'skills');
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of ents) {
        try {
          if (e.name.startsWith('.')) continue;
          const projTag = { id: proj.id, name: proj.name };
          if (e.isDirectory() || e.isSymbolicLink()) {
            const full = path.join(dir, e.name);
            const md = path.join(full, 'SKILL.md');
            if (fs.existsSync(md)) {
              const sk = makeSkill(full, 'folder', e.name, new Set(ids), md);
              sk.project = projTag;
              applyLinkInfo(sk);
              skills.push(sk);
            } else if (!e.isDirectory() && /\.(md|markdown)$/i.test(e.name)) {
              const folder = e.name.replace(/\.(md|markdown)$/i, '');
              const sk = makeSkill(dir, 'file', folder, new Set(ids), full);
              sk.project = projTag;
              skills.push(sk);
            }
          } else if (/\.(md|markdown)$/i.test(e.name)) {
            const folder = e.name.replace(/\.(md|markdown)$/i, '');
            const sk = makeSkill(dir, 'file', folder, new Set(ids), path.join(dir, e.name));
            sk.project = projTag;
            skills.push(sk);
          }
        } catch (_) { /* 单个条目损坏不影响整体 */ }
      }
    }
  }
  // 统计每个唯一副本被多少个链接引用
  const linkCounts = new Map();
  for (const s of skills) {
    if (s.linked && s.linkTarget) {
      const k = s.linkTarget.toLowerCase();
      linkCounts.set(k, (linkCounts.get(k) || 0) + 1);
    }
  }
  for (const s of skills) {
    if (!s.linked) s.linkCount = linkCounts.get(s.absPath.toLowerCase()) || 0;
  }
  skills.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { skills, agents: config.agents, projects: config.projects, webdav: webdavCfg(), missingDirs };
}

// Agent 没有配置目录时，给它一个默认目录并写回配置
function ensureAgentDir(agentId) {
  const agent = config.agents.find((a) => a.id === agentId);
  if (!agent) return null;
  if (agent.dirs && agent.dirs.length) return expand(agent.dirs[0]);
  const builtin = DEFAULT_AGENTS.find((a) => a.id === agentId);
  const d = builtin ? builtin.dirs[0] : `~/.${agentId}/skills`;
  agent.dirs = [d];
  saveConfig();
  return expand(d);
}

function skillTemplate(name, description) {
  const q = (s) => `"${String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `---
name: ${q(name)}
description: ${q(description)}
---

# ${name}

## 用途

（这个 SKILL 做什么、什么场景下触发）

## 用法

（步骤、命令、示例）
`;
}

// ------------------------------ IPC ----------------------------------------
const handle = (ch, fn) =>
  ipcMain.handle(ch, async (_e, payload) => {
    try {
      return await fn(payload || {});
    } catch (err) {
      return { ok: false, reason: 'error', error: String((err && err.message) || err) };
    }
  });

handle('scan', () => scanAll());

handle('config:get', () => ({ agents: config.agents }));
handle('config:set', ({ agents, projects }) => {
  if (!Array.isArray(agents)) return { ok: false, reason: 'invalid' };
  config.agents = agents;
  if (Array.isArray(projects)) {
    config.projects = projects.filter((p) => p && p.id && p.dir);
  }
  normalizeConfigInPlace();
  saveConfig();
  return { ok: true, agents: config.agents, projects: config.projects };
});
handle('config:reset', () => {
  config.agents = JSON.parse(JSON.stringify(DEFAULT_AGENTS));
  config.projects = [];
  saveConfig();
  return { ok: true, agents: config.agents, projects: config.projects };
});

handle('skill:read', ({ path: p }) => {
  const text = fs.readFileSync(expand(p), 'utf8');
  const parsed = parseFrontmatter(text);
  return { ok: true, content: text, body: parsed.body, meta: parsed.meta };
});

handle('skill:write', ({ path: p, content }) => {
  fs.writeFileSync(expand(p), content, 'utf8');
  return { ok: true };
});

handle('skill:files', ({ dir, type }) => {
  if (type !== 'folder') return { ok: true, files: [] };
  const abs = expand(dir);
  const files = fs
    .readdirSync(abs, { withFileTypes: true })
    .map((e) => {
      const full = path.join(abs, e.name);
      let size = 0;
      try { size = e.isDirectory() ? 0 : fs.statSync(full).size; } catch (_) { /* ignore */ }
      return { name: e.name, isDir: e.isDirectory(), size };
    })
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  return { ok: true, files };
});

// 复制技能（folder 整目录 / file 单个 .md）到目标目录；
// mode='link' 时不复制文件，创建指向源技能的目录联接（junction，同一磁盘即可、无需管理员）
handle('skill:copy', ({ srcPath, type, destDir, folderName, onConflict, agentId, mode }) => {
  if (!destDir) destDir = ensureAgentDir(agentId);
  const dd = expand(destDir);
  fs.mkdirSync(dd, { recursive: true });
  let dest = type === 'folder'
    ? path.join(dd, folderName)
    : path.join(dd, folderName + '.md');
  if (fs.existsSync(dest)) {
    if (onConflict === 'overwrite') {
      fs.rmSync(dest, { recursive: true, force: true });
    } else if (onConflict === 'rename') {
      let i = 2;
      const tryName = (n) =>
        type === 'folder' ? path.join(dd, n) : path.join(dd, n + '.md');
      while (fs.existsSync(tryName(`${folderName}-${i}`))) i++;
      dest = tryName(`${folderName}-${i}`);
    } else {
      return { ok: false, reason: 'exists', dest };
    }
  }
  if (mode === 'link') {
    if (type !== 'folder') return { ok: false, reason: 'invalid-link' };
    if (path.parse(expand(srcPath)).root.toLowerCase() !== path.parse(dd).root.toLowerCase()) {
      return { ok: false, reason: 'cross-volume', dest };
    }
    let target = expand(srcPath);
    try { target = fs.realpathSync(target); } catch (_) { /* 源不存在时按原路径创建，生成 dangling 供用户发现 */ }
    fs.symlinkSync(target, dest, 'junction');
    return { ok: true, dest, linked: true };
  }
  if (type === 'folder') {
    fs.cpSync(srcPath, dest, { recursive: true });
  } else {
    fs.copyFileSync(srcPath, dest);
  }
  return { ok: true, dest };
});

handle('skill:trash', async ({ path: p }) => {
  const abs = expand(p);
  let st = null;
  try { st = fs.lstatSync(abs); } catch (_) { return { ok: false, error: '路径不存在' }; }
  if (st.isSymbolicLink()) {
    // 只删除链接本身，绝不动源 SKILL
    fs.rmSync(abs, { recursive: true, force: true });
    return { ok: true, linkRemoved: true };
  }
  // Windows 上 trashItem 偶发返回 false 但实际已移入回收站：是否成功以磁盘实况为准
  const attempt = async () => {
    try { return (await shell.trashItem(abs)) === true; } catch (_) { return false; }
  };
  const apiOk = await attempt();
  if (!apiOk && fs.existsSync(abs)) {
    await new Promise((r) => setTimeout(r, 450));
    await attempt();
  }
  if (!fs.existsSync(abs)) return { ok: true };
  return { ok: false, error: '无法移入回收站，目录可能被其他程序占用' };
});

// 比较两个技能文件夹的 SKILL.md 是否一致（合并重复时提示用户）
handle('skill:compare', ({ pathA, pathB }) => {
  const read = (p) => {
    const md = path.join(expand(p), 'SKILL.md');
    return fs.existsSync(md) ? fs.readFileSync(md) : null;
  };
  const a = read(pathA);
  const b = read(pathB);
  return {
    ok: true,
    same: !!(a && b && a.equals(b)),
    aHas: !!a,
    bHas: !!b,
    aFiles: countFiles(expand(pathA)),
    bFiles: countFiles(expand(pathB)),
  };
});

handle('skill:create', ({ destDir, folder, name, description, agentId }) => {
  if (!destDir) destDir = ensureAgentDir(agentId);
  const dd = expand(destDir);
  fs.mkdirSync(dd, { recursive: true });
  const dest = path.join(dd, folder);
  if (fs.existsSync(dest)) return { ok: false, reason: 'exists', dest };
  fs.mkdirSync(dest, { recursive: true });
  const md = path.join(dest, 'SKILL.md');
  fs.writeFileSync(md, skillTemplate(name, description), 'utf8');
  return { ok: true, dest, skillMdPath: md };
});

handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

handle('dialog:pickZip', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'ZIP 压缩包', extensions: ['zip'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

// 导入前检查：文件夹直接定位技能根；ZIP 先解压到临时目录再定位
handle('import:inspect', async ({ source }) => {
  let src;
  const isZip = /\.zip$/i.test(source || '');
  if (isZip) {
    const tmpRoot = path.join(app.getPath('temp'), 'cc-skill-import-' + Date.now());
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    const ps = (s) => s.replace(/'/g, "''");
    await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          `Expand-Archive -LiteralPath '${ps(source)}' -DestinationPath '${ps(tmpRoot)}' -Force`],
        { timeout: 120000, windowsHide: true },
        (err) => (err ? reject(err) : resolve())
      );
    });
    src = findSkillRoot(tmpRoot);
  } else {
    src = findSkillRoot(expand(source));
  }
  if (!src) return { ok: false, reason: 'no-skill' };
  const md = path.join(src, 'SKILL.md');
  const p = parseFrontmatter(fs.readFileSync(md, 'utf8'));
  return {
    ok: true,
    skillRoot: src,
    folder: path.basename(src),
    name: p.meta.name || path.basename(src),
    description: p.meta.description || firstParagraph(p.body),
    fileCount: countFiles(src),
  };
});

// 应用同级目录：便携版取 exe 所在目录，开发模式取项目根目录
function appDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (app.isPackaged) return path.dirname(app.getPath('exe'));
  return app.getAppPath();
}

// 操作日志落盘（渲染端每条 toast 都会同步一份），便于事后排查
handle('log:append', ({ type, msg }) => {
  try {
    const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] [${String(type || 'info').toUpperCase()}] ${msg}\n`;
    fs.appendFileSync(path.join(appDir(), 'cc-skill.log'), line, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// --------------------------- WebDAV 云同步 ----------------------------------
// 参考 clash / cc-switch 的模式：用户自填 WebDAV 配置，支持连接测试、
// 全量快照备份（zip：manifest + 各目录 SKILL）、恢复最近备份。
function ps(s) { return String(s).replace(/'/g, "''"); }

function webdavCfg() {
  const c = config.webdav || {};
  // 远程目录宽容归一化：无论用户填 /cc-skill-sync、cc-skill-sync/ 还是 //a//b，都收敛为单斜杠路径
  const raw = String(c.remotePath || 'cc-skill-sync').trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  return {
    url: (c.url || '').trim().replace(/\/+$/, ''),
    username: c.username || '',
    password: c.password || '',
    remotePath: raw ? '/' + raw : '/cc-skill-sync',
    autoBackup: !!c.autoBackup,
    autoBackupFreq: c.autoBackupFreq || 'startup',
    lastBackupAt: c.lastBackupAt || 0,
    lastBackupHash: c.lastBackupHash || '',
  };
}
function davUrl(cfg, name) {
  return cfg.url + cfg.remotePath + (name ? '/' + name : '');
}
function davAuth(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
}
async function davRequest(cfg, method, url, { body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: davAuth(cfg), ...headers },
    body,
  });
  if (!res.ok && res.status !== 207) {
    throw new Error(`${method} ${url} → HTTP ${res.status} ${res.statusText}`);
  }
  return res;
}
// 逐级创建远程目录：201=创建成功；405=已存在；403=服务商禁止 WebDAV 建目录（如坚果云）
// 后两类不算失败——目录可由用户在网页端手动创建，PUT 阶段会再次验证
async function davMkcolDeep(cfg, dirUrl) {
  const scheme = dirUrl.startsWith('https') ? 'https://' : 'http://';
  const segs = dirUrl.slice(scheme.length).split('/').filter(Boolean);
  let cur = scheme + segs.shift();
  for (const s of segs) {
    cur += '/' + s;
    try {
      await davRequest(cfg, 'MKCOL', cur);
    } catch (e) {
      if (!/HTTP (403|405|409)/.test(String(e.message))) throw e;
    }
  }
}
const zipName = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `cc-skill-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.zip`;
};
function runPowerShell(cmd) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { timeout: 120000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

handle('sync:getConfig', () => ({ ok: true, webdav: webdavCfg() }));
handle('sync:setConfig', ({ webdav }) => {
  config.webdav = {
    ...(config.webdav || {}),
    url: String(webdav?.url || '').trim(),
    username: String(webdav?.username || ''),
    password: String(webdav?.password || ''),
    remotePath: String(webdav?.remotePath || 'cc-skill-sync').trim(),
    autoBackup: !!webdav?.autoBackup,
    autoBackupFreq: ['startup', 'daily', 'weekly'].includes(webdav?.autoBackupFreq) ? webdav.autoBackupFreq : 'startup',
  };
  saveConfig();
  return { ok: true };
});

handle('sync:test', async () => {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: '请先填写服务器地址' };
  try {
    try {
      await davRequest(cfg, 'PROPFIND', davUrl(cfg, ''), { headers: { Depth: '0' } });
      return { ok: true, exists: true, remote: cfg.url + cfg.remotePath };
    } catch (e) {
      // 404/409 = 远程目录还不存在（409 常见于父集合缺失），尝试自动创建
      if (!/HTTP (404|409)/.test(String(e.message))) throw e;
    }
    try {
      await davMkcolDeep(cfg, davUrl(cfg, ''));
    } catch (_) { /* 服务商禁止 MKCOL 时按需手动创建处理 */ }
    let exists = false;
    try {
      await davRequest(cfg, 'PROPFIND', davUrl(cfg, ''), { headers: { Depth: '0' } });
      exists = true;
    } catch (_) { /* 仍不存在 */ }
    return exists
      ? { ok: true, exists: true, created: true, remote: cfg.url + cfg.remotePath }
      : { ok: true, exists: false, needsManual: true, remote: cfg.url + cfg.remotePath };
  } catch (err) {
    const msg = String(err.message || err);
    let friendly = msg;
    if (/HTTP 401/.test(msg)) friendly = '认证失败：请检查用户名 / 密码（坚果云等服务需使用应用密码）';
    else if (/HTTP 403/.test(msg)) friendly = '无权限访问该目录';
    return { ok: false, error: friendly };
  }
});

// 备份：全局 + 项目内所有实体 SKILL → manifest.json + data/... 打成 zip 上传
handle('sync:backup', async () => {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: '请先填写 WebDAV 配置' };
  const res = scanAll();
  const items = res.skills.filter((s) => s.type === 'folder' && !s.linked && !s.dangling);
  if (!items.length) return { ok: false, error: '没有可备份的 SKILL' };
  const up = await uploadSnapshot(items);
  if (!up.ok) return up;
  config.webdav.lastBackupAt = Date.now();
  config.webdav.lastBackupHash = up.hash;
  saveConfig();
  return { ok: true, name: up.name, size: up.size, count: up.count, targets: up.targets };
});

// 打包（manifest + data）并上传，附带云端保留策略（最多最近 10 份）
async function uploadSnapshot(items) {
  const cfg = webdavCfg();
  const tmpRoot = path.join(app.getPath('temp'), 'cc-skill-sync-' + Date.now());
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  try {
    const targets = new Map();
    for (const s of items) {
      if (!targets.has(s.parentDir)) {
        targets.set(s.parentDir, {
          id: 't' + targets.size,
          destDir: s.parentDir,
          kind: s.project ? 'project' : 'global',
          projectId: s.project ? s.project.id : null,
          agentIds: s.agentIds,
        });
      }
    }
    const manifest = {
      app: 'CC Skill',
      manifestVersion: 1,
      created: new Date().toISOString(),
      settings: buildConfigPayload(true).config,
      targets: [...targets.values()],
      entries: items.map((s) => ({ target: targets.get(s.parentDir).id, folder: s.folder })),
    };
    let count = 0;
    for (const s of items) {
      const t = targets.get(s.parentDir);
      fs.cpSync(s.absPath, path.join(tmpRoot, 'data', t.id, s.folder), { recursive: true });
      count++;
    }
    fs.writeFileSync(path.join(tmpRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const zipPath = tmpRoot + '.zip';
    fs.rmSync(zipPath, { force: true });
      await runPowerShell(`Compress-Archive -Path '${ps(tmpRoot)}\\*' -DestinationPath '${ps(zipPath)}' -Force`);
    const buf = fs.readFileSync(zipPath);
    const name = zipName();

    try {
      await davMkcolDeep(cfg, davUrl(cfg, ''));
    } catch (_) { /* 部分服务商禁止 MKCOL，PUT 阶段再验证 */ }
    try {
      await davRequest(cfg, 'PUT', davUrl(cfg, name), { body: new Uint8Array(buf), headers: { 'Content-Type': 'application/zip' } });
    } catch (err) {
      const msg = String(err.message || err);
      if (/HTTP (404|409)/.test(msg)) {
        return { ok: false, error: `远程目录 ${cfg.url + cfg.remotePath} 不存在且无法通过 WebDAV 创建——请到网盘网页端手动创建该文件夹后重试` };
      }
      if (/HTTP 401/.test(msg)) return { ok: false, error: '认证失败：请检查用户名 / 密码' };
      return { ok: false, error: msg };
    }

    // 云端保留策略：备份 zip 只保留最近 10 份
    try {
      const list = await davRequest(cfg, 'PROPFIND', davUrl(cfg, ''), { headers: { Depth: '1' } });
      const xml = await list.text();
      const names = [...new Set(xml.match(/cc-skill-backup-[^<>]*?[.]zip/g) || [])].sort();
      for (const old of names.slice(0, Math.max(0, names.length - 10))) {
        try { await davRequest(cfg, 'DELETE', davUrl(cfg, old)); } catch (_) { /* 留着也不影响 */ }
      }
    } catch (_) { /* 保留策略失败不影响备份结果 */ }

    return { ok: true, name, size: buf.length, count, targets: targets.size, hash: snapshotHash(items) };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot + '.zip', { force: true });
  }
}

// 快照内容指纹：文件相对路径 + 大小 + 修改时间；自动备份据此“有变化才上传”
function snapshotHash(items) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha256');
  for (const s of items) {
    h.update(s.folder);
    const walk = (d, rel) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(d, e.name);
        const r = rel + '/' + e.name;
        if (e.isDirectory()) walk(full, r);
        else {
          let st = null;
          try { st = fs.statSync(full); } catch (_) { continue; }
          h.update(r); h.update(String(st.size)); h.update(String(Math.floor(st.mtimeMs)));
        }
      }
    };
    walk(s.absPath, '');
  }
  return h.digest('hex');
}

// 自动备份检查：开启 + 已配置 + 频率到期 + 内容有变化才上传；启动后与运行中定期调用
async function autoBackupCheck() {
  const w = config.webdav || {};
  if (!w.autoBackup) return { ok: false, skipped: 'disabled' };
  const cfg = webdavCfg();
  if (!cfg.url || !cfg.username) return { ok: false, skipped: 'no-config' };
  const intervalMs = w.autoBackupFreq === 'daily' ? 86400000 : w.autoBackupFreq === 'weekly' ? 604800000 : 0;
  if (intervalMs && w.lastBackupAt && Date.now() - w.lastBackupAt < intervalMs) return { ok: false, skipped: 'not-due' };
  const res = scanAll();
  const items = res.skills.filter((s) => s.type === 'folder' && !s.linked && !s.dangling);
  if (!items.length) return { ok: false, skipped: 'empty' };
  const hash = snapshotHash(items);
  if (hash === w.lastBackupHash) {
    config.webdav.lastBackupAt = Date.now();
    saveConfig();
    return { ok: true, skipped: 'unchanged' };
  }
  const up = await uploadSnapshot(items);
  if (up.ok) {
    config.webdav.lastBackupAt = Date.now();
    config.webdav.lastBackupHash = up.hash;
    saveConfig();
  }
  return up;
}
handle('sync:autoCheck', () => autoBackupCheck());

// 恢复：取最近一份备份 → 解压 → 按 manifest 覆盖还原到各目录
handle('sync:restore', async () => {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: '请先填写 WebDAV 配置' };
  const res = await davRequest(cfg, 'PROPFIND', davUrl(cfg, ''), { headers: { Depth: '1' } });
  const xml = await res.text();
  const names = [...new Set(xml.match(/cc-skill-backup-[^<>]*?\.zip/g) || [])].sort();
  if (!names.length) return { ok: false, error: '云端没有找到任何备份' };
  const name = names[names.length - 1];

  const tmpRoot = path.join(app.getPath('temp'), 'cc-skill-restore-' + Date.now());
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dl = await davRequest(cfg, 'GET', davUrl(cfg, name));
  fs.writeFileSync(tmpRoot + '.zip', Buffer.from(await dl.arrayBuffer()));
  await runPowerShell(`Expand-Archive -LiteralPath '${ps(tmpRoot + '.zip')}' -DestinationPath '${ps(tmpRoot)}' -Force`);

  const manifest = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'manifest.json'), 'utf8'));
  if (!['CC Skill', 'SkillHarbor'].includes(manifest.app)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot + '.zip', { force: true });
    return { ok: false, error: 'manifest 校验失败，不是 CC Skill 的备份' };
  }
  const targetById = new Map(manifest.targets.map((t) => [t.id, t]));
  let restored = 0;
  const dests = new Set();
  for (const e of manifest.entries) {
    const t = targetById.get(e.target);
    if (!t) continue;
    const src = path.join(tmpRoot, 'data', t.id, e.folder);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(t.destDir, e.folder);
    fs.mkdirSync(t.destDir, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
    dests.add(t.destDir);
    restored++;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpRoot + '.zip', { force: true });
  return { ok: true, name, restored, dests: [...dests], settings: manifest.settings || null };
});

// --------------------------- 配置导入 / 导出 ---------------------------------
function buildConfigPayload(includePassword) {
  const w = { ...(config.webdav || {}) };
  delete w.lastBackupAt;
  delete w.lastBackupHash;
  if (!includePassword) delete w.password;
  return {
    app: 'CC Skill',
    kind: 'config',
    version: 1,
    exportedAt: new Date().toISOString(),
    config: { agents: config.agents, projects: config.projects, webdav: w },
  };
}

handle('config:payload', ({ includePassword = true }) => ({ ok: true, payload: buildConfigPayload(includePassword) }));
handle('config:exportFile', async ({ includePassword = true }) => {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const r = await dialog.showSaveDialog(win, {
    defaultPath: 'cc-skill-config-' + stamp + '.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(r.filePath, JSON.stringify(buildConfigPayload(includePassword), null, 2), "utf8");
  return { ok: true, path: r.filePath };
});

handle('config:importFile', async () => {
  const r = await dialog.showOpenDialog(win, {
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(r.filePaths[0], "utf8"));
  } catch (err) {
    return { ok: false, error: "文件不是有效的 JSON：" + err.message };
  }
  if (payload.kind !== "config" || !Array.isArray(payload.config && payload.config.agents)) {
    return { ok: false, error: "不是有效的 CC Skill 配置文件" };
  }
  return { ok: true, payload };
});

// WebDAV 设置同步：配置（Agents/项目/WebDAV，含密码）单独上传 / 下载
handle('sync:uploadConfig', async ({ includePassword = true }) => {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: "请先填写并保存 WebDAV 配置" };
  const payload = buildConfigPayload(includePassword);
  try {
    try { await davMkcolDeep(cfg, davUrl(cfg, "")); } catch (_) { /* PUT 阶段再验证 */ }
    const body = new Uint8Array(Buffer.from(JSON.stringify(payload, null, 2), "utf8"));
    await davRequest(cfg, 'PUT', davUrl(cfg, 'cc-skill-config.json'), { body, headers: { 'Content-Type': 'application/json' } });
    return { ok: true, name: "cc-skill-config.json" };
  } catch (err) {
    const msg = String(err.message || err);
    if (/HTTP (404|409)/.test(msg)) return { ok: false, error: "远程目录不存在——请到网盘网页端手动创建后重试" };
    if (/HTTP 401/.test(msg)) return { ok: false, error: "认证失败：请检查用户名 / 密码" };
    return { ok: false, error: msg };
  }
});

handle('sync:downloadConfig', async () => {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: "请先填写 WebDAV 配置" };
  try {
    const res = await davRequest(cfg, "GET", davUrl(cfg, "cc-skill-config.json"));
    const payload = JSON.parse(Buffer.from(await res.arrayBuffer()).toString("utf8"));
    if (payload.kind !== "config") return { ok: false, error: "云端文件不是有效的 CC Skill 配置" };
    return { ok: true, payload };
  } catch (err) {
    const msg = String(err.message || err);
    if (/HTTP 404/.test(msg)) return { ok: false, error: "云端还没有配置文件（先在任意一台机器上传配置）" };
    if (/HTTP 401/.test(msg)) return { ok: false, error: "认证失败：请检查用户名 / 密码" };
    return { ok: false, error: msg };
  }
});

handle('shell:openPath', ({ path: p }) => shell.openPath(expand(p)));
handle('app:paths', () => ({
  userData: app.getPath('userData'),
  home: os.homedir(),
  logFile: path.join(appDir(), 'cc-skill.log'),
}));

// ------------------------------ 窗口控制（自绘标题栏） ----------------------
handle('win:minimize', () => { if (win) win.minimize(); return { ok: true }; });
handle('win:maximize', () => {
  if (!win) return { ok: false };
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return { ok: true, maximized: win.isMaximized() };
});
handle('win:close', () => { if (win) win.close(); return { ok: true }; });

// ------------------------------ 窗口 ---------------------------------------
function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#f5f5f7',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    title: 'CC Skill',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    loadConfig();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}
