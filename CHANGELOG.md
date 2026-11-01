# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com), versions follow [SemVer](https://semver.org).

## [0.1.0] - 2026-11-01

First public version.

### Added
- Canvas UI: pan/zoom, terminals (xterm.js), Markdown notes, URL portals, connections, workspaces
- Daemon with PTYs, headless screen mirror, atomic JSON persistence, routines scheduler
- `openmaestri` agent CLI: list, ask (+ batch, raw), check, notify, note, portal, recruit, dismiss, connect, arrange, preset, role, routine, workspace, floor status, guide, debug
- Maestro terminals with an orchestration guide and bootstrap prompt
- Presets for OpenCode, Aider, Claude Code, Codex, Gemini CLI, Goose, with DeepSeek variants
- API keys from `~/.openmaestri/env`, kept out of workspace files
- Loopback-only web server with token, Host/Origin checks, `0600` agent socket
- `.deb` package, GitHub Actions CI and release workflow, documentation site
