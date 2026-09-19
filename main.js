// CC Skill 主进程入口：只做启动装配——数据目录、配置初始化、IPC 注册、窗口与生命周期。
// 具体业务在 src/ 下按职责拆分，且不依赖 electron，可被 `node --test` 直接测试。
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const { setTempDir, sweepStaleTempDirs, resolveDataDir } = require('./src/paths');
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

// ------------------------------ 窗口 ---------------------------------------
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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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
