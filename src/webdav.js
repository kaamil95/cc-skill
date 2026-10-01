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
  webdavServerChanged,
} = require('./config');
const { scanAll, PROJECT_SUBDIR_AGENTS } = require('./skills');

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

// ------------------------------ 云端布局 -------------------------------------
// 每台机器一个子目录：<remotePath>/<slug>-<machineId>/，备份包与它的侧车都在里面。
//   machine.json                       这台机器是谁（显示名从这儿读，所以改名不用搬目录）
//   cc-skill-backup-<时间戳>.zip        备份包
//   cc-skill-backup-<时间戳>.zip.json   那一份里有什么（恢复弹窗靠它免下载整包）
// 目录名只为让人在网盘里认得出：slug 取自首次备份时的机器名，之后改名不搬目录；
// 完整标识写在名字尾部，所以 machine.json 丢了也还能从目录名认出是哪台。
const MACHINE_FILE = 'machine.json';
// 每台机器各自留这么多份。分目录之后不必再写「每台机器最近那份永不删」那个特例——
// 目录天然按机器分开了，别人的频繁备份挤不掉你的
const KEEP_PER_MACHINE = 10;
const SLUG_MAX = 24;

/** 机器名 → 纯 ASCII 的 slug：非 ASCII 一律折成 -，免得 WebDAV 路径编码出岔子 */
function slugify(name) {
  return [...String(name || '')]
    .map((ch) => (/[A-Za-z0-9]/.test(ch) ? ch.toLowerCase() : '-'))
    .join('')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
}

function machineDirName(machineId, name) {
  const id = String(machineId || '');
  const slug = slugify(name);
  return slug ? `${slug}-${id}` : id;
}

/** 目录名尾部的 UUID —— machine.json 坏掉时的兜底身份 */
function machineIdFromDir(dir) {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(String(dir || ''));
  return m ? m[1] : '';
}

/** 本机写进自己目录的档案。显示名在这里，所以改名不必动目录 */
function machineProfile() {
  return {
    machineId: getConfig().machineId || '',
    machineName: machineDisplayName(),
    hostname: os.hostname(),
    updatedAt: new Date().toISOString(),
  };
}

// 名字直接来自服务端，会被拼进后续请求的 URL —— 一个说谎的服务器可以在 href 里塞
// `x/../../whatever.zip`，而 `..` 会被 URL 解析折叠掉，等于让它指定客户端去删同主机上
// 别的路径。所以一律先卡死在「单个路径片段」上（备份包里的目录名同理）。
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

const lastSeg = (u) =>
  String(u || '')
    .replace(/\/+$/, '')
    .split('/')
    .pop();

/**
 * 解析 PROPFIND 的 multistatus。返回 { dirs, files }，各自是**单个路径片段**的集合
 * （名字取自 href 的最后一段）。命名空间前缀可有可无——不同服务商写法不一样。
 */
function parsePropfind(xml) {
  const dirs = new Set();
  const files = new Set();
  for (const block of String(xml || '').match(/<(?:\w+:)?response[\s>][\s\S]*?<\/(?:\w+:)?response>/gi) || []) {
    const href = /<(?:\w+:)?href>([\s\S]*?)<\/(?:\w+:)?href>/i.exec(block);
    if (!href) continue;
    let p = href[1].trim();
    try {
      p = decodeURIComponent(p);
    } catch (_) {
      /* 编码坏了就按原样看 */
    }
    const name = lastSeg(p);
    if (!isSafeSegment(name)) continue;
    if (/<(?:\w+:)?collection\s*\/?>/i.test(block)) dirs.add(name);
    else files.add(name);
  }
  return { dirs, files };
}

/** 列一个目录的直接子项。Depth:1 的结果里含被查询的目录自身，去掉它 */
async function listDir(cfg, url) {
  const xml = await (await davRequest(cfg, 'PROPFIND', url, { headers: { Depth: '1' } })).text();
  const { dirs, files } = parsePropfind(xml);
  dirs.delete(lastSeg(url));
  return { dirs, files };
}

/** 读一台机器的 machine.json。读不到或坏掉一律 null —— 调用方要能区分「没档案」与「档案坏了」 */
async function readMachineJson(cfg, dir) {
  try {
    const parsed = JSON.parse(await (await davRequest(cfg, 'GET', davUrl(cfg, dir + '/' + MACHINE_FILE))).text());
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function putJson(cfg, relPath, obj) {
  await davRequest(cfg, 'PUT', davUrl(cfg, relPath), {
    body: new Uint8Array(Buffer.from(JSON.stringify(obj))),
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 把本机的机器档案写到云端 —— 不备份任何 SKILL，只是让这台机器「存在」。
 * 只保存配置、还没备份过的机器由此也能出现在别的机器的列表里，否则它要等到第一次备份
 * 才被人看见。失败不打扰用户：下一次备份（或这次保存之后点「测试连接」）还会写。
 */
async function registerMachine() {
  const cfg = webdavCfg();
  if (!cfg.url || !getConfig().machineId) return { ok: false, reason: 'no-config' };
  const dir = await resolveMyDir(cfg);
  try {
    await davMkcolDeep(cfg, davUrl(cfg, dir));
    await putJson(cfg, dir + '/' + MACHINE_FILE, machineProfile());
    return { ok: true, dir };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * 本机在云端的目录。
 * 先按「当前机器名 + 标识」算一个；算出来的目录不在云端时，再在根目录里按 machine.json
 * （或目录名尾部的标识）找回原来那个 —— 机器改过名之后必须落回同一个目录，否则每改一次名
 * 就多一个目录，旧备份再也没人认领。都找不到才是新目录。
 */
async function resolveMyDir(cfg) {
  const mine = getConfig().machineId || '';
  const want = machineDirName(mine, machineDisplayName());
  let dirs = new Set();
  try {
    dirs = (await listDir(cfg, davUrl(cfg, ''))).dirs;
  } catch (_) {
    /* 根目录还不存在 —— 那就是新机器 */
  }
  if (dirs.has(want)) return want;
  for (const d of dirs) {
    const profile = await readMachineJson(cfg, d);
    if (profile && profile.machineId === mine) return d;
    if (!profile && machineIdFromDir(d) === mine) return d;
  }
  return want;
}

const zipName = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `cc-skill-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.zip`;
};

/** 备份名里的时间戳（YYYYMMDD-HHMMSS）→ ISO。列表里那些非最新的备份靠它显示时间，省一次请求 */
function createdFromName(name) {
  const m = /^cc-skill-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(name || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).toISOString() : '';
}

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
    // 随包上传的设置。三样刻意不进包：
    //   machineName / machineNames —— 机器名走 manifest 顶层，别名是本机自己的显示信息
    //   webdav.password            —— 包会躺在云端（还可能被分享出去），而恢复必须能连上云端，
    //                                 说明凭据本来就在本机配置里；把密码塞进包只是白白多一份泄露面
    //   用 buildConfigPayload(false)：它本来就删掉密码，导出文件那条路要带密码是用户显式勾的
    const settings = buildConfigPayload(false).config;
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
    // 设置文件随备份一同上传（ Agents / 项目 / WebDAV / 界面语言 ）。
    // webdav 里剥掉密码，理由见上面 settings 那段
    const packedWebdav = { ...webdavCfg() };
    delete packedWebdav.password;
    fs.writeFileSync(
      path.join(tmpRoot, 'config.json'),
      JSON.stringify(
        {
          ui: getConfig().ui || { lang: 'auto' },
          agents: getConfig().agents,
          projects: getConfig().projects,
          webdav: packedWebdav,
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
    const dir = await resolveMyDir(cfg);

    try {
      await davMkcolDeep(cfg, davUrl(cfg, dir));
    } catch (_) {
      /* 部分服务商禁止 MKCOL，PUT 阶段再验证 */
    }
    try {
      await davRequest(cfg, 'PUT', davUrl(cfg, dir + '/' + name), { body: new Uint8Array(buf), headers: { 'Content-Type': 'application/zip' } });
    } catch (err) {
      const msg = String(err.message || err);
      if (/HTTP (404|409)/.test(msg)) {
        return {
          ok: false,
          error: `远程目录 ${cfg.url + cfg.remotePath}/${dir} 不存在且无法通过 WebDAV 创建——请到网盘网页端手动创建该文件夹后重试`,
        };
      }
      if (/HTTP 401/.test(msg)) return { ok: false, error: '认证失败：请检查用户名 / 密码' };
      return { ok: false, error: msg };
    }

    // 侧车：这一份里有什么（恢复弹窗在下载整包之前就要渲染「上传设备 / 恢复范围 / 要重建哪些
    // Agent」，靠的就是它）。写失败不影响备份结果——restoreInfo 会降级为只读 HEAD 响应头
    const meta = buildMeta({ name, manifest, targets, size: buf.length, items });
    try {
      await putJson(cfg, dir + '/' + name + '.json', meta);
    } catch (_) {
      /* 侧车缺失时恢复流程仍可用，只是弹窗少几行信息 */
    }
    // 机器档案：别人（以及改名后的本机）靠它认出这是哪台
    try {
      await putJson(cfg, dir + '/' + MACHINE_FILE, machineProfile());
    } catch (_) {
      /* 同上；目录名尾部还有标识可认 */
    }

    // 保留策略：本目录最多 KEEP_PER_MACHINE 份，多的连同侧车一起删。
    // 只动自己这个目录 —— 别人的备份轮不到我们清理
    try {
      const { files } = await listDir(cfg, davUrl(cfg, dir));
      const names = [...files].filter((f) => BACKUP_NAME_RE.test(f)).sort();
      for (const old of names.slice(0, Math.max(0, names.length - KEEP_PER_MACHINE))) {
        for (const f of [old, old + '.json']) {
          try {
            await davRequest(cfg, 'DELETE', davUrl(cfg, dir + '/' + f));
          } catch (_) {
            /* 留着也不影响 */
          }
        }
      }
    } catch (_) {
      /* 保留策略失败不影响备份结果 */
    }

    return { ok: true, name, size: buf.length, count, targets: targets.size, hash: snapshotHash(items), dir };
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
 * 本机注册过的项目里、SKILL 真正会待的那些目录（`<项目>/<子目录>/skills`）。
 * 项目级 SKILL 只允许落到这里 —— 与全局那条「配置说了才算」是同一条规矩：
 * 备份包说它在哪个项目里不算数，本机注册过这个项目才算。
 */
function localProjectSkillDirs() {
  const dirs = new Set();
  for (const p of getConfig().projects || []) {
    const root = expand(p && p.dir);
    if (!root) continue;
    for (const sub of Object.keys(PROJECT_SUBDIR_AGENTS)) dirs.add(normPath(path.join(root, sub, 'skills')));
  }
  return dirs;
}

/**
 * 项目级 SKILL 的落点长什么样：`<任意前缀>/<子目录>/skills`，子目录是 Agent 那几种
 * （`.claude` / `.agents` / …）。形状不对的一律当非法数据丢掉 —— 只判「在项目目录之内」
 * 是不够的：项目根目录本身也在之内，一份声明 destDir 是项目根、folder 是 `.git` 的包
 * 就能把整个仓库连根删掉（已复现）。
 */
function isProjectSkillDir(abs) {
  const segs = normPath(abs).split('/').filter(Boolean);
  return segs.length >= 3 && segs[segs.length - 1] === 'skills' && Object.prototype.hasOwnProperty.call(PROJECT_SUBDIR_AGENTS, segs[segs.length - 2]);
}

/** 一份备份在云端的完整信息（下载整包之前先把弹窗渲染出来，靠的就是它） */
function metaOf(meta, name) {
  if (!meta || meta.name !== name) return null;
  return {
    name,
    machineId: String(meta.machineId || ''),
    machineName: normalizeMachineName(meta.machineName),
    hostname: String(meta.hostname || ''),
    uploadedAt: String(meta.created || ''),
    entries: Number(meta.entries) || 0,
    size: Number(meta.size) || 0,
    agents: Array.isArray(meta.agents) ? meta.agents : [],
    projectCount: Number(meta.projectCount) || 0,
  };
}

/** 读一份备份的侧车。读不到、坏掉、或它记的不是这一份，一律 null */
async function readBackupMeta(cfg, dir, name) {
  try {
    return metaOf(JSON.parse(await (await davRequest(cfg, 'GET', davUrl(cfg, `${dir}/${name}.json`))).text()), name);
  } catch (_) {
    return null;
  }
}

// 恢复第一步：列目录 + 读侧车元数据（几百字节，秒级返回），用于确认弹窗——不下载整包。
// 选哪一份：默认本机目录里最新那份；本机还没备份过（新机器）就退回最近上传的那台机器。
async function restoreInfo({ dir, name } = {}) {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: M('请先填写 WebDAV 配置', 'Please fill in the WebDAV config first') };
  if (dir !== undefined && dir !== null && !isSafeSegment(String(dir))) {
    return { ok: false, error: M('机器目录不合法', 'Invalid machine folder') };
  }
  const mine = getConfig().machineId || '';
  const wantDir = dir ? String(dir) : await resolveMyDir(cfg);
  const source = dir ? (dir === (await resolveMyDir(cfg)) ? 'local' : 'latest') : 'local';

  let backups = [];
  try {
    backups = [...(await listDir(cfg, davUrl(cfg, wantDir))).files].filter((f) => BACKUP_NAME_RE.test(f)).sort();
  } catch (_) {
    /* 目录不存在 —— 下面按「没有任何备份」处理 */
  }
  // 本机目录空 / 不存在时退回最近上传的那台机器：新机器第一次恢复只有这一条路
  if (!backups.length && !dir) {
    const all = await listMachines();
    if (!all.ok) return all;
    const other = all.machines
      .filter((m) => !m.self && m.backups.length)
      .sort((a, b) => String(b.latest?.created || '').localeCompare(String(a.latest?.created || '')))[0];
    if (!other) return { ok: false, error: M('云端没有找到任何备份', 'No backups found on the cloud') };
    return restoreInfo({ dir: other.dir });
  }
  const picked = name ? String(name) : backups[backups.length - 1];
  if (!picked || !BACKUP_NAME_RE.test(picked) || !backups.includes(picked)) {
    return { ok: false, error: M('云端没有找到任何备份', 'No backups found on the cloud') };
  }

  const remote = `${cfg.url}${cfg.remotePath}/${wantDir}`;
  const meta = await readBackupMeta(cfg, wantDir, picked);
  // sameMachine 是启发式而不是凭证（machineId 就在备份包里写着，不构成认证），
  // 它只用来决定「要不要提示用户认领」以及项目/绝对路径能不能直接用
  const sameMachine = !!meta?.machineId && meta.machineId === mine;
  if (meta) return { ok: true, remote, dir: wantDir, source, ...meta, sameMachine, detailed: true };

  // 侧车缺失（上传中断、或它已被保留策略清掉）：退化成只读 HEAD 响应头。
  // 没有 Agent 明细也就无法按 Agent 勾选，只能整包恢复
  const head = await davRequest(cfg, 'HEAD', davUrl(cfg, `${wantDir}/${picked}`));
  return {
    ok: true,
    remote,
    dir: wantDir,
    source,
    name: picked,
    machineId: '',
    machineName: '',
    hostname: '',
    uploadedAt: head.headers.get('last-modified') || '',
    entries: 0,
    size: Number(head.headers.get('content-length')) || 0,
    agents: [],
    projectCount: 0,
    sameMachine: false,
    detailed: false,
  };
}

// ------------------------------ 机器身份 -------------------------------------

/**
 * 认领：把本机标识改成备份里那个。
 * 用来解决「重装系统后被当成新机器」——与其靠硬件指纹去猜（干净重装恰好会让 OS 级
 * 指纹重新生成，而硬件序列号最容易撞号），不如让用户明确断言「那份备份就是我」。
 * 认领之后 sameMachine 为真，项目与项目级 SKILL 一起回来；下一次备份会写进那个目录
 * （resolveMyDir 按标识找到它），云端那边也重新认上，是一次性的。
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

/**
 * 云端机器档案：根目录下每个子目录就是一台机器。
 *
 * 每台机器列出它目录里的全部备份（挑历史副本就靠这个），但只为**最新那一份**读侧车
 * 拿明细（entries / size / agents）；更早的只给文件名与它自带的时间戳——每份都 GET 一遍
 * 会让十台机器的列表变成上百次请求。
 */
async function listMachines() {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: M('请先填写 WebDAV 配置', 'Please fill in the WebDAV config first') };
  const mine = getConfig().machineId || '';
  const aliases = normalizeMachineNames(getConfig().machineNames);
  let dirs = new Set();
  try {
    dirs = (await listDir(cfg, davUrl(cfg, ''))).dirs;
  } catch (_) {
    /* 根目录还不存在 = 云端什么都没有 */
  }
  const machines = [];
  for (const dir of [...dirs].sort()) {
    if (!isSafeSegment(dir)) continue;
    let files = [];
    try {
      files = [...(await listDir(cfg, davUrl(cfg, dir))).files];
    } catch (_) {
      /* 列不动就当空目录，档案还是要露出来（好让用户能删） */
    }
    const names = files.filter((f) => BACKUP_NAME_RE.test(f)).sort();
    // 档案里的每个字段都来自云端（可能是别人写的、也可能是坏文件），一律先归一化再往下用
    const profile = await readMachineJson(cfg, dir);
    const rawId = String((profile && profile.machineId) || '');
    const machineId = MACHINE_ID_RE.test(rawId) ? rawId : machineIdFromDir(dir) || '';
    const selfName = normalizeMachineName(profile && profile.machineName);
    const hostname = normalizeMachineName(profile && profile.hostname);
    const newest = names[names.length - 1] || '';
    const detail = newest ? await readBackupMeta(cfg, dir, newest) : null;
    const self = !!machineId && machineId === mine;
    machines.push({
      dir,
      machineId,
      self,
      // 档案读不出来：不是「这台机器没备份」，而是我们认不出它是谁 —— 仍列出来，仍可恢复、可删
      unreadable: !machineId,
      alias: aliases[machineId] || '',
      // 显示名优先级：本机名 > 本机起的别名 > 那台机器自己声明的名字 > hostname > 目录名
      name: (self ? machineDisplayName() : '') || aliases[machineId] || selfName || hostname || dir,
      selfName,
      hostname,
      backups: names.map((n) => ({ name: n, created: createdFromName(n) })),
      latest: detail
        ? {
            name: detail.name,
            created: detail.uploadedAt,
            entries: detail.entries,
            size: detail.size,
            projectCount: detail.projectCount,
            agents: detail.agents,
          }
        : newest
          ? { name: newest, created: createdFromName(newest), entries: 0, size: 0, projectCount: 0, agents: [] }
          : null,
    });
  }
  machines.sort((a, b) => Number(b.self) - Number(a.self) || String(b.latest?.created || '').localeCompare(String(a.latest?.created || '')));
  // 本机还没在这里备份过（新装、或目录被删了）时补一行空的自己：
  // 「云端机器档案」要能一眼看出「我在不在这儿」，也留一个改名的入口
  if (mine && !machines.some((m) => m.self)) {
    machines.unshift({
      dir: machineDirName(mine, machineDisplayName()),
      machineId: mine,
      self: true,
      unreadable: false,
      alias: '',
      name: machineDisplayName(),
      selfName: '',
      hostname: os.hostname(),
      backups: [],
      latest: null,
    });
  }
  return { ok: true, remote: cfg.url + cfg.remotePath, machines };
}

/**
 * 删掉一台机器的整个目录 —— 档案与它的全部备份一起。
 * 本机自己的目录不给删：下一次备份会立刻把它建回来，要换身份请走认领或「重置标识」。
 */
async function deleteMachine({ dir } = {}) {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: M('请先填写 WebDAV 配置', 'Please fill in the WebDAV config first') };
  const clean = String(dir || '');
  if (!isSafeSegment(clean)) return { ok: false, error: M('机器目录不合法', 'Invalid machine folder') };
  const profile = await readMachineJson(cfg, clean);
  const mine = getConfig().machineId || '';
  const want = machineDirName(mine, machineDisplayName());
  // 三处各自独立地比一遍：档案里写的标识、目录名尾部的标识、按当前名字算出来的目录名。
  // 只看档案的话，档案被写成别的标识（或写坏了）保护就静默失效；只看目录名的话，
  // 机器改过名之后那个名字就对不上了
  const isSelf = !!mine && (String((profile && profile.machineId) || '') === mine || machineIdFromDir(clean) === mine || clean === want);
  if (isSelf) {
    return {
      ok: false,
      reason: 'self',
      error: M('这是本机的目录，要换身份请用「重置本机标识」', 'This folder is this machine — use “Reset machine id” instead'),
    };
  }
  // 先数一遍份数：删掉之后就无从得知了，而确认框要写清楚删的是什么
  let count = 0;
  try {
    count = [...(await listDir(cfg, davUrl(cfg, clean))).files].filter((f) => BACKUP_NAME_RE.test(f)).length;
  } catch (_) {
    /* 列不动就按 0 报 */
  }
  await davRequest(cfg, 'DELETE', davUrl(cfg, clean));
  return { ok: true, dir: clean, deleted: count };
}

/** 删掉某台机器的一份备份（连同它那份侧车） */
async function deleteBackup({ dir, name } = {}) {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: M('请先填写 WebDAV 配置', 'Please fill in the WebDAV config first') };
  if (!isSafeSegment(String(dir || ''))) return { ok: false, error: M('机器目录不合法', 'Invalid machine folder') };
  if (!BACKUP_NAME_RE.test(String(name || ''))) return { ok: false, error: M('备份名不合法', 'Invalid backup name') };
  await davRequest(cfg, 'DELETE', davUrl(cfg, `${dir}/${name}`));
  try {
    await davRequest(cfg, 'DELETE', davUrl(cfg, `${dir}/${name}.json`));
  } catch (_) {
    /* 侧车可能本来就没写成功 */
  }
  return { ok: true, dir, name };
}

// 恢复第二步（点击「确认恢复」后才会调用）：下载 → 解压 → 校验 manifest → 覆盖还原 SKILL 与配置
// 下载或校验失败时不会落地任何文件，本地数据不受影响。
// 全局 SKILL 一律还原；项目级 SKILL 只在「这份备份是本机的」时还原——项目路径是机器相关的，
// 别台机器恢复过来的一串路径基本全是错的，还得用户手工清一遍。
async function restoreApply({ dir, name, agentIds, adoptMachine = false, allowExternalDirs = false }) {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: M('请先填写 WebDAV 配置', 'Please fill in the WebDAV config first') };
  // 目录名也由渲染进程回传（挑的是哪台机器的那一份），同样只允许单个路径片段
  if (!isSafeSegment(String(dir || ''))) {
    return { ok: false, error: M('机器目录不合法', 'Invalid machine folder') };
  }
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
      dir: String(dir),
      name,
      restored: 0,
      restoredProjects: 0,
      dests: [],
      appliedConfig: false,
      projectConfigSkipped: 0,
      passwordCleared: false,
      skippedProjects: 0,
      skippedAgents: 0,
      skippedInvalid: 0,
      externalDirs: [],
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
    const dl = await davRequest(cfg, 'GET', davUrl(cfg, `${dir}/${name}`));
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
    let restoredProjects = 0;
    let skippedProjects = 0;
    let skippedAgents = 0;
    let skippedInvalid = 0;
    const externalDirs = new Map(); // 本机配置之外的目录 -> SKILL 数（要用户点头才写）
    const dests = new Set();
    // 项目只在「同一台机器」的备份上还原：项目路径是机器相关的，换台电脑恢复过来的一串路径
    // 基本全是错的，还得用户手工清一遍。机器身份取自 manifest（认领之后这里就已经对上了）。
    const sameMachine = !!manifest.machineId && manifest.machineId === getConfig().machineId;
    // 允许写入的目录只有两个来源：
    //   1. 本机配置里现在就在用的 Agent 目录
    //   2. 用户在确认框里明确点过头的「本机配置之外的目录」（allowExternalDirs）
    // 绝不采信备份包自己声明的目录，**~ 形式也一样**：destDir 与包内 agents[].dirs 同出一包，
    // 让它们互相印证等于让被恢复的那份文件自己给自己发通行证 —— 伪造 machineId + 一对自洽的
    // 目录就能把文件写进任意位置（已用 PoC 复现）。~ 形式尤其危险：`~/` 底下是 .ssh、.aws 这些
    // 真东西，而一个 `destDir: '~'` 的包配上 folder `.ssh` 就能把整个目录删掉重建成一个目录。
    // 所以 gate 只能是「本机配置」或「用户」，与形式无关。
    const knownDirs = localSkillDirs();
    const projectEntries = []; // 项目级条目留到配置落地之后再处理（见下面那段注释）
    for (const e of manifest.entries) {
      const t = targetById.get(e.target);
      if (!t) continue;
      const isProject = t.kind !== 'global';
      // 项目级 SKILL 不受 Agent 勾选影响（那组勾选框的标题就写着「全局 SKILL」），
      // 但它有自己更硬的一道门：这份备份得是本机的
      if (isProject) {
        if (!sameMachine) skippedProjects++;
        else projectEntries.push([e, t]);
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
      // 声明里带 .. 或既不是 ~ 形式也不是绝对路径的一律当非法数据丢掉：expand('~/../..') 会落到
      // home 之外，相对路径更会落到进程当前目录 —— 而备份包是外来输入，没有理由需要这种目标目录。
      const raw = String(t.destDir || '');
      if (hasDotDot(raw) || (!isTilde(raw) && !path.isAbsolute(raw))) {
        skippedInvalid++;
        continue;
      }
      const abs = expand(raw);
      if (!abs) {
        skippedInvalid++;
        continue;
      }
      // 落点：本机配置里在用的目录直接用；配置之外的（无论写成 ~ 还是绝对路径）只有用户这次
      // 点过头才写，否则收集起来交给界面去问用户
      if (!knownDirs.has(normPath(abs)) && !allowExternalDirs) {
        externalDirs.set(raw, (externalDirs.get(raw) || 0) + 1);
        continue;
      }
      const dest = path.join(abs, e.folder);
      fs.mkdirSync(abs, { recursive: true });
      // 恢复目标可能是一条链接：走 removePath，别顺着它把唯一副本的内容删了
      removePath(dest);
      fs.cpSync(src, dest, { recursive: true });
      dests.add(abs);
      restored++;
    }
    // 恢复设置文件（ Agents / 项目 / WebDAV / 界面语言 / 机器名 ）。
    // 上面已经把它读进来了（算 localDirs 时要用），这里直接接着用
    let appliedConfig = false;
    let projectConfigSkipped = 0;
    let passwordCleared = false;
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
        if (c.webdav) {
          const local = config.webdav || {};
          const next = { ...local, ...c.webdav, lastBackupAt: Date.now(), lastBackupHash: '' };
          // 包里的地址或账号换成了别的（恢复的是别台机器的备份）→ 本机密码不能跟着走：
          // 那等于把密码送给备份里写的那个地址。包本身不带密码（见 uploadSnapshot）
          if (webdavServerChanged(local, c.webdav) && !c.webdav.password && local.password) {
            next.password = '';
            passwordCleared = true;
          }
          config.webdav = next;
        }
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
    // 项目级 SKILL 放到配置落地之后才处理：认领回来的项目列表是刚刚才写进本机配置的，
    // 而落点必须在本机注册过的项目里 —— 先算一遍的话，「重装 + 认领」第一次恢复会把
    // 项目 SKILL 全判成「项目没登记过」，得恢复两次才齐。
    // 本机不认识的落点走与全局同一条路：列给用户看，点头之后才写（allowExternalDirs）。
    if (projectEntries.length) {
      const allowed = localProjectSkillDirs();
      for (const [e, t] of projectEntries) {
        if (!isSafeSegment(t.id) || !isSafeSegment(e.folder)) {
          skippedInvalid++;
          continue;
        }
        const src = path.join(tmpRoot, 'data', t.id, e.folder);
        if (!fs.existsSync(src)) continue;
        const raw = String(t.destDir || '');
        if (hasDotDot(raw) || (!isTilde(raw) && !path.isAbsolute(raw))) {
          skippedInvalid++;
          continue;
        }
        const abs = expand(raw);
        // 形状必须先对：不是某个项目的 SKILL 目录就直接当非法数据，连确认的机会都不给
        if (!abs || !isProjectSkillDir(abs)) {
          skippedInvalid++;
          continue;
        }
        if (!allowed.has(normPath(abs)) && !allowExternalDirs) {
          externalDirs.set(raw, (externalDirs.get(raw) || 0) + 1);
          continue;
        }
        const dest = path.join(abs, e.folder);
        fs.mkdirSync(abs, { recursive: true });
        removePath(dest);
        fs.cpSync(src, dest, { recursive: true });
        restoredProjects++;
      }
    }
    return {
      ok: true,
      dir: String(dir),
      name,
      restored,
      restoredProjects,
      dests: [...dests],
      appliedConfig,
      adoptedMachine: claimedId,
      // 备份里的 WebDAV 地址与本机不同、包又不带密码时，本机密码会被清空（要重填）
      passwordCleared,
      projectConfigSkipped,
      sameMachine,
      skippedProjects,
      skippedAgents,
      skippedInvalid,
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
  registerMachine,
  autoBackupCheck,
  startAutoBackup,
  restoreInfo,
  restoreApply,
  listMachines,
  deleteMachine,
  deleteBackup,
  adoptMachineId,
  resetMachineId,
  snapshotHash,
  uploadSnapshot,
  BACKUP_NAME_RE,
  MACHINE_FILE,
  KEEP_PER_MACHINE,
  slugify,
  machineDirName,
  machineIdFromDir,
  createdFromName,
  parsePropfind,
};
