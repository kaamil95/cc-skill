// 在线更新：从 github.com 网页端拿最新版本与安装包直链，下载后在应用内静默升级并自动重启。
// 刻意不走 api.github.com：它的匿名额度是每 IP 每小时 60 次，代理出口 IP 一共享就常年 403，
// 而 github.com 网页端不按这套限流，也不需要任何 token。
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { httpGet, downloadToFile } = require('./net');
const { tempDir } = require('./paths');

// 发版仓库。tag 形如 v1.2.3，附件是 electron-builder 打的 exe / dmg（见 .github/workflows/release.yml）
const REPO = 'kaamil95/cc-skill';
const WEB_BASE = 'https://github.com/' + REPO;
// 安装包可能上百 MB（便携版把整个 Electron 打进去了），比 DEFAULT_MAX_BYTES 放宽
const UPDATE_MAX_BYTES = 300 * 1024 * 1024;
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

function parseVersion(v) {
  const m = String(v || '')
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// -1 / 0 / 1：a 小于 / 等于 / b。解析不了的版本一律当「无更新」，别把坏数据当升级理由
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// Release 附件里挑本平台安装包。macOS 打 x64 / arm64 两个 dmg，按 CPU 架构选；
// Windows 便携版一个 .exe
function pickAsset(assets, platform = process.platform, arch = process.arch) {
  const list = (assets || []).filter((a) => a && a.url);
  const name = (a) => String(a.name || '');
  if (platform === 'darwin') {
    const dmgs = list.filter((a) => /\.dmg$/i.test(name(a)));
    return dmgs.find((a) => (/arm64/i.test(name(a)) ? arch === 'arm64' : arch !== 'arm64')) || dmgs[0] || null;
  }
  return list.find((a) => /\.exe$/i.test(name(a))) || null;
}

// expanded_assets 页面里的直链。&amp; 之类要还原，否则下载地址带脏字符
function parseAssets(html) {
  const assets = [];
  const re = /href="([^"]*\/releases\/download\/[^"]+)"/g;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const href = m[1].replace(/&amp;/g, '&');
    const url = href.startsWith('http') ? href : 'https://github.com' + href;
    const name = decodeURIComponent(url.split('/').pop() || '');
    if (name && !assets.some((a) => a.url === url)) assets.push({ name, url });
  }
  return assets;
}

// 清单端点：发版工作流随 Release 上传 latest.json（版本号 + 各平台安装包直链），
// 检测走 GitHub 的稳定地址 releases/latest/download/latest.json——302 到哪份资产都不影响，
// body 就是纯 JSON。这是 Tauri updater（cc-switch 同款）的清单模式，不依赖重定向 URL / HTML 解析
const LATEST_JSON_URL = WEB_BASE + '/releases/latest/download/latest.json';

/** 从更新清单挑本平台的安装包：platforms 键为 win32 / darwin-arm64 / darwin-x64 */
function pickManifestUrl(platforms, platform = process.platform, arch = process.arch) {
  if (!platforms) return null;
  const keys = platform === 'darwin' ? [`darwin-${arch}`, 'darwin'] : [platform];
  for (const k of keys) {
    const url = platforms[k];
    if (url) return { name: decodeURIComponent(String(url).split('/').pop() || ''), url: String(url) };
  }
  return null;
}

// 从 releases/latest 的 HTML 里找版本号。重定向后的 res.url 在 Electron net.fetch 上不可靠，
// 所以优先解析页面里的 canonical / og:url / 任意 tag 链接
function parseTagFromReleasePage(url, html) {
  for (const text of [String(url || ''), String(html || '')]) {
    const canonical = text.match(/(?:rel="canonical" href="|property="og:url" content=")([^"]*\/releases\/tag\/([^/"]+))/);
    if (canonical) return decodeURIComponent(canonical[2]);
    const anyTag = text.match(/\/releases\/tag\/(v?\d+(?:\.\d+)+)/);
    if (anyTag) return decodeURIComponent(anyTag[1]);
  }
  return null;
}

/** 旧版 Release 没有 latest.json 时的回落：解析网页 */
async function checkUpdateFromWeb({ currentVersion, platform, arch } = {}) {
  const res = await httpGet(WEB_BASE + '/releases/latest', { timeoutMs: 30000 });
  const html = await res.text();
  const tag = parseTagFromReleasePage(res.url, html);
  if (!tag) throw new Error('找不到最新版本号（仓库还没有发布过版本？）');
  const latest = tag.replace(/^v/, '');

  const assetsRes = await httpGet(WEB_BASE + '/releases/expanded_assets/' + encodeURIComponent(tag), { timeoutMs: 30000 });
  const assets = parseAssets(await assetsRes.text());
  const asset = pickAsset(assets, platform, arch);

  return {
    ok: true,
    source: 'web',
    updateAvailable: compareVersions(latest, currentVersion) > 0,
    currentVersion: String(currentVersion || ''),
    latestVersion: latest,
    htmlUrl: `${WEB_BASE}/releases/tag/${tag}`,
    asset: asset || null,
  };
}

/** 查最新版本与安装包。主通道是 latest.json 清单；旧版 Release 没有清单时回落网页端解析 */
async function checkUpdate({ currentVersion, platform = process.platform, arch = process.arch } = {}) {
  try {
    const res = await httpGet(LATEST_JSON_URL, { timeoutMs: 30000 });
    const manifest = JSON.parse(await res.text());
    const latest = String(manifest.version || '').replace(/^v/, '');
    if (!latest) throw new Error('清单里没有版本号');
    const assetUrl = pickManifestUrl(manifest.platforms, platform, arch);
    return {
      ok: true,
      source: 'manifest',
      updateAvailable: compareVersions(latest, currentVersion) > 0,
      currentVersion: String(currentVersion || ''),
      latestVersion: latest,
      htmlUrl: `${WEB_BASE}/releases/tag/v${latest}`,
      asset: assetUrl || null,
    };
  } catch (err) {
    // 清单缺失（旧版 Release）/ 解析失败才走网页端；网络层错误原样抛出让用户看到真实原因
    if (err instanceof SyntaxError) throw err;
    const msg = String((err && err.message) || err);
    if (!/404|清单|latest\.json/i.test(msg)) throw err;
    return checkUpdateFromWeb({ currentVersion, platform, arch });
  }
}

// 下载 URL 只放行 GitHub 的发行附件域名——这个入口能把任意字节落到磁盘并执行，
// 渲染层给什么就下什么太危险（SKILL.md 里的内容都能把链接渲染到界面上）
function isGitHubReleaseUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'https:' && ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(u.host);
  } catch (_) {
    return false;
  }
}

/** 下载安装包到临时目录；返回本地路径，供「立即安装」静默升级 */
async function downloadUpdate({ url, version }) {
  if (!isGitHubReleaseUrl(url)) return { ok: false, reason: 'invalid-url' };
  const ext = path.extname(new URL(url).pathname) || '.bin';
  const dest = path.join(tempDir(), `cc-skill-${String(version || 'update').replace(/[^\w.-]/g, '_')}${ext}`);
  const r = await downloadToFile(url, dest, { timeoutMs: UPDATE_TIMEOUT_MS, maxBytes: UPDATE_MAX_BYTES });
  return { ok: true, path: r.path, bytes: r.bytes };
}

/** 静默升级脚本：先等应用完全退出（exe 还被占用时安装器写不进去），再 /S 静默重装（沿用注册表里的安装目录），装完自动重启 */
function buildUpdateBatch({ installerPath, appExe }) {
  return ['@echo off', 'ping -n 3 127.0.0.1 >nul', `"${installerPath}" /S`, `start "" "${appExe}"`, ''].join('\r\n');
}

/**
 * 退出应用 → 静默安装 → 自动重启。安装包只认本应用临时目录里刚下载的那个
 * （这个入口等于「执行任意 exe」，路径必须收死）；开发模式跑的是 electron.exe，
 * 静默升级打包版没有意义，直接拒绝。
 */
async function installUpdate({ installerPath, appExe, isPackaged }) {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported' };
  if (!isPackaged) return { ok: false, reason: 'dev-mode' };
  const safe = path.resolve(String(installerPath || ''));
  if (
    path.dirname(safe).toLowerCase() !== path.resolve(tempDir()).toLowerCase() ||
    !/^cc-skill-[\w.-]+\.exe$/i.test(path.basename(safe)) ||
    !fs.existsSync(safe)
  ) {
    return { ok: false, reason: 'invalid-path' };
  }
  const batchPath = path.join(tempDir(), 'cc-skill-update.cmd');
  fs.writeFileSync(batchPath, buildUpdateBatch({ installerPath: safe, appExe: String(appExe || '') }), 'utf8');
  const child = spawn('cmd.exe', ['/d', '/c', batchPath], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { ok: true };
}

module.exports = {
  REPO,
  LATEST_JSON_URL,
  parseVersion,
  compareVersions,
  pickAsset,
  parseAssets,
  pickManifestUrl,
  parseTagFromReleasePage,
  checkUpdate,
  downloadUpdate,
  buildUpdateBatch,
  installUpdate,
  isGitHubReleaseUrl,
};
