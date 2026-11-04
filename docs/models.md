---
title: Which models work as Maestro
---

# Which models work as Maestro

Real runs of the [orchestration challenge](functional-test.html), with a bug planted in the Dev's script (`--inject`), on 2026-11-04: three runs per Maestro, and six for the three that were run in both batches, 36 runs in all. The teammates were `gpt-oss-120b` in every run; only the Maestro changed. OpenCode, through OpenRouter. Three runs are enough to see that a model is unreliable, not to rank two close models.

| Maestro | Teammates | Runs | Passed | Stopped by a limit | Avg seconds | Avg messages | Repeated messages | Runs with a REJECTED | Median cost per pass |
|---|---|---|---|---|---|---|---|---|---|
| openrouter/anthropic/claude-haiku-5.5 | openrouter/openai/gpt-oss-120b | 3 | 3 | 0 | 180 | 5.7 | 0 | 0 | $0.030 |
| openrouter/deepseek/deepseek-v4.1-flash | openrouter/openai/gpt-oss-120b | 3 | 3 | 0 | 276 | 7.3 | 0 | 1 | $0.040 |
| openrouter/google/gemini-3.8-flash | openrouter/openai/gpt-oss-120b | 3 | 3 | 0 | 448 | 5.0 | 0 | 0 | $0.310 |
| openrouter/moonshotai/kimi-k2.7-code | openrouter/openai/gpt-oss-120b | 3 | 3 | 0 | 229 | 5.0 | 0 | 0 | $0.070 |
| openrouter/z-ai/glm-5.3-flash | openrouter/openai/gpt-oss-120b | 6 | 5 | 0 | 317 | 5.2 | 1 | 0 | $0.040 |
| openrouter/openai/gpt-5.6-luna | openrouter/openai/gpt-oss-120b | 3 | 2 | 0 | 236 | 8.3 | 0 | 1 | $0.030 |
| openrouter/openai/gpt-oss-120b | openrouter/openai/gpt-oss-120b | 6 | 3 | 0 | 361 | 6.3 | 2 | 2 | $0.045 |
| openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | openrouter/openai/gpt-oss-120b | 3 | 1 | 0 | 374 | 2.0 | 0 | 0 | - |
| openrouter/qwen/qwen3.7-flash | openrouter/openai/gpt-oss-120b | 6 | 1 | 0 | 639 | 12.3 | 7 | 1 | - |

"Runs with a REJECTED" counts runs where the Auditor refused the planted bug at least once (otherwise the program's own check caught it). A run passes when all 12 checks hold: the answer matches the key computed from the data, the script is right, the Maestro delegated instead of computing, the Maestro sent nothing twice, no figures were dictated to a teammate, and the planted bug was caught and fixed. "Median cost per pass" is what the agents' screens show as spent, over the runs that passed; it is empty for the cheap runs made before the column existed and for free models.

With three runs, 3 of 3 means anywhere from about 40% to 100%, 2 of 3 from about 20% to 95%, 1 of 3 from about 6% to 80%.

## What we saw

- **The slightly better models were steady.** Haiku 5.5, Gemini 3.8 Flash and Kimi K2.7 Code passed 3 of 3, gpt-5.6-luna 2 of 3. They all took the same path: about 5 messages, 3 program checks, no message twice, never asking the human.
- **More money did not buy more.** Gemini 3.8 Flash cost about ten times what Haiku 5.5 and gpt-5.6-luna cost per pass ($0.31 against $0.03) and was twice as slow. Haiku 5.5 and gpt-5.6-luna are the cheap end of the group that works.
- **A repeated-message failure was partly the harness, twice.** When a check kept failing the same way, the program sent its own correction to the Dev twice, and the harness counted that as the Maestro repeating itself; that is fixed and the first 24 runs were scored again. The harness also compared only the first 300 characters of each message, so two long messages that start alike counted as a repeat; that is fixed for new runs, and the old ones cannot be scored again because the full text was not kept. Read the "Repeated messages" column of the older runs as an upper bound.
- **The cheap group is noisy, not worse in one clear way.** The same four cheap Maestros, run again on code that differs only by a notice that never fired (see below), moved by a full run or more each: GLM 2 of 3 then 3 of 3, gpt-oss 1 of 3 then 2 of 3, Qwen 1 of 3 then 0 of 3. That is the size of the noise at three runs. DeepSeek V4.1 Flash, new in the second batch, passed 3 of 3 for /bin/bash.04 per pass.
- **Qwen 3.7 Flash is the one that keeps failing.** 1 of 6 runs, 15 messages on average in the second batch and up to 18 minutes a run.
- **gpt-5.6-luna lost a run to a weak reviewer.** The Auditor (gpt-oss) refused a script the program's check accepted, and the Maestro spent 5 rounds and 13 messages before ending with `VERDICT: FAILED`. Failing closed was right; the loop was avoidable.
- **gpt-oss-120b as Maestro works about half the time** since the bootstrap names the program path (3 of 6; it delegated in every run).
- **Nemotron 3 Ultra (free) is inconclusive.** Two of its runs never started: the first prompt stayed QUEUED in OpenCode.
- A reviewer's `APPROVED` is cheap: in one run the Auditor approved a wrong list. What stopped it was the program comparing the Dev's script with an independent `verify.py` the Auditor wrote, not the Auditor's opinion. See [checking work](validation.html).

A second batch of cheap Maestros ran on a branch with one change: the first time the exact same message goes to a teammate, the Maestro is told how many seconds ago it sent it and that it was answered. The notice never fired in those 12 runs, so that batch measures the models again, not the notice, and the change was not merged. The repeats that did happen were not byte-for-byte copies (or, in older runs, only looked alike in their first 300 characters).

What to do with this: Haiku 5.5, gpt-5.6-luna, GLM 5.3 Flash and DeepSeek V4.1 Flash are the ones to start with, all at 3 to 5 cents a pass; avoid Qwen 3.7 Flash and free models as Maestro. The gap between Qwen and the rest is the only one that three runs show clearly; the order of the others is not settled.

What the table still lacks, and a public comparison of coding harnesses points to the same gap: a baseline. One strong model alone on the same task, with no Maestro, no Auditor and no gate, tells whether the orchestration pays for itself. Until that run exists, the table says which Maestro is better than another, not that having a Maestro is better than not having one.

## Add your own runs

```bash
node test/challenge/run.mjs --inject --record runs.jsonl \
  --maestro 'opencode -m openrouter/anthropic/claude-haiku-5.5' --worker 'opencode -m openrouter/openai/gpt-oss-120b'
node test/challenge/summary.mjs < runs.jsonl
```

Each run costs from one cent to thirty cents on OpenRouter with these models.
