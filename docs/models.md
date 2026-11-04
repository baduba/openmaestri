---
title: Which models work as Maestro
---

# Which models work as Maestro

Real runs of the [orchestration challenge](functional-test.html), with a bug planted in the Dev's script (`--inject`), on 2026-11-04: three runs per Maestro, twelve in all. The teammates were `gpt-oss-120b` in every run; only the Maestro changed. OpenCode, through OpenRouter. Three runs are enough to see that a model is unreliable, not to rank two models against each other.

| Maestro | Teammates | Runs | Passed | Stopped by a limit | Avg seconds | Avg messages | Repeated messages | Runs with a REJECTED |
|---|---|---|---|---|---|---|---|---|
| openrouter/z-ai/glm-5.3-flash | openrouter/openai/gpt-oss-120b | 3 | 2 | 0 | 433 | 5.3 | 1 | 0 |
| openrouter/openai/gpt-oss-120b | openrouter/openai/gpt-oss-120b | 3 | 1 | 0 | 431 | 6.0 | 3 | 0 |
| openrouter/qwen/qwen3.7-flash | openrouter/openai/gpt-oss-120b | 3 | 1 | 0 | 454 | 9.7 | 5 | 1 |
| openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | openrouter/openai/gpt-oss-120b | 3 | 0 | 0 | 374 | 2.0 | 1 | 0 |

"Runs with a REJECTED" counts runs where the Auditor refused the planted bug at least once. A run passes when all 12 checks hold: the answer matches the key computed from the data, the script is right, the Maestro delegated instead of computing, nothing was sent twice, no figures were dictated to a teammate, and the planted bug was caught and fixed.

With three runs, a model that passed 2 of 3 could have a true rate anywhere from about 20% to 95%; 1 of 3 is anywhere from 6% to 80%; 0 of 3 up to 56%.

## What we saw

- **No model is reliable as Maestro yet.** Best result: GLM 5.3 Flash, 2 of 3. The first single runs (all but gpt-oss passed) were one draw each, which is why we ran three.
- **Many failures are one check: the same message sent twice.** GLM, gpt-oss, Nemotron and Qwen each failed one run on that check alone (the work itself was right). Counting only the work, GLM got 3 of 3, gpt-oss 2 of 3, Qwen 2 of 3 and Nemotron 1 of 3 (two of its runs never started, see below). The loop guard exists for this, and the repeated message is what it warns about.
- **Qwen 3.7 Flash is the chattiest.** It sent the most messages (9.7 on average, up to 13), and in one run the check failed three times and `flag.py` was never fixed.
- **gpt-oss-120b as Maestro now works sometimes.** The bootstrap that names the full path of the program and says to use the shell tool took it from 0 messages to 4, 8 and 6 messages, and one pass. One run stalled after 4 messages with one gate, never reaching a verdict. The earlier "the command does not exist" answer did not come back.
- **Nemotron 3 Ultra (free) is inconclusive.** Two of its three runs never started: the first prompt stayed QUEUED in OpenCode for the whole run, with 0 messages. That is the free model not answering, not a decision of the model. The third run did the work and repeated one message.
- A reviewer's `APPROVED` is cheap: in one run the Auditor approved a wrong list. What stopped it was the program comparing the Dev's script with an independent `verify.py` the Auditor wrote, not the Auditor's opinion. See [checking work](validation.html).

What to do with this: pick GLM 5.3 Flash first, keep the loop guard and the reminder on, and do not rely on a free model for the Maestro. A paid model from another family is the next experiment.

## Add your own runs

```bash
node test/challenge/run.mjs --inject --record runs.jsonl \
  --maestro 'opencode -m openrouter/z-ai/glm-5.3-flash' --worker 'opencode -m openrouter/openai/gpt-oss-120b'
node test/challenge/summary.mjs < runs.jsonl
```

Each run costs a few cents on OpenRouter with these models.
