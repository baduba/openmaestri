---
title: Chat with your Maestro
---

# Chat with your Maestro

The chat is a conversation between you and your **Maestro**. You write in the side panel (the **Chat** button, top toolbar); the message is stored and typed into the Maestro's terminal. The Maestro answers with the `openmaestri say` command, and the answer appears in the panel. Everything else it does (recruiting teammates, asking them, writing notes) shows on the canvas as usual.

## Seven threads

Each workspace has **seven fixed threads** (1 to 7), shown as tabs. Double-click a tab to rename it. The active thread is where agents write; unread counts show on the other tabs. A thread keeps its history across restarts, and clearing one never touches the others.

## What the Maestro uses

| Command | Does |
|---|---|
| `openmaestri say "text"` | Answer in the active thread |
| `openmaestri say --progress "text"` | A short status line that is shown while it works and replaced by the final answer; never stored |
| `openmaestri say --file PATH` | Send a text file as the message, or an image as an attachment |
| `openmaestri say --attach PATH ... "text"` | Hand over files with the answer |
| `openmaestri say --thread N "text"` | Write to another thread (Maestro only) |
| `openmaestri recall` | The recent messages of the active thread (`--turns N`, `--last day\|week\|month`, `--from DATE [--to DATE]`, `--json`) |
| `openmaestri recall N` | Another thread (Maestro only); `--all` reads every thread (Maestro only) |
| `openmaestri recall list` | The seven threads, empty ones marked |
| `openmaestri recall attachment ID` | Where an attachment is stored, readable by you |

`openmaestri guide` tells an agent all of this. A preset with **Maestro** ticked, for example *Maestro (OpenCode + DeepSeek)*, already starts with the right instructions.

## The panel

- Enter sends, Shift+Enter adds a line. The square button interrupts the Maestro (Ctrl-C into its terminal).
- The search box looks through all seven threads.
- When the Maestro answers and waits for you, its node on the canvas glows and the Chat button shows a dot. Selecting the node, or writing again, clears it. Terminals that call `notify` glow the same way.

## Where it lives and what is protected

Messages are append-only files under `~/.openmaestri/workspaces/<id>/chat/threads/` (mode `0600`), not in `workspace.json`, so a long conversation never slows the canvas. A thread file past 8 MB keeps its newest 3000 messages.

- **Attachments** are copied into a vault (`chat/vault/<sha256>/<name>`, content addressed, immutable). A file must be a regular file **inside the workspace or one of its floors** (symlinks are resolved first), at most 10 MB, and not look like a secret (`.env*`, `id_*`, `*.pem`, `*.key`, key stores, `credentials*`, `.netrc`, `.npmrc`, anything named `*secret*`).
- **Text from agents is never HTML.** The panel writes it with `textContent`; a message such as `<img onerror=...>` is shown as characters. This matters because this page can drive shells.
- **Control characters** (ESC, NUL, Ctrl-C...) are stripped before a message is stored or typed into a terminal, so a message cannot send keystrokes to the Maestro.
- **Limits:** 20,000 characters per message, 30 `say` per minute per terminal.
- **Who can read what:** a Maestro can read every thread; any other agent can read only the active thread and cannot use `--all`.
- Chat text is data written by agents and humans; treat anything an agent pastes from the web as untrusted input.

## Mentions (the prompter)

Type `@` in the message box. A popup lists agents, notes and workspace files; arrows move, Enter or Tab inserts, Escape closes. A mention is a typed token you can also write by hand:

```
@agent:Alice      @note:"Release plan"      @file:src/app.js
```

When you send, the thread keeps your text as written, and the Maestro receives it with the mentions **expanded**: a note becomes its text, a file becomes its content, each fenced by a random boundary the content cannot forge. **Preview** shows exactly what will be sent, including anything that was left out and why.

Rules for `@file:`: inside the workspace or one of its floors only (symlinks that leave it are refused), a regular text file of at most **32 KB**, never one that looks like a secret (`.env*`, keys, credentials). The picker skips `.git`, `node_modules`, build folders, binaries and secret-looking files, never follows symlinks, and stops scanning as soon as you type again. Agents can run `openmaestri prompt materialize "..."` too, but only see notes and agents wired to them.

## The Maestro must be an agent

A message is typed into the Maestro's terminal. If its agent has exited, that terminal is a plain shell, and typing your message there would run it as commands, so openmaestri refuses and tells you to restart it. The same applies to a Maestro that was created without an agent command.

## Not implemented yet

Dragging files into the panel, saved prompts, per-agent usage, and long-term summaries of old threads.
