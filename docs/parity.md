---
title: Feature parity
---

# Feature parity with the commercial Maestri

openmaestri aims at the same capabilities, written from scratch. This page is the honest scoreboard. "Channels" is the number of distinct operations the commercial app's UI calls in that area, observed from its public interface surface; it is a size indicator, not a to-do list to copy.

Legend: done = works and is tested · partial = some of it · missing = not started.

| Area | Channels | Status | What exists / what is missing |
|---|---:|---|---|
| Terminals (PTY, xterm, resize, restart) | 30 | partial | spawn, IO, resize, restart, status badge. Missing: persistent sessions (tmux), process list/stop, memory readout, remote sessions |
| Agent CLI (`ask`, `check`, `list`, `notify`) | 13 | done | batch and raw modes, name resolution, permissions by connection |
| Notes | 14 | partial | create/read/write/edit/delete, live sync. Missing: images, notes backed by external files, Markdown editor with preview |
| Note stacks (fichários) | 16 | missing | |
| Connections / cable ties | 19 | partial | connect, disconnect, curved cables. Missing: draggable rope points, cross-floor links, turn a file into a note |
| Bands (agent groups) and groups | 17 | missing | |
| Maestro orchestration (recruit, dismiss, connect, arrange) | 13 | partial | recruit/replace/dismiss/connect/arrange. Missing: bands, account switch, recruit on another floor/workspace |
| Presets, roles | 13 | partial | presets and role prompts. Missing: role discovery, install roles into agent configs |
| Routines (scheduler) | 11 | partial | every/daily/weekly/once, pre-run, count/until. Missing: run history, reminders UI |
| Workspaces | 36 | partial | create/rename/delete/select, clone. Missing: duplicate, export/import archive, undo/redo, unload, icons, sidebar groups and folders, config-file sync |
| Floors (git worktree per task) | 42 | missing | only `floor status` exists. Missing: worktrees, copy floors, landing/merge, hooks, snapshots |
| Pull requests and git hosts | 41 | missing | review floors, PR list, checks |
| File tree and editor panes | 43 | missing | |
| Partituras (saved layouts) | 10 | missing | |
| Portals (web panes) | 12 | partial | URL panes, sandboxed. Missing: page automation (snapshot, click, fill, ...), design mode, user-agent presets |
| Android devices | 7 | missing | |
| Maestri Chat (threads, `say`, `recall`) | 28 | missing | conversational front-end with per-thread memory |
| Prompter (composer with @mentions, file index) and saved prompts | 16 | missing | |
| Agent accounts, usage and identity | 41 | missing | multiple accounts per agent, usage/cost tracking |
| Sandboxes, Docker, WSL, remote tunnels | 18+ | missing | |
| Drawing, auto-layout (tidy/snap), command palette | 9 | missing | |
| App shell (window, tray, preferences, onboarding, updates) | 40 | partial | runs in the browser; `.deb` ships updates through apt. Missing: Electron shell, tray, preferences screen, onboarding |
| Licensing | 7 | not applicable | openmaestri is MIT |

## Order of work

1. **Canvas parity**: note stacks, bands and groups, partituras, auto-layout and snapping, undo/redo, command palette, workspace export/import.
2. **Floors**: git worktrees, landing, hooks, snapshots, then pull-request review floors.
3. **Portals**: page automation over the Chrome DevTools Protocol, design mode.
4. **Intelligence**: chat threads with memory (`say`/`recall`), prompter with @mentions and file index, saved prompts, agent usage tracking, role discovery.
5. **Shell**: Electron wrapper, tray, preferences, onboarding.
6. **Everything else**: accounts, sandboxes/Docker/WSL, remote, Android.

Track progress in the [roadmap](https://github.com/baduba/openmaestri/blob/main/TODO.md) and pick items labelled `help wanted`.

## Clean-room rule

Behavior seen in the commercial app is fair game; its code, prompts, text and artwork are not. Prompts and role texts in openmaestri are written from scratch.
