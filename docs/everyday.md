---
title: Everyday tools
---

# Everyday tools

Small things that make a busy canvas easier to live with.

## Processes and memory

```bash
openmaestri ps                      # every terminal you can reach: process count, memory, CPU
openmaestri ps --all                # and each process below it
openmaestri ps stop "Builder" 4242  # ask one process to stop (add --force to kill it)
```

`ps` reads `/proc`, so it is for Linux. `ps stop` only works on a process that runs *below* that terminal's shell, so it cannot be aimed at anything else on the machine; to stop a whole terminal use `dismiss`.

## Workspaces: icons, groups, unload

```bash
openmaestri workspace set "Client A" --icon 🚀 --group Clients
openmaestri workspace unload "Client A"      # stop its terminals and portals, keep everything
```

Groups become collapsible headings in the sidebar, an icon sits before the name, and a dot shows when a workspace has running terminals. In the interface, open the command palette (Ctrl+K) for *Workspace: set icon and group* and *Workspace: stop everything running in ...*. Unloading frees memory without deleting anything: the terminals start again when you open the workspace.

## Notes

- **Preview** in a note's toolbar shows it as formatted Markdown.
- **Pictures:** drop or paste a PNG, JPEG, GIF or WebP onto a note (up to 5 MB). It is stored in the workspace's private vault and a `![name](/attachment/...)` line is inserted. Pictures are recognised by their content, not their file name, and SVG is not accepted because it can carry script.
- **A file as a note:** `openmaestri note from-file docs/plan.md` copies a text file of the project (up to 32 KB, nothing that looks like a secret) into a new note.

## Chat

- **Copy** (⧉) puts the thread on the clipboard as text, **Download** (⭳) saves it as a Markdown file. Credentials are masked in the download.
- **A summary written by an agent you choose:** `openmaestri chat summarize --with claude` sends the thread (credentials masked) to that agent as a one-shot run and keeps the answer. `recall --summary` then shows it next to the rule-based summary, labelled with who wrote it and when. Nothing is sent anywhere unless you run this.
