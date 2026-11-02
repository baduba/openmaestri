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
| `run "task" --agents a,b [--floors] [--dry-run] [--model M] [--timeout 10m]` | The same task to several one-shot agents in parallel, one report (also kept as a note). Maestro only. See [one-shot agents](oneshot.html) |
| `agent <driver> "prompt" [--model M] [--floor NAME] [--timeout 10m]` | One-shot run of an agent CLI in its non-interactive mode (Maestro only); prints the answer. See [one-shot agents](oneshot.html) |
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
| `note delete "N"` | Remove (the text is kept in a trash folder for 7 days so undo can bring it back) |
| `note create "text" --stack ["Stack"]` | File the new note in a stack (a "fichário"); the stack is created and wired to you if it does not exist |
| `note stack "N" ["Stack"]` · `note unstack "N"` | File or free an existing note |
| `note delete --stack "Stack"` | Delete a stack and the notes in it |
| `portal create URL ["Name"] [--size WxH]` | Web pane (http/https only) |
| `portal edit "P" --url URL` · `portal close "P"` · `portal info "P"` | Manage |

Portals are real browsers you and your agents share: `snapshot`, `click`, `fill`, `type`, `key`, `select`, `check`, `wait`, `evaluate`, `screenshot`, `upload` and more. See [Portals](portals.html) for every command and the safety rules.

## Orchestration (Maestro)

| Command | Description |
|---|---|
| `recruit "Name" [--preset P] [--role R] [--dir PATH] [--command C]` | Start a teammate wired to you |
| `recruit "New" --preset P --replace "Old"` | Swap what runs in a teammate, keeping connections |
| `dismiss "Name"` | Stop and remove a teammate |
| `connect "A" "B" [--agent\|--band\|--note\|--fichario\|--portal]` · `disconnect "A" "B"` | Wire or unwire. The flag says what kind of thing `B` is when names collide |
| `band create "Name" ["Agent" ...] [--without-me]` | Group agents. Members see each other, a cable to the band reaches every member, and a member reaches what its band reaches. An agent is in at most one band |
| `band add "B" "Agent"` · `band remove "B" "Agent"` · `band dissolve "B"` | Manage a band (agents keep running when it dissolves) |
| `partitura list` | Saved layouts of agents, notes and cables |
| `partitura create "Name" ["Agent" ...] [--without-me] [--commands on\|off] [--note-text on\|off] [--description D] [--scope current\|global]` | Save you and your team (and what is wired to them) |
| `partitura insert "Name"` · `update` · `delete` | Place a layout at a free spot, wired to you; re-save it; remove it |
| `arrange ["Name" --name N --color C --icon I]` | Rename or restyle |
| `preset list/show/create/set/delete` | Agent presets |
| `role list/show/create/write/edit/assign/delete` | Reusable role prompts |
| `routine create "N" --command "…" <schedule>` | Scheduled prompt |
| `workspace list/create/rename` | Workspaces |
| `floor status "text" --state working\|blocked\|review\|done` | Progress shown in the toolbar (any agent) |

Routine schedules: `--every 30m`, `--daily 09:00`, `--weekly mon,fri@09:00`, `--once "2026-12-01 15:00"`. Options: `--terminal "Name"`, `--count N`, `--until DATE`, `--pre-run "cmd"` (output replaces `{{output}}` in the command), `--no-notify`, `--disabled`. Manage with `routine list/show/edit/enable/disable/run/delete`.

## Other

`say`, `recall` and `prompt parse|materialize` are the chat commands (see [Chat](chat.html)). `openmaestri doctor` checks the installation and prints how to fix what is missing (it works in any shell, with or without the app running). `openmaestri guide` prints the orchestration instructions for agents. `openmaestri debug` prints diagnostics (attach it to bug reports). `openmaestri version`.

## Exit codes

`0` success · `1` command failed (message on stderr) · `2` usage error or not inside an openmaestri terminal.
