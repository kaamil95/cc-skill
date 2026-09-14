# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
