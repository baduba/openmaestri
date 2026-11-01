---
title: Architecture
---

# Architecture

```
src/store.js       workspaces, nodes, connections, notes; atomic debounced JSON writes
src/terminals.js   node-pty processes + a headless xterm per terminal (screen mirror, snapshots)
src/core.js        every command (CLI and UI) and name resolution / permissions
src/routines.js    schedule parsing and the 1-second scheduler
src/ipc.js         Unix socket server, one JSON object per line
src/server.js      HTTP + WebSocket server, auth, static files, UI protocol
bin/openmaestri.js CLI (inside a terminal) and launcher (outside)
web/               the canvas UI (vanilla ES modules + xterm.js, no build step)
```

## Why a headless terminal per agent

`check` and `ask` must return what a person would see. A TUI agent redraws its screen with cursor movement, so raw output is unreadable. The daemon feeds every byte into a headless xterm and reads text from its buffer. The same buffer yields a serialized snapshot so a reloaded browser tab restores the screen and scrollback.

## `ask` semantics

1. Resolve the target among the nodes connected to the caller (a Maestro reaches all).
2. Remember the cursor line and the time.
3. Type the prompt. If the app enabled bracketed paste, multi-line text is pasted as one unit, then Enter is sent.
4. Wait until the terminal has produced output and then been quiet for 2.5 s (0.8 s for `--raw`), or until `--timeout`.
5. Return the text from the remembered line to the end.

This is a heuristic, not a protocol: agents that stream slowly or show spinners may need a longer `--timeout`, and `check` is the escape hatch.

## Security model

- The UI server binds `127.0.0.1`, requires a 192-bit token (cookie or query), and rejects any `Host` or `Origin` that is not the loopback address and port. This blocks DNS rebinding and cross-site WebSocket hijacking.
- The agent socket is `0600` inside a `0700` directory. Anything that can connect already runs as your user, so identity is the terminal id it presents, and visibility is enforced from the connection graph.
- Portals are iframes with `sandbox`; loopback pages run without `allow-same-origin`, and pages from the openmaestri origin are refused.
- API keys come from `~/.openmaestri/env`, not from workspace files.

## Wire formats

**Agent socket** (one JSON per line):
```json
{"id":1,"ctx":{"terminalId":"…"},"cmd":"ask","args":{"name":"Alice","prompt":"…"}}
{"id":1,"ok":true,"text":"…","data":{…}}
```

**UI WebSocket** messages carry a `t` field: `workspace.select`, `node.create`, `node.patch`, `conn.create`, `term.attach`, `term.in`, `term.resize`, and so on. The server pushes `workspace` (full state of the changed workspace), `term.out`, `term.snapshot`, `term.status`, `notify`.

## Tests

`npm test` runs real PTYs: the CLI is executed *inside* terminals to prove the whole path. The UI test drives headless Chromium with `playwright-core`.
