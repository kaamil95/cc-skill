// IPC 注册层：electron 的依赖集中在这里，业务模块保持纯净可测。
// 每个通道都必须登记在 ipc-channels.js，否则启动即报错（见 handle 里的断言）。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcMain, dialog, shell } = require('electron');
const { IPC_CHANNEL_SET } = require('../ipc-channels');
const { expand, tempDir } = require('./paths');
const { DEFAULT_AGENTS, getConfig, saveConfig, normalizeConfigInPlace, normalizeUi } = require('./config');
const {
  parseFrontmatter,
  firstParagraph,
  countFiles,
  findSkillRoot,
  scanAll,
  readSkill,
  writeSkill,
  listSkillFiles,
  copySkill,
  createSkill,
  compareSkills,
  trashSkill,
} = require('./skills');
const { unpackZip } = require('./zip');
const webdav = require('./webdav');

function registerIpcHandlers({ getWindow, appDir, userData }) {
  const handle = (ch, fn) => {
    // 白名单与处理器必须一一对应：漏进白名单的通道渲染进程永远调不到，这里直接拦在启动时
    if (!IPC_CHANNEL_SET.has(ch)) {
      throw new Error(`IPC 通道 ${ch} 未登记在 ipc-channels.js，渲染进程将无法调用`);
    }
    ipcMain.handle(ch, async (_e, payload) => {
      try {
        return await fn(payload || {});
      } catch (err) {
        return { ok: false, reason: 'error', error: String((err && err.message) || err) };
      }
    });
  };

  // ------------------------------ 扫描 / 配置 --------------------------------
  // scan 的返回体里带上 WebDAV 配置（渲染层启动时要用），由这里拼装以保持 skills 模块纯净
  handle('scan', () => ({ ...scanAll(), webdav: webdav.webdavCfg() }));

  handle('config:get', () => ({ agents: getConfig().agents }));
  handle('config:set', ({ agents, projects, ui }) => {
    // 各字段均可选：只传 ui 时（如「保存设置」）不会误伤 Agents / 项目
    const config = getConfig();
    if (agents !== undefined) {
      if (!Array.isArray(agents)) return { ok: false, reason: 'invalid' };
      config.agents = agents;
    }
    if (projects !== undefined) {
      if (!Array.isArray(projects)) return { ok: false, reason: 'invalid' };
      config.projects = projects.filter((p) => p && p.id && p.dir);
    }
    // 合并而非整体替换：只传 ui.lang 时不会把遮罩配置清掉
    if (ui) config.ui = normalizeUi({ ...config.ui, ...ui });
    normalizeConfigInPlace();
    saveConfig();
    return { ok: true, agents: config.agents, projects: config.projects, ui: config.ui };
  });
  handle('config:reset', () => {
    const config = getConfig();
    config.agents = JSON.parse(JSON.stringify(DEFAULT_AGENTS));
    config.projects = [];
    saveConfig();
    return { ok: true, agents: config.agents, projects: config.projects };
  });

  // ------------------------------ 技能操作 -----------------------------------
  handle('skill:read', ({ path: p }) => readSkill(p));
  handle('skill:write', ({ path: p, content }) => writeSkill(p, content));
  handle('skill:files', ({ dir, type }) => listSkillFiles(dir, type));
  handle('skill:copy', (args) => copySkill(args));
  handle('skill:trash', ({ path: p }) => trashSkill(p, { trashItem: (abs) => shell.trashItem(abs) }));
  handle('skill:create', (args) => createSkill(args));
  handle('skill:compare', ({ pathA, pathB }) => compareSkills({ pathA, pathB }));

  // ------------------------------ 对话框 / 导入 -------------------------------
  handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle('dialog:pickZip', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      properties: ['openFile'],
      filters: [
        { name: 'ZIP 压缩包', extensions: ['zip'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // 导入前检查：文件夹直接定位技能根；ZIP 先解压到临时目录再定位
  handle('import:inspect', async ({ source }) => {
    let src;
    const isZip = /\.zip$/i.test(source || '');
    if (isZip) {
      const tmpRoot = path.join(tempDir(), 'cc-skill-import-' + Date.now());
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.mkdirSync(tmpRoot, { recursive: true });
      await unpackZip(source, tmpRoot);
      src = findSkillRoot(tmpRoot);
    } else {
      src = findSkillRoot(expand(source));
    }
    if (!src) return { ok: false, reason: 'no-skill' };
    const md = path.join(src, 'SKILL.md');
    const p = parseFrontmatter(fs.readFileSync(md, 'utf8'));
    return {
      ok: true,
      skillRoot: src,
      folder: path.basename(src),
      name: p.meta.name || path.basename(src),
      description: p.meta.description || firstParagraph(p.body),
      fileCount: countFiles(src),
    };
  });

  // ------------------------------ 外壳 / 日志 / 路径 ---------------------------
  handle('shell:openPath', ({ path: p }) => shell.openPath(expand(p)));

  handle('app:paths', () => ({
    userData,
    home: os.homedir(),
    logFile: path.join(appDir(), 'cc-skill.log'),
    // 归一化后再下发：渲染层拿到的永远是完整对象，不会因为某个字段缺失而算出 0
    ui: normalizeUi(getConfig().ui),
    // 渲染层据此调整自绘标题栏：macOS 用系统原生红绿灯，不再画一套自己的窗口按钮
    platform: process.platform,
  }));

  // 操作日志落盘（渲染端每条 toast 都会同步一份），便于事后排查
  handle('log:append', ({ type, msg }) => {
    try {
      const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] [${String(type || 'info').toUpperCase()}] ${msg}\n`;
      fs.appendFileSync(path.join(appDir(), 'cc-skill.log'), line, 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // ------------------------------ WebDAV 云同步 -------------------------------
  handle('sync:getConfig', () => ({ ok: true, webdav: webdav.webdavCfg() }));
  handle('sync:setConfig', ({ webdav: w }) => webdav.setWebdavConfig(w));
  handle('sync:test', () => webdav.testConnection());
  handle('sync:backup', () => webdav.backup());
  handle('sync:restoreInfo', () => webdav.restoreInfo());
  handle('sync:restoreApply', ({ name, agentIds }) => webdav.restoreApply({ name, agentIds }));

  // ------------------------------ 窗口控制（自绘标题栏）----------------------
  handle('win:minimize', () => {
    const win = getWindow();
    if (win) win.minimize();
    return { ok: true };
  });
  handle('win:maximize', () => {
    const win = getWindow();
    if (!win) return { ok: false };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return { ok: true, maximized: win.isMaximized() };
  });
  handle('win:close', () => {
    const win = getWindow();
    if (win) win.close();
    return { ok: true };
  });
}

module.exports = { registerIpcHandlers };
