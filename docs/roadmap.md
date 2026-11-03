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
| 0.19 | Process list, workspace groups and unload, notes with pictures, editor tabs/search/colours, chat export and agent-written summaries |
| 0.20 | Persistent terminals (tmux), Docker sandbox for one-shot agents, optional desktop window, preferences |
| 0.21 | Hooks in containers, `persist list/stop`, a fuller `doctor`, clearer Docker errors |
| 0.22 | Fallback to the next driver when an account is out of quota, handoff notes when an agent is replaced, project memory (`remember`, `facts`), MCP servers per workspace (Context7 preset), ports and compose project per floor, boxed terminal teammates, the orchestration challenge, dynamic security tests (DAST) |
| 0.23 | `ask --check`, `--verdict`, `--retries`, `--then`, `agent --check`, `report`, a loop guard, guards against pagers and editors in agent terminals, and a per-model table of challenge runs |

## Next

Nothing is planned beyond bug reports and what the planning agents flag at their next review.

## Left out on purpose

Android (needs a phone and adb), WSL, and remote tunnels (a page that drives shells must not be exposed to a network). Posting reviews to GitHub or GitLab is left out too: it writes to a service in your name, so it should be an explicit act of yours.
