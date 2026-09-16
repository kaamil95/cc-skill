// WebDAV 云同步：参考 clash / cc-switch 的模式——用户自填 WebDAV 配置，支持连接测试、
// 全量快照备份（zip：manifest + 各目录 SKILL）、恢复最近备份。
// 不依赖 electron：配置从 ./config 取，临时目录从 ./paths 取。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { tempDir } = require('./paths');
const { M } = require('./i18n');
const { packZip, unpackZip } = require('./zip');
const { getConfig, saveConfig, buildConfigPayload, normalizeConfigInPlace, normalizeUi } = require('./config');
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
  saveConfig();
  return { ok: true, name: up.name, size: up.size, count: up.count, targets: up.targets };
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
      hostname: os.hostname(),
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

    // 元数据侧车文件：固定名、每次覆盖写，供恢复前的确认弹窗廉价读取（不必下载整包）
    // 上传失败不影响备份结果——restoreInfo 会降级为只读 HEAD 响应头
    try {
      const meta = {
        name,
        hostname: manifest.hostname,
        created: manifest.created,
        entries: manifest.entries.length,
        size: buf.length,
        targets: targets.size,
      };
      await davRequest(cfg, 'PUT', davUrl(cfg, META_FILE), {
        body: new Uint8Array(Buffer.from(JSON.stringify(meta))),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (_) {
      /* 侧车文件缺失时恢复流程仍可用，只是弹窗少两行信息 */
    }

    // 云端保留策略：备份 zip 只保留最近 10 份
    try {
      const list = await davRequest(cfg, 'PROPFIND', davUrl(cfg, ''), { headers: { Depth: '1' } });
      const xml = await list.text();
      const names = [...new Set(xml.match(/cc-skill-backup-[^<>]*?[.]zip/g) || [])].sort();
      for (const old of names.slice(0, Math.max(0, names.length - 10))) {
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

// 自动备份检查：开启 + 已配置 + 频率到期 + 内容有变化才上传；启动后与运行中定期调用
async function autoBackupCheck() {
  const config = getConfig();
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

// ------------------------------ 恢复 ---------------------------------------
// 备份名由渲染进程回传，故收紧为不含路径分隔符的字符集，杜绝 ../ 穿越
const BACKUP_NAME_RE = /^cc-skill-backup-[A-Za-z0-9._-]+\.zip$/;
const META_FILE = 'latest.json';

// 找最新一份备份（PROPFIND 列目录，按文件名时间戳排序取最后一份）
async function findLatestBackupName(cfg) {
  const res = await davRequest(cfg, 'PROPFIND', davUrl(cfg, ''), { headers: { Depth: '1' } });
  const xml = await res.text();
  const names = [...new Set(xml.match(/cc-skill-backup-[^<>]*?[.]zip/g) || [])].sort();
  return names.length ? names[names.length - 1] : null;
}

// 恢复第一步：列目录 + 读侧车元数据（几百字节，秒级返回），用于确认弹窗——不下载整包
async function restoreInfo() {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: M('请先填写 WebDAV 配置', 'Please fill in the WebDAV config first') };
  const name = await findLatestBackupName(cfg);
  if (!name) return { ok: false, error: M('云端没有找到任何备份', 'No backups found on the cloud') };
  const base = { ok: true, name, remote: cfg.url + cfg.remotePath };
  try {
    const meta = JSON.parse(await (await davRequest(cfg, 'GET', davUrl(cfg, META_FILE))).text());
    // name 对不上说明侧车文件与最新备份不同步（如上传中断），同样降级
    if (meta && meta.name === name) {
      return {
        ...base,
        hostname: String(meta.hostname || ''),
        uploadedAt: String(meta.created || ''),
        entries: Number(meta.entries) || 0,
        size: Number(meta.size) || 0,
        detailed: true,
      };
    }
  } catch (_) {
    /* 旧备份没有侧车文件，走下面的 HEAD 降级分支 */
  }
  const head = await davRequest(cfg, 'HEAD', davUrl(cfg, name));
  return {
    ...base,
    hostname: '',
    uploadedAt: head.headers.get('last-modified') || '',
    entries: 0,
    size: Number(head.headers.get('content-length')) || 0,
    detailed: false,
  };
}

// 恢复第二步（点击「确认恢复」后才会调用）：下载 → 解压 → 校验 manifest → 覆盖还原 SKILL 与配置
// 下载或校验失败时不会落地任何文件，本地数据不受影响
async function restoreApply({ name }) {
  const cfg = webdavCfg();
  if (!cfg.url) return { ok: false, error: M('请先填写 WebDAV 配置', 'Please fill in the WebDAV config first') };
  if (!BACKUP_NAME_RE.test(String(name || ''))) {
    return { ok: false, error: M('备份名不合法', 'Invalid backup name') };
  }

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
    // 恢复设置文件（ Agents / 项目 / WebDAV / 界面语言 ）
    let appliedConfig = false;
    const cfgFile = path.join(tmpRoot, 'config.json');
    if (fs.existsSync(cfgFile)) {
      try {
        const config = getConfig();
        const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        if (Array.isArray(c.agents)) config.agents = c.agents;
        if (Array.isArray(c.projects)) config.projects = c.projects.filter((p) => p && p.id && p.dir);
        // 合并而非替换：旧备份的 config.json 里只有 lang，别把本地新加的界面偏好清掉
        if (c.ui) config.ui = normalizeUi({ ...config.ui, ...c.ui });
        if (c.webdav) config.webdav = { ...(config.webdav || {}), ...c.webdav, lastBackupAt: Date.now(), lastBackupHash: '' };
        normalizeConfigInPlace();
        saveConfig();
        appliedConfig = true;
      } catch (_) {
        /* 配置恢复失败不影响 SKILL */
      }
    }
    return { ok: true, name, restored, dests: [...dests], appliedConfig };
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
  restoreInfo,
  restoreApply,
  snapshotHash,
  uploadSnapshot,
  BACKUP_NAME_RE,
  META_FILE,
};
