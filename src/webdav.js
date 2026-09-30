// WebDAV 云同步：参考 clash / cc-switch 的模式——用户自填 WebDAV 配置，支持连接测试、
// 全量快照备份（zip：manifest + 各目录 SKILL）、恢复最近备份。
// 不依赖 electron：配置从 ./config 取，临时目录从 ./paths 取。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { tempDir, expand, isTilde, toTilde, removePath } = require('./paths');
const { httpFetch } = require('./net');
const { M } = require('./i18n');
const { packZip, unpackZip } = require('./zip');
const {
  getConfig,
  saveConfig,
  buildConfigPayload,
  normalizeConfigInPlace,
  normalizeUi,
  mergeAgentDirs,
  normalizeMachineName,
  normalizeMachineNames,
  machineDisplayName,
  MACHINE_ID_RE,
} = require('./config');
const { scanAll } = require('./skills');

function webdavCfg() {
  const c = getConfig().webdav || {};
  // 远程目录宽容归一化：无论用户填 /cc-skill-sync、cc-skill-sync/ 还是 //a//b，都收敛为单斜杠路径
  const raw = String(c.remotePath || 'cc-skill-sync')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
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

function setWebdavConfig(webdav) {
  const config = getConfig();
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
}

function davUrl(cfg, name) {
  return cfg.url + cfg.remotePath + (name ? '/' + name : '');
}

function davAuth(cfg) {
  return 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
}

async function davRequest(cfg, method, url, { body, headers = {} } = {}) {
  // 走 src/net.js 的注入式 fetch：主进程注入的是 Electron 的 net.fetch，
  // 因此这里会认用户配置的代理；直接用全局 fetch 的话代理配置形同虚设。
  const res = await httpFetch(url, {
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

// ------------------------------ 连接测试 -----------------------------------
async function testConnection() {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: M('请先填写服务器地址', 'Please fill in the server URL first') };
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
    } catch (_) {
      /* 服务商禁止 MKCOL 时按需手动创建处理 */
    }
    let exists = false;
    try {
      await davRequest(cfg, 'PROPFIND', davUrl(cfg, ''), { headers: { Depth: '0' } });
      exists = true;
    } catch (_) {
      /* 仍不存在 */
    }
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
}

// ------------------------------ 备份 ---------------------------------------
// 备份：全局 + 项目内所有实体 SKILL → manifest.json + data/... 打成 zip 上传
async function backup() {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: '请先填写 WebDAV 配置' };
  const res = scanAll();
  const items = res.skills.filter((s) => s.type === 'folder' && !s.linked && !s.dangling);
  if (!items.length) return { ok: false, error: M('没有可备份的 SKILL', 'No skills to back up') };
  const up = await uploadSnapshot(items);
  if (!up.ok) return up;
  const config = getConfig();
  config.webdav.lastBackupAt = Date.now();
  config.webdav.lastBackupHash = up.hash;
  // 手动备份过一次，才算这台机器「在这里有备份」，自动备份从此放行
  config.webdav.everBackedUp = true;
  saveConfig();
  return { ok: true, name: up.name, size: up.size, count: up.count, targets: up.targets };
}

// 侧车元数据。确认弹窗必须在下载整包之前就渲染出「上传设备 / 恢复范围 / 要重建哪些 Agent」，
// 所以 Agent 维度的汇总得在这里算好——恢复时按 Agent 勾选，靠的就是这份数据。
function buildMeta({ name, manifest, targets, size, items }) {
  const names = new Map((manifest.settings?.agents || []).map((a) => [a.id, a.name]));
  const agents = new Map();
  for (const t of targets.values()) {
    if (t.kind !== 'global') continue;
    // 一个 Agent 可能对应多个目录；~/.agents/skills 这类共享目录会同时计入多个 Agent
    for (const id of t.agentIds || []) {
      if (!agents.has(id)) agents.set(id, { id, name: names.get(id) || id, dirs: [], count: 0 });
      const a = agents.get(id);
      a.dirs.push(t.destDir);
      a.count += t.count;
    }
  }
  return {
    name,
    machineId: getConfig().machineId || '',
    // 机器自己声明的名字（默认 hostname）。hostname 仍然如实记着——换名不该让排查时认不出机器
    machineName: machineDisplayName(),
    hostname: manifest.hostname,
    created: manifest.created,
    entries: manifest.entries.length,
    size,
    projectCount: items.filter((s) => s.project).length,
    agents: [...agents.values()].map((a) => ({ ...a, dirs: [...new Set(a.dirs)] })),
  };
}

// 打包（manifest + data）并上传，附带云端保留策略（最多最近 10 份）
async function uploadSnapshot(items) {
  const cfg = webdavCfg();
  const tmpRoot = path.join(tempDir(), 'cc-skill-sync-' + Date.now());
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  try {
    const targets = new Map();
    for (const s of items) {
      if (!targets.has(s.parentDir)) {
        targets.set(s.parentDir, {
          id: 't' + targets.size,
          // 存 ~ 形式而不是绝对路径：换机后由新机器的 home 展开，这是跨机器恢复能成立的前提
          destDir: toTilde(s.parentDir),
          kind: s.project ? 'project' : 'global',
          projectId: s.project ? s.project.id : null,
          agentIds: [...s.agentIds],
          count: 0,
        });
      }
      targets.get(s.parentDir).count++;
    }
    // 随包上传的设置。机器名走 manifest 顶层、别名（本机给别的机器起的名字）压根不上云 ——
    // 它是本机自己的显示信息，随备份跑到别的机器上没有意义
    const settings = buildConfigPayload(true).config;
    delete settings.machineName;
    delete settings.machineNames;
    const manifest = {
      app: 'CC Skill',
      manifestVersion: 1,
      created: new Date().toISOString(),
      hostname: os.hostname(),
      // 记录「打包这台机器」的身份，供恢复时判断能否连项目一起还原。
      // 注意它只是来源信息，不进 settings——那才是会被恢复覆盖的配置。
      machineId: getConfig().machineId || '',
      machineName: machineDisplayName(),
      settings,
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
    // 设置文件随备份一同上传（ Agents / 项目 / WebDAV / 界面语言 ）
    fs.writeFileSync(
      path.join(tmpRoot, 'config.json'),
      JSON.stringify(
        {
          ui: getConfig().ui || { lang: 'auto' },
          agents: getConfig().agents,
          projects: getConfig().projects,
          webdav: webdavCfg(),
          exportedAt: manifest.created,
        },
        null,
        2
      ),
      'utf8'
    );

    const zipPath = tmpRoot + '.zip';
    fs.rmSync(zipPath, { force: true });
    await packZip(tmpRoot, zipPath);
    const buf = fs.readFileSync(zipPath);
    const name = zipName();

    try {
      await davMkcolDeep(cfg, davUrl(cfg, ''));
    } catch (_) {
      /* 部分服务商禁止 MKCOL，PUT 阶段再验证 */
    }
    try {
      await davRequest(cfg, 'PUT', davUrl(cfg, name), { body: new Uint8Array(buf), headers: { 'Content-Type': 'application/zip' } });
    } catch (err) {
      const msg = String(err.message || err);
      if (/HTTP (404|409)/.test(msg)) {
        return {
          ok: false,
          error: `远程目录 ${cfg.url + cfg.remotePath} 不存在且无法通过 WebDAV 创建——请到网盘网页端手动创建该文件夹后重试`,
        };
      }
      if (/HTTP 401/.test(msg)) return { ok: false, error: '认证失败：请检查用户名 / 密码' };
      return { ok: false, error: msg };
    }

    // 元数据侧车文件：固定名、每次覆盖写，供恢复前的确认弹窗廉价读取（不必下载整包）。
    // 写两份——全局最新的 META_FILE，外加本机专属的 host-<slug>.json：恢复时优先取后者，
    // 这样多台机器共用同一个远程目录时，各自恢复的都是自己那份。
    // 上传失败不影响备份结果——restoreInfo 会降级为只读 HEAD 响应头
    const meta = buildMeta({ name, manifest, targets, size: buf.length, items });
    for (const file of [META_FILE, hostMetaFile()]) {
      try {
        await davRequest(cfg, 'PUT', davUrl(cfg, file), {
          body: new Uint8Array(Buffer.from(JSON.stringify(meta))),
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (_) {
        /* 侧车文件缺失时恢复流程仍可用，只是弹窗少几行信息 */
      }
    }

    // 云端保留策略：总量最多 10 份，但每台机器最近那份永不删——各机器共用同一个远程目录，
    // 谁也不想自己唯一的备份被别人的频繁备份挤掉（那会让「本机备份」无声无息地退化成别人的备份）。
    try {
      const { backups, sidecars } = await listRemote(cfg);
      const keep = new Set([name]);
      for (const { meta } of await readSidecars(cfg, sidecars)) {
        if (meta && meta.name) keep.add(meta.name);
      }
      for (const old of backups.slice(0, Math.max(0, backups.length - 10))) {
        if (keep.has(old)) continue;
        try {
          await davRequest(cfg, 'DELETE', davUrl(cfg, old));
        } catch (_) {
          /* 留着也不影响 */
        }
      }
    } catch (_) {
      /* 保留策略失败不影响备份结果 */
    }

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
      try {
        ents = fs.readdirSync(d, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(d, e.name);
        const r = rel + '/' + e.name;
        if (e.isDirectory()) walk(full, r);
        else {
          let st;
          try {
            st = fs.statSync(full);
          } catch (_) {
            continue;
          }
          h.update(r);
          h.update(String(st.size));
          h.update(String(Math.floor(st.mtimeMs)));
        }
      }
    };
    walk(s.absPath, '');
  }
  return h.digest('hex');
}

// 自动备份检查：开启 + 已配置 + 频率到期 + 内容有变化才上传。
// atStartup 区分启动那一轮与运行中的定期复查——「仅启动时」只在前者生效。
async function autoBackupCheck({ atStartup = false } = {}) {
  const config = getConfig();
  const w = config.webdav || {};
  if (!w.autoBackup) return { ok: false, skipped: 'disabled' };
  const cfg = webdavCfg();
  if (!cfg.url || !cfg.username) return { ok: false, skipped: 'no-config' };
  if (!atStartup && (w.autoBackupFreq || 'startup') === 'startup') return { ok: false, skipped: 'startup-only' };
  // 本机一次都没备份过时不自作主张上传：云端很可能躺着别的机器更完整的备份，而这一传会同时写下
  // 本机侧车、把「该恢复哪一份」指向眼前这份几乎空的本地状态，旧备份就再也选不到了。
  // 第一次备份必须由用户明确点一次，之后才是全自动。
  if (!w.everBackedUp) return { ok: false, skipped: 'needs-first-backup' };
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
    config.webdav.everBackedUp = true;
    saveConfig();
  }
  return up;
}

// 自动备份调度：启动跑一轮，之后按固定间隔复查（多久真备一次由 autoBackupFreq 决定）。
// 结果回传给宿主再转给界面——后台自动发生的事必须让用户看得见，否则就退化成静默行为。
const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000;
let autoTimer = null;

function startAutoBackup({ intervalMs = AUTO_CHECK_INTERVAL_MS, startupDelayMs = 0, onResult = () => {} } = {}) {
  const run = async (atStartup) => {
    let r;
    try {
      r = await autoBackupCheck({ atStartup });
    } catch (err) {
      r = { ok: false, error: String((err && err.message) || err) };
    }
    // 只上报「真的做了什么」「真的失败了」「明确需要用户出手」——普通的 skipped 是常态，不打扰
    const worthReporting = r.error || (r.ok && !r.skipped) || (atStartup && r.skipped === 'needs-first-backup');
    if (worthReporting) onResult(r);
    return r;
  };
  const startupTimer = setTimeout(() => run(true), startupDelayMs);
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(() => run(false), intervalMs);
  autoTimer.unref?.();
  return {
    stop() {
      clearTimeout(startupTimer);
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
      }
    },
  };
}

// ------------------------------ 恢复 ---------------------------------------
// 备份名由渲染进程回传，故收紧为不含路径分隔符的字符集，杜绝 ../ 穿越
const BACKUP_NAME_RE = /^cc-skill-backup-[A-Za-z0-9._-]+\.zip$/;
// 备份包里的目录名只允许是「单个路径片段」：不含分隔符、不是 . 或 ..。
// 这些值会被 path.join 进真实路径，放行就等于允许备份包在目标目录之外增删文件。
const isSafeSegment = (s) => typeof s === 'string' && s !== '.' && s !== '..' && /^[^\\/]+$/.test(s);

// 路径比对用的归一化：统一分隔符、去掉结尾斜杠、转小写（Windows 上大小写不敏感）
const normPath = (p) =>
  String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();

// 声明路径里有没有 .. 段。备份包是外来输入，任何需要 .. 的目标目录都当非法数据：
// expand('~/../..') 会落到 home 之外，等于把「写哪儿」交给包决定。
const hasDotDot = (p) =>
  String(p || '')
    .split(/[\\/]+/)
    .includes('..');

/**
 * 备份包里声明的 Agent 目录，只留下「本机用得上」的那些。
 * ~ 形式在哪儿都有意义；绝对路径则必须已经在本机配置里（knownDirs），或这一轮真的落过地
 * （dests，也就是用户确认过的那批）。否则一份外来备份就能把任意绝对路径并进本机配置，
 * 而配置里的目录在**下一次**恢复时会被当成「本机的」—— 正好绕过那道用户确认。
 */
function keepUsableDirs(agents, knownDirs, dests) {
  return (agents || []).map((a) => ({
    ...a,
    dirs: ((a && a.dirs) || []).filter((d) => isTilde(d) || knownDirs.has(normPath(d)) || dests.has(expand(d))),
  }));
}

/**
 * 本机配置里在用的 SKILL 目录（Agent 目录展开成绝对路径后的集合）。
 * 这是绝对路径能不能落地的**唯一**依据之一 —— 另一条依据是用户这次明确点头
 * （restoreApply 的 allowExternalDirs）。刻意不接受「备份包自己声明的目录」：
 * destDir 与包内 agents[].dirs 同出一包，让它们互相印证等于自证。
 */
function localSkillDirs() {
  const dirs = new Set();
  for (const a of getConfig().agents || []) {
    for (const d of (a && a.dirs) || []) {
      const abs = expand(d);
      if (abs) dirs.add(normPath(abs));
    }
  }
  return dirs;
}

/**
 * 旧版备份把上传机器的绝对路径原样写进了 manifest（那时还没有 ~ 归一化）。
 * 但同一份 manifest 的 settings 里，Agent 目录是 ~ 形式的——据此可以把旧路径还原：
 * 只要某条旧路径正好以某个 ~ 目录的相对部分结尾，就认定两者指向同一个位置。
 * 返回 null 表示无从判断，调用方必须跳过它，而不是照着旧路径硬写。
 */
function makeLegacyRemap(manifest) {
  const tildes = [];
  for (const a of (manifest.settings && manifest.settings.agents) || []) {
    for (const d of (a && a.dirs) || []) if (isTilde(d)) tildes.push(d);
  }
  return (absPath) => {
    const target = normPath(absPath);
    if (!target) return null;
    // 取最长的那个匹配：目录名有包含关系时才不会挑错
    let best = null;
    for (const t of tildes) {
      const rel = normPath(t.slice(2));
      if (rel && target.endsWith('/' + rel) && (!best || t.length > best.length)) best = t;
    }
    return best;
  };
}
// 全局最新的侧车文件（所有机器共享一份）
const META_FILE = 'latest.json';
// 本机专属的侧车文件。键用配置里的 machineId 而不是 hostname——
// 两台同名机器会写同一个文件名，互相把对方的备份当成「自己的」。
// hostname 只用于展示，仍需净化成文件名安全的字符集。
function hostMetaFile() {
  const id = String(getConfig().machineId || '').replace(/[^A-Za-z0-9._-]/g, '');
  return 'host-' + (id || 'unknown') + '.json';
}

// 云端目录实况：一次 PROPFIND 同时拿到备份名与侧车名（保留策略、机器档案、恢复都要用）
async function listRemote(cfg) {
  const xml = await (await davRequest(cfg, 'PROPFIND', davUrl(cfg, ''), { headers: { Depth: '1' } })).text();
  return {
    // 这两个名字都直接取自服务端返回的 XML，所以必须按形状过滤后再交给任何人用：
    // 一个说谎的服务器可以在 href 里塞 `cc-skill-backup-x/../../whatever.zip`，
    // 而下面的 `..` 会被 URL 解析折叠掉 —— 等于让它指定客户端去 DELETE 同主机上别的路径。
    // BACKUP_NAME_RE / SIDECAR_FILE_RE 都不含路径分隔符，这类名字一律进不来。
    backups: [...new Set(xml.match(/cc-skill-backup-[^<>]*?[.]zip/g) || [])].filter((n) => BACKUP_NAME_RE.test(n)).sort(),
    sidecars: [...new Set(xml.match(/host-[^<>/]*?[.]json/g) || [])].filter((n) => SIDECAR_FILE_RE.test(n)),
  };
}

/**
 * 读云端所有侧车。读不到或坏掉的一律以 meta=null 记着 —— 调用方要能区分
 * 「这台机器没有档案」与「档案坏了」，后者正是最该被清掉的那种。
 */
async function readSidecars(cfg, files) {
  const out = [];
  for (const file of files) {
    let meta = null;
    try {
      const parsed = JSON.parse(await (await davRequest(cfg, 'GET', davUrl(cfg, file))).text());
      if (parsed && typeof parsed === 'object') meta = parsed;
    } catch (_) {
      /* 坏掉的侧车照样列出来，好让用户能删 */
    }
    out.push({ file, meta });
  }
  return out;
}

// 列云端所有备份名（PROPFIND 列目录，按文件名时间戳排序）
async function listBackupNames(cfg) {
  return (await listRemote(cfg)).backups;
}

// 读一份侧车元数据。必须与目录实况对得上——上传中断、或该份备份已被保留策略清掉时一律作废降级
async function readMeta(cfg, file, names, expectMachineId) {
  try {
    const meta = JSON.parse(await (await davRequest(cfg, 'GET', davUrl(cfg, file))).text());
    if (!meta || !names.includes(meta.name)) return null;
    if (expectMachineId && meta.machineId !== expectMachineId) return null;
    return {
      name: meta.name,
      machineId: String(meta.machineId || ''),
      machineName: normalizeMachineName(meta.machineName),
      hostname: String(meta.hostname || ''),
      uploadedAt: String(meta.created || ''),
      entries: Number(meta.entries) || 0,
      size: Number(meta.size) || 0,
      agents: Array.isArray(meta.agents) ? meta.agents : [],
      projectCount: Number(meta.projectCount) || 0,
    };
  } catch (_) {
    return null;
  }
}

// 恢复第一步：列目录 + 读侧车元数据（几百字节，秒级返回），用于确认弹窗——不下载整包。
// 选哪一份：本机备份过就用本机那份，没备份过（新机器）就退回全局最新的一条。
async function restoreInfo() {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: M('请先填写 WebDAV 配置', 'Please fill in the WebDAV config first') };
  const names = await listBackupNames(cfg);
  if (!names.length) return { ok: false, error: M('云端没有找到任何备份', 'No backups found on the cloud') };
  const base = { ok: true, remote: cfg.url + cfg.remotePath };
  const mine = getConfig().machineId;

  const local = await readMeta(cfg, hostMetaFile(), names, mine);
  if (local) return { ...base, ...local, sameMachine: true, source: 'local', detailed: true };
  const latest = await readMeta(cfg, META_FILE, names);
  // sameMachine 是启发式而不是凭证（machineId 就在备份包里写着，不构成认证），
  // 它只用来决定「要不要提示用户认领」以及项目/绝对路径能不能直接用
  if (latest) return { ...base, ...latest, sameMachine: !!latest.machineId && latest.machineId === mine, source: 'latest', detailed: true };

  // 旧版备份没有侧车文件：退化成只读 HEAD 响应头，且无法按 Agent 勾选（只能整包恢复）
  const newest = names[names.length - 1];
  const head = await davRequest(cfg, 'HEAD', davUrl(cfg, newest));
  return {
    ...base,
    name: newest,
    machineId: '',
    machineName: '',
    hostname: '',
    uploadedAt: head.headers.get('last-modified') || '',
    entries: 0,
    size: Number(head.headers.get('content-length')) || 0,
    agents: [],
    projectCount: 0,
    sameMachine: false,
    source: 'latest',
    detailed: false,
  };
}

// ------------------------------ 机器身份 -------------------------------------

/**
 * 认领：把本机标识改成备份里那个。
 * 用来解决「重装系统后被当成新机器」——与其靠硬件指纹去猜（干净重装恰好会让 OS 级
 * 指纹重新生成，而硬件序列号最容易撞号），不如让用户明确断言「那份备份就是我」。
 * 认领之后 sameMachine 为真，项目与绝对路径目录一起回来；下一次备份还会重新写出
 * host-<id>.json，云端那边也重新认上，是一次性的。
 */
function adoptMachineId(id) {
  const clean = String(id || '').trim();
  if (!MACHINE_ID_RE.test(clean)) return { ok: false, error: M('机器标识不合法', 'Invalid machine id') };
  const changed = getConfig().machineId !== clean;
  if (changed) {
    getConfig().machineId = clean;
    saveConfig();
  }
  return { ok: true, machineId: clean, changed };
}

/** 重置本机标识：认领错了、或要把机器交出去时的退路 */
function resetMachineId() {
  getConfig().machineId = require('crypto').randomUUID();
  saveConfig();
  return { ok: true, machineId: getConfig().machineId };
}

// 侧车文件名只允许这个形状：它会被拼进 URL，放行 ../ 就等于允许删云端别的文件
const SIDECAR_FILE_RE = /^host-[A-Za-z0-9._-]+\.json$/;

/**
 * 云端机器档案：读所有 host-*.json 侧车。
 *
 * 一个必须说清楚的限制：备份 zip 的归属只能靠侧车里的 name 得知——zip 文件名不带机器
 * 标识，zip 里的 manifest 要下载才读得到。所以「某台机器有多少份备份」无从得知，
 * 这里只能给出它最近那一份（更早的快照本来就由保留策略收敛）。
 */
async function listMachines() {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: M('请先填写 WebDAV 配置', 'Please fill in the WebDAV config first') };
  const { backups, sidecars } = await listRemote(cfg);
  const mine = getConfig().machineId || '';
  const aliases = normalizeMachineNames(getConfig().machineNames);
  const machines = [];
  const referenced = new Set();
  // 侧车里的每个字段都来自云端（可能是别人写的、也可能是坏文件），一律先归一化再往下用：
  // 标识按形状校验、名字/主机名按机器名的规则限长去控制字符、备份名按备份名的形状校验
  for (const { file, meta } of await readSidecars(cfg, sidecars)) {
    const rawId = String((meta && meta.machineId) || '');
    const machineId = MACHINE_ID_RE.test(rawId) ? rawId : '';
    const self = !!machineId && machineId === mine;
    const selfName = normalizeMachineName(meta && meta.machineName);
    const hostname = normalizeMachineName(meta && meta.hostname);
    const rawBackup = String((meta && meta.name) || '');
    const backupName = BACKUP_NAME_RE.test(rawBackup) ? rawBackup : '';
    if (backupName && backups.includes(backupName)) referenced.add(backupName);
    machines.push({
      file,
      machineId,
      self,
      alias: aliases[machineId] || '',
      // 显示名优先级：本机名 > 本机起的别名 > 那台机器自己声明的名字 > hostname > 标识前 12 位
      name: (self ? machineDisplayName() : '') || aliases[machineId] || selfName || hostname || (machineId || file).slice(0, 12),
      selfName,
      hostname,
      backup: backupName
        ? {
            name: backupName,
            created: String((meta && meta.created) || ''),
            entries: Number((meta && meta.entries) || 0),
            size: Number((meta && meta.size) || 0),
            // 侧车指向的备份已经不在云端了（被保留策略清掉、或上传中断）
            present: backups.includes(backupName),
          }
        : null,
    });
  }
  machines.sort((a, b) => Number(b.self) - Number(a.self) || String(b.backup?.created || '').localeCompare(String(a.backup?.created || '')));
  // 本机还没在这里备份过（新装、或档案被移出/清掉了）时补一行空的自己：
  // 「云端机器档案」要能一眼看出「我在不在这儿」，也留个改名的入口
  if (mine && !machines.some((m) => m.self)) {
    machines.unshift({ file: '', machineId: mine, self: true, alias: '', name: machineDisplayName(), selfName: '', hostname: os.hostname(), backup: null });
  }
  // 全局最新那条也是有效引用（读不到本机侧车时的兜底路径就靠它），不算无主
  let latestName = '';
  try {
    latestName = String(JSON.parse(await (await davRequest(cfg, 'GET', davUrl(cfg, META_FILE))).text()).name || '');
  } catch (_) {
    /* 没有 latest.json 就没有兜底引用 */
  }
  return {
    ok: true,
    remote: cfg.url + cfg.remotePath,
    machines,
    orphans: backups.filter((n) => !referenced.has(n) && n !== latestName),
  };
}

/**
 * 把一台机器从云端档案里移出；deleteBackups 为真时连它最近那份备份一起删。
 * 本机自己的档案不给删——下一次备份会立刻把侧车写回来，要换身份请走认领或「重置标识」。
 */
async function forgetMachine({ file, deleteBackups = false } = {}) {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: M('请先填写 WebDAV 配置', 'Please fill in the WebDAV config first') };
  if (!SIDECAR_FILE_RE.test(String(file || ''))) return { ok: false, error: M('机器档案名不合法', 'Invalid machine profile name') };
  let meta = null;
  try {
    meta = JSON.parse(await (await davRequest(cfg, 'GET', davUrl(cfg, file))).text());
  } catch (_) {
    /* 读不到也允许删：坏掉的侧车正是最该清掉的 */
  }
  // 本机自己的档案不给删：下一次备份会立刻写回来，要换身份请走认领或「重置标识」。
  // 文件名也兜一道 —— 侧车坏掉读不出 machineId 时，只比标识的保护会静默失效
  if (file === hostMetaFile() || (meta && meta.machineId && meta.machineId === getConfig().machineId)) {
    return {
      ok: false,
      reason: 'self',
      error: M('这是本机的档案，要换身份请用「重置本机标识」', 'This profile is this machine — use “Reset machine id” instead'),
    };
  }
  let deletedBackup = '';
  if (deleteBackups && meta && BACKUP_NAME_RE.test(String(meta.name || ''))) {
    try {
      await davRequest(cfg, 'DELETE', davUrl(cfg, String(meta.name)));
      deletedBackup = String(meta.name);
    } catch (_) {
      /* 备份删不掉（可能已经不在了）不阻塞档案清理 */
    }
  }
  await davRequest(cfg, 'DELETE', davUrl(cfg, file));
  return { ok: true, deletedBackup };
}

/** 删掉一份无主备份（没被任何机器档案引用） */
async function deleteBackup({ name } = {}) {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: M('请先填写 WebDAV 配置', 'Please fill in the WebDAV config first') };
  if (!BACKUP_NAME_RE.test(String(name || ''))) return { ok: false, error: M('备份名不合法', 'Invalid backup name') };
  await davRequest(cfg, 'DELETE', davUrl(cfg, String(name)));
  return { ok: true, name };
}

// 恢复第二步（点击「确认恢复」后才会调用）：下载 → 解压 → 校验 manifest → 覆盖还原 SKILL 与配置
// 下载或校验失败时不会落地任何文件，本地数据不受影响。
// 只还原全局 SKILL：项目级 SKILL 随项目仓库走，在这里落地只会写进一个没人读的目录。
async function restoreApply({ name, agentIds, adoptMachine = false, allowExternalDirs = false }) {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: M('请先填写 WebDAV 配置', 'Please fill in the WebDAV config first') };
  if (!BACKUP_NAME_RE.test(String(name || ''))) {
    return { ok: false, error: M('备份名不合法', 'Invalid backup name') };
  }
  if (agentIds !== undefined && agentIds !== null && !Array.isArray(agentIds)) {
    return { ok: false, error: M('恢复范围参数不合法', 'Invalid restore scope') };
  }
  if (adoptMachine !== undefined && adoptMachine !== null && typeof adoptMachine !== 'boolean') {
    return { ok: false, error: M('认领参数不合法', 'Invalid adopt flag') };
  }
  if (allowExternalDirs !== undefined && allowExternalDirs !== null && typeof allowExternalDirs !== 'boolean') {
    return { ok: false, error: M('外部目录授权参数不合法', 'Invalid external-directory flag') };
  }
  // 显式传空数组 = 一个 Agent 都不选：整次恢复都是空操作，连配置也不该动。
  // 不这么挡的话，技能没恢复、本机的项目与 WebDAV 配置却已被备份里的覆盖了。
  if (Array.isArray(agentIds) && !agentIds.length) {
    return {
      ok: true,
      name,
      restored: 0,
      dests: [],
      appliedConfig: false,
      projectConfigSkipped: 0,
      skippedProjects: 0,
      skippedAgents: 0,
      skippedInvalid: 0,
      skippedExternal: [],
      externalDirs: [],
      relocated: [],
    };
  }
  // 不传 agentIds 视为全选，兼容不带勾选的旧调用
  const selected = Array.isArray(agentIds) ? new Set(agentIds) : null;
  // 认领会立刻落盘改身份，而恢复后续任何一步都可能失败 —— 失败时要把身份还回去，
  // 否则用户看到「恢复失败」，本机标识却已经成了别人的（下次备份会写进对方的档案）
  const machineIdBefore = getConfig().machineId;
  let claimedId = false;

  const tmpRoot = path.join(tempDir(), 'cc-skill-restore-' + Date.now());
  const zipPath = tmpRoot + '.zip';
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
  try {
    const dl = await davRequest(cfg, 'GET', davUrl(cfg, name));
    fs.writeFileSync(zipPath, Buffer.from(await dl.arrayBuffer()));
    await unpackZip(zipPath, tmpRoot);

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'manifest.json'), 'utf8'));
    } catch (_) {
      return {
        ok: false,
        error: M('备份包解析失败，可能下载不完整，请重试', 'Failed to parse the backup archive — the download may be incomplete, please retry'),
      };
    }
    if (!['CC Skill', 'SkillHarbor'].includes(manifest.app)) {
      return { ok: false, error: M('manifest 校验失败，不是 CC Skill 的备份', 'Manifest validation failed — not a CC Skill backup') };
    }

    // manifest 的结构先校验，再动任何东西 —— 认领会立刻落盘改身份，后面任何一步失败都会让
    // 用户看到「恢复失败」而标识已经被改掉（config.backup.json 也被覆盖了）。
    if (!Array.isArray(manifest.targets) || !Array.isArray(manifest.entries)) {
      return { ok: false, error: M('manifest 结构不合法，不是有效的备份', 'Malformed manifest — not a valid backup') };
    }

    // 认领：用户确认「这份备份就是我（比如刚重装过系统）」，于是把本机标识改成备份里那个。
    // 必须在算 sameMachine 之前完成。旧版备份没有这一项 → 认领无从谈起，按「不认领」继续，
    // 不该因为用户勾了一下就把整次恢复拒掉。
    if (adoptMachine && manifest.machineId) {
      const adopted = adoptMachineId(manifest.machineId);
      if (!adopted.ok) return adopted;
      claimedId = adopted.changed;
    }

    // 备份里的 config.json（旧版备份可能不带；解析不动就按空对象处理，不拖累 SKILL 恢复）
    let backupConfig = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'config.json'), 'utf8'));
      if (parsed && typeof parsed === 'object') backupConfig = parsed;
    } catch (_) {
      /* 旧版备份可能不带 config.json */
    }

    const targetById = new Map(manifest.targets.map((t) => [t.id, t]));
    let restored = 0;
    let skippedProjects = 0;
    let skippedAgents = 0;
    let skippedInvalid = 0;
    const externalDirs = new Map(); // 本机配置之外的绝对路径目录 -> SKILL 数（要用户点头才写）
    const relocated = new Map(); // 旧绝对路径 -> 还原后的 ~ 路径
    const dests = new Set();
    const legacyRemap = makeLegacyRemap(manifest);
    // 项目列表只在「同一台机器」的备份上还原：项目路径是机器相关的，换台电脑恢复过来的一串路径
    // 基本全是错的，还得用户手工清一遍。机器身份取自 manifest（旧版备份没有这一项 → 不还原）。
    const sameMachine = !!manifest.machineId && manifest.machineId === getConfig().machineId;
    // 允许写入的目录只有两个来源：
    //   1. 本机配置里现在就在用的 Agent 目录
    //   2. 用户在确认框里明确点过头的「本机配置之外的目录」（allowExternalDirs）
    // 绝不采信备份包自己声明的目录：destDir 与包内 agents[].dirs 同出一包，让它们互相印证
    // 等于让被恢复的那份文件自己给自己发通行证 —— 伪造 machineId + 一对自洽的目录，就能把
    // 文件写进任意绝对路径（已用 PoC 复现）。所以 gate 只能是「本机配置」或「用户」。
    const knownDirs = localSkillDirs();
    for (const e of manifest.entries) {
      const t = targetById.get(e.target);
      if (!t) continue;
      if (t.kind !== 'global') {
        skippedProjects++;
        continue;
      }
      if (selected && !(t.agentIds || []).some((id) => selected.has(id))) {
        skippedAgents++;
        continue;
      }
      // 这两个字段都来自备份包，可能被篡改或损坏。一个 ../ 的 folder 就能让下面的
      // rmSync 删掉目标目录之外的东西，所以先卡死在「单个路径片段」上。
      if (!isSafeSegment(t.id) || !isSafeSegment(e.folder)) {
        skippedInvalid++;
        continue;
      }
      const src = path.join(tmpRoot, 'data', t.id, e.folder);
      if (!fs.existsSync(src)) continue;
      // 落到哪儿：
      //   1. ~ 形式（现在的备份都这样）——按本机 home 展开
      //   2. 本机配置里在用的绝对路径目录——本来就在那儿（自定义 Agent 目录常在 home 之外，
      //      备份存不下 ~ 形式，只能用绝对路径），直接用
      //   3. 本机配置之外的绝对路径——只有用户这次确认过（allowExternalDirs）才写，
      //      否则收集起来交给界面去问
      //   4. 旧版备份的绝对路径——按 manifest 里声明的 ~ 目录重新映射
      // 声明里带 .. 或不是绝对路径的一律当非法数据丢掉：expand('~/../..') 会落到 home 之外，
      // 相对路径更会落到进程当前目录 —— 而备份包是外来输入，没有理由需要这样的目标目录。
      const raw = String(t.destDir || '');
      if (hasDotDot(raw) || (!isTilde(raw) && !path.isAbsolute(raw))) {
        skippedInvalid++;
        continue;
      }
      let declared = null;
      if (isTilde(raw)) declared = raw;
      else if (knownDirs.has(normPath(raw))) declared = raw;
      else if (allowExternalDirs) declared = raw;
      else declared = legacyRemap(raw);
      if (!declared) {
        // 映射不上：不是「无法解析」，而是「本机配置里没有这个目录」——交给用户判断
        externalDirs.set(raw, (externalDirs.get(raw) || 0) + 1);
        continue;
      }
      if (!isTilde(raw) && declared !== raw) relocated.set(raw, declared);
      const destDir = expand(declared);
      const dest = path.join(destDir, e.folder);
      fs.mkdirSync(destDir, { recursive: true });
      // 恢复目标可能是一条链接：走 removePath，别顺着它把唯一副本的内容删了
      removePath(dest);
      fs.cpSync(src, dest, { recursive: true });
      dests.add(destDir);
      restored++;
    }
    // 恢复设置文件（ Agents / 项目 / WebDAV / 界面语言 / 机器名 ）。
    // 上面已经把它读进来了（算 localDirs 时要用），这里直接接着用
    let appliedConfig = false;
    let projectConfigSkipped = 0;
    if (Object.keys(backupConfig).length) {
      try {
        const config = getConfig();
        const c = backupConfig;
        // Agent 目录按勾选合并（取并集），不整体替换——本机自定义过的目录不该被静默抹掉。
        // 但**只并「本机用得上」的目录**：~ 形式在哪儿都有意义；绝对路径必须是本机已有的、
        // 或这次真的写进去了的（用户已确认）。否则一份外来备份就能把任意绝对路径塞进本机配置，
        // 而配置里的目录在下次恢复时会被当成「本机的」—— 正好绕过刚加的那道确认。
        if (Array.isArray(c.agents)) config.agents = mergeAgentDirs(config.agents, keepUsableDirs(c.agents, knownDirs, dests), agentIds);
        if (Array.isArray(c.projects)) {
          if (sameMachine) config.projects = c.projects.filter((p) => p && p.id && p.dir);
          else projectConfigSkipped = c.projects.filter((p) => p && p.id && p.dir).length;
        }
        // 合并而非替换：旧备份的 config.json 里只有 lang，别把本地新加的界面偏好清掉
        if (c.ui) config.ui = normalizeUi({ ...config.ui, ...c.ui });
        if (c.webdav) config.webdav = { ...(config.webdav || {}), ...c.webdav, lastBackupAt: Date.now(), lastBackupHash: '' };
        // 机器名只跟「本机自己的备份」走：恢复别人的备份不该把本机改名。名字取自 manifest 顶层
        // （包内 config.json 里没有它），本机已经起过名就不覆盖 —— 非破坏性
        if (sameMachine && !normalizeMachineName(config.machineName)) {
          config.machineName = normalizeMachineName(manifest.machineName);
        }
        normalizeConfigInPlace();
        saveConfig();
        appliedConfig = true;
      } catch (_) {
        /* 配置恢复失败不影响 SKILL */
      }
    }
    return {
      ok: true,
      name,
      restored,
      dests: [...dests],
      appliedConfig,
      adoptedMachine: claimedId,
      projectConfigSkipped,
      sameMachine,
      skippedProjects,
      skippedAgents,
      skippedInvalid,
      relocated: [...relocated].map(([from, to]) => ({ from, to })),
      // 本机配置之外、这次没写的目录：界面拿它去问用户（列具体路径），确认后带
      // allowExternalDirs 再来一次。绝不默认写 —— 这些路径来自被恢复的那份包
      externalDirs: [...externalDirs].map(([dir, count]) => ({ dir, count })),
    };
  } catch (err) {
    // 认领是立刻落盘的：恢复中途失败就把身份还回去，免得用户看到「失败」而标识已成了别人的
    if (claimedId) {
      getConfig().machineId = machineIdBefore;
      saveConfig();
    }
    throw err;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
  }
}

module.exports = {
  webdavCfg,
  setWebdavConfig,
  testConnection,
  backup,
  autoBackupCheck,
  startAutoBackup,
  restoreInfo,
  restoreApply,
  listMachines,
  forgetMachine,
  deleteBackup,
  adoptMachineId,
  resetMachineId,
  snapshotHash,
  uploadSnapshot,
  BACKUP_NAME_RE,
  META_FILE,
  hostMetaFile,
};
