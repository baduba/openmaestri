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

## One task, several agents

```bash
openmaestri run "Find the bug in the login flow" --agents claude,opencode-deepseek,agy --dry-run
openmaestri run "Find the bug in the login flow" --agents claude,opencode-deepseek,agy --floors
```

Every agent gets the same task and they run in parallel (2 to 6 of them). The answer of each one is quoted as it came, with its status and time, in one report. The report is printed and also left as a note next to the Maestro. Nothing summarises it with a model, so it never invents or loses a result; a failing agent is marked and the others still count (the command only fails when all of them fail).

- `--dry-run` shows what would run (agents, folders, floors) and starts nothing. It still checks that every driver exists and its program is installed.
- `--floors` gives each agent its own floor: a separate git worktree and branch, so they cannot overwrite each other. It needs the workspace folder to be a git repository. A snapshot of each floor is taken when its agent finishes, so `openmaestri floor rollback NAME ID` puts back what the agent produced after you change files by hand. Floors are kept for you to review; land the one you want with `openmaestri floor land NAME`, and remove the others with `openmaestri floor delete NAME`. Without `--floors` all agents share one folder, which is fine for questions and reviews and risky for edits.
- `--model M` applies to every driver that takes a model, `--timeout 10m` to each agent.

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

## In a container

`--sandbox IMAGE` runs the agent inside a Docker container instead of directly on your machine:

```bash
openmaestri agent claude "Review src/" --sandbox my-agents:latest
openmaestri run "Find the bug" --agents claude,codex --floors --sandbox my-agents:latest --no-network
```

You provide the image: it must contain the agent program (`claude`, `aider`...). openmaestri then runs it with:

- only the working folder shared, at `/work`, writable; nothing else of your machine is visible (not your home folder, not your keys);
- your user id, not root; all Linux capabilities dropped; no privilege gain; 2 GB of memory and 256 processes at most;
- the variables the driver is allowed (see below) passed **by name**, so values never appear in a process list;
- `--no-network` removes the network entirely (useful for review jobs that need no API);
- the container is killed on timeout or cancel, not just the `docker` client.

If Docker is not running, you are not allowed to use it, or the image is missing, the message says which and what to do.

A custom driver can carry its own sandbox in `settings.json`: `"sandbox": { "image": "my-agents:latest", "network": "none", "memory": "1g" }`. Programs that sign in through files in your home folder (for example a logged-in `claude`) do not find them inside the container; give them a key through an [account](accounts.html) instead.

## Safety

- **Keys per driver.** A driver is given only the secret variables it needs: `claude` gets the Anthropic key, `aider-deepseek` the DeepSeek key, and neither sees the other. Settings that are not secrets (such as `OPENMAESTRI_DEEPSEEK_MODEL`) pass to all. A custom driver lists its own with `"keys": ["MY_TOKEN"]`; without that list it receives every key in the env file, since you wrote the driver.
- **No planted programs.** The program is found through your own shell, and a program that resolves inside the workspace or a floor (also through a symbolic link) is refused, so a repository cannot shadow `claude` by putting a file of that name on `PATH`.
- **No keyring, no agent socket.** The desktop keyring bus, `SSH_AUTH_SOCK` and the display are not passed on, so a one-shot agent cannot ask the keyring for your other secrets or use your SSH agent.

- The program starts with a short allow-list of your environment (`PATH`, `HOME`, locale, proxies, certificates) plus the keys from `~/.openmaestri/env` (including `secret://` ones). It never receives `OPENMAESTRI_*`, so it cannot drive the canvas, and it does not see other tokens in the daemon's environment.
- Standard input is closed: a tool that asks a question gets end-of-file instead of hanging.
- A time limit (default 10 minutes, at most 60) stops the agent and every process it started. At most 6 run at once. Output is cut at 400 KB.
- What this does not do: without `--sandbox` it is not a sandbox. An agent runs as you, so it can still read your home folder, use your git credentials stored in files, and start a background process that escapes the time limit (`setsid`, `nohup`). A floor separates the working files, not the shared `.git` folder. For code you do not trust, run openmaestri inside a container or a virtual machine.
- Tokens and cost are not guessed for one-shot runs: the footer shows the driver, seconds and folder.
