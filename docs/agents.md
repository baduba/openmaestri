---
title: Saved prompts, usage and roles
---

# Saved prompts, usage and roles

## Saved prompts

Prompts you use again and again, one Markdown file each. In the chat panel press **Prompts**: click one to put it in the message box, **Save current** to keep what you typed, **×** to delete (an **Undo** bar appears; the file waits 30 days in a trash folder).

```bash
openmaestri prompt list
openmaestri prompt read "Daily review"      # the raw text, mentions untouched
openmaestri prompt use "Daily review"       # with @file:/@note: mentions expanded
openmaestri prompt save "Daily review" "Summarise @note:Plan" [--global] [--overwrite]   # Maestro
openmaestri prompt delete "Daily review"    # Maestro
openmaestri prompt undo                     # Maestro
```

- **Where:** `~/.openmaestri/workspaces/<id>/prompts/NAME.md` for one workspace, `~/.openmaestri/prompts/NAME.md` for all. A workspace prompt hides a global one with the same name. You can edit the files with any editor; the panel updates by itself.
- **Names** use letters, digits, spaces, dots, dashes and underscores (up to 60), start with a letter or digit, and never contain `..`. Prompts are at most 64 KB. Symbolic links, FIFOs and oversized files in those folders are ignored.
- Any agent can read prompts; only a Maestro can save or delete them. A saved prompt is plain text from you or an agent: treat it as data, like a note.

## Usage and cost

```bash
openmaestri usage                 # every agent (Maestro) or just yourself
openmaestri usage "Worker" --days 7 --json
openmaestri usage report --in 12000 --out 3400 [--model deepseek-flash] [--cost 0.0021]
openmaestri usage reset ["Worker"]          # Maestro
```

The node header shows tokens and cost for each terminal. **Where the numbers come from is always shown**:

| Source | Meaning |
|---|---|
| `reported` | The agent (or a wrapper script) called `usage report`. Exact. |
| `parsed` | A line such as `Tokens: 4.5k sent, 1.2k received.` appeared in the terminal. Best effort; the format of each tool is not guaranteed, so check it once against your tool. |

There is **no estimate from terminal bytes**: agent screens redraw constantly, so byte counts say nothing about tokens. A terminal with no reported or parsed numbers shows turns and active minutes only, and `usage` says `unknown` for its tokens rather than guess.

**Prices** (USD per million tokens) are built in for `deepseek-flash` and `deepseek-v4-pro`, including DeepSeek's higher peak rate (01:00-04:00 and 06:00-10:00 UTC, Monday to Friday), copied from the vendor's price page on 2026-11-01. Prices change: override or add models in `~/.openmaestri/prices.json`:

```json
{ "my-model": { "input": 1.0, "output": 2.0, "peak": { "input": 2.0, "output": 4.0 } } }
```

That file is read as untrusted input: only numbers from 0 to 10000 are accepted, bad entries are ignored with a note in `usage`. A DeepSeek preset implies the model in `OPENMAESTRI_DEEPSEEK_MODEL` (default `deepseek-flash`); `usage report --model` overrides it. If you pass `--cost`, your figure replaces the table's. Cost is shown only when a model with a price is known. All of it is an **estimate**, not an invoice.

Totals live in `~/.openmaestri/usage.json` (90 days of daily detail), not in the workspace file. Deleting a terminal moves its totals into an archived total.

## Roles

A role is a short set of instructions ("you are the reviewer..."). Five come built in: reviewer, tester, explorer, implementer and writer. You can add your own with `role create`, or drop `NAME.md` files in `~/.openmaestri/roles/`.

```bash
openmaestri role discover                                 # where each role comes from; repository ones are marked UNTRUSTED
openmaestri role install "Reviewer" --agent "Dev"           # dry run: shows the exact change
openmaestri role install "Reviewer" --agent "Dev" --apply   # writes it (a .bak-<time> backup first)
openmaestri role uninstall "Reviewer" --agent "Dev" --apply
```

Installing puts a marked block into the instruction file the agent already reads: `AGENTS.md` (OpenCode, Codex, Goose), `CLAUDE.md` (Claude Code) or `GEMINI.md` (Gemini CLI), in that agent's folder. Re-installing replaces the same block, never duplicates it; uninstalling removes only that block. Restart the agent afterwards so it reads the file again. Aider has no standard instruction file, so it is not supported.

Safety: it is a **dry run unless you add `--apply`**; the target must be inside the workspace and must not be a symbolic link; and roles found in the repository (`.openmaestri/roles/*.md`, `AGENTS.md`, `CLAUDE.md`) are **untrusted** because anyone who can commit could have written them. Installing one needs `--trust` after you have read it. Only a Maestro can install.
