# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com), versions follow [SemVer](https://semver.org).

## [Unreleased]

### Fixed
- `openmaestri --version` outside a terminal started the server instead of printing the version (found installing the released `.deb` in a clean Ubuntu container)

### Changed
- README: the `.deb` steps name no fixed version and show how to get Node 22 on Ubuntu 24.04 and Debian 12, where apt has an older one
- README: a section on one-shot agents with which agents were checked against the real programs, and a Status paragraph that matches what exists today

## [0.21.2] - 2026-11-02

### Added
- `scripts/aws-spot-check.sh`: a Spot test box on AWS kept for a while, reached through SSM (no inbound port, no SSH key), with `up`, `run`, `stop`, `start`, `status` and a tag-checked `down`

### Fixed
- Drivers checked against the real `codex`, `opencode`, `goose` and `aider`: `codex` runs outside a git repository, `goose` takes `--provider`/`--model` and prints only the answer, `aider` no longer writes history files or edits `.gitignore`, and a call that aider reports as an error (it exits 0) is now a failure
- Colour codes are removed from what a tool prints

### Changed
- `scripts/aws-spot-check.sh` can also open SSH to the box (port 22 from your own IP only) with `ssh-setup`, `ssh-allow` and `ssh`
- `npm test` gives each test 4 minutes, so a hang fails with the test's name instead of blocking CI for an hour

### Tests
- The container sandbox is proven to have no Docker socket, no capabilities, no privilege gain, one mount only, and no sight of the openmaestri data folder

## [0.21.1] - 2026-11-02

### Changed
- The kimi driver's bullet, version line and resume hint no longer reach the answer or the run report
- A failed `gemini` run says that Google ended the CLI for individual accounts and points to `agy`

### Fixed
- A container that was killed before it started is now removed (`docker rm -f` instead of `docker kill`), so none is left in the "Created" state

## [0.21.0] - 2026-11-02

### Added
- Floor hooks can run in a Docker container (`floor hooks --sandbox IMAGE`), and a `run --floors --sandbox` checks each agent's work in a container too
- `openmaestri persist list|stop --yes`; `ps` marks terminals kept in tmux
- `doctor` checks Docker (installed and reachable), persistent sessions, permissions of `accounts.json` and `secrets.json`, and the desktop window
- Docker errors say what to do (service stopped, no permission, image missing)

### Security
- A run in a container no longer checks its result outside the container

## [0.20.0] - 2026-11-02

### Added
- Persistent terminals: with `OPENMAESTRI_PERSIST=tmux` or the preference, each terminal runs in its own session on a private tmux server and survives a restart of openmaestri (docs/persistent-terminals.md)
- `--sandbox IMAGE` and `--no-network` for `agent` and `run`: the agent runs in a Docker container with only the working folder shared, your user id, no capabilities, memory and process limits; custom drivers can carry a sandbox
- Optional desktop window (Electron): `openmaestri desktop`, tray icon, notifications; not part of the .deb's dependencies (docs/desktop.md)
- Preferences window (command palette): persistence switch, version and folders, show the welcome again

### Security
- The tmux server starts with a minimal environment and each session gets its own, so keys of one terminal never reach another; the container receives variables by name only and is killed by name on timeout; the desktop window is sandboxed, loopback-only and allows only notifications

## [0.19.0] - 2026-11-02

### Added
- `openmaestri ps`: processes, memory and CPU of each terminal; `ps stop` for one process below a terminal
- Workspaces: icon and sidebar group (`workspace set`), `workspace unload`, a dot for running terminals
- Notes: Markdown preview, pictures dropped or pasted (PNG/JPEG/GIF/WebP, checked by content), `note from-file`
- Files editor: tabs that keep unsaved text, search in files, syntax colours
- Chat: copy a thread, download it as Markdown (credentials masked), `chat summarize --with DRIVER`
- docs/everyday.md; parity table brought up to date

### Fixed
- In a note stack, text typed right after switching tabs, before the server answered, was saved into the previous note

### Security
- Pictures are recognised by their first bytes and only raster formats are accepted; the Markdown view admits only pictures from the workspace vault; `ps stop` can only signal a descendant of the terminal's shell; the Markdown export is behind the token like everything else

## [0.18.0] - 2026-11-02

### Added
- Floor hooks: `floor hooks "Floor" --post-agent CMD --pre-land CMD --rollback-on-fail on`; the after-agent check runs on every `run --floors` agent and shows in the report (optionally rolling the files back), the pre-land check stops a landing when it fails (`--no-hooks` to skip)
- `routine history "Name"`: the last 20 runs with trigger, outcome and time
- Drop files on the chat panel: stored in the chat vault and announced to the Maestro with `recall attachment ID`

### Security
- Hooks run with an allow-listed environment (no keys), no input, a time limit, and the whole process group stopped on timeout; uploads refuse secret-looking names, private keys, empty and oversize files, and never keep a path from the browser

## [0.17.0] - 2026-11-02

### Added
- Accounts: `openmaestri accounts set|list|rm`, named environments (keys as `secret://`) used with `--account` on `recruit`, `agent`, `run`, per preset (`preset set --account`) and in the New terminal window (docs/accounts.md)
- `partitura export` / `partitura import FILE`: one layout as a closed-format file; imported terminal commands are held back until trusted
- "Duplicate this workspace" in the command palette
- docs/roadmap.md

### Security
- Account variables named like keys must be `secret://` references; names that change how programs start (PATH, LD_*, NODE_OPTIONS, GIT_*, SSH_*, OPENMAESTRI_*...) are refused; `accounts` refuses to run inside an agent terminal; changes are audited with names only

## [0.16.0] - 2026-11-02

### Added
- Welcome screen on first run: pick the project folder and an agent (installed ones first), press Start; the agent opens as the Maestro in that folder; optional AGENTS.md / CLAUDE.md / GEMINI.md that is never overwritten; Skip is remembered; `OPENMAESTRI_NO_WELCOME=1` turns it off (docs/getting-started.md)
- Snapshots are refused, with advice, when more than 20000 new files are not ignored by git (`OPENMAESTRI_SNAPSHOT_MAX_FILES`)

## [0.15.0] - 2026-11-02

### Added
- `openmaestri floor snapshot|snapshots|rollback`: remember the files of a floor (edits, new files, deletions) as hidden git objects, list them, put them back; a rollback takes a snapshot of the present first, so it can be undone (docs/floors.md)
- Automatic snapshots: after each agent of `run --floors` (the id is in the report) and before `floor land`

### Security
- Snapshots never touch the branch, the index or `git status`; rollback deletes only files git knows or would add, inside the floor folder, and refuses while an agent is writing there

## [0.14.0] - 2026-11-02

### Added
- `openmaestri floor prs [--provider github|gitlab] [--json]`: open pull requests (gh) or merge requests (glab) with check status; read-only, uses your own signed-in CLI
- `floor create --pull-request` also takes GitLab merge requests (`--provider gitlab`, `merge_requests/N` URLs, `#N`)

### Security
- Text from other people (titles, branches, authors) is stripped of control and direction-changing characters before it is shown; only https links are kept

## [0.13.0] - 2026-11-02

### Added
- `openmaestri audit [--verify] [--tail N]`: an append-only, hash-chained log of secrets stored or removed, agent runs, imports and exports; `--verify` detects edited, removed, reordered and cut-off lines (docs/audit.md)

### Security
- Workspace files are checked against a closed format: unknown fields, wrong types, unknown kinds, over-deep nesting and other versions are refused as a whole, with the reasons listed; a refused file creates nothing and is recorded
- The audit log never stores a prompt or a key, only names, sizes and a SHA-256

### Changed
- Node.js 22 is the minimum (Node 20 reached end of life in April 2026); CI tests 22 and 24

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
