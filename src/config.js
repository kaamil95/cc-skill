// 配置读写与自愈。数据目录由宿主注入（Electron 里是 exe 同级目录 / CC_SKILL_DATA_DIR），
// 因此本模块不依赖 electron，测试里可以指向临时目录。
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { toTilde, basenameOf } = require('./paths');

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

/** 配置导入 / 导出用的载荷（导出时不带 lastBackupAt / lastBackupHash） */
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
    config: { agents: config.agents, projects: config.projects, webdav: w, ui: config.ui || { lang: 'auto' } },
  };
}

module.exports = {
  DEFAULT_AGENTS,
  OVERLAY_LIMITS,
  OVERLAY_DEFAULTS,
  THEMES,
  THEME_BG,
  ACCENT_AUTO,
  themeBg,
  normalizeUi,
  initConfig,
  getConfig,
  configPath,
  saveConfig,
  loadConfig,
  normalizeConfigInPlace,
  mergeAgentDirs,
  buildConfigPayload,
};
