// IPC 注册层：electron 的依赖集中在这里，业务模块保持纯净可测。
// 每个通道都必须登记在 ipc-channels.js，否则启动即报错（见 handle 里的断言）。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcMain, dialog, shell } = require('electron');
const { IPC_CHANNEL_SET } = require('../ipc-channels');
const { expand, tempDir } = require('./paths');
const { resolveRef } = require('./nav');
const { logLine } = require('./applog');
const {
  DEFAULT_AGENTS,
  getConfig,
  saveConfig,
  normalizeConfigInPlace,
  normalizeUi,
  normalizeProxy,
  normalizeMarket,
  normalizeMachineName,
  renameMachine,
  machineDisplayName,
  buildConfigPayload,
  parseConfigPayload,
  applyConfigPayload,
  themeBg,
} = require('./config');
const { httpGet } = require('./net');
const market = require('./market');
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
  moveSkill,
  trashSkill,
} = require('./skills');
const { unpackZip } = require('./zip');
const webdav = require('./webdav');

function registerIpcHandlers({ getWindow, appDir, userData, applyProxy }) {
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
  // scan 的返回体里带上 WebDAV 配置（渲染层启动时要用），由这里拼装以保持 skills 模块纯净。
  // ok 必须显式给：handle 的兜底返回是 { ok:false }，渲染层据此区分「扫描成功但没内容」
  // 和「扫描整个失败了」——少了它，失败时渲染层会把 undefined 当数据用，界面停在空壳上。
  handle('scan', () => ({ ok: true, ...scanAll(), webdav: webdav.webdavCfg() }));

  handle('config:get', () => ({ agents: getConfig().agents }));
  handle('config:set', ({ agents, projects, ui, machineName }) => {
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
    // 机器名允许清空（清空 = 回落 hostname），所以只按「传没传」判断，不看真假值
    if (machineName !== undefined) config.machineName = normalizeMachineName(machineName);
    normalizeConfigInPlace();
    saveConfig();
    return { ok: true, agents: config.agents, projects: config.projects, ui: config.ui, machineName: machineDisplayName() };
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
  // SKILL.md 里点开的相对链接：按 skill 目录（baseDir）解析，绝不按页面目录。
  // 解析与「该不该放行」的判定全在 src/nav.js，渲染层只负责展示。
  handle('skill:readRef', ({ baseDir, href }) => {
    const ref = resolveRef(baseDir, href);
    if (!ref.ok || ref.kind !== 'text') return ref; // external / other / 失败原因原样回传
    return { ...ref, ...readSkill(ref.path) };
  });
  handle('skill:copy', (args) => copySkill(args));
  // 迁移本体：源路径、目标目录与冲突策略同 skill:copy；trashItem 注入方式也一致（回收站，不硬删）
  handle('skill:move', ({ srcPath, type, destDir, folderName, onConflict, leaveLink }) =>
    moveSkill({ srcPath, type, destDir, folderName, onConflict, leaveLink }, { trashItem: (abs) => shell.trashItem(abs) })
  );
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

  // ------------------------------ 配置文件 导出 / 导入 -------------------------
  // 与「机器」有关：换台机器、留个档、多套配置之间来回换，都靠这一对。
  // 解析与落地在 src/config.js（纯函数、可单测），这里只管弹窗与读写文件。
  handle('config:exportFile', async ({ includePassword = false } = {}) => {
    const stamp = new Date().toISOString().slice(0, 10);
    // 机器名可能带 : / * 之类文件名非法字符，先洗干净再拼默认文件名
    const slug = machineDisplayName().replace(/[\\/:*?"<>|]/g, '-');
    const r = await dialog.showSaveDialog(getWindow(), {
      defaultPath: `cc-skill-config-${slug}-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const payload = buildConfigPayload(!!includePassword);
    fs.writeFileSync(r.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, path: r.filePath, includePassword: !!includePassword, agents: payload.config.agents.length, projects: payload.config.projects.length };
  });

  // 只读 + 解析 + 给摘要：确认之前绝不改本机任何配置
  handle('config:importFile', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    let text;
    try {
      text = fs.readFileSync(r.filePaths[0], 'utf8');
    } catch (err) {
      return { ok: false, error: '读取文件失败：' + err.message };
    }
    const parsed = parseConfigPayload(text);
    if (!parsed.ok) return parsed;
    return { ok: true, path: r.filePaths[0], payload: parsed.payload, summary: parsed.summary };
  });

  // payload 经渲染层转了一手，这里重新校验（applyConfigPayload 内部会再做一次）
  handle('config:importApply', ({ payload, includeWebdav = false } = {}) => applyConfigPayload(payload, { includeWebdav: !!includeWebdav }));

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

  // 外链只允许交给系统浏览器。scheme 白名单是硬性的：渲染层的 href 来自 SKILL.md，
  // 是第三方内容，不能让它直接驱动 shell
  handle('shell:openUrl', async ({ url }) => {
    let u;
    try {
      u = new URL(String(url || ''));
    } catch (_) {
      return { ok: false, reason: 'invalid' };
    }
    if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) return { ok: false, reason: 'scheme' };
    await shell.openExternal(u.href);
    return { ok: true };
  });

  handle('app:paths', () => ({
    userData,
    home: os.homedir(),
    logFile: path.join(appDir(), 'cc-skill.log'),
    // 归一化后再下发：渲染层拿到的永远是完整对象，不会因为某个字段缺失而算出 0
    ui: normalizeUi(getConfig().ui),
    proxy: normalizeProxy(getConfig().proxy),
    market: normalizeMarket(getConfig().market),
    // 机器身份：名字给界面显示，完整标识用于「机器档案」里认领/比对。它本来就存在本机
    // config.json 里，下发给自己的渲染层不算泄露；进备份包才是要避免的（见 buildConfigPayload）
    machineId: getConfig().machineId || '',
    machineName: machineDisplayName(),
    hostname: os.hostname(),
    // 渲染层据此调整自绘标题栏：macOS 用系统原生红绿灯，不再画一套自己的窗口按钮
    platform: process.platform,
  }));

  // 操作日志落盘（渲染端每条 toast 都会同步一份），便于事后排查
  handle('log:append', ({ type, msg }) => logLine(path.join(appDir(), 'cc-skill.log'), type, msg));

  // ------------------------------ WebDAV 云同步 -------------------------------
  handle('sync:getConfig', () => ({ ok: true, webdav: webdav.webdavCfg() }));
  // 保存配置后顺手把本机的机器档案写上云：只保存不上传的话，这台机器要等到第一次备份
  // 才会出现在别的机器的列表里。失败不阻塞保存 —— 第一次备份还会写
  handle('sync:setConfig', async ({ webdav: w }) => {
    const r = webdav.setWebdavConfig(w);
    if (r.ok && webdav.webdavCfg().url) await webdav.registerMachine();
    return r;
  });
  handle('sync:test', () => webdav.testConnection());
  handle('sync:backup', () => webdav.backup());
  handle('sync:restoreInfo', ({ dir, name }) => webdav.restoreInfo({ dir, name }));
  handle('sync:restoreApply', ({ dir, name, agentIds, adoptMachine, allowExternalDirs }) =>
    webdav.restoreApply({ dir, name, agentIds, adoptMachine, allowExternalDirs })
  );

  // 机器档案：云端按机器分目录，每个目录一台机器；改名、认领、重置标识、删目录、删某一份备份
  handle('sync:machines', () => webdav.listMachines());
  handle('sync:renameMachine', ({ machineId, name }) => renameMachine(machineId, name));
  handle('sync:adoptMachine', ({ machineId }) => webdav.adoptMachineId(machineId));
  handle('sync:resetMachine', () => webdav.resetMachineId());
  handle('sync:deleteMachine', ({ dir }) => webdav.deleteMachine({ dir }));
  handle('sync:deleteBackup', ({ dir, name }) => webdav.deleteBackup({ dir, name }));

  // ------------------------------ 网络代理 ------------------------------------
  // 代理是本机配置（不进云备份）：手动模式可能带凭据，且 127.0.0.1 换台机器就不对了
  const apply = async (proxy) => {
    if (typeof applyProxy === 'function') await applyProxy(proxy);
  };

  handle('proxy:get', () => ({ ok: true, proxy: normalizeProxy(getConfig().proxy) }));
  handle('proxy:set', async ({ proxy }) => {
    const config = getConfig();
    config.proxy = normalizeProxy({ ...config.proxy, ...proxy });
    saveConfig();
    await apply(config.proxy);
    return { ok: true, proxy: config.proxy };
  });
  // 测试用「界面上刚填的值」而不是已保存的值——否则改了地址点测试，测的还是旧代理，
  // 结论会骗人。测完恢复成已保存的配置，不留副作用。
  handle('proxy:test', async ({ proxy }) => {
    const saved = normalizeProxy(getConfig().proxy);
    await apply(proxy ? normalizeProxy({ ...saved, ...proxy }) : saved);
    const t0 = Date.now();
    try {
      // 测的是 github.com 主站而不是 api.github.com：API 端点对匿名请求按出口 IP 限流
      //（走代理时出口是共享节点，动辄 403），会把「链路通」误报成「被拒」。主站没这个毛病。
      await httpGet('https://github.com/', { headers: { 'user-agent': 'cc-skill' }, timeoutMs: 15000 });
      return { ok: true, ms: Date.now() - t0 };
    } catch (err) {
      const msg = String((err && err.message) || err);
      // 拿到 HTTP 响应 = 请求确实到了对端，链路是通的，只是这个端点不肯给内容。
      // 只有网络层错误（DNS / 连不上 / 超时）才算「代理不通」—— 两者混成一句会误导人。
      const status = /^HTTP (\d{3})/.exec(msg);
      if (status) return { ok: true, ms: Date.now() - t0, httpStatus: Number(status[1]) };
      return { ok: false, error: msg };
    } finally {
      await apply(saved);
    }
  });

  // ------------------------------ SKILL 市场 ----------------------------------
  // 搜索/索引/取回都在主进程做：渲染层不该直接发网络请求，也免得绕开代理配置
  const token = () => normalizeMarket(getConfig().market).token;

  handle('market:setConfig', ({ indexUrl, token: tk }) => {
    const config = getConfig();
    config.market = normalizeMarket({ ...config.market, ...(indexUrl !== undefined ? { indexUrl } : {}), ...(tk !== undefined ? { token: tk } : {}) });
    saveConfig();
    return { ok: true, market: config.market };
  });
  // 聚合检索：skills.sh / SkillsMP / GitHub / 自定义索引并行，统一条目形状。
  // token 只发给 GitHub 域（ghHeaders 的纪律），skills.sh / SkillsMP / 索引站都不在其列
  handle('market:searchAll', ({ query, indexUrl, category, sortBy, page }) =>
    market.searchAll(query, {
      token: token(),
      // 显式传空串 = 不用自定义索引；只有不传才回退到配置里的索引地址
      indexUrl: typeof indexUrl === 'string' ? indexUrl : normalizeMarket(getConfig().market).indexUrl,
      category: typeof category === 'string' ? category : '',
      sortBy: typeof sortBy === 'string' && sortBy ? sortBy : 'popular',
      page: Number.isInteger(page) && page > 0 ? page : 1,
    })
  );
  // 描述回填：渲染层拿到列表后按行调用，描述与路径一次解析（skillCache 缓存 24h）
  handle('market:resolveOne', async (args) => ({
    ok: true,
    ...(await market.resolveEntry(
      { name: args.skillId, source: { kind: 'github', owner: args.owner, repo: args.repo, path: args.path || '' }, meta: { skillId: args.skillId } },
      { token: token() }
    )),
  }));
  // 仓库模式详情：列出仓库里的 SKILL，弹窗里挑一个看正文再装
  handle('market:repoSkills', (args) => market.repoSkills(args, { token: token() }));
  handle('market:listBuiltin', () => ({ ok: true, markets: market.listBuiltinMarkets() }));
  // 链接解析只在主进程做一处（src/market.js 的 parseSource）：渲染层再写一份必然会与它漂移
  handle('market:inspect', ({ source, raw }) => market.inspectSource(source || market.parseSource(raw), { token: token() }));
  // 详情弹窗：描述 + SKILL.md 正文 + 文件清单，一次拿齐
  handle('market:skillDetail', (args) => market.skillDetail(args, { token: token() }));
  // 只取回单个 SKILL 的目录（不下载整仓 zip），返回临时目录交给 skill:copy
  handle('market:fetchSkill', (args) => market.fetchSkillFiles(args, { token: token() }));
  // owner 头像：主进程取回转 data URL —— 渲染层的 CSP 只放行 data:，这里也顺带走代理
  handle('market:avatar', ({ owner }) => market.ownerAvatar({ owner }));

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
  // 换主题时同步窗口底色：窗口背景是原生层，不跟着改的话切到深色后重载会闪一下白
  handle('win:setBackground', ({ theme }) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return { ok: false };
    win.setBackgroundColor(themeBg(theme));
    return { ok: true };
  });
}

module.exports = { registerIpcHandlers };
