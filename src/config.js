// 配置读写与自愈。数据目录由宿主注入（Electron 里是 exe 同级目录 / CC_SKILL_DATA_DIR），
// 因此本模块不依赖 electron，测试里可以指向临时目录。
const path = require('path');
const fs = require('fs');
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
      return;
    }
  } catch (_) {
    /* 首次运行或损坏则重置 */
  }
  config = { agents: JSON.parse(JSON.stringify(DEFAULT_AGENTS)), projects: [], ui: normalizeUi(null) };
  saveConfig();
}

// 界面偏好：语言 + 弹窗遮罩的毛玻璃强度。越界 / 缺失一律回落到默认值，
// 免得手改 config.json 写进离谱的数字后界面直接看不见。
const OVERLAY_LIMITS = { blur: [0, 40], dim: [0, 0.8] };
const OVERLAY_DEFAULTS = { blur: 24, dim: 0.3 };

function normalizeUi(ui) {
  const clamp = (v, [lo, hi], dflt) => {
    // 注意 Number(null) === 0：空值必须先单独挡掉，否则「没配」会被当成「配成 0」
    if (v === null || v === undefined || v === '') return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  return {
    lang: ui && ['auto', 'zh', 'en'].includes(ui.lang) ? ui.lang : 'auto',
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
  normalizeUi,
  initConfig,
  getConfig,
  configPath,
  saveConfig,
  loadConfig,
  normalizeConfigInPlace,
  buildConfigPayload,
};
