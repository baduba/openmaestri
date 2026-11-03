---
title: Project memory
---

# Project memory

Chat memory (see [chat](chat.html)) keeps one conversation readable. **Project memory** keeps what the *project* learned, so an agent that starts tomorrow does not repeat what an agent did yesterday: decisions ("we use pnpm, not npm"), lessons ("port 3000 is taken by the mock"), facts.

```bash
openmaestri remember "Use pnpm, not npm" --kind decision      # any agent
openmaestri facts                                             # list, newest last
openmaestri facts search pnpm
openmaestri facts rm 3fa91c                                   # Maestro only
openmaestri facts export "Dev"                                # dry run: what would go into Dev's CLAUDE.md or AGENTS.md
openmaestri facts export "Dev" --apply                        # write it between markers, with a backup
```

## What fills it

- **You and your agents**, with `remember`. The guide tells agents to read `facts` before planning and to save decisions and traps.
- **openmaestri itself**, one line when a floor is landed or a `run` finishes. These are marked `(auto)`, are dropped first when the list is full (200 entries), and are not exported.

## Who sees it

A new teammate (`recruit`) and a replacement (`recruit --replace`) are told how many entries there are and shown the newest decisions, as information and not as orders. The Maestro gets the same when it starts. The full list is one command away.

## Safety

Everything one agent writes is read by others, so entries are one line (400 characters), credentials are masked, and leading `#`, `>` and `-` are stripped so an entry cannot pose as a heading or a list of orders. Entries live in the data folder of the workspace, not in your repository, until you export them.

`facts export` uses the same marker block, backup and workspace-only rule as roles ([agents](agents.html)).
