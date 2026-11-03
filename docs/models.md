---
title: Which models work as Maestro
---

# Which models work as Maestro

Real runs of the [orchestration challenge](functional-test.html), with a bug planted in the Dev's script (`--inject`), on 2026-11-03. The teammates were `gpt-oss-120b` in every run; only the Maestro changed. OpenCode, through OpenRouter. One run per model: this is evidence, not a ranking, and the table grows with `--record`.

| Maestro | Teammates | Runs | Passed | Stopped by a limit | Avg seconds | Avg messages | Repeated messages | Runs with a REJECTED |
|---|---|---|---|---|---|---|---|---|
| openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | openrouter/openai/gpt-oss-120b | 1 | 1 | 0 | 208 | 5.0 | 0 | 0 |
| openrouter/qwen/qwen3.7-flash | openrouter/openai/gpt-oss-120b | 1 | 1 | 0 | 188 | 7.0 | 0 | 1 |
| openrouter/z-ai/glm-5.3-flash | openrouter/openai/gpt-oss-120b | 1 | 1 | 0 | 290 | 6.0 | 0 | 1 |
| openrouter/openai/gpt-oss-120b | openrouter/openai/gpt-oss-120b | 1 | 0 | 0 | 546 | 0.0 | 0 | 0 |

"Runs with a REJECTED" counts runs where the Auditor refused the planted bug at least once. A run passes when all 12 checks hold: the answer matches the key computed from the data, the script is right, the Maestro delegated instead of computing, nothing was sent twice, no figures were dictated to a teammate, and the planted bug was caught and fixed.

## What we saw

- **GLM 5.3 Flash, Nemotron 3 Ultra and Qwen 3.7 Flash passed** once the program did the judging (see [checking work](validation.html)). Before that, GLM Flash stopped to ask the human what the goal was, and Nemotron approved without looking or refused good work.
- **gpt-oss-120b as Maestro failed every time**: it answers that the `openmaestri` command does not exist in its environment without trying to run it. The reminders (twice, in fixed words) did not change that. It works well as a teammate in the same runs. Use another model for the Maestro.
- A reviewer's `APPROVED` is cheap: in one run the Auditor approved a wrong list. What stopped it was the program comparing the Dev's script with an independent `verify.py` the Auditor wrote, not the Auditor's opinion.

## Add your own runs

```bash
node test/challenge/run.mjs --inject --record runs.jsonl \
  --maestro 'opencode -m openrouter/z-ai/glm-5.3-flash' --worker 'opencode -m openrouter/openai/gpt-oss-120b'
node test/challenge/summary.mjs < runs.jsonl
```

Each run costs a few cents on OpenRouter with these models.
