// SKILL.md 解析、目录扫描、以及技能的增删改查。除「移入回收站」需要宿主注入 shell 外，
// 本模块不依赖 electron。
const path = require('path');
const fs = require('fs');
const { expand, LINK_TYPE, removePath } = require('./paths');
const { getConfig, saveConfig, DEFAULT_AGENTS } = require('./config');

// 项目内约定的 SKILL 目录：<project>/<sub>/skills
const PROJECT_SUBDIR_AGENTS = {
  '.claude': ['claude-code'],
  '.agents': ['claude-code', 'zcode'],
  '.zcode': ['zcode'],
  '.codex': ['codex'],
  '.qoder': ['qoder'],
};

// ------------------------------ SKILL.md 解析 -------------------------------
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (!m) return { meta: { name: null, description: null }, body: text || '' };
  const fm = m[1];
  // frontmatter 与正文之间的空行全部吃掉，正文不该带前导换行
  const body = text.slice(m[0].length).replace(/^(?:\r?\n)+/, '');
  const getValue = (key) => {
    // 值一直取到下一个 key / 分隔线 / 字符串真正结尾；注意不能用 $，多行模式下它会在行尾就命中，
    // 导致折行的值只截到第一行
    const re = new RegExp('^' + key + ':[ \\t]*([\\s\\S]*?)(?=\\n[a-zA-Z_-]+:|\\n---|(?![\\s\\S]))', 'm');
    const v = re.exec(fm);
    if (!v) return null;
    let s = v[1].replace(/\s*\n\s*/g, ' ').trim();
    if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) {
      // 还原 skillTemplate 写入时的转义；顺序与写入相反（先引号后反斜杠）
      s = s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (s.length > 1 && s.startsWith("'") && s.endsWith("'")) {
      s = s.slice(1, -1);
    }
    return s || null;
  };
  return { meta: { name: getValue('name'), description: getValue('description') }, body };
}

// 取第一段正文作为描述兜底：跳过标题 / 分隔线，并整体跳过代码块（围栏内的行不是正文）
function firstParagraph(body) {
  const lines = (body || '').split(/\r?\n/);
  let inFence = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!t || t.startsWith('#') || t.startsWith('---')) continue;
    return t.slice(0, 300);
  }
  return '';
}

function skillTemplate(name, description) {
  const q = (s) =>
    `"${String(s || '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')}"`;
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

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of ents) {
      n++;
      if (e.isDirectory()) walk(path.join(d, e.name));
      if (n > 500) return;
    }
  };
  walk(dir);
  return n;
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
    } catch (_) {
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const sub = path.join(d, e.name);
      if (fs.existsSync(path.join(sub, 'SKILL.md'))) return sub;
      queue.push({ d: sub, depth: depth + 1 });
    }
  }
  return null;
}

function makeSkill(absDir, type, folder, agentIds, mdPath) {
  let name = null;
  let description = null;
  try {
    const p = parseFrontmatter(fs.readFileSync(mdPath, 'utf8'));
    name = p.meta.name;
    description = p.meta.description;
    if (!description) description = firstParagraph(p.body);
  } catch (_) {
    /* 读不到就用文件夹名 */
  }
  let mtime = 0;
  try {
    mtime = fs.statSync(type === 'folder' ? absDir : mdPath).mtimeMs;
  } catch (_) {
    /* ignore */
  }
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
  let st;
  try {
    st = fs.lstatSync(skill.absPath);
  } catch (_) {
    return;
  }
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

// ------------------------------ 扫描 ---------------------------------------
function scanAll() {
  const config = getConfig();
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
      } catch (_) {
        /* 单个条目损坏不影响整体 */
      }
    }
  }
  // 项目级 SKILL：<project>/.claude|agents|zcode|codex|qoder/skills
  for (const proj of config.projects || []) {
    const root = expand(proj.dir);
    for (const [sub, ids] of Object.entries(PROJECT_SUBDIR_AGENTS)) {
      const dir = path.join(root, sub, 'skills');
      let ents;
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
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
        } catch (_) {
          /* 单个条目损坏不影响整体 */
        }
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
  // 不含 webdav —— 由 IPC 层补上，避免这里反向依赖 webdav 模块
  return { skills, agents: config.agents, projects: config.projects, ui: config.ui || { lang: 'auto' }, missingDirs };
}

// Agent 没有配置目录时，给它一个默认目录并写回配置
function ensureAgentDir(agentId) {
  const config = getConfig();
  const agent = config.agents.find((a) => a.id === agentId);
  if (!agent) return null;
  if (agent.dirs && agent.dirs.length) return expand(agent.dirs[0]);
  const builtin = DEFAULT_AGENTS.find((a) => a.id === agentId);
  const d = builtin ? builtin.dirs[0] : `~/.${agentId}/skills`;
  agent.dirs = [d];
  saveConfig();
  return expand(d);
}

// ------------------------------ 单技能操作 ---------------------------------
function readSkill(p) {
  const text = fs.readFileSync(expand(p), 'utf8');
  const parsed = parseFrontmatter(text);
  return { ok: true, content: text, body: parsed.body, meta: parsed.meta };
}

function writeSkill(p, content) {
  fs.writeFileSync(expand(p), content, 'utf8');
  return { ok: true };
}

function listSkillFiles(dir, type) {
  if (type !== 'folder') return { ok: true, files: [] };
  const abs = expand(dir);
  const files = fs
    .readdirSync(abs, { withFileTypes: true })
    .map((e) => {
      const full = path.join(abs, e.name);
      let size = 0;
      try {
        size = e.isDirectory() ? 0 : fs.statSync(full).size;
      } catch (_) {
        /* ignore */
      }
      return { name: e.name, isDir: e.isDirectory(), size };
    })
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  return { ok: true, files };
}

// 复制技能（folder 整目录 / file 单个 .md）到目标目录；
// mode='link' 时不复制文件，创建指向源技能的目录联接（junction，同一磁盘即可、无需管理员）
function copySkill({ srcPath, type, destDir, folderName, onConflict, agentId, mode }) {
  if (!destDir) destDir = ensureAgentDir(agentId);
  const dd = expand(destDir);
  fs.mkdirSync(dd, { recursive: true });
  let dest = type === 'folder' ? path.join(dd, folderName) : path.join(dd, folderName + '.md');
  if (fs.existsSync(dest)) {
    if (onConflict === 'overwrite') {
      // 目标可能是别人建的链接：走 removePath，别顺着它把唯一副本的内容删了
      removePath(dest);
    } else if (onConflict === 'rename') {
      let i = 2;
      const tryName = (n) => (type === 'folder' ? path.join(dd, n) : path.join(dd, n + '.md'));
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
    try {
      target = fs.realpathSync(target);
    } catch (_) {
      /* 源不存在时按原路径创建，生成 dangling 供用户发现 */
    }
    fs.symlinkSync(target, dest, LINK_TYPE);
    return { ok: true, dest, linked: true };
  }
  if (type === 'folder') {
    fs.cpSync(srcPath, dest, { recursive: true });
  } else {
    fs.copyFileSync(srcPath, dest);
  }
  return { ok: true, dest };
}

function createSkill({ destDir, folder, name, description, agentId }) {
  if (!destDir) destDir = ensureAgentDir(agentId);
  const dd = expand(destDir);
  fs.mkdirSync(dd, { recursive: true });
  const dest = path.join(dd, folder);
  if (fs.existsSync(dest)) return { ok: false, reason: 'exists', dest };
  fs.mkdirSync(dest, { recursive: true });
  const md = path.join(dest, 'SKILL.md');
  fs.writeFileSync(md, skillTemplate(name, description), 'utf8');
  return { ok: true, dest, skillMdPath: md };
}

// 归一化后按大小写不敏感比较路径：Windows 上 A:\a 与 a:/A 是同一个目录，
// 「迁移到原地」这类等价判断必须先统一分隔符再比，否则漏判
function normCase(p) {
  return path
    .resolve(String(p || ''))
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// 迁移 SKILL 本体到另一个目录。与 copySkill 的「复制一份、原件不动」相反：本体真的搬走。
// 链接体系下本体搬家会让所有指向它的链接失效，所以搬家前先找出入站链接，搬完一律重指向
// 新家；leaveLink 时再在原位置补一个链接，原目录继续可用。
async function moveSkill({ srcPath, type, destDir, folderName, onConflict, leaveLink }, { trashItem }) {
  const src = expand(srcPath);
  const dd = expand(destDir);
  if (!src || !dd) return { ok: false, reason: 'invalid' };
  // 同目录没有迁移可言：dest 会与 src 完全重合（渲染层已把源目录从候选里过滤掉，这里是防御）
  if (normCase(path.dirname(src)) === normCase(dd)) return { ok: false, reason: 'same-dir' };
  let st;
  try {
    st = fs.lstatSync(src);
  } catch (_) {
    return { ok: false, reason: 'missing' };
  }
  // 链接条目没有本体：搬走链接只会让唯一副本丢失一个入口，防御渲染层漏判
  if (st.isSymbolicLink()) return { ok: false, reason: 'is-link' };
  // 目标路径与冲突策略，与 copySkill 同构
  let dest = type === 'file' ? path.join(dd, folderName + '.md') : path.join(dd, folderName);
  if (fs.existsSync(dest)) {
    if (onConflict === 'overwrite') {
      // 目标可能是别人建的链接：走 removePath，别顺着它把链接背后的内容删了
      removePath(dest);
    } else if (onConflict === 'rename') {
      let i = 2;
      const tryName = (n) => (type === 'file' ? path.join(dd, n + '.md') : path.join(dd, n));
      while (fs.existsSync(tryName(`${folderName}-${i}`))) i++;
      dest = tryName(`${folderName}-${i}`);
    } else {
      return { ok: false, reason: 'exists', dest };
    }
  }
  fs.mkdirSync(dd, { recursive: true });
  // 入站链接在搬家前找齐：此时旧路径还是实体，scanAll 不会把它算成链接。
  // linkTarget 是 realpath 解析的，源也取 realpath 再比，避免 macOS /var → /private/var 这类前缀差异漏判
  let srcReal = src;
  try {
    srcReal = fs.realpathSync(src);
  } catch (_) {
    /* 拿原路径比 */
  }
  const inbound = scanAll().skills.filter((s) => s.linked && normCase(s.linkTarget) === normCase(srcReal));
  // 同卷 fs.renameSync 原子搬走；跨卷（EXDEV）复制后原件进回收站，绝不 rmSync 硬删
  let moved = false;
  try {
    fs.renameSync(src, dest);
    moved = true;
  } catch (_) {
    /* EXDEV 或被占用，走复制兜底 */
  }
  if (!moved) {
    if (type === 'folder') fs.cpSync(src, dest, { recursive: true });
    else fs.copyFileSync(src, dest);
    const attempt = async () => {
      try {
        return (await trashItem(src)) === true;
      } catch (_) {
        return false;
      }
    };
    let trashOk = await attempt();
    if (!trashOk && fs.existsSync(src)) {
      // Windows 上 trashItem 偶发 false 但实际已移入回收站：是否成功以磁盘实况为准
      await new Promise((r) => setTimeout(r, 450));
      trashOk = await attempt();
    }
    // 原件进不了回收站（目录被占用）：副本已在目标就位，迁移按「部分成功」收尾——
    // 绝不在错误路径删数据（回滚副本会误伤 overwrite 情形下目标原有的内容），
    // 副本转正为本体，入站链接照常重指向新家，原件留给用户手动清理
  }
  const partial = !moved && fs.existsSync(src) ? 'src-locked' : null;
  const realDest = fs.realpathSync(dest);
  // 入站链接重指向：摘掉旧 junction 重建到新家；单个失败只跳过，不阻塞其他链接的修复
  let rePointed = 0;
  for (const l of inbound) {
    try {
      removePath(l.absPath);
      fs.symlinkSync(realDest, l.absPath, LINK_TYPE);
      rePointed++;
    } catch (_) {
      /* 单个链接修复失败不阻塞迁移本身 */
    }
  }
  // 原位置留链接：本体搬走后原目录经 junction 继续可用（junction 仅限目录，单文件建不了）
  let leftLink = false;
  if (leaveLink && type === 'folder') {
    try {
      fs.symlinkSync(realDest, src, LINK_TYPE);
      leftLink = true;
    } catch (_) {
      /* 建不了链接不影响迁移本身 */
    }
  }
  return { ok: true, dest, rePointed, leftLink, partial };
}

// 比较两个技能文件夹的 SKILL.md 是否一致（合并重复时提示用户）
function compareSkills({ pathA, pathB }) {
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
}

// 删除：链接只删链接本身；实体目录交给宿主注入的 trashItem 移入回收站
async function trashSkill(p, { trashItem }) {
  const abs = expand(p);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (_) {
    return { ok: false, error: '路径不存在' };
  }
  if (st.isSymbolicLink()) {
    // 只删除链接本身，绝不动源 SKILL。必须走 removePath —— rmSync({recursive:true})
    // 在 Electron 的 Node 上会顺着 junction 把源 SKILL 的内容删光
    removePath(abs);
    return { ok: true, linkRemoved: true };
  }
  // Windows 上 trashItem 偶发返回 false 但实际已移入回收站：是否成功以磁盘实况为准
  const attempt = async () => {
    try {
      return (await trashItem(abs)) === true;
    } catch (_) {
      return false;
    }
  };
  const apiOk = await attempt();
  if (!apiOk && fs.existsSync(abs)) {
    await new Promise((r) => setTimeout(r, 450));
    await attempt();
  }
  if (!fs.existsSync(abs)) return { ok: true };
  return { ok: false, error: '无法移入回收站，目录可能被其他程序占用' };
}

module.exports = {
  PROJECT_SUBDIR_AGENTS,
  parseFrontmatter,
  firstParagraph,
  skillTemplate,
  countFiles,
  findSkillRoot,
  makeSkill,
  applyLinkInfo,
  scanAll,
  ensureAgentDir,
  readSkill,
  writeSkill,
  listSkillFiles,
  copySkill,
  createSkill,
  compareSkills,
  moveSkill,
  trashSkill,
};
