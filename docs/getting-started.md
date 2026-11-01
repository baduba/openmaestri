---
title: Getting started
---

# Getting started

## Install

**Debian / Ubuntu**

```bash
sudo apt install ./openmaestri_0.3.0_amd64.deb   # needs Node.js >= 20
openmaestri serve --open
```

If your distribution ships an older Node.js, install a current one from [nodejs.org](https://nodejs.org) or NodeSource first.

**From source**

```bash
git clone https://github.com/baduba/openmaestri.git && cd openmaestri
npm ci          # needs build-essential and python3 (node-pty compiles)
npm start
```

The command prints a URL such as `http://127.0.0.1:7777/?token=...`. Open it once; the token is kept in a cookie. Running `openmaestri serve` again while it is already up just prints the URL again.

## Your first canvas

1. **Workspaces** live in the left sidebar. A workspace is a project directory with its own canvas. Create one with the **+** button.
2. **+ Terminal** opens a dialog. Pick a preset (a plain Shell is fine to start) and a directory.
3. **+ Note** adds a Markdown note. Notes are plain files under `~/.openmaestri/workspaces/<id>/notes/`.
4. **Pan** by dragging the background or scrolling. **Zoom** with Ctrl/Cmd + wheel, or the toolbar. **Fit** frames everything.
5. **Connect** two nodes with the ⚭ button on one, then click the other. Click a cable to remove it.

## Your first orchestration

1. Create a terminal, tick **Maestro**, and choose a preset such as *Maestro (OpenCode + DeepSeek)* (see [DeepSeek](deepseek.html)).
2. After the agent boots, openmaestri tells it to run `openmaestri guide`. Tell it your goal.
3. The Maestro recruits teammates (`openmaestri recruit`), which appear on the canvas already connected to it, and coordinates them with `ask`, `check` and shared notes.

You can try the whole mechanism without any API key: open two Shell terminals, connect them, and from one run `openmaestri ask "Shell 2" "echo hello"`.

## Where things are stored

| Path | What |
|---|---|
| `~/.openmaestri/settings.json` | presets, roles, last workspace |
| `~/.openmaestri/workspaces/<id>/workspace.json` | nodes, connections, routines, viewport |
| `~/.openmaestri/workspaces/<id>/notes/*.md` | note bodies |
| `~/.openmaestri/env` | API keys as `KEY=VALUE` lines (keep it `chmod 600`) |
| `~/.openmaestri/token` | the UI token |

Set `OPENMAESTRI_DATA_DIR` to move all of it.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `OPENMAESTRI_PORT` | `7777` | UI port on 127.0.0.1 (`0` = random) |
| `OPENMAESTRI_DATA_DIR` | `~/.openmaestri` | data root |
| `OPENMAESTRI_SOCKET_PATH` | `$XDG_RUNTIME_DIR/openmaestri-<uid>/ipc.sock` | agent socket (must be under about 100 bytes) |
