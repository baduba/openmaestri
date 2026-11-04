---
title: Which models work as Maestro
---

# Which models work as Maestro

Real runs of the [orchestration challenge](functional-test.html), with a bug planted in the Dev's script (`--inject`), on 2026-11-04: three runs per Maestro, 24 in all. The teammates were `gpt-oss-120b` in every run; only the Maestro changed. OpenCode, through OpenRouter. Three runs are enough to see that a model is unreliable, not to rank two close models.

| Maestro | Teammates | Runs | Passed | Stopped by a limit | Avg seconds | Avg messages | Repeated messages | Runs with a REJECTED | Median cost per pass |
|---|---|---|---|---|---|---|---|---|---|
| openrouter/anthropic/claude-haiku-5.5 | openrouter/openai/gpt-oss-120b | 3 | 3 | 0 | 180 | 5.7 | 0 | 0 | $0.030 |
| openrouter/google/gemini-3.8-flash | openrouter/openai/gpt-oss-120b | 3 | 3 | 0 | 448 | 5.0 | 0 | 0 | $0.310 |
| openrouter/moonshotai/kimi-k2.7-code | openrouter/openai/gpt-oss-120b | 3 | 3 | 0 | 229 | 5.0 | 0 | 0 | $0.070 |
| openrouter/openai/gpt-5.6-luna | openrouter/openai/gpt-oss-120b | 3 | 2 | 0 | 236 | 8.3 | 0 | 1 | $0.030 |
| openrouter/z-ai/glm-5.3-flash | openrouter/openai/gpt-oss-120b | 3 | 2 | 0 | 433 | 5.3 | 1 | 0 | - |
| openrouter/nvidia/nemotron-3-ultra-550b-a55b:free | openrouter/openai/gpt-oss-120b | 3 | 1 | 0 | 374 | 2.0 | 0 | 0 | - |
| openrouter/openai/gpt-oss-120b | openrouter/openai/gpt-oss-120b | 3 | 1 | 0 | 431 | 6.0 | 1 | 0 | - |
| openrouter/qwen/qwen3.7-flash | openrouter/openai/gpt-oss-120b | 3 | 1 | 0 | 454 | 9.7 | 3 | 1 | - |

"Runs with a REJECTED" counts runs where the Auditor refused the planted bug at least once (otherwise the program's own check caught it). A run passes when all 12 checks hold: the answer matches the key computed from the data, the script is right, the Maestro delegated instead of computing, the Maestro sent nothing twice, no figures were dictated to a teammate, and the planted bug was caught and fixed. "Median cost per pass" is what the agents' screens show as spent, over the runs that passed; it is empty for the cheap runs made before the column existed and for free models.

With three runs, 3 of 3 means anywhere from about 40% to 100%, 2 of 3 from about 20% to 95%, 1 of 3 from about 6% to 80%.

## What we saw

- **The slightly better models were steady.** Haiku 5.5, Gemini 3.8 Flash and Kimi K2.7 Code passed 3 of 3, gpt-5.6-luna 2 of 3: 11 of 12 against 5 of 12 for the cheapest group. They all took the same path: about 5 messages, 3 program checks, no message twice, never asking the human.
- **More money did not buy more.** Gemini 3.8 Flash cost about ten times what Haiku 5.5 and gpt-5.6-luna cost per pass ($0.31 against $0.03) and was twice as slow. Haiku 5.5 and gpt-5.6-luna are the cheap end of the group that works.
- **A repeated-message failure was partly the harness.** When a check kept failing the same way, the program sent its own correction to the Dev twice, and the harness counted that as the Maestro repeating itself. It no longer does, and the 24 runs were scored again: Nemotron 3 Ultra and Haiku 5.5 each gained a pass.
- **What is left of the repetition is real**, and only in the cheap group: the Maestro asks the same thing again 30 to 120 seconds after the answer arrived (GLM once, gpt-oss once, Qwen up to 3 times). Qwen 3.7 Flash is also the chattiest, 9.7 messages on average.
- **gpt-5.6-luna lost a run to a weak reviewer.** The Auditor (gpt-oss) refused a script the program's check accepted, and the Maestro spent 5 rounds and 13 messages before ending with `VERDICT: FAILED`. Failing closed was right; the loop was avoidable.
- **gpt-oss-120b as Maestro works sometimes** since the bootstrap names the program path (it delegated in all three runs; it passed once).
- **Nemotron 3 Ultra (free) is inconclusive.** Two of its runs never started: the first prompt stayed QUEUED in OpenCode.
- A reviewer's `APPROVED` is cheap: in one run the Auditor approved a wrong list. What stopped it was the program comparing the Dev's script with an independent `verify.py` the Auditor wrote, not the Auditor's opinion. See [checking work](validation.html).

What to do with this: use Haiku 5.5 or gpt-5.6-luna first; use a free or very cheap model as Maestro only with the loop guard on and a person watching. The gap between the groups is real; the order inside a group is not settled.

What the table still lacks, and a public comparison of coding harnesses points to the same gap: a baseline. One strong model alone on the same task, with no Maestro, no Auditor and no gate, tells whether the orchestration pays for itself. Until that run exists, the table says which Maestro is better than another, not that having a Maestro is better than not having one.

## Add your own runs

```bash
node test/challenge/run.mjs --inject --record runs.jsonl \
  --maestro 'opencode -m openrouter/anthropic/claude-haiku-5.5' --worker 'opencode -m openrouter/openai/gpt-oss-120b'
node test/challenge/summary.mjs < runs.jsonl
```

Each run costs from one cent to thirty cents on OpenRouter with these models.
