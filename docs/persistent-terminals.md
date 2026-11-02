---
title: Persistent terminals
---

# Persistent terminals

Normally, stopping openmaestri stops its terminals. With persistence on, each terminal runs inside its own **tmux** session, so an agent that is in the middle of a long job keeps working while you restart openmaestri, update it, or reboot the page. When openmaestri starts again it attaches to the same sessions: the command is not run a second time.

## Turn it on

```bash
sudo apt install tmux
OPENMAESTRI_PERSIST=tmux openmaestri        # for one run
```

or tick **Keep terminals running when openmaestri restarts** in *Preferences* (command palette), which writes `"persistTerminals": true` to `~/.openmaestri/settings.json` and takes effect the next time openmaestri starts. `openmaestri doctor` shows whether tmux is found.

## How it behaves

- Closing the page or reloading it never stopped anything; this is about stopping and starting **openmaestri itself**.
- **Dismissing** a terminal, deleting its node, unloading a workspace or removing a floor ends its session for good. Only a plain shutdown of openmaestri leaves sessions running.
- Sessions of terminals that were deleted while openmaestri was stopped are removed at the next start.
- It uses a private tmux server (socket `openmaestri`, no config file, no status bar, no prefix key), so your own tmux is not touched. `tmux -L openmaestri ls` lists the sessions.
- Each session gets the environment it was created with (keys from `~/.openmaestri/env`, accounts), and the tmux server itself starts with an almost empty environment, so one terminal's keys never reach another. Values never appear on a command line.
- A terminal whose agent had exited before the restart comes back as the shell it fell back to, and chat messages are not typed into it.
- Scrolling back happens in tmux's own history, not in the canvas scrollback of a freshly attached terminal, which starts from the screen as tmux redraws it.
- If tmux is missing or fails, terminals start as plain ones and a warning is logged.

## See them, end them

```bash
openmaestri persist list          # each session: terminal id, since when, what runs in it
openmaestri persist stop --yes    # end all of them (and the programs in them)
openmaestri ps                    # terminals kept in tmux are marked
openmaestri doctor                # how many sessions are running now
```

Sessions keep using memory after you quit, on purpose; this is how you check on them. `persist` runs only in your own shell, never inside an agent terminal.
