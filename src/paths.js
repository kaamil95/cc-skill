// 平台差异与路径工具。刻意不依赖 electron —— 这些函数是纯的，能直接被单测调用。
const path = require('path');
const os = require('os');
const fs = require('fs');

/** 项目根目录（开发模式下等同 Electron 的 app.getAppPath()） */
const ROOT = path.join(__dirname, '..');

// Windows：junction 链接 + PowerShell 打包；macOS / Linux：symlink + zip/unzip
const IS_WIN = process.platform === 'win32';
const LINK_TYPE = IS_WIN ? 'junction' : 'dir';

// 临时目录由宿主注入（Electron 里是 app.getPath('temp')），默认取系统临时目录
let tempDirOverride = null;
function setTempDir(dir) {
  tempDirOverride = dir;
}
function tempDir() {
  return tempDirOverride || os.tmpdir();
}

/** 是否 ~ 开头的家目录相对路径。要求 ~ 后紧跟分隔符或结尾，避免把 ~foo 当成路径 */
const isTilde = (p) => /^~(?=$|[\\/])/.test(String(p || '').trim());

/** ~ 形式 → 本机绝对路径。跨机器同步的正确性完全建立在「两端各自展开自己的 home」之上 */
const expand = (p) => (isTilde(p) ? path.join(os.homedir(), String(p).trim().slice(1)) : p);

/**
 * 绝对路径 → ~ 形式，让配置能跨机器复用。
 * 两条硬要求：
 * 1. 必须做分隔符边界判断——只比对前缀会把 C:\Users\kaix 误判成 C:\Users\kai 之下的 ~/x，
 *    而路径一旦被这样写进配置就再也还原不回来。
 * 2. 必须先把两种分隔符统一再比对——Windows 上 C:\a\b 与 C:/a/b 是同一个目录，
 *    只比对原样字符串会漏掉正斜杠写法（手改配置、或别的工具写进去的路径常是这样）。
 * 同理，home 自身要收敛成 ~ 而不是 ~/。
 */
const toTilde = (p) => {
  const s = String(p || '').trim();
  if (!s || isTilde(s)) return s;
  const h = os.homedir().replace(/[\\/]+$/, '');
  if (!h) return s;
  // sn 只统一分隔符、保留原始大小写（它要用来切出相对部分）；
  // 小写化只用于比对，绝不能拿小写串去切片，否则会把路径的大小写吃掉
  const sn = s.replace(/\\/g, '/');
  const hn = h.replace(/\\/g, '/');
  const snLower = sn.toLowerCase();
  const hnLower = hn.toLowerCase();
  if (snLower !== hnLower && !snLower.startsWith(hnLower + '/')) return s;
  const rest = sn.slice(hn.length).replace(/\/+$/, '').split('/').filter(Boolean).join('/');
  return rest ? '~/' + rest : '~';
};

const basenameOf = (p) =>
  String(p || '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .pop() || String(p || '');

/** PowerShell 单引号字符串转义 */
const ps = (s) => String(s).replace(/'/g, "''");

/**
 * 解析数据目录（config.json / cc-skill.log / userData 的落点）。
 * - override（CC_SKILL_DATA_DIR）最优先：测试隔离与便携多实例
 * - macOS：.app 是只读的代码签名包，配置写进去会破坏签名、且随版本更新被覆盖，
 *   所以用系统标准位置（~/Library/Application Support/<App>）
 * - Windows / Linux：保持便携语义——配置与 exe 同级，整个目录拷走即可
 */
function resolveDataDir({ override, platform, exeDir, systemUserData }) {
  if (override) return override;
  return platform === 'darwin' ? systemUserData : exeDir;
}

// 本应用在临时目录下创建的名字：<前缀>-<毫秒时间戳>[.zip]。
// 必须精确到这个形状——只按前缀匹配会误删名字碰巧相似的其他目录。
const TEMP_DIR_RE = /^cc-skill-(?:import|fetch|sync|restore)-\d+(?:\.zip)?$/;

/**
 * 清理遗留的临时工作目录。
 * 正常流程里这些目录用完即删，但进程被杀 / 崩溃时会留下；启动时扫一遍避免长期堆积。
 * 只删名字完全匹配且超过 maxAgeMs 的，绝不碰正在进行中的操作，也不碰别人的目录。
 */
function sweepStaleTempDirs({ maxAgeMs = 3600000, matches = (name) => TEMP_DIR_RE.test(name) } = {}) {
  const root = tempDir();
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (_) {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    if (!matches(name)) continue;
    const full = path.join(root, name);
    try {
      if (now - fs.statSync(full).mtimeMs < maxAgeMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch (_) {
      /* 被占用就留给下次 */
    }
  }
  return removed;
}

/**
 * 删除一个路径；是链接就只摘掉链接本身。
 *
 * 绝不能用 `fs.rmSync(p, { recursive: true })` 删链接：在 Electron 44 的 Node 上它会
 * **顺着 junction 进到目标里去，把「唯一副本」的内容删光**，只留下一个空目录
 * （真机踩过：卸载链接把 `~/.agents/skills/<skill>/SKILL.md` 删了，界面还报「唯一副本保留」。
 * 系统 Node 24.13 上同一个调用是安全的，所以这个坑在 `node --test` 里测不出来）。
 *
 * `rmdir` 作用于重解析点本身，不会进去；POSIX 上的符号链接则要用 `unlink`。
 */
function removePath(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (_) {
    return; // 已经没了
  }
  if (st.isSymbolicLink()) {
    try {
      fs.rmdirSync(p); // Windows：junction / 目录符号链接
    } catch (_) {
      fs.unlinkSync(p); // POSIX 的符号链接，以及 Windows 上的文件符号链接
    }
    return;
  }
  fs.rmSync(p, { recursive: true, force: true });
}

module.exports = {
  ROOT,
  IS_WIN,
  LINK_TYPE,
  expand,
  isTilde,
  toTilde,
  basenameOf,
  ps,
  setTempDir,
  tempDir,
  sweepStaleTempDirs,
  resolveDataDir,
  removePath,
};
