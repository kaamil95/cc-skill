// 配置读写与自愈。数据目录由宿主注入（Electron 里是 exe 同级目录 / CC_SKILL_DATA_DIR），
// 因此本模块不依赖 electron，测试里可以指向临时目录。
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { toTilde, basenameOf } = require('./paths');
const { M } = require('./i18n');

// 默认 Agent 注册表：id / 显示名 / 主题色 / 默认技能目录（~ 开头，运行时展开）
// ~/.agents/skills 是多个 CLI 共享的技能目录（Claude Code 与 ZCode 均会读取）
const DEFAULT_AGENTS = [
  { id: 'claude-code', name: 'Claude Code', color: '#e07a4f', dirs: ['~/.claude/skills', '~/.agents/skills'] },
  { id: 'codex', name: 'Codex', color: '#19b39a', dirs: ['~/.codex/skills'] },
  { id: 'openclaw', name: 'OpenClaw', color: '#f0a35c', dirs: ['~/.openclaw/skills'] },
  { id: 'zcode', name: 'ZCode', color: '#4f8ef7', dirs: ['~/.zcode/skills', '~/.agents/skills'] },
  { id: 'qoder', name: 'Qoder', color: '#8b5cf6', dirs: ['~/.qoder/skills'] },
];

let config = null;
let dataDir = null;

function initConfig(dir) {
  dataDir = dir;
  loadConfig();
}

function getConfig() {
  return config;
}

function configPath() {
  return path.join(dataDir, 'config.json');
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  try {
    if (fs.existsSync(configPath())) {
      fs.copyFileSync(configPath(), path.join(path.dirname(configPath()), 'config.backup.json'));
    }
  } catch (_) {
    /* 备份失败不阻塞保存 */
  }
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (Array.isArray(raw.agents)) {
      config = raw;
      if (!Array.isArray(config.projects)) config.projects = [];
      config.ui = normalizeUi(config.ui);
      normalizeConfigInPlace();
      if (ensureMachineId()) saveConfig();
      return;
    }
  } catch (_) {
    /* 首次运行或损坏则重置 */
  }
  config = { agents: JSON.parse(JSON.stringify(DEFAULT_AGENTS)), projects: [], ui: normalizeUi(null) };
  normalizeConfigInPlace(); // 补齐 proxy / market 这类带默认值的字段
  ensureMachineId();
  saveConfig();
}

// 本机标识。云备份按「机器维度」存放（见 webdav 的 host-<id>.json 侧车），
// 拿 hostname 当键的话，两台同名机器（克隆的镜像、同批采购的机器）会互相顶掉对方的备份。
// 刻意不进 buildConfigPayload —— 它不该随备份跑到别的机器上去。
function ensureMachineId() {
  if (config.machineId) return false;
  config.machineId = crypto.randomUUID();
  return true;
}

// ------------------------------ 机器身份 -------------------------------------
// 不用硬件指纹是有意的：干净重装系统恰好会让 OS 级指纹（注册表 MachineGuid、卷序列号）
// 重新生成，剩下的硬件序列号反而是最不可靠的那几个（廉价主板常是 To be filled by
// O.E.M.，虚拟机与克隆盘会撞号）。撞号的后果是两台机器互相认领对方的归档——
// 认错成「同一台」比认成「不同台」危险得多，因为它不会报错，只会静静地做错事。
// 所以身份只认 machineId 这个随机 UUID，「重装后被当成新机器」交给用户认领来解决
// （见 webdav 的 adoptMachineId）。
//
// 名字分两层：
//   machineName    本机自己声明的名字，默认回落 hostname；随备份上传，别的机器看到的就是它
//   machineNames   本机给任意机器起的别名，只影响本机显示，绝不上传
const MACHINE_NAME_MAX = 40;
const MACHINE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** 机器名的归一化：去掉控制字符与换行（它要进 JSON 与界面），限长 40 */
function normalizeMachineName(raw) {
  if (typeof raw !== 'string') return '';
  // 逐字符判而不是写正则 [\x00-\x1f\x7f]：后者会被 eslint 的 no-control-regex 拦下
  // （那条规则是对的，只是这里确实要判控制字符），逐字符判反而更直白
  const cleaned = [...raw].map((ch) => (ch.codePointAt(0) < 32 || ch.codePointAt(0) === 127 ? ' ' : ch)).join('');
  return cleaned.replace(/\s+/g, ' ').trim().slice(0, MACHINE_NAME_MAX);
}

/** 机器别名表：id 与名字都得合法，脏条目直接丢掉 */
function normalizeMachineNames(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, name] of Object.entries(raw)) {
    if (!MACHINE_ID_RE.test(id)) continue;
    const n = normalizeMachineName(name);
    if (n) out[id] = n;
  }
  return out;
}

/** 本机对外显示的名字：用户没起名就用 hostname */
function machineDisplayName() {
  return normalizeMachineName(config.machineName) || os.hostname();
}

/**
 * 给机器改名。
 * - 本机：改 machineName，随备份上传，别的机器看到的就是它
 * - 别的机器：改本机别名 machineNames[id]，只影响本机显示。刻意不写回云端侧车——
 *   那台机器下次备份会用自己的名字覆盖掉，白改
 */
function renameMachine(machineId, name) {
  const id = String(machineId || '').trim();
  if (!MACHINE_ID_RE.test(id)) return { ok: false, error: M('机器标识不合法', 'Invalid machine id') };
  const clean = normalizeMachineName(name);
  if (!clean) return { ok: false, error: M('名字不能为空', 'The name cannot be empty') };
  const self = id === config.machineId;
  if (self) config.machineName = clean;
  else config.machineNames = { ...normalizeMachineNames(config.machineNames), [id]: clean };
  saveConfig();
  return { ok: true, name: clean, self };
}

// 界面偏好：语言 + 主题 + 强调色 + 弹窗遮罩的毛玻璃强度。越界 / 缺失一律回落到默认值，
// 免得手改 config.json 写进离谱的数字后界面直接看不见。
const OVERLAY_LIMITS = { blur: [0, 40], dim: [0, 0.8] };
const OVERLAY_DEFAULTS = { blur: 24, dim: 0.3 };

// 主题清单与各自的窗口底色。底色要在这里有一份，因为窗口是在渲染层之前创建的，
// 主进程得先铺对底色，否则切到深色主题后启动/重载会闪一下白。
// 具体的配色在 renderer/styles.css 里（[data-theme='...'] 块），这里只管窗口背景。
const THEMES = ['light', 'dark', 'sepia', 'contrast'];
const THEME_BG = { light: '#f5f5f7', dark: '#1b1b1e', sepia: '#f4efe6', contrast: '#ffffff' };
const ACCENT_AUTO = 'auto'; // 跟随主题自带的强调色
const ACCENT_RE = /^#[0-9a-f]{6}$/i;

const themeBg = (theme) => THEME_BG[THEMES.includes(theme) ? theme : 'light'];

// ------------------------------ 网络代理 -------------------------------------
// 代理是本机配置：不进云备份（127.0.0.1:7890 换台机器就是错的，URL 里还可能带密码）。
const PROXY_MODES = ['system', 'direct', 'manual'];
const PROXY_SCHEMES = ['http://', 'https://', 'socks5://', 'socks4://'];

function normalizeProxy(p) {
  const url = p && typeof p.url === 'string' ? p.url.trim() : '';
  return {
    // 默认 system：跟 Chromium 一致——系统配了代理就跟着走，没配就是直连
    mode: p && PROXY_MODES.includes(p.mode) ? p.mode : 'system',
    url: PROXY_SCHEMES.some((s) => url.toLowerCase().startsWith(s)) ? url : '',
    bypass: p && typeof p.bypass === 'string' ? p.bypass.trim() : '',
  };
}

/**
 * 代理配置 → Electron session.setProxy 的入参（纯映射，便于单测）。
 * 手动模式但地址为空时回落到 system：宁可跟随系统，也不要让网络整个断掉。
 * bypass 一律补上 <local>：本地回环地址走代理是绝大多数「连不上」的根源。
 */
function proxyToSessionConfig(proxy) {
  const p = normalizeProxy(proxy);
  if (p.mode === 'direct') return { mode: 'direct' };
  if (p.mode === 'manual' && p.url) {
    return { mode: 'fixed_servers', proxyRules: p.url, proxyBypassRules: [p.bypass, '<local>'].filter(Boolean).join(',') };
  }
  return { mode: 'system' };
}

/** 从代理 URL 里取出鉴权凭据；Chromium 不会自动使用 URL 里的 user:pass */
function proxyCredentials(proxy) {
  const p = normalizeProxy(proxy);
  if (p.mode !== 'manual' || !p.url) return null;
  try {
    const u = new URL(p.url);
    if (!u.username) return null;
    return { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password || '') };
  } catch (_) {
    return null;
  }
}

/**
 * 写日志 / 报错时用的代理地址：抹掉 user:pass。
 * 代理配置是本机敏感信息，明文凭据不该落到 cc-skill.log 里。
 * 传入的不是合法 URL（比如一整条错误信息）时按字符串粗暴处理，宁可多抹。
 */
function redactProxyUrl(url) {
  const s = String(url || '');
  if (!s) return s;
  try {
    const u = new URL(s);
    if (!u.username && !u.password) return s;
    u.username = u.password ? '***' : u.username;
    u.password = '';
    return u.toString();
  } catch (_) {
    return s.replace(/\/\/[^/@\s]*@/g, '//***@');
  }
}

// 市场：索引源地址与 GitHub token。同样是本机配置——token 是凭据，不该跟着备份走。
function normalizeMarket(m) {
  const indexUrl = m && typeof m.indexUrl === 'string' ? m.indexUrl.trim() : '';
  return {
    indexUrl: /^https?:\/\//i.test(indexUrl) ? indexUrl : '',
    token: m && typeof m.token === 'string' ? m.token.trim() : '',
  };
}

function normalizeUi(ui) {
  const clamp = (v, [lo, hi], dflt) => {
    // 注意 Number(null) === 0：空值必须先单独挡掉，否则「没配」会被当成「配成 0」
    if (v === null || v === undefined || v === '') return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const theme = ui && THEMES.includes(ui.theme) ? ui.theme : 'light';
  return {
    lang: ui && ['auto', 'zh', 'en'].includes(ui.lang) ? ui.lang : 'auto',
    theme,
    // 强调色只接受规范 6 位十六进制；其余（含缺失、乱填）一律 'auto' = 用主题自带的
    accent: ui && typeof ui.accent === 'string' && ACCENT_RE.test(ui.accent.trim()) ? ui.accent.trim().toLowerCase() : ACCENT_AUTO,
    overlayBlur: clamp(ui && ui.overlayBlur, OVERLAY_LIMITS.blur, OVERLAY_DEFAULTS.blur),
    overlayDim: clamp(ui && ui.overlayDim, OVERLAY_LIMITS.dim, OVERLAY_DEFAULTS.dim),
  };
}

// 自愈：项目名若被存成完整路径则回退为目录名；HOME 下的路径统一存 ~ 形式
function normalizeConfigInPlace() {
  for (const a of config.agents || []) {
    a.dirs = (a.dirs || []).map(toTilde).filter(Boolean);
  }
  // 代理与市场配置同样是「手改 config.json 也不该把界面/网络搞坏」的那类字段
  config.proxy = normalizeProxy(config.proxy);
  config.market = normalizeMarket(config.market);
  config.machineName = normalizeMachineName(config.machineName);
  config.machineNames = normalizeMachineNames(config.machineNames);
  for (const p of config.projects || []) {
    p.dir = toTilde(String(p.dir || '').trim());
    if (!p.name || /[\\/]/.test(p.name)) p.name = basenameOf(p.dir);
  }
}

/**
 * 恢复时按 Agent 合并技能目录：只并入用户勾选要重建的那些 Agent。
 * 取并集而非整体替换——宁可多出一个界面上可见、可手动删掉的目录，
 * 也不静默抹掉本机已有的 Agent 配置。
 */
function mergeAgentDirs(localAgents, incomingAgents, selectedIds) {
  const sel = Array.isArray(selectedIds) ? new Set(selectedIds) : null;
  const out = (localAgents || []).map((a) => ({ ...a, dirs: [...(a.dirs || [])] }));
  for (const inc of incomingAgents || []) {
    if (!inc || !inc.id) continue;
    if (sel && !sel.has(inc.id)) continue;
    const cur = out.find((a) => a.id === inc.id);
    const dirs = [...new Set([...(cur ? cur.dirs : []), ...(inc.dirs || [])].map(toTilde).filter(Boolean))];
    if (cur) cur.dirs = dirs;
    else out.push({ id: inc.id, name: inc.name || inc.id, color: inc.color, dirs });
  }
  return out;
}

/** 配置导入 / 导出用的载荷（导出时不带 lastBackupAt / lastBackupHash，也不带 machineId） */
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
    config: {
      agents: config.agents,
      projects: config.projects,
      webdav: w,
      ui: config.ui || { lang: 'auto' },
      // 机器名跟着走（换台机器不用重新起名）；machineId 不跟着走——那是身份，不是配置
      machineName: normalizeMachineName(config.machineName),
      machineNames: normalizeMachineNames(config.machineNames),
    },
  };
}

// ------------------------------ 配置文件导入 ---------------------------------

/**
 * 解析一份配置文件（用户选的文件内容，或渲染层回传的 payload）。
 * 返回 { ok:true, payload, summary } 或 { ok:false, reason, error }。
 * 校验条件沿用 v0.0.1：kind 标记 + agents 必须是数组——不满足就不是本应用的配置文件。
 */
function parseConfigPayload(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return { ok: false, reason: 'invalid-json', error: M('文件不是有效的 JSON', 'The file is not valid JSON') };
    }
  }
  const c = data && data.config;
  if (!data || data.kind !== 'config' || !c || !Array.isArray(c.agents)) {
    return { ok: false, reason: 'not-config', error: M('不是有效的 CC Skill 配置文件', 'Not a valid CC Skill config file') };
  }
  return { ok: true, payload: data, summary: configSummary(data, c) };
}

/** 导入摘要：确认框据此写清「用文件里的什么替换本机的什么」，所以只数真正会落地的条目 */
function configSummary(data, c) {
  const w = c.webdav || {};
  return {
    agents: normalizeAgents(c.agents).length,
    projects: Array.isArray(c.projects) ? c.projects.filter((p) => p && p.id && p.dir).length : 0,
    lang: (c.ui && c.ui.lang) || 'auto',
    webdav: !!w.url,
    password: !!w.password,
    machineName: normalizeMachineName(c.machineName),
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
  };
}

/**
 * 应用一份配置：Agent 与项目**替换**本机的，界面偏好合并，WebDAV 设置按开关决定。
 * 替换而非合并是「换台机器」该有的语义——调用方必须先让用户看清后果
 * （确认框里写「用 X 个 Agent / Y 个项目替换本机的 A 个 / B 个」）。
 * 传进来的 payload 同样不可信（它经渲染层转了一手），所以在这里重新校验一遍。
 *
 * 机器名与别名只做非破坏性合并：名字本机还没起过才采用文件里的，别名取并集。
 * 这两样是展示信息，覆盖掉本机已有的只会让人莫名其妙。
 */
function applyConfigPayload(payload, { includeWebdav = false } = {}) {
  const parsed = parseConfigPayload(payload);
  if (!parsed.ok) return parsed;
  const c = parsed.payload.config;
  config.agents = normalizeAgents(c.agents);
  config.projects = (Array.isArray(c.projects) ? c.projects : []).filter((p) => p && p.id && p.dir);
  if (c.ui) config.ui = normalizeUi({ ...config.ui, ...c.ui });
  // 密码跟不跟着走由用户决定：导出的文件可能被随手放进共享盘或仓库
  if (includeWebdav && c.webdav) config.webdav = { ...(config.webdav || {}), ...c.webdav };
  if (!normalizeMachineName(config.machineName)) config.machineName = normalizeMachineName(c.machineName);
  config.machineNames = { ...normalizeMachineNames(config.machineNames), ...normalizeMachineNames(c.machineNames) };
  normalizeConfigInPlace();
  saveConfig();
  return {
    ok: true,
    agents: config.agents,
    projects: config.projects,
    ui: config.ui,
    webdavApplied: !!(includeWebdav && c.webdav),
  };
}

/** 只留带 id 的 Agent，并把 dirs 收敛成字符串数组——外部文件里什么都可能有 */
function normalizeAgents(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((a) => a && typeof a.id === 'string' && a.id)
    .map((a) => ({ ...a, id: a.id, name: String(a.name || a.id), dirs: (Array.isArray(a.dirs) ? a.dirs : []).map(String) }));
}

module.exports = {
  DEFAULT_AGENTS,
  OVERLAY_LIMITS,
  OVERLAY_DEFAULTS,
  THEMES,
  THEME_BG,
  ACCENT_AUTO,
  themeBg,
  PROXY_MODES,
  normalizeProxy,
  proxyToSessionConfig,
  proxyCredentials,
  redactProxyUrl,
  normalizeMarket,
  normalizeUi,
  normalizeMachineName,
  normalizeMachineNames,
  machineDisplayName,
  renameMachine,
  MACHINE_ID_RE,
  initConfig,
  getConfig,
  configPath,
  saveConfig,
  loadConfig,
  normalizeConfigInPlace,
  mergeAgentDirs,
  buildConfigPayload,
  parseConfigPayload,
  applyConfigPayload,
};
