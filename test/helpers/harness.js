// 测试夹具：用桩 electron 载入真实的 main.js，再把全部 IPC 处理器取出来直接调用。
// 测试因此走的是真实代码路径（黑盒），重构内部结构不会让测试失效。
//
// 注意：每个测试文件是独立进程，一个进程只允许调用一次 startApp()
// （require 有缓存，且 CC_SKILL_DATA_DIR 是进程级环境变量）。
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');

const DEFAULT_CONFIG = {
  agents: [
    { id: 'claude-code', name: 'Claude Code', color: '#e07a4f', dirs: [] },
    { id: 'codex', name: 'Codex', color: '#19b39a', dirs: [] },
  ],
  projects: [],
  ui: { lang: 'zh' },
};

function makeElectronStub({ dataDir, workDir, trashItem }) {
  const handlers = new Map();
  // 如实记录 setPath：main.js 会 setPath('userData', <数据目录>/user-data)，getPath 得读回来
  const customPaths = new Map();
  // 窗口侧的行为也要如实建模：main.js 装了导航守卫、加载失败自愈、快捷键，
  // 桩缺一个方法就会在启动时把整个集成测试打断。listeners 让测试能真实触发这些事件。
  const windowState = {
    listeners: new Map(),
    loadFileCalls: [],
    openPathCalls: [],
    openExternalCalls: [],
    windowOpenHandler: null,
    backgroundColors: [],
    windowOptions: {},
  };
  const stub = {
    app: {
      isPackaged: false,
      // appDir() 会拿它当「exe 同级目录」——指向测试工作目录，
      // 免得 log:append 之类往真实仓库里写 cc-skill.log
      getAppPath: () => workDir,
      // 临时目录也指向工作目录：测试里应用产生的临时文件全部落在 workDir，随 cleanup 一起删掉，
      // 不会往真实 %TEMP% 里丢东西，也不会误删开发者机器上的既有残留
      getPath: (k) => customPaths.get(k) || (k === 'temp' ? path.join(workDir, 'temp') : path.join(dataDir, k)),
      getLocale: () => 'zh-CN',
      setPath: (k, v) => customPaths.set(k, v),
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on: () => {},
      quit: () => {},
    },
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    BrowserWindow: class {
      constructor(opts) {
        windowState.windowOptions = opts || {};
        this.webContents = { on: () => {}, once: () => {}, send: () => {} };
      }
      loadFile() {}
      on() {}
      isDestroyed() {
        return false;
      }
      setBackgroundColor(c) {
        windowState.backgroundColors.push(c);
      }
    },
    Menu: { setApplicationMenu: () => {} },
    // main.js 会把代理配置交给 session，并把 net.fetch 注入 src/net.js；
    // 桩如实记录 setProxy 的入参（代理映射才断言得了），net.fetch 则透传给真 fetch——
    // WebDAV / 市场的集成测试靠它打本地 HTTP 服务器，这里不能返回假响应
    session: { defaultSession: { setProxy: (cfg) => windowState.proxyConfigs.push(cfg) } },
    net: { fetch: (...args) => fetch(...args) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: {
      // 默认真的把路径删掉，模拟「已移入回收站」
      trashItem: trashItem || (async (p) => (fs.rmSync(p, { recursive: true, force: true }), true)),
      openPath: async (p) => (windowState.openPathCalls.push(p), ''),
      showItemInFolder: () => {},
      openExternal: async (u) => {
        windowState.openExternalCalls.push(u);
      },
    },
  };
  return { stub, handlers, windowState };
}

async function startApp({ config, trashItem } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-skill-test-'));
  const dataDir = path.join(workDir, 'data');
  const tempDir = path.join(workDir, 'temp');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  // 必须先写好配置：main.js 载入时就读它
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config || DEFAULT_CONFIG, null, 2), 'utf8');

  const { stub, handlers, windowState } = makeElectronStub({ dataDir, workDir, trashItem });
  const origLoad = Module._load;
  Module._load = function (request) {
    return request === 'electron' ? stub : origLoad.apply(this, arguments);
  };
  process.env.CC_SKILL_DATA_DIR = dataDir;
  try {
    require(path.join(ROOT, 'main.js'));
  } finally {
    Module._load = origLoad; // 载入完即还原，别污染后续 require
  }
  // main.js 在 app.whenReady().then() 里才 loadConfig()，等一个宏任务确保已跑完
  await new Promise((r) => setTimeout(r, 0));

  return {
    workDir,
    dataDir,
    tempDir,
    configPath: path.join(dataDir, 'config.json'),
    readConfig: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')),
    invoke(ch, payload) {
      const fn = handlers.get(ch);
      if (!fn) throw new Error('未注册的通道: ' + ch);
      return fn(null, payload);
    },
    channels: () => [...handlers.keys()],
    // 窗口侧的可观测状态：导航守卫 / 自愈 / 系统调用都从这里断言
    loadFileCalls: () => windowState.loadFileCalls,
    openPathCalls: () => windowState.openPathCalls,
    openExternalCalls: () => windowState.openExternalCalls,
    windowOpenHandler: () => windowState.windowOpenHandler,
    reloads: () => windowState.reloads,
    backgroundColors: () => windowState.backgroundColors,
    windowOptions: () => windowState.windowOptions,
    proxyConfigs: () => windowState.proxyConfigs,
    // 真实触发主进程挂在窗口上的事件（如 will-navigate），用来验证守卫确实拦住了
    emitWebContents(event, ...args) {
      for (const fn of windowState.listeners.get(event) || []) fn(...args);
    },
    cleanup() {
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

module.exports = { startApp, ROOT, DEFAULT_CONFIG };
