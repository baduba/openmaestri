---
title: Desktop window
---

# Desktop window

openmaestri runs in your browser. If you prefer a window of its own, there is an optional shell built on Electron: one window, a tray icon, and system notifications for the agents' messages. It shows the same page as the browser and adds no extra powers to it.

```bash
npm --prefix /usr/lib/openmaestri/app/desktop install    # once (downloads Electron, about 100 MB)
openmaestri desktop
```

From a source checkout the folder is `desktop/`. It needs Node.js 22 or newer on the `PATH` (or `OPENMAESTRI_NODE`).

- It starts `openmaestri serve` for you, or attaches to the one already running, and stops only the daemon it started when you quit.
- Closing the window hides it to the tray (when your desktop shows tray icons); *Quit* in the tray menu ends everything. Only one window can be open.
- Safety: the window is sandboxed, has no Node integration and no preload script, may only show the daemon's own address, and sends web links to your browser. Only notifications are allowed as a permission; camera, microphone and location are refused.
- Electron is not part of the `.deb` and is not installed by default; the rest of openmaestri does not depend on it.

## Preferences

*Preferences* in the command palette (Ctrl+K) shows the version, the data folder and the secret store, switches persistent terminals on or off, and brings the welcome screen back. This works in the browser too.
