<div align="center">

<img src="assets/icon-256.png" width="88" alt="CC Skill logo">

# CC Skill

**一个桌面应用，统一管理 Claude Code / Codex / OpenClaw / ZCode / Qoder 等 AI Agent 的 SKILL。**

扫描 · 预览 · 编辑 · 安装（副本或链接）· 去重合并 · 项目级管理 · WebDAV 云备份

[English](README.en.md) · [报告问题](../../issues) · [功能建议](../../issues)

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
- 🎨 **四套主题 + 自选强调色**：浅色 / 深色 / 护眼 / 高对比，强调色可跟随主题或自己挑；全部颜色走 CSS 变量，深色下不会漏出白块
- 🛒 **发现 SKILL**：从 GitHub 仓库搜索、粘贴仓库 / 子目录 / zip 链接，或加载一份索引 JSON —— 下载解压后列出其中所有 SKILL，预览 `SKILL.md`，勾选后装进任意 Agent 目录（安装前会明确提示来源与风险）
- 🌐 **网络代理**：跟随系统 / 直连 / 手动（支持 `http://用户:密码@主机:端口` 与不走代理列表），附连接测试；WebDAV 同步与 SKILL 市场都走它
- ☁️ **WebDAV 备份恢复**：自带服务器即可（坚果云 / Nextcloud / Alist …），一键打包全部实体 SKILL，可在任何机器恢复到对应目录
- 🖥️ **机器身份与档案**：云端按机器分目录，一台机器有几份备份一眼可见；可恢复 / 改名 / 认领 / 删除机器。重装系统后在恢复弹窗勾一下「这就是这台电脑」，项目配置与它名下的项目 SKILL 一起回来。配置可导出成文件随身携带，也能从文件导入
- 🧾 **操作日志**：所有操作留痕于应用内，并追加写入应用同级目录的 `cc-skill.log`

## 快速开始

```bash
git clone https://github.com/kaamil95/cc-skill.git
cd cc-skill
npm install           # 国内网络：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ 可加速
npm start             # 开发运行
npm run dist          # 打包 Windows 便携版 exe（dist/CC Skill <version>.exe）
npm run dist:mac      # 打包 macOS dmg（必须在 macOS 上执行，见下）
```

环境要求：Windows 10+（链接安装依赖 NTFS）或 macOS 12+、Node.js 22+（开发与测试用；应用运行时用的是 Electron 自带的 Node）。

> 每次发版都会在 [Releases](../../releases) 附上免安装便携版。

### 打包 macOS 版

macOS 的 `.app` / `.dmg` **只能在 macOS 上构建**——electron-builder 无法从 Windows 交叉编译，签名与公证更是必须在本机。两条路：

- **有 Mac**：`npm ci && npm run dist:mac`，产物在 `dist/*.dmg`（同时出 Apple Silicon 与 Intel 两个架构）
- **没有 Mac**：在 GitHub 上手动触发 **Actions → Build macOS → Run workflow**，跑完在 Artifacts 里下载

未签名的包首次打开会被 Gatekeeper 拦住，右键 →「打开」即可放行（或 `xattr -cr "/Applications/CC Skill.app"`）。
要分发给别人，需要 Apple 开发者账号做签名 + 公证，否则对方每次都得手动放行。

macOS 上配置与日志存放在 `~/Library/Application Support/CC Skill/`——`.app` 是只读的代码签名包，
写进去会破坏签名，所以不沿用 Windows 的便携语义（Windows 便携版仍是配置与 exe 同级，整个目录拷走即可）。

### 发版

判断该发一版时，改版本号、写一句发版说明、打个 tag，剩下的交给 CI：

```bash
# 1. 改 package.json 的 version（如 0.0.2）
# 2. 把 CHANGELOG.md 的 [Unreleased] 整理成 ## [0.0.2] - 2026-10-01
git commit -am "chore: 发 0.0.2"
git tag v0.0.2 && git push origin main --tags
```

`Release` 工作流随即在 Windows 与 macOS 上各构建一次，把便携版 exe 与 dmg 一起挂到 Releases 上：

- **版本号以 `package.json` 为准**，tag 必须与之对得上（`v0.0.2` ↔ `version: "0.0.2"`），对不上直接失败——免得发出去的包和 Release 标题是两个版本号
- **发版说明取自 `CHANGELOG.md` 里对应版本那一节**（`scripts/release-notes.js`）；那一节还没写就退回 GitHub 自动生成的说明
- macOS 产物未签名，首次打开需右键 →「打开」（见上）

只想单独拿一个 dmg、不发版时，手动触发 **Actions → Build macOS**。

## 实现原理

- **副本安装**：普通递归复制到目标 Agent 目录。
- **链接安装**：在目标 Agent 目录内创建指向唯一副本的**目录链接**——Windows 用 NTFS 目录联接（`junction`，无需管理员权限、要求同一磁盘），macOS 用符号链接（`symlink`）。删除链接绝不会动唯一副本；删除唯一副本会警告有多少链接将失效；源丢失后的失效链接会被标记、可安全清理。
- **项目级管理**：扫描 `<project>/.claude|.agents|.zcode|.codex|.qoder/skills`。项目内安装强制副本。
- **WebDAV 备份**：把 `manifest.json` + 全部实体 SKILL 打成 zip PUT 到本机在云端的目录（每台机器一个子目录）；恢复时任选一台机器的任一份快照，按记录覆盖还原到对应目录。

## WebDAV 配置

设置 → WebDAV 云同步：

| 字段     | 示例                              |
| -------- | --------------------------------- |
| 服务器地址 | `https://dav.jianguoyun.com/dav/` |
| 用户名   | 账号                              |
| 密码     | 应用密码                          |

流程：测试连接 → 立即备份 → 恢复最近备份。**保存配置的那一刻，本机的机器档案就会写上云**——还没备份过的新机器也能立刻出现在其他机器的列表里。仅使用 `PROPFIND / MKCOL / PUT / GET` 四个标准方法，兼容一切标准 WebDAV 服务。

### 多台机器共用一份云端

云端**按机器分目录**：根目录固定为 `cc-skill-sync`（界面里不再有要填的远程目录），下面每台机器一个子目录，名字是「机器名 + 完整标识」，比如 `kai-pc-8c2f1d4e-1a2b-4c3d-9e8f-0123456789ab`：

```
cc-skill-sync/
  kai-pc-8c2f1d4e-1a2b-4c3d-9e8f-0123456789ab/
    machine.json                       这台机器是谁（改名只改这里，不搬目录）
    cc-skill-backup-20261001-022130.zip
    cc-skill-backup-20261001-022130.zip.json   这一份里有什么
  old-mbp-3d7a1b90-2c4e-4f61-8a55-9b0c1d2e3f40/
    ...
```

于是备份归属不再需要猜：一台机器有几份备份、哪份是谁的，看目录就知道。每台机器各自保留最近 10 份，别人的频繁备份挤不掉你的。

恢复时想用哪台机器、哪一份都行——「云端机器档案」里点开一台机器就能看到它的全部副本（时间 / 大小 / SKILL 数）逐份挑。**用别的机器的备份恢复本机时只还原全局 SKILL**：项目路径是机器相关的，从别处恢复过来的一串路径基本全是错的；用本机自己的备份恢复则连项目级 SKILL 一起还原。

每台机器在 `config.json` 里有一个随机 `machineId`，目录名尾部写的就是它。**重装系统后配置没了，会生成新标识**，于是本机不再认领旧备份——这时在恢复弹窗里勾一下「这就是这台电脑（例如刚重装过系统）」，标识就被认领回来，项目配置与它名下的项目 SKILL 会一并还原，之后的备份也照旧写回原来那个目录。

身份**刻意不靠硬件指纹推断**：干净重装恰好会让 OS 级指纹（注册表 `MachineGuid`、卷序列号）重新生成，而能扛过重装的硬件序列号（主板 / 磁盘）恰恰最容易撞号——同批次采购的机器会互相认领对方的备份，而「认错成同一台」不会报错，只会静静地做错事。

设置 → 机器与配置里可以改名（本机名字随备份上传；给别的机器起的名字只在本机显示）、重置标识，以及管理**云端机器档案**（恢复 / 改名 / 认领 / 删除机器——删除会连同该目录下的全部备份一起永久删掉，确认框里写明份数）。配置也能导出成 JSON 文件随身携带、再从文件导入。

恢复时**写入范围由本机把关**：只会写「本机配置里在用的目录」，或恢复时列给你确认过的那批目录；备份包自己声明的目录不作数 —— 那等于让被恢复的文件自己给自己发通行证，写成 `~` 形式也一样（`~` 底下就是 `.ssh` 这些真东西）。项目级 SKILL 还多一道：落点必须是**本机注册过的项目**下的 SKILL 目录，备份包说它在哪个项目不算数。带 `..` 或不是绝对路径的目标一律当非法数据丢掉。

备份包里**不含 WebDAV 密码**（地址 / 账号跟着走）：包躺在云端、还可能被分享出去，而恢复本来就得先连上云端，说明凭据已经在本机配置里了。恢复一份地址或账号与本机不同的备份时，本机密码会被清空并提示重填；地址没变就原样留着。

## 常见问题

**支持 macOS / Linux 吗？**
界面本身跨平台，但链接安装依赖 NTFS junction。欢迎 PR 增加 unix symlink 支持。

**我的数据在哪？**
Windows 便携版：配置与日志都在 exe 同级目录（整个目录拷走即可，`%APPDATA%` 下的旧配置首次启动会自动迁移）；macOS：`~/Library/Application Support/CC Skill/`。测试 / 多实例可用 `CC_SKILL_DATA_DIR` 指到别处。本机文件不会永久删除——删除一律进回收站；但**云端备份的删除是永久的**（WebDAV 没有回收站），所以「云端机器档案」里删备份、删机器都会在确认框里写明要删掉几份。

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
