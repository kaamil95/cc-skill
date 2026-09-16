# Contributing to CC Skill

Thanks for your interest in contributing! Issues, bug reports, feature requests and pull requests are all welcome.

[中文](#中文) below.

## Development setup

```bash
git clone https://github.com/kaamil95/cc-skill.git
cd cc-skill
npm install
npm start
```

- Node.js 18+ and Windows 10+ or macOS 12+ (link-install uses NTFS junctions on Windows, symlinks on macOS).
- Building for macOS requires macOS — `npm run dist:mac` cannot be cross-compiled from Windows. Use the `Build macOS` workflow if you have no Mac.
- If the Electron binary download is slow (mainland China), set the mirror before installing:
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- The app has **zero runtime npm dependencies** besides Electron itself; the UI is vanilla HTML/CSS/JS in `renderer/`. Please keep it that way unless there is a strong reason.

## Project layout

```
main.js            Electron entry point: data dir, config init, IPC wiring, window, lifecycle
ipc-channels.js    single source of truth for the renderer-callable IPC channels
preload.js         contextBridge API exposed to the renderer
src/               main-process logic — deliberately free of electron imports, so it is unit-testable
  paths.js         platform differences (~ expansion, junction vs symlink, temp dir)
  config.js        config load / save / self-healing
  skills.js        SKILL.md parsing, directory scanning, skill CRUD
  zip.js           pack / unpack (PowerShell on Windows, zip/unzip elsewhere)
  webdav.js        WebDAV client, backup & restore
  ipc.js           IPC registration — the only src module that touches electron
renderer/          UI (vanilla JS, macOS-style theme)
  index.html       markup incl. modals
  app.js           all UI logic and state
  i18n.js          zh / en dictionary
  styles.css       theme
test/              node:test — unit tests plus integration tests against a stubbed WebDAV
```

## Checks

```bash
npm test            # unit + integration tests (stubbed electron & WebDAV — no network, no real config)
npm run lint        # ESLint
npm run format      # Prettier (also: npm run format:check)
```

The integration tests load the real `main.js` with a stubbed `electron` module and an isolated data
directory (`CC_SKILL_DATA_DIR`), then drive the actual IPC handlers — so they never touch your real
config, skills or cloud backup.

## Guidelines

- Keep IPC channels whitelisted in `ipc-channels.js`; do not enable `nodeIntegration`.
- Keep `src/` free of `electron` imports (inject what you need) so it stays testable.
- Destructive operations must go to the Recycle Bin (`shell.trashItem`) and be confirmed in the UI.
- Every user-facing action should produce a toast (which is also written to the operation log).
- New features should work with the "one physical copy + junction links" model in mind, and must never leave a SKILL missing from an agent directory when a step fails (retry, then fall back to copy).
- UI text is Simplified Chinese; keep English terms like SKILL / Agent as-is.

## Pull requests

1. Fork → create a branch (`feat/xxx` or `fix/xxx`).
2. Keep changes focused; one PR per feature/fix.
3. Make sure `npm run lint`, `npm run format:check` and `npm test` all pass (CI runs the same three).
4. Smoke-test the real app for anything the tests can't cover: scan, install (copy + link), merge duplicates, project install.
5. Update `CHANGELOG.md` under **Unreleased**.
6. Open the PR with a short description and screenshots for UI changes.

## Reporting bugs

Include: Windows version, CC Skill version (Help → about or package.json), steps to reproduce, expected vs actual behavior, and the `cc-skill.log` content if relevant (redact personal paths if you wish).

---

## 中文

感谢你关注 CC Skill！欢迎提交 Issue 与 PR。

### 开发环境

```bash
npm install
npm start
```

- 建议 Windows 10+ 或 macOS 12+、Node.js 18+（链接安装：Windows 用 NTFS junction，macOS 用 symlink）。
- 打 macOS 包必须在 macOS 上执行——`npm run dist:mac` 无法从 Windows 交叉编译；没有 Mac 就用 `Build macOS` 工作流。
- Electron 二进制下载慢可设置镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- 除 Electron 外**零运行时依赖**，UI 为 `renderer/` 下的原生 HTML/CSS/JS，请保持这一特点。

### 目录结构

```
main.js            主进程入口：数据目录、配置初始化、IPC 装配、窗口与生命周期
ipc-channels.js    渲染进程可调用的 IPC 通道白名单（唯一来源）
preload.js         contextBridge 暴露给渲染层的 API
src/               主进程业务逻辑——刻意不 import electron，因此可以直接单测
  paths.js         平台差异（~ 展开、junction/symlink、临时目录）
  config.js        配置读写与自愈
  skills.js        SKILL.md 解析、目录扫描、技能增删改查
  zip.js           打包 / 解压（Windows 走 PowerShell，其余走 zip/unzip）
  webdav.js        WebDAV 客户端、备份与恢复
  ipc.js           IPC 注册——src 里唯一接触 electron 的模块
renderer/          界面（原生 JS，macOS 风格）
  index.html       标记（含各弹窗）
  app.js           全部 UI 逻辑与状态
  i18n.js          中英词典
  styles.css       主题
test/              node:test —— 单测 + 对着桩 WebDAV 的集成测试
```

### 自检

```bash
npm test            # 单测 + 集成测试（桩 electron、桩 WebDAV，不联网、不碰真实配置）
npm run lint        # ESLint
npm run format      # Prettier（检查用 npm run format:check）
```

集成测试会用桩 electron 载入真实的 `main.js`，并把数据目录隔离到 `CC_SKILL_DATA_DIR` 指向的临时目录，
然后直接驱动真实的 IPC 处理器——所以不会碰你的真实配置、技能目录或云端备份。

### 约定

- IPC 通道必须在 `ipc-channels.js` 白名单内，不要开启 `nodeIntegration`。
- `src/` 里不要 import electron（需要什么就注入），以保持可测。
- 破坏性操作必须走回收站（`shell.trashItem`）并在界面确认。
- 所有用户操作都要有 toast 提示（同时写入操作日志）。
- 新功能需兼容「一份实体副本 + junction 链接」模型；任何步骤失败都不能让某个 Agent 目录缺失该 SKILL（先重试，再兜底为副本）。
- 界面文案使用简体中文。

### 提交 PR

1. Fork → 新建分支（`feat/xxx` / `fix/xxx`）。
2. 一个 PR 聚焦一件事。
3. 确保 `npm run lint`、`npm run format:check`、`npm test` 全绿（CI 跑的就是这三条）。
4. 测试覆盖不到的部分手动冒烟：扫描、安装（副本 + 链接）、合并重复、项目安装。
5. 在 `CHANGELOG.md` 的 **Unreleased** 下补充变更。
6. PR 描述写清改动点，UI 变更请附截图。
