// CC Skill 主进程入口：只做启动装配——数据目录、配置初始化、IPC 注册、窗口与生命周期。
// 具体业务在 src/ 下按职责拆分，且不依赖 electron，可被 `node --test` 直接测试。
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const { setTempDir, sweepStaleTempDirs, resolveDataDir } = require('./src/paths');
const { classifyNavigation } = require('./src/nav');
const { logLine } = require('./src/applog');
const { initConfig } = require('./src/config');
const { initMainMessages } = require('./src/i18n');
const { registerIpcHandlers } = require('./src/ipc');
const { startAutoBackup } = require('./src/webdav');

let win = null;

// 应用同级目录：便携版取 exe 所在目录，开发模式取项目根目录
function appDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (app.isPackaged) return path.dirname(app.getPath('exe'));
  return app.getAppPath();
}

// 主进程侧的日志：与渲染层共用同一个 cc-skill.log，格式也一致
const logErr = (msg) => logLine(path.join(appDir(), 'cc-skill.log'), 'err', msg);
const logInfo = (msg) => logLine(path.join(appDir(), 'cc-skill.log'), 'info', msg);

// 数据目录：Windows / Linux 与 exe 同级（便携），macOS 用系统标准位置；
// 测试隔离：CC_SKILL_DATA_DIR 可覆盖。注意要在 setPath('userData') 之前取默认值。
const DATA_DIR = resolveDataDir({
  override: process.env.CC_SKILL_DATA_DIR,
  platform: process.platform,
  exeDir: appDir(),
  systemUserData: app.getPath('userData'),
});
// 首次运行时从 %APPDATA% 下的历史目录迁移 config.json（仅 Windows 有这个概念）
try {
  const legacyRoot = process.env.APPDATA;
  if (legacyRoot && !process.env.CC_SKILL_DATA_DIR && !fs.existsSync(path.join(DATA_DIR, 'config.json'))) {
    for (const legacy of ['cc-skill', 'CC Skill', 'skillharbor', 'skillhub']) {
      const oldCfg = path.join(legacyRoot, legacy, 'config.json');
      if (fs.existsSync(oldCfg)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.copyFileSync(oldCfg, path.join(DATA_DIR, 'config.json'));
        break;
      }
    }
  }
} catch (_) {
  /* 迁移失败按默认路径运行 */
}

setTempDir(app.getPath('temp'));
initMainMessages(app.getLocale());

// 启动时清掉上次进程被杀 / 崩溃时留下的临时工作目录（导入解压、备份打包、恢复解压）
try {
  sweepStaleTempDirs();
} catch (_) {
  /* 清理失败不影响启动 */
}

const USER_DATA_DIR = path.join(DATA_DIR, 'user-data');
// userData（Chromium 缓存等）与单实例锁都挂在配置目录下：便携版不留痕迹于 %APPDATA%，
// 且 CC_SKILL_DATA_DIR 隔离的测试实例不会和正式实例抢锁
app.setPath('userData', USER_DATA_DIR);

registerIpcHandlers({
  getWindow: () => win,
  appDir,
  userData: USER_DATA_DIR,
});

// 主进程的兜底：异常不该让窗口无声无息地消失。记日志，让用户能在操作日志里看到线索。
process.on('uncaughtException', (err) => logErr('主进程未捕获异常：' + String((err && err.stack) || err)));
process.on('unhandledRejection', (err) => logErr('主进程未处理的 Promise 拒绝：' + String((err && err.stack) || err)));

// ------------------------------ 窗口 ---------------------------------------
const INDEX_HTML = path.join(__dirname, 'renderer', 'index.html');
const APP_URL = pathToFileURL(INDEX_HTML).href;

/**
 * 窗口的护栏。三件事：
 * 1. 拦住一切把窗口带离 index.html 的导航——页面一旦被换掉，自绘标题栏和所有操作入口
 *    都会随 DOM 消失，用户只能杀进程（这正是「点 SKILL.md 里的相对链接就白屏」的成因）。
 * 2. 主 frame 加载失败 / 渲染进程退出后自动回到界面，不停在白屏上。
 * 3. 补上无菜单环境缺失的快捷键，给用户留一条自救的路。
 */
function guardWindow(win) {
  const onNavigate = (e, url) => {
    const verdict = classifyNavigation(url, { appUrl: APP_URL });
    if (verdict.action === 'allow') return;
    e.preventDefault();
    if (verdict.action === 'openExternal') {
      shell.openExternal(verdict.url).catch((err) => logErr('打开外链失败：' + String(err && err.message)));
      logInfo('已在系统默认程序打开链接：' + verdict.url);
      return;
    }
    if (verdict.action === 'openLocal') {
      if (fs.existsSync(verdict.path)) {
        shell.openPath(verdict.path);
        logInfo('已用系统默认程序打开：' + verdict.path);
      } else {
        logErr('拦截导航：目标文件不存在 ' + verdict.path);
      }
      return;
    }
    logErr('拦截导航（' + verdict.reason + '）：' + url);
  };

  win.webContents.on('will-navigate', onNavigate);
  // 服务端重定向与 meta refresh 走的是 will-redirect：只挂 will-navigate 的话，
  // 一个 302 就能把窗口带走，白屏那条路又通了
  win.webContents.on('will-redirect', onNavigate);

  // window.open / target=_blank：一律不开新窗口，外链转交系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    const verdict = classifyNavigation(url, { appUrl: APP_URL });
    if (verdict.action === 'openExternal') shell.openExternal(verdict.url).catch(() => {});
    else if (verdict.action === 'openLocal' && fs.existsSync(verdict.path)) shell.openPath(verdict.path);
    return { action: 'deny' };
  });

  // 自动恢复要带滑窗限流：界面本身坏掉时，无限重载只会把日志刷满
  let recoveries = 0;
  let lastRecoveryAt = 0;
  const recover = (why) => {
    const now = Date.now();
    if (now - lastRecoveryAt > 60000) recoveries = 0;
    if (recoveries >= 3) {
      logErr(why + '：一分钟内已自动恢复 3 次仍失败，停止重载，请查看开发者工具');
      return;
    }
    recoveries++;
    lastRecoveryAt = now;
    logErr(why + '：正在重新加载界面（第 ' + recoveries + ' 次）');
    if (win && !win.isDestroyed()) win.loadFile(INDEX_HTML);
  };

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 = ERR_ABORTED：正常的中断（如快速重载）也会触发，不算故障
    if (!isMainFrame || code === -3) return;
    recover('界面加载失败（' + (desc || code) + '）：' + url);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    recover('渲染进程退出（' + ((details && details.reason) || 'unknown') + '）');
  });

  // 无菜单环境下的逃生口：F5 / Ctrl+R 重载，F12 / Ctrl+Shift+I 开发者工具
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    const mod = input.control || input.meta;
    if (key === 'f5' || (mod && key === 'r' && !input.shift)) {
      win.webContents.reload();
      return;
    }
    if (key === 'f12' || (mod && input.shift && key === 'i')) win.webContents.toggleDevTools();
  });
}

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
    trafficLightPosition: { x: 14, y: 22 },
    autoHideMenuBar: true,
    title: 'CC Skill',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  guardWindow(win);
  win.loadFile(INDEX_HTML);
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
    initConfig(DATA_DIR);
    createWindow();
    // 自动备份：等窗口就绪再起，否则启动那一轮的结果推不出去；之后由定时器定期复查。
    // 结果一律转给界面——后台悄悄发生的事，用户有权知道。
    win.webContents.once('did-finish-load', () => {
      startAutoBackup({
        onResult: (r) => {
          if (win && !win.isDestroyed()) win.webContents.send('sync:autoResult', r);
        },
      });
    });
  });
  app.on('window-all-closed', () => app.quit());
}
