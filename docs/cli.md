---
title: CLI reference
---

# CLI reference

`openmaestri` works inside terminals started by openmaestri (it needs `OPENMAESTRI_SOCKET`). Outside a terminal, `openmaestri [serve] [--open]` starts the app. Add `--json` for machine output where supported.

An agent sees only what is connected to it. A **Maestro** terminal sees the whole workspace and can run the commands marked *(Maestro)*.

## Talking to agents

| Command | Description |
|---|---|
| `list` | Reachable agents, notes, portals with status |
| `ask "Agent" "prompt" [--timeout 120s]` | Type the prompt (bracketed paste for multi-line), wait until output is quiet, print the new screen text |
| `ask --batch '{"A":"…","B":"…"}'` | Parallel asks, JSON array `[{agent,state,output}]`; `state` is `idle`, `timeout` or `exited` |
| `ask "Agent" --raw "\x03"` | Raw keystrokes. Escapes: `\n` Enter, `\t` Tab, `\e` ESC, `\xNN` byte |
| `check "Agent" [--lines N]` | Current screen of an agent |
| `notify "message"` | Notification for the human |

## Notes and portals

| Command | Description |
|---|---|
| `note create ["text"] [--name N] [--color C]` | New note wired to you; prints its name |
| `note read "N" [offset] [limit]` | Read lines |
| `note write "N" "text"` | Replace content |
| `note edit "N" "old" "new"` | Replace one unique substring |
| `note delete "N"` | Remove |
| `portal create URL ["Name"] [--size WxH]` | Web pane (http/https only) |
| `portal edit "P" --url URL` · `portal close "P"` · `portal info "P"` | Manage |

Page automation (click, fill, snapshot) is not implemented yet.

## Orchestration (Maestro)

| Command | Description |
|---|---|
| `recruit "Name" [--preset P] [--role R] [--dir PATH] [--command C]` | Start a teammate wired to you |
| `recruit "New" --preset P --replace "Old"` | Swap what runs in a teammate, keeping connections |
| `dismiss "Name"` | Stop and remove a teammate |
| `connect "A" "B"` · `disconnect "A" "B"` | Wire or unwire |
| `arrange ["Name" --name N --color C --icon I]` | Rename or restyle |
| `preset list/show/create/set/delete` | Agent presets |
| `role list/show/create/write/edit/assign/delete` | Reusable role prompts |
| `routine create "N" --command "…" <schedule>` | Scheduled prompt |
| `workspace list/create/rename` | Workspaces |
| `floor status "text" --state working\|blocked\|review\|done` | Progress shown in the toolbar (any agent) |

Routine schedules: `--every 30m`, `--daily 09:00`, `--weekly mon,fri@09:00`, `--once "2026-12-01 15:00"`. Options: `--terminal "Name"`, `--count N`, `--until DATE`, `--pre-run "cmd"` (output replaces `{{output}}` in the command), `--no-notify`, `--disabled`. Manage with `routine list/show/edit/enable/disable/run/delete`.

## Other

`openmaestri guide` prints the orchestration instructions for agents. `openmaestri debug` prints diagnostics (attach it to bug reports). `openmaestri version`.

## Exit codes

`0` success · `1` command failed (message on stderr) · `2` usage error or not inside an openmaestri terminal.
