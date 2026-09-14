<div align="center">

<img src="assets/icon-256.png" width="88" alt="CC Skill logo">

# CC Skill

**一个桌面应用，统一管理 Claude Code / Codex / OpenClaw / ZCode / Qoder 等 AI Agent 的 SKILL。**

扫描 · 预览 · 编辑 · 安装（副本或链接）· 去重合并 · 项目级管理 · WebDAV 云备份

[English](README.md) · [报告问题](../../issues) · [功能建议](../../issues)

![platform](https://img.shields.io/badge/platform-Windows%2010%2B-0078d4)
![electron](https://img.shields.io/badge/Electron-44-47848f)
![license](https://img.shields.io/badge/license-MIT-green)

</div>

---

CC Skill 是一个原生桌面应用（Electron），把散落在各个 AI CLI 目录里的 SKILL 收进一块面板。不用再把同一个 `SKILL.md` 文件夹复制进五六个目录——保留**一份实体副本**，处处可用。

## 为什么需要它

每个 AI CLI 都读自己的技能目录：

| Agent       | 默认目录                                 |
| ----------- | ---------------------------------------- |
| Claude Code | `~/.claude/skills`                       |
| Codex       | `~/.codex/skills`                        |
| OpenClaw    | `~/.openclaw/skills`                     |
| ZCode       | `~/.zcode/skills`                        |
| Qoder       | `~/.qoder/skills`                        |
| （共享约定）| `~/.agents/skills`                       |

给每个 Agent 都装一份，就意味着 N 份会各自发散的副本。CC Skill 用**副本 / 目录联接（junction）两种安装方式**、重复合并、项目级管理和 WebDAV 备份来解决这个问题。

## 功能

- 🔍 **统一扫描**：自动发现各 Agent 目录下的 SKILL（含平铺单文件 `.md`），侧栏分 Agent 计数
- 📄 **详情视图**：Markdown 预览、源码编辑、文件列表
- 📦 **随处安装**：复制到任意 Agent，或创建**目录联接（junction）**——所有 Agent 共用一份实体，改一处即时生效
- 🔗 **链接管理**：详情页列出已安装的链接，支持查看 / 打开 / 卸载 / 新增
- 🧹 **合并重复**：自动识别散落在多个目录的同名 SKILL，一键收敛为「1 份唯一副本 + N 个链接」（移入回收站可找回，失败自动重试并兜底为副本）
- 🗂 **项目级管理**：登记项目目录（如 `your-repo/.claude/skills`），全局 ⇄ 项目双向安装；项目目录强制用副本（Git 仓库中链接有误提交风险）
- 📊 **总览仪表盘**：统计磁贴、Agent / 项目分布、最近动态
- ☁️ **WebDAV 备份恢复**：自带服务器即可（坚果云 / Nextcloud / Alist …），一键打包全部实体 SKILL，可在任何机器恢复到对应目录
- 🧾 **操作日志**：所有操作留痕于应用内，并追加写入应用同级目录的 `cc-skill.log`

## 快速开始

```bash
git clone https://github.com/kaamil95/cc-skill.git
cd cc-skill
npm install           # 国内网络：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ 可加速
npm start             # 开发运行
npm run dist          # 打包便携版 exe（dist/CC Skill <version>.exe）
```

环境要求：Windows 10+（链接安装依赖 NTFS）、Node.js 18+。

> 每次发版都会在 [Releases](../../releases) 附上免安装便携版。

## 实现原理

- **副本安装**：普通递归复制到目标 Agent 目录。
- **链接安装**：在目标 Agent 目录内创建 NTFS **目录联接**（`fs.symlinkSync(target, dest, 'junction')`），指向唯一副本。无需管理员权限，要求同一磁盘。删除链接绝不会动唯一副本；删除唯一副本会警告有多少链接将失效；源丢失后的失效链接会被标记、可安全清理。
- **项目级管理**：扫描 `<project>/.claude|.agents|.zcode|.codex|.qoder/skills`。项目内安装强制副本。
- **WebDAV 备份**：把 `manifest.json` + 全部实体 SKILL 打成 zip PUT 到你的服务器；恢复时下载最近一份快照，按记录覆盖还原到对应目录。

## WebDAV 配置

设置 → WebDAV 云同步：

| 字段     | 示例                              |
| -------- | --------------------------------- |
| 服务器地址 | `https://dav.jianguoyun.com/dav/` |
| 用户名   | 账号                              |
| 密码     | 应用密码                          |
| 远程目录 | `/CC Skill`                       |

流程：测试连接 → 立即备份 → 恢复最近备份。仅使用 `PROPFIND / MKCOL / PUT / GET` 四个标准方法，兼容一切标准 WebDAV 服务。

## 常见问题

**支持 macOS / Linux 吗？**
界面本身跨平台，但链接安装依赖 NTFS junction。欢迎 PR 增加 unix symlink 支持。

**我的数据在哪？**
配置：`%APPDATA%\cc-skill\config.json`；日志：便携版在 exe 同级、开发模式在项目根目录。CC Skill 不会永久删除任何东西——删除一律进回收站。

**WebDAV 密码安全吗？**
密码明文保存在本机配置文件（与大多数同类工具一致）。建议使用服务方签发的应用密码，并妥善保管配置文件。

## 路线图

- [ ] 定时 / 自动备份
- [ ] macOS 与 Linux symlink 支持
- [ ] SKILL 市场 / 从 Git 一键安装
- [ ] 多语言界面

## 参与贡献

欢迎 Issue 和 PR，参见 [CONTRIBUTING.md](CONTRIBUTING.md)，请遵守[行为准则](CODE_OF_CONDUCT.md)。

## 许可证

[MIT](LICENSE)
