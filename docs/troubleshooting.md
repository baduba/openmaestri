---
title: Troubleshooting
---

# Troubleshooting

Run `openmaestri debug` inside the affected terminal first. It prints the daemon uptime, socket, workspace, terminal id and what that terminal can reach.

| Symptom | Likely cause and fix |
|---|---|
| `only available inside openmaestri terminals` | You ran the command in a normal shell. Open a terminal from the canvas. |
| `cannot reach the openmaestri daemon` | The app is not running, or the socket path differs. Run `openmaestri serve`. |
| `no terminal named "X" is connected to you` | Connect them (⚭ button, or `connect` from a Maestro). The message lists what you can reach. |
| `only available to Maestro terminals` | Recreate the terminal with **Maestro** ticked, or pick a Maestro preset. |
| `403 forbidden` in the browser | Open the exact URL printed by `openmaestri serve` (it has the token). |
| `socket path is too long` | Set `OPENMAESTRI_SOCKET_PATH` to a shorter path (limit about 100 bytes). |
| `openmaestri is already running` | One daemon per user. The URL is printed again; open it. |
| Terminal output looks garbled after zoom | Reset zoom with the percentage button; the terminal refits on resize. |
| `ask` returns too early or late | Use `--timeout 5m` and `check` to see the live screen. |
| DeepSeek preset says `command not found` | Install `opencode` or `aider` and make sure it is on `PATH` for your login shell. |
| `npm ci` fails building node-pty | Install `build-essential` and `python3`. |
| Port 7777 in use | `OPENMAESTRI_PORT=0 openmaestri serve` picks a free port. |

Still stuck? [Report a bug](reporting-bugs.html).
