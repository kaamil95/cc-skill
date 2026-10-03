# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.3] - 2026-10-03

### 新增

- **SKILL 市场改版：一个搜索框，聚合所有来源。** skills.sh / SkillsMP / GitHub / SkillHub 四来源并行检索，来源只是结果行上的徽章——不再让用户先挑站点。列表秒出（只等站点接口），描述按行异步回填，行带首字母头像、装机量/星标指标与来源徽章
- **分类浏览与排序**：合集 / 开发 / 运维 / 测试 / 文档 / AI·ML / 前端 / 后端 / 安全（走 SkillHub 目录），支持热门 / 星标最多 / 名称 A-Z；默认按装机量降序——最多人用的排最前
- **少量多次的分页**：每次展示 30 条，先本地展开（零网络）、耗尽才翻页；skills.sh 接口不支持服务端分页（实测确认），整表缓存在主进程按 20 条/页切片，翻页不再空手而回
- **从 GitHub 安装**：搜索按钮右侧新增独立按钮，弹窗里粘贴仓库 / `/tree/` 子目录 / zip 直链，读取后进入勾选页；弹窗内「Token 设置」一键直达设置页
- **GitHub Token 迁到 设置 → SKILL 市场**：说明改为「大多数场景用不上它」——面向高级用户的可选项；代理测试改测 github.com 主站，只报链路通断，不再劝用户填 Token
- **「同名已存在」标记**：搜索结果行与安装勾选页都会标出本机已装过的 SKILL（琥珀徽章，只提示不拦截——仍可装到其他 Agent）
- **目标目录下拉重组**：共用目录（如 `~/.agents/skills`）单独成组「全局 · 共享目录」，行内叠色点 + 全部 Agent 名字 + 路径，不再伪装成多个不同目标
- 打包体积：极限压缩 + 语言包裁剪（仅 zh-CN / en-US）

### 修复

- **切页崩溃**：市场页的异步回调（检索 / 描述回填 / 安装）在页面被切走后写 DOM，抛「Cannot set properties of null (setting 'textContent')」——所有市场 DOM 写入点先确认页面还在，回来时按 state 恢复
- **zip-slip**：解压前解析 zip 中央目录，拒绝 `../`、绝对路径、盘符与反斜杠穿越条目（含 zip64）——市场 zip 直链与本地导入都受保护
- 头像失败不再被永久缓存（此前负缓存会粘住整个运行期，网络恢复也不重试）；详情缓存封顶（此前无上限，条目含 SKILL.md 全文）；各缓存容量判定统一；名称排序固定 locale
- 仓库模式清单超过 20 个 SKILL 时明示「共 N 个，仅列出前 20 个」
- 代理测试改测 github.com 主站：API 端点对匿名请求按出口 IP 限流，走共享代理时动辄 403，会被误报成「连接失败」

### English

#### Added
- **The SKILL market is now one search box aggregating every source.** skills.sh / SkillsMP / GitHub / SkillHub are queried in parallel; a source is just a badge on the row — no picking a site first. Lists render in about a second, descriptions backfill per row, rows carry first-letter avatars, install/star metrics and source badges
- **Categories and sorts**: collections / devops / testing / docs / AI·ML / frontend / backend / security (via the SkillHub catalog), plus popular / most-stars / name sorts; the default order is installs-descending
- **Incremental paging**: 30 rows at a time — expand locally first (zero network), fetch the next page only when local stock runs out; the skills.sh API has no server-side paging (verified), so its full response is cached in the main process and served 20 rows per page
- **Install from GitHub**: a dedicated button next to Search opens a dialog for repo / `/tree/` subdirectory / direct zip links; a "Token settings" shortcut jumps straight to Settings
- **GitHub Token moved to Settings → SKILL Market**, worded as "most users never need this" — an option for advanced users; the proxy test now probes github.com (the homepage, not the IP-rate-limited API) and only reports link health, never nagging about tokens
- **"Same name exists" badge** on both the result rows and the install pick list (amber, advisory only — you can still install into another agent)
- **Target-directory dropdown reworked**: shared directories (e.g. `~/.agents/skills`) get their own "Global · Shared directories" group with stacked colour dots, every agent's name and the path
- Packaging: maximum compression + locale trim (zh-CN / en-US only)

#### Fixed
- **Crash on page switch**: async market callbacks (search / description backfill / install) wrote to DOM after the page was replaced — every market DOM write now checks the page is still alive and recovers from state on return
- **zip-slip**: the zip central directory is parsed before extraction; `../`, absolute-path, drive-letter and backslash traversal entries are refused (zip64 included) — covers both market zip links and local import
- Avatar failures are no longer cached forever (a network blip used to stick for the whole run); the detail cache is bounded (it was unbounded, holding full SKILL.md bodies); cache-cap operators unified; name sort locale pinned
- Repo mode now says "N in total, showing the first 20" when the listing is truncated


## [0.0.2] - 2026-10-01

### 新增

- **云端备份按机器分目录。** 每台机器在云端有自己的子目录（`<可读名>-<机器标识>`），内含 `machine.json` 机器档案、各备份归档与配套 `<archive>.json` 内容清单（列表不下载即可预览内容）；保留策略按目录各自保留最近 10 份，**机器列表会列出每台机器名下的全部备份**——可回滚到昨天，也可直接从另一台机器整包恢复。**恢复别家机器的备份只还原全局 SKILL**（项目路径不跨机器）；恢复本机自己的备份则会连项目级 SKILL 一起还原（目的地必须落在本机已登记的项目内）。删除机器即删除其整个目录（确认框明示数量）
- **保存 WebDAV 配置即注册机器档案**——新机器配好服务器立刻出现在所有机器的列表里，不必等到第一次备份
- **恢复不再替用户做主**：优先用本机自己的最新备份；本机没有则打开机器列表让你选——不再默默抓「云端最新」把别家机器的备份当成默认选项
- **设置页去掉远程目录输入**：云端根目录固定为 `cc-skill-sync`，留一行说明；旧配置里的自定义目录仍然兼容
- **机器身份与云端档案**：重装系统后在恢复弹窗勾选「这就是这台电脑」即可认领回原机器标识，项目配置随之回来；home 之外的目录会列出清单二次确认后才写入。机器可改名（本机名随备份上云，给别家机器起的名字只是本地别名）。**云端机器档案面板**列出每台备份过的机器，可恢复 / 改名 / 认领 / 连目录整体删除（每一步都先确认）
- **配置文件导出 / 导入回归**（设置 → 机器与配置）：导出默认不含 WebDAV 密码；导入先预览将替换的内容再确认——Agent 与项目做替换、外观偏好做合并，机器标识绝不进文件
- **发版自动化**：打 `v*` tag 触发 Release 工作流，双平台构建并挂到 GitHub Release；tag 与 package.json 版本号强校验，发版说明取自 CHANGELOG 对应小节
- **四套主题 + 自选强调色**（设置 → 主题）：浅色 / 深色 / 护眼 / 高对比；全部颜色改走 CSS 变量，强调色由 `--accent` 派生，选择缓存到 localStorage 首帧前套用
- **发现 SKILL**：从 GitHub 搜索仓库、粘贴仓库 / 子目录 / zip 直链或加载索引 JSON——下载解压、列出其中所有 SKILL 并预览，勾选后装进任意 Agent 目录；安装第三方 SKILL 前必现来源与风险确认
- **网络代理**（设置 → 网络）：跟随系统 / 直连 / 手动（支持凭据与不走代理列表）+ 连接测试；经 Electron session 生效，WebDAV 同步与市场都遵守
- **窗口级错误韧性**：SKILL 内相对链接的导航守卫、页面加载失败 / 渲染进程崩溃自动恢复、无菜单窗口的 F5 / Ctrl+R / DevTools、启动失败显示重载按钮、致命错误卡片
- 内部：注入式 HTTP 层（超时 + 下载上限，主进程注入 `net.fetch`）；链接解析 / 索引归一 / 归档取回拆分为 `src/market.js`、`src/nav.js`、`src/applog.js`

### 变更

- **缺失目录点名标出**：总览的「N 个目录缺失」可点击跳转到对应 Agent，芯片上直接写「目录不存在」；顺带修了 `~` 形路径因分隔符不一致永远比对不上的老问题
- **备份不再携带 WebDAV 密码**（曾以明文随每个归档旅行）；恢复地址或用户名与本地不一致时清空本地密码，绝不把密码带去别人文件的地址
- **备份包不能再指定落点**：恢复只写入本机配置在用、或用户刚在清单里确认过的目录——伪造备份包（WebDAV 目录可写即可伪造）无法再把文件写到任意路径并删除原内容；含 `..` 或非绝对路径的声明按脏数据丢弃
- 机器认领失败不再留下别人的机器标识（失败路径回滚）；旧备份无机器标识时跳过认领而不是中止整个恢复
- 删除机器的确认明示将删除多少份备份；「永久删除」的 README 表述改为如实描述（本地进回收站，云端彻底删除）
- 安装弹窗默认并首选**「创建链接（单副本）」**；单文件 SKILL 与项目目录内（git 仓库）自动回退副本并说明原因
- 技能弹窗去重：「链接」页不再把当前条目伪装成独立条目；「+ 安装链接」与「复制到 Agent…」合并为一个「安装到其他 Agent…」
- **目标目录下拉改为自绘列表**：Agent 色点 + 名字在左、目录灰字在右、多 Agent 共读的目录标「共用」、项目各自分组；支持方向键 / Enter / Esc / 点外部关闭
- SKILL 卡片一眼区分**本体与链接**：本体实线轨 + 「本体 · N 链接」徽章，链接虚线轨 + 🔗 徽章；Agent 视图按视角呈现（在 Claude Code 下把经由链接访问的 SKILL 显示为链接），从 Agent 视图删除只删该 Agent 的条目，不再连带清空共用的本体
- 总览与卡片重设计：去掉与工具栏重复的操作行、总览改为单分组容器、卡片悬停显露路径与操作
- `src/webdav.js` 改走注入式 HTTP 层——全局 fetch 无视代理，配置了代理也形同虚设
- 窗口背景跟随主题（创建时 + 运行中经 `win:setBackground`）

### 修复

- 封死备份包指定落点的最后两条路：`~` 形目的地（`~/.ssh` / `~/.aws` 同样在家目录里）必须过与绝对路径相同的闸门；项目级目的地必须形如项目 SKILL 目录且属于本机已登记项目——顺带修了认领机器后需恢复两次的老问题
- **CI 自建立以来一直是红的**：Node 20 没有 glob 支持导致测试跑不起来 + 两个集成测试依赖 TEMP 位置假设——CI 与 mac 构建改用 Node 22，测试自持 `os.homedir()`
- 本机恢复不再跳过 home 之外的目录（自定义目录如 `D:\AI\skills`）；同时保留防线防止外来绝对路径借「在配置里」混入
- **删除链接不再清空本体**：Electron 44 内置 Node 的 `fs.rmSync(recursive)` 会穿透 Windows junction 删掉目标内容——链接卸载改走 detach reparse point 的 `removePath`，并加了回归测试
- scan 失败渲染错误卡片而非空壳；补上通用 `.hidden` 规则（市场弹窗三面板曾同时显示）；确认弹窗不再被后续弹窗盖住；市场预览点击不再报 `EISDIR`

### English



### Added
- **Backups are organised per machine.** The cloud used to be a flat pile: every machine's `cc-skill-backup-*.zip` in one directory, plus a global `latest.json` and a `host-<id>.json` profile per machine. The only thing that said whose a backup was was the profile record, which recorded just *one* name — so "how many backups does this machine have" was unknowable, the retention policy needed a special case ("the newest one per machine is never deleted, or a machine that rarely backs up silently loses its only copy to a busier neighbour"), and a restore could only pick between "the one my profile points at" and "the newest overall". Each machine now gets its own subdirectory under the remote directory, named `<readable-slug>-<full-machine-id>` — readable in the provider's web UI, and carrying the id in the name so a lost `machine.json` still says which machine it is. Inside it: `machine.json` (who this machine is — renaming rewrites this rather than moving the folder, and a machine renamed after claiming still lands back in the original folder), the archives, and a `<archive>.json` sidecar per backup so the list can show each one's contents without downloading it. Retention is now per folder (the last 10 each), and **the machine list shows every backup a machine holds**, so you can pick any of them — roll back to yesterday's, or restore from another machine entirely. **Restoring another machine's backup brings back global skills only**; project paths are machine-specific, so a set of paths restored from elsewhere is mostly wrong. Restoring *this* machine's own backup now restores the project-level skills too, which it never did: they were skipped unconditionally, even for a backup taken here. Their destination has to sit inside a project this machine has registered — the archive saying which project it belongs to does not count, the same rule the global skills already followed. Deleting a machine deletes its whole folder and every backup in it (the confirmation states how many), and the separate "remove from list" and "unreferenced backups" states are gone: with one folder per machine they only ever produced folders nothing could attribute. Two things were removed with the flat layout, since neither had ever been used: reading the old root-level files, and the remapping of absolute paths declared by pre-2019-era archives (the one path rule that trusted the archive's own declarations rather than this machine's config)
- `src/webdav.js` gained `slugify` / `machineDirName` / `machineIdFromDir` / `createdFromName` / `parsePropfind` (a namespaced-prefix-tolerant multistatus parser) and `deleteMachine`, and the WebDAV test stub now answers `PROPFIND Depth: 1` with a directory's direct children and `resourcetype`, and deletes collections recursively — both as the RFC requires, and both of which the flat layout never exercised
- **Saving the WebDAV config now registers the machine in the cloud.** A machine used to exist only from its first backup onward: configure the same server on a new laptop and the other machines saw nothing until that laptop happened to back up. Saving the config now writes the machine profile (`machine.json`) up front — no skills, just "this machine exists" — so it shows up everywhere immediately; the first backup only adds to it
- **Restoring no longer guesses on the user's behalf.** "Restore from cloud" checks this machine's own folder first and uses its latest backup; when this machine has none, the machine list opens instead — the old behavior silently fell back to "the newest backup on the cloud", which on a new machine meant presenting *another* machine's backup as if it were the natural thing to restore
- **The remote-directory input is gone from Settings.** With one folder per machine the cloud root is fixed at `cc-skill-sync`; what used to be a field (optional since the last change, which was already one field too many) is now a single line of explanation. A config that still carries a custom directory keeps working
- **Machine identity — the cloud now knows which machine you are.** A reinstalled system used to be treated as a brand-new machine: the config is gone, so `machineId` (a random UUID in `config.json`) is minted afresh, and from then on the machine no longer recognises its own backups — project entries and project-level skills are skipped. The restore dialog now offers **"this is this computer"** when the backup came from a different id: tick it and the id is adopted, project entries come back with it, and the directories outside your home folder — which are not in a fresh config — are listed in a follow-up dialog to confirm before anything is written to them. It is deliberately not inferred from hardware — a clean reinstall regenerates the OS-level fingerprints anyway (registry `MachineGuid`, volume serial), and the hardware serials that survive it are exactly the ones that collide between identically bought machines, where mistaking two machines for one is far worse than the reverse because it fails silently. Machines can also be renamed: your own name travels with the backup (the real `hostname` is still recorded, so a rename never hides which box it was), while a name you give another machine is a local alias that is never written back — that machine's next backup would overwrite it anyway. The **Cloud machine profiles** panel lists every machine that has backed up, with how many backups it holds, and can restore from it, rename it, claim it, or delete it together with everything in its folder. Each of those asks first, and the delete confirmation says how many backups it will take; this machine's own folder is protected (the next backup would just write it back — changing identity means claiming or resetting the id)
- **Config files can be exported to and imported from a file again** (Settings → Machine & config) — the feature existed in 0.0.1, lost its UI in the settings-page rework, and left its dictionary entries behind. Export defaults to *not* including the WebDAV password. Import reads the file first and says what it would replace ("replace this machine's A agents / B projects with the file's X / Y?") before touching anything: agents and projects are replaced (that is what moving to another machine means), appearance preferences are merged, and the machine id is never part of the file — it is an identity, not a setting
- `src/config.js` gained `normalizeMachineName` / `normalizeMachineNames` / `machineDisplayName` / `renameMachine` / `parseConfigPayload` / `applyConfigPayload`, and `src/webdav.js` gained `adoptMachineId` / `resetMachineId` / `listMachines` / `forgetMachine` / `deleteBackup` — all with unit and integration tests, the file-dialog stub extended to hand out paths

- Releasing is now "change the version, write the CHANGELOG entry, push a tag". A `Release` workflow builds on Windows and macOS and attaches the portable exe and the dmg to a GitHub Release. The version in `package.json` and the tag must agree (`v0.0.2` ↔ `version: "0.0.2"`) or the job fails, so a release can never be titled one version and contain another; the release notes come from the matching section of `CHANGELOG.md` (falling back to GitHub's generated notes), and re-running the workflow re-uploads the assets instead of erroring. `Build macOS` no longer also fires on tags — it stays as the manual "just give me a dmg" button
- **Themes** (Settings → Theme): four palettes — Light, Dark, Sepia, High contrast — plus a freely chosen accent color. Every color in the stylesheet is now a variable, so a theme can no longer leave a hard-coded `#fff` glowing on a dark background; the accent's tints are derived from a single `--accent` via `color-mix`, and the last choice is cached in `localStorage` so it is applied before the first paint
- **Discover SKILLs** — install skills from the outside world: search GitHub repositories, paste a repo / subdirectory / direct zip link, or point it at a JSON index. It downloads the archive, unpacks it, lists every SKILL it contains (with a preview of each `SKILL.md`), and installs the ones you tick into any agent directory — reusing the same copy/link pipeline as the local import. Installing third-party skills is always preceded by a confirmation that names the source and warns that a SKILL's instructions and scripts are read — and may be executed — by your agents
- **Network proxy** (Settings → Network proxy): Follow system / Direct / Manual, the last with `http://user:pass@host:port` and a bypass list, plus a connection test. Applied through Electron's session, so WebDAV sync and the market both honour it; a manually configured proxy that requires authentication is answered via the app `login` event. The proxy config is machine-local and never uploaded with a backup
- Error resilience for the window itself: navigation guards (a relative link inside a SKILL preview used to navigate the whole window away and leave a blank screen), automatic recovery from a failed page load or a crashed renderer, `F5` / `Ctrl+R` reload and `Ctrl+Shift+I` devtools in a menu-less window, a boot guard that shows a reload button if the UI never comes up, and a fatal-error card with retry instead of an empty shell
- `src/net.js`: an injectable HTTP layer with timeouts and a download size cap; the main process injects Electron's `net.fetch` (which honours the session proxy), tests inject a fake
- `src/market.js`, `src/nav.js`, `src/applog.js`: link/repo parsing, index normalisation, archive retrieval and SKILL enumeration; navigation classification; a shared log-line writer

### Changed
- **A missing directory is now named, not just counted.** The dashboard's "N directories missing" said how many but never which — and clicking through to the agent's view didn't help, because the marker never fired for `~`-form directories at all: the main process records them with backslashes (`path.join`) while the renderer expands `~` by string concatenation, so the two spellings of the same directory never compared equal. Paths are now compared with separators normalized, the chip states "directory missing" in plain text on the chip itself (with a tinted background, not just the ring), and the dashboard's count is clickable and jumps to that agent's view, where each missing directory is marked
- Backups no longer carry the WebDAV password. It used to travel inside every archive — plain text, in both the packed `config.json` and the manifest's `settings` — so anyone who obtained an archive (or could read the shared cloud folder) held credentials to the whole backup set. Retyping is not the cost it looks like: reaching a backup already requires your WebDAV settings, so those credentials are in the local config before anything can be restored. Address, username and remote directory still travel with the archive, and restoring a backup whose address or username differs from yours now clears your password rather than carrying it to an address that came out of someone else's file — the same rule the config-file import already followed, comparing addresses with any trailing slash ignored so `https://dav.test/` versus `https://dav.test` does not make anyone retype
- A backup can no longer decide where its files land. Restoring writes to a directory only when **this machine's own config** uses that directory, or when the user has just confirmed a list of destinations that it does not. Until now "the backup says so" counted as proof: `destDir` and the archive's own `agents[].dirs` were checked against each other, so anyone able to write to the WebDAV folder could forge a package (copying the machine id, which is written in plain sight in the sidecar file name, every archive's `manifest.json` and `latest.json`), point it at any absolute path on a home directory or outside it, and have the files written and the directory's previous contents deleted on a plain "confirm restore" — no checkbox in between. A forged package now gets its paths listed in a dialog ("the backup has N skills in directories this machine does not have configured: …") and is refused until the user says those directories are this machine's. Declared paths containing `..`, or not absolute, are dropped as malformed data — that also closes a pre-existing escape where `~/../../…` walked out of the home directory. And the archive's agent directories no longer get merged into the local config unless they are `~`-form or were actually written, since a directory that lands in the config is treated as this machine's on the *next* restore — which would have walked around the confirmation
- Claiming a backup that then fails to restore no longer leaves the machine id changed: the id is written before the files land (it has to be, `sameMachine` is computed from it), so the failure path puts it back instead of leaving the user with "restore failed" and an identity that now belongs to someone else. Claiming is also skipped, not fatal, when an old backup carries no machine id at all — that used to abort the whole restore, skills included
- Renaming a machine to an empty name now clears it (falling back to the hostname, or dropping the alias for another machine), which is what the dialog promised and what the code refused to do. And importing a config file whose WebDAV address differs from yours no longer keeps your password next to it — it is cleared so it cannot be sent to an address that came out of someone else's file
- `listRemote` filters the names it returns to the shapes a backup name and a sidecar name can have. They come straight from the server's PROPFIND response, and the retention policy DELETEs them: a lying server could return `cc-skill-backup-x/../../whatever.zip`, which URL parsing collapses, pointing the delete at another path on that host. Pre-existing, but it was worth closing while the function was being extracted
- The "machine profiles" list says what a delete will take with it, and the README claim that "CC Skill never deletes anything permanently" now says what is actually true: local removals go to the Recycle Bin, cloud backups are deleted for good. (The delete used to name one exact backup file, because the profile recorded only one name; with one folder per machine it states the count instead — the folder *is* the machine)
- The "N project entries were not restored (project paths do not carry over between machines)" toast no longer misdiagnoses a reinstall — it now says the backup does not count as this machine's and points at the checkbox that fixes it
- The install dialog defaults to **Link (single copy)** and lists it first. One physical copy shared by every agent is what this app is for; N diverging copies is the problem it exists to solve. It falls back to Copy for a single-file skill (a link is not possible) and whenever the target directory sits inside a project (a link in a git repo risks being committed) — the option is disabled there with the reason in its tooltip, and switching back to a linkable directory restores the link default. Choosing Copy yourself is never overridden
- Two overlaps in the skill dialog are gone. (1) The **Links** tab listed the entry you had open as if it were a separate one, with an "Open" and an "Uninstall" that were the same actions as the footer's "Open Folder" and "Delete" — that row is now marked *Current entry* and carries no buttons. (2) The Links tab's "＋ Install Link to Agent" and the footer's "Copy to Agent…" opened the same dialog, differing only in which mode it preselected; there is now one entry, relabelled **Install to another agent…** (the dialog already lets you pick copy or link). The blue "this is a link, the canonical copy is at …" banner stays — it is what tells you the files are not here
- The target-directory dropdown (install / new skill / import / market) is no longer a native `<select>`. Its options could only ever read `~/.claude/skills · Claude Code` — path first, agent second, both the same weight, so nothing said which half was the agent and which was the directory, and the shared `~/.agents/skills` appeared once under Codex and once under ZCode as if they were two different targets. It is now a listbox with the agent's colour dot and name on the left, the directory dimmed on the right, a `Shared` tag on directories more than one agent reads, and a group header per project. Arrow keys, Enter, Escape and click-outside work; Escape closes only the dropdown, not the dialog behind it
- A skill's card now says at a glance whether it is the **canonical copy** or a **link**: the canonical copy gets a filled accent badge (`Canonical · N links`) and a solid accent rail down its left edge, a link gets a dashed-outline badge (`🔗 Link`) and a dashed rail, and a plain copy with no links stays unmarked. Previously both drew the same accent-blue `🔗` badge, so the only difference was one glyph
- The card describes **the entry the current view is about**, not always the physical record. Cards fold "1 canonical + N links" into one, but the list is titled after an agent — so under *Claude Code* a skill that Claude Code reaches through a link now presents as that link (dashed rail, `🔗 Link`, and a path line pointing at the canonical), while the same skill under *Codex* presents as the canonical copy. Overview and project views have no agent context and keep showing the physical record. Deleting from an agent's view removes that agent's entry only — it used to delete the shared physical copy, taking the other agents' links down with it
- The agent chips follow the same rule: an agent that only sees the skill through a link shows a dashed chip with a 🔗 instead of a solid chip with the agent's colour dot — which is what answers "so where do the files actually live?" when the card was reached by filtering on that agent
- Dashboard and skill cards reworked: the action row that duplicated the toolbar is gone, the overview is a single grouped container instead of nested cards, skill cards reveal their path and actions on hover, and the content column is capped at 1180px
- `src/webdav.js` now sends its requests through the injectable HTTP layer instead of the global `fetch` — the global one ignores the proxy entirely, which made a configured proxy a no-op
- The window background follows the configured theme, both at creation (the main process reads the config first) and live via a new `win:setBackground` channel

### Fixed
- **Two remaining ways an archive could still pick where its files land are closed.** (1) A destination written in `~` form was trusted unconditionally — the reasoning being that it can only land inside your home directory. It can: `~/.ssh`, `~/.aws`, `~/.gnupg` are all inside your home directory, and an archive declaring `destDir: "~"` with an entry named `.ssh` had the restore delete `~/.ssh` and replace it with a directory, with nothing shown to the user (`externalDirs` came back empty). `~` form now goes through exactly the same gate as an absolute path: the directory must be one this machine's config uses, or the user must have confirmed it. On a fresh machine the default agent directories still match, so the ordinary reinstall restore is unaffected. (2) Project-level skills only had to land *somewhere inside* a registered project — and the project root is somewhere inside a registered project, so an archive declaring the project root as `destDir` with an entry named `.git` deleted the repository's `.git` directory and replaced it with a copy of itself. A project destination must now be shaped like a project skill directory (`<project>/<sub>/skills`, sub being one of the agent subdirectories), and must belong to a project this machine has registered — the archive's own project list does not count, the same rule global skills already followed. Project skills whose destination this machine does not know are listed for confirmation rather than skipped, which also fixes the reinstall case: claiming a backup used to leave the project skills behind on the first pass, because the project list was read before the same click had written it — restoring twice was required, and the dialog claimed otherwise
- **CI has been red since it was added.** `node --test "test/**/*.test.js"` relies on glob support that only landed in Node 21, so on the Node 20 the workflow pinned, the test runner never even started — it just reported `Could not find 'test/**/*.test.js'`. CI and the macOS build now run Node 22 (the version `engines` declares); Node 22 also brings an `fs.rmSync` that can remove a directory whose name is still in Windows' delete-pending state, which the market integration test's cleanup hook tripped over on Node 20 and which no amount of retrying fixed. Getting the runner started then exposed a second, unrelated reason CI was red: two integration tests built their fixture directories under `os.tmpdir()` and then asserted those paths were stored in `~` form. That only holds where `TEMP` happens to sit under the user profile — true on a dev machine, false on GitHub's Windows runners, where `TEMP` is `D:\a\_temp` and the profile is `C:\Users\runneradmin`. There the `~` assertion failed and a backup/restore round trip restored 0 skills. Both tests now point `os.homedir()` at a directory they own (the helper lives in `test/helpers/fixtures.js`), so they assert the same contract wherever they run
- **Restoring on the same machine skipped every SKILL whose directory lives outside the home directory** (a custom agent directory like `D:\AI\skills`). The manifest can only record such a directory as an absolute path, and the restore treated *every* absolute path as "from another machine": it tried to re-map it onto a `~` directory, and when that failed it skipped the SKILLs and reported the path as unmappable — so a backup taken on your own machine would not restore those SKILLs back onto it. A same-machine restore now uses the absolute path as it stands, but only when both of these hold: the backup really is this machine's (matching `machineId`), and the directory is still one of the local config's agent directories. The second condition is what keeps the fix from re-opening the ghost-directory-tree problem — a restore merges the backup's agent directories into the local config, so "it is in the config" on its own would let a foreign absolute path sneak in on the *next* restore
- **Removing a link could empty the canonical copy.** `fs.rmSync(p, { recursive: true })` follows a Windows junction on the Node that ships inside Electron 44: it deletes the *target's* contents and leaves an empty directory behind. Uninstalling a link, overwriting an install, and restoring a backup over a link all went through it, so the shared physical copy was emptied while the UI reported "canonical copy kept". Link removal now goes through a `removePath` helper that detaches the reparse point itself (`rmdir`, falling back to `unlink` on POSIX). The old call is harmless on plain Node, so the test suite could not have caught this — there is now a test that stubs `fs.rmSync` and fails if link removal ever routes through it again
- A failed `scan()` left the UI on an empty shell (the IPC layer returns `{ok:false}` and the renderer stored `undefined`); failures now render an error card with a retry button
- A missing generic `.hidden` rule meant elements carrying the class stayed visible — the market dialog's three source panes all showed at once
- The confirmation dialog could be stacked underneath a later dialog in the DOM, making its buttons unclickable
- Clicking a skill in the market preview passed a directory to `skill:read`, which reported `EISDIR`

- macOS support: junction links become symlinks, zip packing via native zip/unzip, traffic-light buttons adapted
- UI i18n (Simplified Chinese / English), defaults to the system language, switchable in Settings
- **Adjustable dialog backdrop** (Settings → Dialog backdrop): two sliders for the blur radius and the dim level behind dialogs, previewed live and persisted in the config
- macOS packaging: `npm run dist:mac` produces a `.dmg` for both Apple Silicon and Intel, plus a `Build macOS` GitHub Actions workflow so a Mac build can be made without owning a Mac
- Tests (`node --test`): unit tests plus integration tests that drive the real IPC handlers with a stubbed `electron` and an in-memory WebDAV server — no network, no real config
- ESLint (flat config), Prettier and `.editorconfig`, plus a GitHub Actions workflow running lint / format check / tests on `windows-latest`
- Backups now upload a small `latest.json` metadata sidecar (device, entry count, timestamp, size) next to the zip
- Backups also upload a per-machine sidecar keyed by a `machineId` generated once per install, so restoring on a machine that has backed up before uses *its own* latest backup instead of whatever was uploaded last; the confirmation dialog shows which of the two it picked
- The restore dialog now lists the agents found in the backup with their target directories and skill counts, so you can choose which agents to rebuild
- Restore reports what it deliberately left alone (project skills, unselected agents, unresolvable paths, malformed entries) instead of only counting what it restored

### Changed
- All six native `confirm()` dialogs (upload to cloud, delete / uninstall / merge / remove project / reset defaults) replaced by one styled confirmation dialog matching the cloud-restore dialog — and destructive actions now get a red button while non-destructive ones stay neutral
- Main process split into `src/` modules (`paths` / `config` / `skills` / `zip` / `webdav` / `ipc`); `main.js` is now just the entry point, and `src/` no longer imports `electron` so it can be unit-tested
- IPC channel whitelist moved to `ipc-channels.js` as a single source of truth; `main.js` asserts at startup that every registered handler is listed
- Restoring from the cloud now opens the confirmation dialog immediately and only downloads the backup after you confirm — previously the dialog waited for the full archive to download and unpack
- `import:inspect` no longer shadows the module-level PowerShell escaping helper
- Restore now rebuilds **global** skills only: project-level skills travel with their project repo, so they are no longer written out (they were previously dumped into a directory nothing reads) and are reported as skipped instead
- Backup manifests record skill directories as `~`-relative paths rather than absolute ones, so a backup taken on one machine restores into the correct directory on another
- Agent directories from a backup are merged into the local config (union) instead of replacing it wholesale, so a machine with customised skill directories no longer has them silently reverted
- Project entries (names and paths) are now restored only when the backup came from the same machine, matched via the machine id recorded in the manifest — project paths rarely line up across machines, so restoring them elsewhere just produced a list of dead paths to clean up by hand

### Fixed
- Automatic backup never ran: the `autoBackup` toggle and its frequency had no effect because nothing ever invoked the check. It now runs once when the window is ready and re-checks every 30 minutes, honouring the startup / daily / weekly setting, and reports the outcome in the UI instead of working silently
- Automatic backup will not upload the *first* time from a machine until you have backed up manually once. Uploading first would write this machine's sidecar and repoint "which backup do I restore" at the near-empty local state, hiding the older, fuller backup with no way to select it from the UI
- Restoring on a different machine no longer recreates the uploading machine's directory tree: a path like `C:\Users\alice\.claude\skills` used to be recreated verbatim — and reported as a success — on a machine whose home directory is somewhere else, leaving the skills in a folder no agent reads
- `toTilde` no longer mistakes a sibling directory for the home directory (`C:\Users\kaix` with home `C:\Users\kai` used to be rewritten to `~/x`, which is irreversible once saved into the config), the home directory itself now collapses to `~` rather than `~/`, and forward-slash paths (`C:/Users/kai/skills`) are recognised as being under the home directory too
- Restoring a backup made by an older version now works again: those archives record the uploading machine's absolute paths, and restores used to recreate that directory tree verbatim (reporting success) instead of putting the skills where the local agents actually read them. The paths are now matched against the `~`-based agent directories the archive itself declares and mapped onto the local home directory; only paths that cannot be mapped are skipped, and those are reported
- The cloud retention policy no longer evicts another machine's most recent backup. Machines share one remote folder, so a machine that backs up frequently could otherwise push out the only backup another machine had — silently demoting it to "restore some other machine's snapshot"
- Directory names inside a backup archive are now validated as single path segments, so a tampered or corrupt manifest can no longer use `..` to delete files outside the destination
- Restore no longer leaks a `cc-skill-restore-*` temp directory (and a copy of your backup zip) when the confirmation dialog is dismissed
- Restore temp directories are cleaned up in a `finally`, so failed downloads or invalid archives leave nothing behind
- Stale `cc-skill-import-*` / `-sync-*` / `-restore-*` working directories left behind by a crash are swept at startup (only ones older than an hour, so an in-flight operation is never touched)
- SKILL.md frontmatter: values spanning multiple lines are now folded into one line instead of being cut at the first line break
- SKILL.md frontmatter: escaped quotes and backslashes written by the "new skill" template are unescaped on read, so such names round-trip
- `firstParagraph` now skips fenced code blocks as a whole, instead of picking a line of code as the fallback description
- The blank line between frontmatter and body is fully stripped (previously one leading newline survived)
- Restoring a backup no longer wipes the locally configured dialog-backdrop settings — the settings from the backup are merged over the local ones instead of replacing them wholesale
- On macOS the config, log and Chromium profile now live in `~/Library/Application Support/CC Skill/` instead of inside the `.app` bundle, which is a read-only signed package (Windows keeps the portable layout: everything next to the exe)
- Legacy `%APPDATA%` config migration is now Windows-only — on other platforms it could previously probe a relative path
- Backup name validation tightened to reject path separators
- Legacy config migration from `%APPDATA%` is skipped when `CC_SKILL_DATA_DIR` is set, so tests can no longer pick up the developer's real config
- `build.files` now includes `src/` and `ipc-channels.js`, which the packaged app needs to start — guarded by a test that walks the require graph

## [0.0.1] - 2026-09-14

首个公开发布。

### 新增

- **统一扫描**：跨 Claude Code / Codex / OpenClaw / ZCode / Qoder 目录发现 SKILL（含共享的 `~/.agents/skills` 与单文件 SKILL）；侧栏按 Agent / 项目计数
- **SKILL 详情**：Markdown 预览、源码编辑保存、文件清单
- **随处安装**：复制到任意 Agent，或安装为 NTFS **junction 链接**——所有 Agent 共享一份实体，改动处处即时生效；链接可查看 / 打开 / 卸载
- **合并重复**：识别复制到多处的同一 SKILL，收敛为「1 本体 + N 链接」；识别跨范围重复（全局 ⇄ 项目）并以保留副本内容同步其余；回收站删除 + 重试与副本回退
- **项目级管理**：登记项目文件夹，管理其 `.claude / .agents / .zcode / .codex / .qoder` 技能目录；全局 ⇄ 项目双向安装（项目内一律副本，防误提交 git）
- **总览仪表盘**：统计磁贴、Agent / 项目分布与目录健康、最近动态、快捷操作；分组列表 + 行内搜索
- **WebDAV 备份恢复**：自带服务器（坚果云 / Nextcloud / Alist…），兼容各种斜杠风格，支持时自动建目录、不支持时引导手动创建，401/403 有友好提示
- **自动备份**：启动 / 每日 / 每周；内容 hash 去重，没变化不重复上传；云端保留最近 10 份
- **操作日志**：应用内记录每个动作（面板、未读错误角标、点错误 toast 直达日志），同步落盘 `cc-skill.log`；捕获未处理异常
- **自定义 Agent 与目录**：任意 Agent + 自有技能目录；home 相对路径以 `~` 形存储并自愈
- 其余：配置导入导出、WebDAV 设置同步、`CC_SKILL_DATA_DIR` 数据目录隔离、滚动 `config.backup.json`、macOS 风格中文界面与无边框窗口

### English



First public release. 项目的第一个对外版本，此前为内部迭代。

### Added
- Config import / export: export Agents, projects and WebDAV settings (optional password) to a JSON file and import on any machine
- WebDAV settings sync: upload / download `cc-skill-config.json` for multi-device setup; SKILL backups now embed settings and can restore them together with the SKILLs
- Data-dir isolation via `CC_SKILL_DATA_DIR` (for tests / portable multi-instance) and a rolling `config.backup.json` written before every save

- **Unified scan** — discovers SKILLs across Claude Code / Codex / OpenClaw / ZCode / Qoder directories, including the shared `~/.agents/skills` and flat single-file `.md` skills; sidebar counters per agent and per project
- **SKILL detail** — markdown preview, raw source editor with save, file list
- **Install anywhere** — copy a SKILL to any agent, or install as an NTFS **junction link** so every agent shares one physical copy (edits apply instantly everywhere); links are managed per SKILL (view / open / uninstall)
- **Merge duplicates** — detects the same SKILL copied into multiple locations and collapses them into "1 canonical copy + N links"; detects **cross-scope duplicates** (global <-> project) and content-syncs project copies from the kept one (no links inside git repos); recycle-bin deletes with retry and copy-fallback so a SKILL is never left missing
- **Project scopes** — register project folders and manage their `.claude / .agents / .zcode / .codex / .qoder` skill directories; bidirectional install between global and project scopes (project installs are always copies for git safety); quick "add project" from the sidebar
- **Overview dashboard** — stat tiles, per-agent / per-project distribution with directory health, recent activity, quick actions; grouped Global / per-project lists with inline search
- **WebDAV backup & restore** — bring your own server (Jianguoyun / Nextcloud / Alist ...); tolerant of any slash style, auto-creates the remote directory where supported, guides manual creation where not (e.g. Jianguoyun); friendly 401/403 messages
- **Auto WebDAV backup** — startup / daily / weekly; content-hash dedup so unchanged SKILLs are never re-uploaded; cloud keeps only the latest 10 backups
- **Operation log** — every action recorded in-app (panel, unread error badge, click-to-open error toasts) and appended to `cc-skill.log`; unhandled exceptions are captured
- **Custom agents & directories** — add any agent with its own skill directories; home-relative paths are stored as `~` form and self-healed
- **macOS-style Chinese UI** — grouped overview page, frameless title bar with custom window controls, light theme with hairline separators, app logo & exe icon
