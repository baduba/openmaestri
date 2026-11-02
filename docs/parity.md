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
| Note stacks (fichários) | 16 | done | file/unstack notes, tabs, per-stack front note, CLI and UI. Missing: shared uniform color, drag-and-drop between stacks |
| Connections / cable ties | 19 | partial | connect, disconnect, curved cables. Missing: draggable rope points, cross-floor links, turn a file into a note |
| Bands (agent groups) | 17 | done | members share connections, frame follows members, drag the label to move the team. Missing: free-form visual groups of arbitrary nodes |
| Maestro orchestration (recruit, dismiss, connect, arrange) | 13 | partial | recruit/replace/dismiss/connect/arrange. Missing: bands, account switch, recruit on another floor/workspace |
| Presets, roles | 13 | partial | presets and role prompts. Missing: role discovery, install roles into agent configs |
| Routines (scheduler) | 11 | partial | every/daily/weekly/once, pre-run, count/until. Missing: run history, reminders UI |
| Workspaces | 36 | partial | create/rename/delete/select, clone, export/import (untrusted-input safe), undo/redo of the canvas. Duplicate (palette and `workspace create --from`). Missing: unload, icons, sidebar groups and folders, config-file sync |
| Floors (git worktree per task) | 42 | partial | worktree, clone, dir and plain floors with the refusals the original makes (folder or branch already claimed, folder inside another workspace, detached HEAD, unique names); per-floor canvas, status, land with conflict abort, delete, unload, `recruit --floor`, UI floor bar; see [floors](floors.html). Snapshots and rollback of a floor's files (see [floors](floors.html)). Missing: floor hooks, snapshots, uniform-name collisions across floors, band/partitura options on other floors |
| Pull requests and git hosts | 41 | partial | `floor prs` lists open pull/merge requests with check status (GitHub via gh, GitLab via glab), `floor create --pull-request` opens one as a floor, see [floors](floors.html). Missing: posting reviews, checks for GitLab, other hosts |
| File tree and editor panes | 43 | partial | `+ Files` node: confined tree with git markers, text editor with Ctrl+S, conflict check, 10 versions, trash on delete, safe Markdown preview; see [files](files.html). Missing: syntax highlighting, tabs, multi-file search, opening a file as its own node |
| Partituras (saved layouts) | 10 | partial | save/insert/update/delete from CLI, UI and palette, with or without commands and note text, global or per workspace. Single layouts as closed-format files (`partitura export/import`, commands held back). Missing: chat history option |
| Portals (web panes) | 12 | done | a real Chromium per portal shared by the human and agents: snapshot with refs, click, fill, type, key, select, check, scroll, drag, upload, wait, evaluate, logs, screenshot, resize, user-agent presets; see [portals](portals.html). Missing: design mode |
| Android devices | 7 | missing | |
| Maestri Chat (threads, `say`, `recall`) | 28 | partial | seven threads, JSONL history, `say`/`recall`/`recall list`/`recall attachment`, panel with progress, unread, attention badges, search, interrupt, attachment vault, local summaries of long threads with a permanent archive; see [chat](chat.html). Missing: model-written summaries, drag-and-drop attachments, thread copy |
| Prompter (composer with @mentions, file index) and saved prompts | 16 | done | `@agent:`/`@note:`/`@file:` tokens, popup with keyboard, cancellable file index, 32 KB materialisation with a preview, saved prompts with undo and live updates; see [chat](chat.html) and [agents](agents.html). Missing: drag-and-drop files |
| Agent accounts, usage and identity | 41 | partial | usage per terminal with tokens, cost estimate (reported or parsed, never guessed), DeepSeek prices with peak hours, `usage report`; role discovery and install with dry run. Named secrets (`secret://`) in the desktop keyring or a 0600 file, see [secrets](secrets.html). Named accounts (work / personal) per terminal, preset or one-shot run, see [accounts](accounts.html). Missing: identity |
| Sandboxes, Docker, WSL, remote tunnels | 18+ | missing | |
| Auto-layout (tidy/snap), command palette | 4 | done | tidy by depth from the Maestro, snap to grid, Ctrl+K palette. Missing: drawing recognition |
| App shell (window, tray, preferences, onboarding, updates) | 40 | partial | runs in the browser; `.deb` ships updates through apt. First-run welcome (folder, agent, optional AGENTS.md). Missing: Electron shell, tray, preferences screen |
| Licensing | 7 | not applicable | openmaestri is MIT |

## Order of work

1. **Canvas parity** (done in 0.2): note stacks, bands, partituras, auto-layout and snapping, undo/redo, command palette, workspace export/import.
2. **Floors** (core done in 0.2): worktrees, landing. Next: hooks, snapshots, then pull-request review UI.
3. **Portals** (done in 0.3): page automation over the Chrome DevTools Protocol. Next: design mode.
4. **Intelligence**: chat threads with memory (`say`/`recall`), prompter with @mentions and file index, saved prompts, agent usage tracking, role discovery.
5. **Shell**: Electron wrapper, tray, preferences, onboarding.
6. **Everything else**: accounts, sandboxes/Docker/WSL, remote, Android.

Track progress in the [roadmap](https://github.com/baduba/openmaestri/blob/main/TODO.md) and pick items labelled `help wanted`.

## Clean-room rule

Behavior seen in the commercial app is fair game; its code, prompts, text and artwork are not. Prompts and role texts in openmaestri are written from scratch.
