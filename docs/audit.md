---
title: Audit log and workspace files
---

# Audit log and workspace files

## The audit log

openmaestri keeps a record of the things that change your machine's state through it, in `~/.openmaestri/audit.log` (mode 0600), one JSON line per event:

| Event | When | What is stored |
| --- | --- | --- |
| `secret.set`, `secret.remove` | `openmaestri secrets ...` | the name and the backend, never the value |
| `agent.run`, `run` | a Maestro starts one-shot agents | driver names, who asked, the folder name, the size of the prompt and its SHA-256, never the prompt |
| `workspace.import` | a workspace file is loaded in the UI | accepted or refused, the first reason, node counts, how many commands were held back |
| `workspace.export` | a workspace file is downloaded | the workspace name and node count |

```bash
openmaestri audit --tail 30      # the last events
openmaestri audit --verify       # check the whole chain
```

Each line carries the hash of the line before it. `--verify` fails, and says at which line, when a line was **edited, removed, repeated, reordered** or when the end of the log was **cut off** (a small `audit.log.head` file remembers where the log should end).

What it is not: it is tamper-**evident**, not tamper-proof. A program that runs as you can rewrite `audit.log` and `audit.log.head` together. Copy the `head` line from `--verify` somewhere else now and then if you want an anchor it cannot reach. The `audit` command refuses to run inside an agent terminal.

## Workspace files (export and import)

A workspace file (`*.openmaestri.json`) has a **closed format**, version 1. On import every field is checked, and a file is refused as a whole, with the reasons listed, when it has:

- a field the format does not define (at any level), or a field of the wrong type;
- a version other than 1, a node kind that does not exist, or a connection that is not exactly `{from, to}`;
- more than 2000 nodes, a note over 1 MB, more than 20 MB of text, or nesting deeper than 12 levels.

A refused file creates nothing and is recorded in the audit log. Ids in the file are never reused, and a terminal command that arrives in a file does not run until you trust it. Exporting then importing gives back the same structure. Files nodes (folder browsers) are not part of the format; they are a view, not content.
