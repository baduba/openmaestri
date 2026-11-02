---
title: Roadmap
---

# Roadmap

What is done, what is next, and what is deliberately left out. The order follows the advice of the two planning agents (kimi and agy), who review every release.

## Done

| Version | What |
| --- | --- |
| 0.1 to 0.8 | Canvas, terminals, notes, stacks, bands, portals, floors, chat with memory, prompter, saved prompts, usage, roles, doctor |
| 0.9 | Files node: tree and editor |
| 0.10 | Named secrets (`secret://`), keyring or private file |
| 0.11 to 0.12 | One-shot agents (`agent`) and one task for several agents (`run`), with hardening |
| 0.13 | Closed workspace-file format and the audit log |
| 0.14 | Pull and merge requests (`floor prs`), GitLab floors |
| 0.15 | Floor snapshots and rollback |
| 0.16 | First-run welcome screen |
| 0.17 | Accounts, single-partitura files, duplicate workspace |
| 0.18 | Floor hooks, routine history, files dropped on the chat |

## Next

1. **Persistent terminals**: terminals that survive a restart of openmaestri (needs `tmux`; it cannot be tested on every machine).
2. Whatever the planning agents flag after the next review, and bugs people report.

## Left out on purpose

Electron shell and tray, images in notes, tabs and syntax highlighting in the file editor, Android, sandboxes and remote tunnels. Each costs a lot to keep working and adds little to orchestrating agents; they come back if people ask.
