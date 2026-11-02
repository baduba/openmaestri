# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com), versions follow [SemVer](https://semver.org).

## [Unreleased]

## [0.13.0] - 2026-11-02

### Added
- `openmaestri audit [--verify] [--tail N]`: an append-only, hash-chained log of secrets stored or removed, agent runs, imports and exports; `--verify` detects edited, removed, reordered and cut-off lines (docs/audit.md)

### Security
- Workspace files are checked against a closed format: unknown fields, wrong types, unknown kinds, over-deep nesting and other versions are refused as a whole, with the reasons listed; a refused file creates nothing and is recorded
- The audit log never stores a prompt or a key, only names, sizes and a SHA-256

### Fixed
- Files nodes are left out of exported workspace files (they were not part of the format)

## [0.12.1] - 2026-11-01

### Security
- One-shot agents receive only their own driver's secret variables (custom drivers: the `keys` list); DBUS, SSH_AUTH_SOCK and the display are no longer passed on
- A program that resolves inside the workspace or a floor, also through a symbolic link, is refused
- `run` takes its concurrency slots before creating floors, so two runs started together cannot exceed the limit
- docs/oneshot.md now says plainly what one-shot agents are not isolated from

## [0.12.0] - 2026-11-01

### Fixed
- A leftover Chromium profile folder at portal shutdown can no longer raise an uncaught exception in the daemon (the removal retries and gives up quietly)

### Added
- `openmaestri run "task" --agents a,b`: one task to up to 6 one-shot agents in parallel, with `--floors` (a git worktree and branch each), `--dry-run`, `--model`, `--timeout`; a deterministic report that quotes each answer, kept as a note next to the Maestro (docs/oneshot.md)

## [0.11.0] - 2026-11-01

### Added
- `openmaestri agent <driver> "prompt"`: a one-shot run of any agent CLI in its non-interactive mode (claude, codex, gemini, agy, kimi, opencode, aider, goose, plus opencode-deepseek and aider-deepseek), answer printed, no terminal; custom drivers in settings.json (docs/oneshot.md)

### Security
- One-shot agents get an allow-listed environment plus the env-file keys, never OPENMAESTRI_*; no shell, stdin closed, time limit that stops the whole process group, at most 6 at once, output cut at 400 KB

## [0.10.0] - 2026-11-01

### Added
- `openmaestri secrets set|list|status|rm`: named API keys in the desktop keyring (`secret-tool`) or a 0600 file; the env file can say `ANTHROPIC_API_KEY=secret://anthropic`; works for any agent, not only DeepSeek (docs/secrets.md)
- `doctor` reports the secret store and whether a `secret://` key resolves

### Security
- The `secrets` command refuses to run inside an agent terminal; values are read from stdin or a hidden prompt, never from an argument, and are never printed
- A `secret://` reference that cannot be resolved leaves the variable out instead of passing the reference text on

### Fixed
- Human input into a portal is applied one event at a time, in arrival order (concurrent handlers could reorder keys)
- The portal UI test waits for typed keys to land instead of reading the field at once (it failed about one run in three)

## [0.9.0] - 2026-11-01

### Added
- Files node (`+ Files`): tree of the floor or workspace folder with git status markers, text editor (Ctrl+S), the last 10 versions of each saved file, safe Markdown preview, new / rename / delete (to a trash); see docs/files.md

### Security
- File access is confined to the node's folder after resolving symbolic links; links out are hidden and never written through; saves refuse a file changed on disk since it was opened; `.git` and `.openmaestri` are not reachable

## [0.8.0] - 2026-11-01

### Added
- `openmaestri doctor`: checks Node, git, the browser, the agents (OpenCode, Aider, Claude, Codex, Gemini), the DeepSeek key and the data folder, and prints the fix for each problem without ever printing a key
- `recruit --model` for the DeepSeek presets; `recruit` and the UI check that the agent program is installed

### Security
- Portals refuse cloud metadata and link-local addresses and openmaestri's own port, in the URL check and inside the browser
- Repository hooks no longer run during floor operations (opt in with OPENMAESTRI_GIT_HOOKS=1)
- A ceiling of 40 running terminals (OPENMAESTRI_MAX_TERMINALS)
- Tests that an export never contains the UI token or an API key

### Fixed
- `localhost:3000` is accepted as a portal address (it was read as a URL scheme)

## [0.7.0] - 2026-11-01

### Added
- Long-term chat memory: a thread of 200 messages is condensed locally (no model, no network) into a deterministic summary that quotes the thread and masks credentials; older messages go to a permanent archive first; `recall` shows the summary, `recall --archive` reads everything, `memory status|compress`

### Changed
- Floors, bands and workspaces now refuse what the original refuses instead of renaming silently: a folder already used by another floor or inside another workspace, a branch already used by another floor, landing into a detached HEAD, duplicate band and workspace names

## [0.6.0] - 2026-11-01

### Added
- Saved prompts: one Markdown file per prompt (workspace or global), trash with undo, live updates when files change, a drawer in the chat panel and `openmaestri prompt list|read|use|save|delete|undo`
- Agent usage: tokens and cost per terminal from reported or parsed numbers (never estimated from bytes), DeepSeek prices including peak hours with a strict override file, a badge on the node, `openmaestri usage`
- Roles: five built-in roles, `role discover`, and `role install|uninstall` into AGENTS.md/CLAUDE.md/GEMINI.md as a marked block, dry run by default, with backups; repository roles need `--trust`

### Changed
- The DeepSeek presets default to `deepseek-flash`, a model name DeepSeek's API lists (it was `deepseek-chat`)

## [0.5.0] - 2026-11-01

### Added
- Prompter: `@agent:`/`@note:`/`@file:` mentions with a popup, preview of what the Maestro will receive, a cancellable file index and `openmaestri prompt parse|materialize`

### Security
- Chat messages are only typed into a Maestro whose agent is still running (an exited agent leaves a plain shell); attachments cannot hang the daemon through a FIFO; the attachment vault has a size cap; thread writes are fsynced

## [0.4.0] - 2026-11-01

### Added
- Chat with the Maestro: seven threads, append-only history, `openmaestri say` / `recall`, side panel with progress lines, unread and attention badges, search, interrupt and an attachment vault (docs/chat.md)

## [0.3.0] - 2026-11-01

### Added
- Portals are real Chromium browsers shared by the human and agents: `portal snapshot|click|fill|type|key|select|check|scroll|drag|upload|wait|evaluate|logs|screenshot|resize|ua|...`; live view with mouse and keyboard in the canvas (docs/portals.md)

## [0.2.0] - 2026-11-01

### Added
- Floors: per-task canvases with their own git worktree/clone/folder, `floor create|list|land|delete|set-dir|unload|status`, `recruit --floor`, floor bar in the UI (see docs/floors.md)
- Stacks (fichários), bands, partituras (saved layouts), undo/redo with a note trash, tidy auto-layout, snap to grid, Ctrl+K command palette
- Workspace export and import. Imported files are untrusted: ids are regenerated, fields are re-validated and terminal commands stay unrun until you click Trust
- CLI: `note stack|unstack|create --stack|delete --stack`, `band`, `partitura`, `connect --band|--fichario|...`

## [0.1.0] - 2026-11-01

First public version.

### Security
- Hardened HTTP responses (CSP, nosniff, frame and referrer policies); ids validated before use in file paths; prototype-key lookups rejected; type checks on node fields; generic internal errors; notification rate limit; shell-quoted `$SHELL`; env file permission warning
- SAST in CI: CodeQL, Semgrep, ESLint security rules, gitleaks, Trivy, npm audit; Actions pinned by SHA

### Added
- Canvas UI: pan/zoom, terminals (xterm.js), Markdown notes, URL portals, connections, workspaces
- Daemon with PTYs, headless screen mirror, atomic JSON persistence, routines scheduler
- `openmaestri` agent CLI: list, ask (+ batch, raw), check, notify, note, portal, recruit, dismiss, connect, arrange, preset, role, routine, workspace, floor status, guide, debug
- Maestro terminals with an orchestration guide and bootstrap prompt
- Presets for OpenCode, Aider, Claude Code, Codex, Gemini CLI, Goose, with DeepSeek variants
- API keys from `~/.openmaestri/env`, kept out of workspace files
- Loopback-only web server with token, Host/Origin checks, `0600` agent socket
- `.deb` package, GitHub Actions CI and release workflow, documentation site
