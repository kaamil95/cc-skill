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

- Node.js 18+ and Windows 10+ recommended (link-install relies on NTFS junctions).
- If the Electron binary download is slow (mainland China), set the mirror before installing:
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- The app has **zero runtime npm dependencies** besides Electron itself; the UI is vanilla HTML/CSS/JS in `renderer/`. Please keep it that way unless there is a strong reason.

## Project layout

```
main.js            Electron main process: scan / install / merge / WebDAV / config
preload.js         contextBridge API exposed to the renderer (whitelisted IPC channels)
renderer/          UI (vanilla JS, macOS-style theme)
  index.html       markup incl. modals
  app.js           all UI logic and state
  styles.css       theme
```

## Guidelines

- Keep IPC channels whitelisted in `preload.js`; do not enable `nodeIntegration`.
- Destructive operations must go to the Recycle Bin (`shell.trashItem`) and be confirmed in the UI.
- Every user-facing action should produce a toast (which is also written to the operation log).
- New features should work with the "one physical copy + junction links" model in mind, and must never leave a SKILL missing from an agent directory when a step fails (retry, then fall back to copy).
- UI text is Simplified Chinese; keep English terms like SKILL / Agent as-is.

## Pull requests

1. Fork → create a branch (`feat/xxx` or `fix/xxx`).
2. Keep changes focused; one PR per feature/fix.
3. Verify manually: scan, install (copy + link), merge duplicates, project install, WebDAV backup/restore against a local WebDAV server.
4. Update `CHANGELOG.md` under **Unreleased**.
5. Open the PR with a short description and screenshots for UI changes.

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

- 建议 Windows 10+ 与 Node.js 18+（链接安装依赖 NTFS junction）。
- Electron 二进制下载慢可设置镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- 除 Electron 外**零运行时依赖**，UI 为 `renderer/` 下的原生 HTML/CSS/JS，请保持这一特点。

### 约定

- IPC 通道必须在 `preload.js` 白名单内，不要开启 `nodeIntegration`。
- 破坏性操作必须走回收站（`shell.trashItem`）并在界面确认。
- 所有用户操作都要有 toast 提示（同时写入操作日志）。
- 新功能需兼容「一份实体副本 + junction 链接」模型；任何步骤失败都不能让某个 Agent 目录缺失该 SKILL（先重试，再兜底为副本）。
- 界面文案使用简体中文。

### 提交 PR

1. Fork → 新建分支（`feat/xxx` / `fix/xxx`）。
2. 一个 PR 聚焦一件事。
3. 手动验证：扫描、安装（副本 + 链接）、合并重复、项目安装、WebDAV 备份/恢复。
4. 在 `CHANGELOG.md` 的 **Unreleased** 下补充变更。
5. PR 描述写清改动点，UI 变更请附截图。
