# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com), versions follow [SemVer](https://semver.org).

## [Unreleased]

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
