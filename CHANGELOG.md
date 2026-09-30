# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Releasing is now "change the version, write the CHANGELOG entry, push a tag". A `Release` workflow builds on Windows and macOS and attaches the portable exe and the dmg to a GitHub Release. The version in `package.json` and the tag must agree (`v0.0.2` ↔ `version: "0.0.2"`) or the job fails, so a release can never be titled one version and contain another; the release notes come from the matching section of `CHANGELOG.md` (falling back to GitHub's generated notes), and re-running the workflow re-uploads the assets instead of erroring. `Build macOS` no longer also fires on tags — it stays as the manual "just give me a dmg" button
- **Themes** (Settings → Theme): four palettes — Light, Dark, Sepia, High contrast — plus a freely chosen accent color. Every color in the stylesheet is now a variable, so a theme can no longer leave a hard-coded `#fff` glowing on a dark background; the accent's tints are derived from a single `--accent` via `color-mix`, and the last choice is cached in `localStorage` so it is applied before the first paint
- **Discover SKILLs** — install skills from the outside world: search GitHub repositories, paste a repo / subdirectory / direct zip link, or point it at a JSON index. It downloads the archive, unpacks it, lists every SKILL it contains (with a preview of each `SKILL.md`), and installs the ones you tick into any agent directory — reusing the same copy/link pipeline as the local import. Installing third-party skills is always preceded by a confirmation that names the source and warns that a SKILL's instructions and scripts are read — and may be executed — by your agents
- **Network proxy** (Settings → Network proxy): Follow system / Direct / Manual, the last with `http://user:pass@host:port` and a bypass list, plus a connection test. Applied through Electron's session, so WebDAV sync and the market both honour it; a manually configured proxy that requires authentication is answered via the app `login` event. The proxy config is machine-local and never uploaded with a backup
- Error resilience for the window itself: navigation guards (a relative link inside a SKILL preview used to navigate the whole window away and leave a blank screen), automatic recovery from a failed page load or a crashed renderer, `F5` / `Ctrl+R` reload and `Ctrl+Shift+I` devtools in a menu-less window, a boot guard that shows a reload button if the UI never comes up, and a fatal-error card with retry instead of an empty shell
- `src/net.js`: an injectable HTTP layer with timeouts and a download size cap; the main process injects Electron's `net.fetch` (which honours the session proxy), tests inject a fake
- `src/market.js`, `src/nav.js`, `src/applog.js`: link/repo parsing, index normalisation, archive retrieval and SKILL enumeration; navigation classification; a shared log-line writer

### Changed
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
- **CI has been red since it was added.** `node --test "test/**/*.test.js"` relies on glob support that only landed in Node 21, so on the Node 20 the workflow pinned, the test runner never even started — it just reported `Could not find 'test/**/*.test.js'`. CI and the macOS build now run Node 22 (the version `engines` declares); Node 22 also brings an `fs.rmSync` that can remove a directory whose name is still in Windows' delete-pending state, which the market integration test's cleanup hook tripped over on Node 20 and which no amount of retrying fixed
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
