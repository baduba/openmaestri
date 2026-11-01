---
title: DeepSeek and open models
---

# DeepSeek and open models

openmaestri never talks to a model. The agent CLI inside each terminal does. So "using DeepSeek" means running an agent CLI that supports it. Two work well today.

## 1. Put the key where openmaestri can inject it

```bash
mkdir -p ~/.openmaestri
install -m 600 /dev/null ~/.openmaestri/env
cat >> ~/.openmaestri/env <<'ENV'
DEEPSEEK_API_KEY=sk-your-key
OPENMAESTRI_DEEPSEEK_MODEL=deepseek-chat
ENV
```

Every terminal openmaestri starts receives these variables. They are never written to `workspace.json`, so you can share or commit a workspace without leaking a key. Terminals that are already running keep their old environment, so create a new terminal after changing the file.

Create a key in the [DeepSeek console](https://platform.deepseek.com/).

## 2. OpenCode

[OpenCode](https://opencode.ai) is a terminal coding agent with a DeepSeek provider.

```bash
opencode auth login      # choose DeepSeek and paste the key (stored in ~/.local/share/opencode/auth.json)
opencode models deepseek # lists valid model ids, in provider/model form
```

The built-in presets run `opencode -m "deepseek/${OPENMAESTRI_DEEPSEEK_MODEL:-deepseek-chat}"`. If `deepseek-chat` is not in the list that `opencode models deepseek` prints, set `OPENMAESTRI_DEEPSEEK_MODEL` in `~/.openmaestri/env` to one that is.

## 3. Aider

```bash
pip install aider-chat
```

The *Aider (DeepSeek)* preset runs `aider --model "deepseek/${OPENMAESTRI_DEEPSEEK_MODEL:-deepseek-chat}"` and reads `DEEPSEEK_API_KEY`.

## 4. A Maestro on DeepSeek

Choose **Maestro (OpenCode + DeepSeek)** in the New terminal dialog. It starts OpenCode on DeepSeek with the Maestro flag, then sends it an opening instruction: run `openmaestri guide` and ask you for the goal. The guide teaches it to recruit teammates, share context in notes, use `ask --batch` for parallel work, and report progress.

Teammates can run on other models. A good pattern for cost: a stronger model as Maestro, DeepSeek workers.

```bash
openmaestri recruit "Backend" --preset "OpenCode (DeepSeek)" --dir ./api
openmaestri recruit "Tests"   --preset "Aider (DeepSeek)"    --dir ./api
```

## Custom presets

A preset is just a shell command. Add your own from a Maestro:

```bash
openmaestri preset create "Local Ollama" --command 'aider --model ollama_chat/qwen2.5-coder'
```

Anything that runs in a terminal can be an agent: other providers, local models through Ollama, a script.

## Tips for cheaper models

- Keep prompts concrete and short. Put shared context in a note instead of repeating it.
- Give each worker one directory and one task.
- Use `check` before assuming a worker finished; slow models need `ask --timeout 5m`.
- Keep the Maestro's guide in view: `openmaestri guide` is what it should follow.
