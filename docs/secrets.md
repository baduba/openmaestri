---
title: API keys and secrets
---

# API keys and secrets

openmaestri works with any command line agent: Claude Code, Codex, Gemini CLI, OpenCode, Aider, Goose, or whatever you add as a preset. DeepSeek has ready-made presets and prices because it is the cheapest way to run many agents, not because it is the only choice. Every key an agent needs is a plain environment variable, and the terminal starts with the ones you list in `~/.openmaestri/env`:

```
ANTHROPIC_API_KEY=...      # Claude Code
OPENAI_API_KEY=...         # Codex, Aider, OpenCode
GEMINI_API_KEY=...         # Gemini CLI
DEEPSEEK_API_KEY=...       # OpenCode and Aider with DeepSeek
```

## Keep the key out of that file

Store it once and point to it:

```bash
openmaestri secrets set anthropic        # type it (hidden), or: pass it on stdin
echo 'ANTHROPIC_API_KEY=secret://anthropic' >> ~/.openmaestri/env
```

`secret://anthropic` is replaced by the stored value when a terminal starts. A reference to a secret that is not stored is left out (and a warning tells you the command to fix it); the reference text is never handed to the agent as if it were the key.

| Command | What it does |
| --- | --- |
| `openmaestri secrets set NAME` | Store a value. Read from stdin or typed with the echo off, never an argument (it would show in `ps` and your shell history). |
| `openmaestri secrets list` | Names only. |
| `openmaestri secrets status` | Which backend is in use. |
| `openmaestri secrets rm NAME` | Forget one. |

Names are lowercase letters, digits, dot, dash and underscore.

## Where the value lives

- **keyring**: the desktop keyring through `secret-tool` (`apt install libsecret-tools`), used automatically when it works. 
- **file**: `~/.openmaestri/secrets.json`, mode 0600, used when there is no usable keyring (a server, a container). It has the same trust level as the env file it replaces, so this is not encryption: openmaestri does not invent a home-made cipher whose key would sit next to the data.

`OPENMAESTRI_SECRETS_BACKEND=file|keyring|auto` forces a choice.

## What it protects

- The `secrets` command refuses to run inside an agent terminal, so an agent cannot read or change your keys through openmaestri.
- Secrets are never in `workspace.json`, an export, the chat memory, the usage log or `doctor` output.
- This does not stop a program that runs as you from reading your files. Give an agent only the key it needs, and use separate keys with spending limits where the provider allows it.

`openmaestri doctor` shows the backend and how many secrets are stored, and checks that a `secret://` key resolves, without printing it.
