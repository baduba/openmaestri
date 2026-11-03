---
title: Orchestration challenge
---

# Orchestration challenge (functional test)

A test of the whole product with real agents: a Maestro has to coordinate teammates through several round trips, with data that must come back, decisions that depend on it, and a reviewer that can send the work back.

## The task

The folder has `data/sales.csv` (about 250 rows, with refunds and repeated orders) and `data/rules.md` (what makes a row valid, how revenue is summed, when a region is flagged). The Maestro must not read the data or compute anything. It has to:

1. recruit an **Auditor** and have it restate the rules from the file;
2. recruit a **Dev** and hand it the rules (not the file) to write `flag.py`;
3. run `flag.py`, send the output to the Auditor for **APPROVED** or **REJECTED**;
4. on REJECTED, send the reason back to the Dev and go again (at most 5 rounds);
5. answer the human in the chat with `VERDICT`, `FLAGGED` and `ROUNDS`.

The data comes from a seed, and the answer key is computed by the harness, so the result is checked, not judged by eye. The key differs from the naive reading of the data (every row counts), which is what makes the feedback loop necessary.

## Running it

```bash
# with real agents (a Maestro terminal and a Worker preset, any command)
node test/challenge/run.mjs --maestro 'opencode -m opencode/big-pickle' --worker 'opencode -m opencode/big-pickle'

# with scripted agents (no model; this is what npm test runs)
node test/challenge/run.mjs --scripted
```

Options: `--seed N`, `--timeout MIN` (default 30), `--stall MIN` (give up after this long without any terminal output, default 8), `--boot SECONDS`, `--out DIR`.

It prints one line and writes `report.md` and `result.json` (the checks, the messages delivered to each teammate with times, the final chat answer, the last lines of every terminal) and a copy of `flag.py`.

## What is checked

| Check | Why |
|---|---|
| final answer says APPROVED | the loop closed |
| flagged regions equal the key | the result is right |
| `flag.py` exists and prints the key | the work product is right, not only the claim |
| Auditor and Dev were recruited | recruiting works |
| Auditor asked at least twice, Dev at least once | there were round trips |
| the Maestro did not read the data itself | it delegated |

The report also counts messages sent to each teammate, so a run that only needed one round shows it.

## Scripted agents

`test/challenge/agents/` has a Maestro and a teammate written in bash. The Dev is wrong on purpose the first time. They prove that the harness, the chat, `recruit`, `ask`, `say` and the answer key work together, with no model, so `npm test` covers the challenge on every change.

## Free models

A run that hits a provider's limit stops at once with the outcome `provider-limit` (it looks for the messages agents print when a free tier ends), instead of waiting for the stall timeout. OpenRouter's free models allow 50 requests a day (1000 after a 10 dollar top-up), which one real run of the challenge can use up.

A real run passed on 2026-11-03: opencode with Nemotron 3 Ultra (free) as Maestro and gpt-oss-120b as teammates, 7 of 7 checks, 394 seconds, 9 messages, about 1.4 cents on OpenRouter. GLM 5.3 Flash as Maestro did not work: it treated the task as a bug report and asked the human a question instead of recruiting. Small models can fail the challenge for their own reasons; that says nothing about openmaestri.

OpenCode has free models (`opencode models`), but they stop with "Free usage limit reached" when the quota is used up. Since 0.21.4 openmaestri reports that at once instead of waiting for the timeout. Run the challenge when a probe such as `opencode run -m opencode/big-pickle "Reply OK"` answers.
