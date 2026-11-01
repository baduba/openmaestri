---
title: One-shot agents
---

# One-shot agents

`openmaestri agent <driver> "prompt"` gives a question or a job to an agent CLI in its **non-interactive mode** and prints the answer. There is no terminal on the canvas and no screen to read: the process starts, answers, and is gone. It is the simple way for a Maestro to use a second opinion, a cheaper model for a small job, or several agents at once.

```bash
openmaestri agent claude "Summarise the open TODOs in @file:TODO.md"
openmaestri agent opencode-deepseek "Write a unit test for src/files.js" --floor feature-x
openmaestri agent agy "Review this plan" --model gemini-3.8-flash --timeout 5m
```

Only a Maestro can run it. The agent works in the Maestro's folder, or in a floor with `--floor`. `@agent:`, `@note:` and `@file:` mentions in the prompt are expanded the same way as in the chat.

## Drivers

Any agent works; DeepSeek is only the pair of cheapest presets.

| Driver | Runs |
| --- | --- |
| `claude` | `claude -p PROMPT [--model M]` |
| `codex` | `codex exec [--model M] PROMPT` |
| `gemini` | `gemini [--model M] -p PROMPT` |
| `agy` | `agy -p PROMPT [--model M]` (Antigravity) |
| `kimi` | `kimi -p PROMPT [--model M]` |
| `opencode` | `opencode run [-m M] PROMPT` |
| `aider` | `aider --message PROMPT --yes-always --no-auto-commits --no-pretty [--model M]` |
| `goose` | `goose run -t PROMPT` |
| `opencode-deepseek`, `aider-deepseek` | the two above with `deepseek/<model>` (`OPENMAESTRI_DEEPSEEK_MODEL`, default `deepseek-flash`) |

These flags are what each tool documents today. When a tool changes them, or you want another tool, add or override a driver in `~/.openmaestri/settings.json`:

```json
{ "drivers": { "claude": { "bin": "claude", "args": ["-p", "{prompt}", "--model", "{model}"] },
               "mytool": { "bin": "mytool", "args": ["--ask", "{prompt}"] } } }
```

`{prompt}` is required and is always a single argument; no shell is involved, so a prompt cannot run commands. A driver that does not show up in `openmaestri agent` is missing `{prompt}` or has a name outside lowercase letters, digits and `-`.

## Safety

- The program starts with a short allow-list of your environment (`PATH`, `HOME`, locale, proxies, certificates) plus the keys from `~/.openmaestri/env` (including `secret://` ones). It never receives `OPENMAESTRI_*`, so it cannot drive the canvas, and it does not see other tokens in the daemon's environment.
- Standard input is closed: a tool that asks a question gets end-of-file instead of hanging.
- A time limit (default 10 minutes, at most 60) stops the agent and every process it started. At most 6 run at once. Output is cut at 400 KB.
- Agents can still edit files in their folder. Use a floor when you want that kept apart.
- Tokens and cost are not guessed for one-shot runs: the footer shows the driver, seconds and folder.
