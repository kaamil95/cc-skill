# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- macOS support: junction links become symlinks, zip packing via native zip/unzip, traffic-light buttons adapted
- UI i18n (Simplified Chinese / English), defaults to the system language, switchable in Settings
- **Adjustable dialog backdrop** (Settings → Dialog backdrop): two sliders for the blur radius and the dim level behind dialogs, previewed live and persisted in the config
- macOS packaging: `npm run dist:mac` produces a `.dmg` for both Apple Silicon and Intel, plus a `Build macOS` GitHub Actions workflow so a Mac build can be made without owning a Mac
- Tests (`node --test`): unit tests plus integration tests that drive the real IPC handlers with a stubbed `electron` and an in-memory WebDAV server — no network, no real config
- ESLint (flat config), Prettier and `.editorconfig`, plus a GitHub Actions workflow running lint / format check / tests on `windows-latest`
- Backups now upload a small `latest.json` metadata sidecar (device, entry count, timestamp, size) next to the zip

### Changed
- All six native `confirm()` dialogs (upload to cloud, delete / uninstall / merge / remove project / reset defaults) replaced by one styled confirmation dialog matching the cloud-restore dialog — and destructive actions now get a red button while non-destructive ones stay neutral
- Main process split into `src/` modules (`paths` / `config` / `skills` / `zip` / `webdav` / `ipc`); `main.js` is now just the entry point, and `src/` no longer imports `electron` so it can be unit-tested
- IPC channel whitelist moved to `ipc-channels.js` as a single source of truth; `main.js` asserts at startup that every registered handler is listed
- Restoring from the cloud now opens the confirmation dialog immediately and only downloads the backup after you confirm — previously the dialog waited for the full archive to download and unpack
- `import:inspect` no longer shadows the module-level PowerShell escaping helper

### Fixed
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
