---
title: Starter team
---

# Starter team

A ready team made of the models that passed our challenge runs: one Maestro and two workers, through OpenCode and OpenRouter. Three presets come with openmaestri (an existing installation gets them the next time it starts):

| Preset | Model | Role |
|---|---|---|
| **Starter Maestro (DeepSeek V4.1 Flash)** | `deepseek/deepseek-v4.1-flash` | The Maestro: plans, recruits, sends the work, reads the program's checks |
| **Starter Dev (DeepSeek V4.1 Flash)** | `deepseek/deepseek-v4.1-flash` | Writes the code |
| **Starter Auditor (gpt-oss-120b)** | `openai/gpt-oss-120b` | Writes an independent check from the spec, without seeing the Dev's code |

Each model can be changed with a variable in `~/.openmaestri/env`: `OPENMAESTRI_STARTER_MAESTRO`, `OPENMAESTRI_STARTER_DEV`, `OPENMAESTRI_STARTER_AUDITOR` (a model id as OpenRouter writes it; `opencode models openrouter` lists them).

## Set it up

```bash
install -m 600 /dev/null ~/.openmaestri/env          # skip if the file exists
echo 'OPENROUTER_API_KEY=sk-or-your-key' >> ~/.openmaestri/env
opencode auth login        # choose OpenRouter, paste the key
openmaestri doctor         # tells you what is still missing
```

In the New terminal dialog choose **Starter Maestro (DeepSeek V4.1 Flash)**. Then tell it what you want and how to use the team, for example:

> Goal: (what you want built or found). Use the presets "Starter Dev (DeepSeek V4.1 Flash)" and "Starter Auditor (gpt-oss-120b)". The Auditor writes a check from the spec alone, without seeing the Dev's code. The Dev writes the code. The program decides: run both and compare their outputs (or run the Auditor's tests with `--check`). You act only when they differ, at most 4 rounds. Never retell the spec or a reply: send the file path and use `--relay`.

## What we measured, and what we did not

Everything below is in [which models work](models.html), with the runs.

- **The Maestro** is the weak link. DeepSeek V4.1 Flash, Haiku 5.5, Kimi K2.7 Code and gpt-5.6-luna led teams that passed; `gpt-oss-120b`, Qwen 3.7 Flash and the free models were poor Maestros. That is why the Maestro here is DeepSeek.
- **The workers can be cheap.** With a DeepSeek Maestro, `gpt-oss-120b` workers were right in 10 of 10 runs on the first ledger task and in 6 of 8 on the harder one (ten rules with traps), where `gpt-oss-120b` alone was right in 14 of 40 runs and a vote over four runs in 3 of 8. DeepSeek, Kimi and GLM workers were right in 4 of 4, 3 of 4 and 3 of 4. The Auditor is a different model family from the Dev so that their mistakes are less likely to be the same.
- **A strong cheap model alone is as good.** DeepSeek V4.1 Flash alone was right in 8 of 8 runs even with ten traps, for about a cent. If you can use it alone, use one agent. The team pays when the model you have to use is a weak one (open weights on your own machine, a strict budget, no strong model).
- **Not tested: more agents.** Every team measured is a Maestro and two workers. A team of seven was never run, and the planners who reviewed our results advised against adding agents before three were shown to beat one. If you try more, measure it against the trio with `test/challenge/run.mjs` and tell us.
- **Not tested: other kinds of work.** The runs are one family of tasks (read a ledger, apply rules, print a list). The starter team is a good place to begin, not a promise for any code.
- **The cross-family choice of the Auditor is a hunch,** supported by the literature on correlated errors but not measured against a Dev and Auditor of the same model here.

A run costs a few cents. Set a limit before you start: `OPENMAESTRI_BUDGET_USD=1 openmaestri serve` (see [validation](validation.html)).
