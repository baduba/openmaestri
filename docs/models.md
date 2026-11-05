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
- **The cheap group is noisy, not worse in one clear way.** The same four cheap Maestros, run again on code that differs only by a notice that never fired (see below), moved by a full run or more each: GLM 2 of 3 then 3 of 3, gpt-oss 1 of 3 then 2 of 3, Qwen 1 of 3 then 0 of 3. That is the size of the noise at three runs. DeepSeek V4.1 Flash, new in the second batch, passed 3 of 3 at $0.04 per pass.
- **Qwen 3.7 Flash is the one that keeps failing.** 1 of 6 runs, 15 messages on average in the second batch and up to 18 minutes a run.
- **gpt-5.6-luna lost a run to a weak reviewer.** The Auditor (gpt-oss) refused a script the program's check accepted, and the Maestro spent 5 rounds and 13 messages before ending with `VERDICT: FAILED`. Failing closed was right; the loop was avoidable.
- **gpt-oss-120b as Maestro works about half the time** since the bootstrap names the program path (3 of 6; it delegated in every run).
- **Nemotron 3 Ultra (free) is inconclusive.** Two of its runs never started: the first prompt stayed QUEUED in OpenCode.
- A reviewer's `APPROVED` is cheap: in one run the Auditor approved a wrong list. What stopped it was the program comparing the Dev's script with an independent `verify.py` the Auditor wrote, not the Auditor's opinion. See [checking work](validation.html).

A second batch of cheap Maestros ran on a branch with one change: the first time the exact same message goes to a teammate, the Maestro is told how many seconds ago it sent it and that it was answered. The notice never fired in those 12 runs, so that batch measures the models again, not the notice, and the change was not merged. The repeats that did happen were not byte-for-byte copies (or, in older runs, only looked alike in their first 300 characters).

What to do with this: Haiku 5.5, gpt-5.6-luna, GLM 5.3 Flash and DeepSeek V4.1 Flash are the ones to start with, all at 3 to 5 cents a pass; avoid Qwen 3.7 Flash and free models as Maestro. The gap between Qwen and the rest is the only one that three runs show clearly; the order of the others is not settled.

## The baseline: one agent alone

The same task given to one agent, with no Maestro, no Auditor, no `verify.py` and no gate (`--baseline`; it writes `flag.py` and an `answer.txt`). Five runs per model, on 2026-11-04, same OpenCode and OpenRouter. No bug is planted, since there is no hand-over to plant it in.

| Agent alone | Runs | Right answer | Avg seconds | Median cost per run |
|---|---|---|---|---|
| anthropic/claude-haiku-5.5 | 5 | 5 | 38 | not shown |
| deepseek/deepseek-v4.1-flash | 5 | 5 | 31 | not shown |
| moonshotai/kimi-k2.7-code | 5 | 5 | 52 | $0.020 |
| openai/gpt-5.6-luna | 5 | 5 | 37 | $0.010 |
| openai/gpt-oss-120b | 5 | 5 | 51 | $0.010 |
| z-ai/glm-5.3-flash | 5 | 4 | 108 | not shown |

"Right answer" means the answer matches the key and `flag.py` prints it. The team runs above are judged by 12 checks, most of them about the way of working, so the fair comparison is on the right answer alone: the team got it in 31 of 36 runs, the single agent in 29 of 30 (the one miss was GLM stalling for 7 minutes). Cost is shown by OpenCode only on some runs; where it shows, the single agent spent 1 to 2 cents against 3 to 31 cents for the team.

What this says, and what it does not:

- **On this task the team did not buy a better answer.** One agent writes a 20-line script and checks it in under a minute, and gets it right as often as the team does, in a fifth to a tenth of the time and for a fraction of the money. `gpt-oss-120b` fails as a Maestro half the time but is 5 of 5 alone: the hard part for it is coordinating, not solving.
- **The task is small, and it has no trap for the single agent.** Nothing here shows what happens on work where one agent's script is wrong and nobody looks. The team's case is the independent check (the program compares the Dev's script with the Auditor's `verify.py`), and it was tested only by planting a bug for it to catch. A task where a lone agent errs often is needed to measure that, and the next step is to make one.
- **So the layer is for work a single agent gets wrong, not for every job.** Use a Maestro when a result must be checked by something other than the one who made it. For a task a single agent solves in a minute, send it to the agent.

## A second task, where the lone agent can fail (scenario B)

Scenario A is easy for a lone agent. Scenario B is a ledger with four traps: two ways of writing the amount (`1.250,50` and `1250.50`), two time zones, chargebacks that cancel a sale by reference (anywhere in the file), and repeated ids. The answer key of both data sets used (seeds 11 and 13) was checked against a second, independent reading of the file. The teammates were `gpt-oss-120b` in every team run; only the Maestro changed. A run counts when the final answer and the `flag.py` are both right.

| How the work was done | Qwen 3.7 Flash | gpt-oss-120b | DeepSeek V4.1 Flash | Total |
|---|---|---|---|---|
| One agent alone | 1 of 10 | 7 of 10 | 9 of 10 | 17 of 30 |
| Team, the Auditor's summary of the rules goes to the Dev (seed 11 only) | 1 of 5 | 3 of 5 | 3 of 5 | 7 of 15 |
| Team, the Dev reads the rule file itself | 6 of 8 | 3 of 10 | 10 of 10 | 19 of 28 |

Haiku 5.5 alone got 5 of 5 on seed 11. The Qwen team has 8 runs, not 10: the last two were cut to save time.

- **The team helps a weak solver and a good coordinator.** Qwen alone fails (1 of 10); led by Qwen, with the work done by `gpt-oss-120b`, the team got 6 of 8. DeepSeek alone is already good (9 of 10) and got 10 of 10 as the team's Maestro, above what the worker (`gpt-oss-120b`, 7 of 10 alone) does by itself. So a coordinator can lift a cheaper worker.
- **The team hurts when the Maestro is the weak link.** `gpt-oss-120b` alone got 7 of 10 and, as Maestro of the same worker, 3 of 10. The coordination added errors that its own solving did not have. Choosing the Maestro matters more than having one.
- **A summary is a lossy copy.** The challenge used to say "give the Dev the Auditor's rules in its own words". With four traps, the summary dropped some (the chargebacks and the time window were missing from the Dev's message in most failed runs) and the team did worse than the lone agents (7 of 15). Telling the Dev to read the file itself raised it. The Maestro's instructions now say to send sources and not summaries (rule 11), and `ask --relay` passes a reviewer's words on as written.
- **The team is slow.** A lone agent took about a minute; the team took 4 to 18 minutes.
- **Relaying the reviewer's words did not fix scenario A.** With `--relay` the three Maestros that fail most (gpt-oss, Qwen, gpt-5.6-luna) passed 9 of 15 runs, against 6 of 15 before, short of the 11 asked for. luna went 5 of 5; the other two did not move.
- **What this does not show.** Ten runs per cell on two data sets, one task of one kind, one worker model. The Qwen and gpt-oss differences are large enough to take seriously (Qwen 1 of 10 against 6 of 8, gpt-oss 7 of 10 against 3 of 10); the rest could be noise.

## Other workers, a Maestro with only the goal, and the state line (round 15)

Three questions asked after scenario B, answered with 30 real runs plus 8 controls (scenario B, seeds 11 and 13, a bug planted in the Dev's first script, "right" means the answer and the `flag.py` are both right).

**Does the team work with a worker other than `gpt-oss-120b`?** Maestro DeepSeek V4.1 Flash, the Dev reads the files, `--relay`, four runs per worker:

| Worker | Right | Median cost per pass |
|---|---|---|
| DeepSeek V4.1 Flash | 4 of 4 | $0.03 |
| Kimi K2.7 Code | 3 of 4 | $0.12 |
| GLM 5.3 Flash | 3 of 4 | $0.03 |
| `gpt-oss-120b` (the earlier table) | 10 of 10 | |

Yes. Neither miss was the team's coordination: one Kimi run stopped at an OpenCode permission question (the Maestro tried to write into `/usr/local/bin`) before any message to a teammate, and one GLM script was wrong. Kimi as a worker costs four times as much as the others for the same result.

**Can the Maestro build the plan itself?** The task is the goal only (`--free`): no steps, no roles, no gates, and the Maestro may read the files. The worker is `gpt-oss-120b`.

| Maestro | Right | Messages to teammates |
|---|---|---|
| DeepSeek V4.1 Flash | 4 of 4 | 3 to 6 |
| Haiku 5.5 | 2 of 2 | 2 to 4 |
| Kimi K2.7 Code | 1 of 2 | 3 in the right run; the other worked alone, asked no teammate, and its answer never reached the human |
| `gpt-oss-120b` | 0 of 2 | one wrong script, one answer that never reached the human |

The two good Maestros recruited a reviewer and a Dev, asked for an independent check and got it right without being told how. The weak one still cannot. Eight runs is small, so read it as "it can", not as "it always does". The harness first let a Maestro wander out of the work folder and open the challenge's own files; the prompt now forbids it and a run that does so is not counted as right.

**Does a line written by the program help a weak Maestro?** With `OPENMAESTRI_STATE_LINE=1` every `ask` ends with one line the program writes from what it saw, for example `[openmaestri state] Dev: 2 messages, last check PASSED (python3 flag.py exit 0). Auditor: 1 message, last verdict REJECTED. Open: nothing.` `gpt-oss-120b` as Maestro of `gpt-oss-120b`, same code, same machine, same seeds:

| | Right | Passed (all 12 checks) | Seconds | Messages |
|---|---|---|---|---|
| Without the line | 5 of 8 | 2 of 8 | 434 | 7.0 |
| With the line | 7 of 8 | 4 of 8 | 277 | 6.8 |

The direction is the one hoped for, but two runs of difference out of eight is inside the noise, so the line stays off by default. The 3 of 10 in the table above was measured with older code; the 5 of 8 of the control shows that the instructions and notes added since then, or luck, already moved this model. The verdict that kimi's plan asked to be "structured by the program" already was: the reviewer must end with `VERDICT: APPROVED or REJECTED - reason` and the program parses it, sends back once what does not parse and fails closed.

## Does the team beat one agent alone? Scenario C and the stop rule (round 16)

Three research rounds (Claude, kimi and agy, 2026-11-05, notes in `notes/planners/sintese15.md`) agreed on one mechanism that wins in the literature: two independent implementations compared by a program, with the reviewer blind to the other's code, and a lone-agent control with the same compute (a vote over several runs). Scenario C is the ledger of scenario B with a dial of 1 to 10 traps (number formats, time zones and a window, chargebacks, repeated ids, USD at 5.10 rounded half to even, partial refunds, VIP limits, weekend half, a cap per sale, small sales dropped). The key is checked in the tests against an independent Python reading with `Decimal`. The `--diff` mode has the Auditor write `verify.py` from the rules alone, the Dev write `flag.py`, and the Maestro run a `diff` of their outputs; it acts only when they differ.

The stop rule was set before the runs: the team has to beat the same model alone, with the same compute, by 20 points or more, on a task where the lone agent is under 50%.

Lone agent, 8 data sets per cell (right means the answer and `flag.py` are both right):

| Model | 4 traps | 6 traps | 7 traps | 10 traps |
|---|---|---|---|---|
| DeepSeek V4.1 Flash | 8 of 8 | 7 of 8 | 6 of 8 | 8 of 8 |
| GLM 5.3 Flash | | | 2 of 8 | |
| `gpt-oss-120b` | | | 2 of 8 | |

Seven traps, `gpt-oss-120b` (the model that fails alone):

| How the work was done | Right |
|---|---|
| One run alone | 14 of 40 (35%) |
| Majority vote over 4 runs, same data | 3 of 8 |
| Team: Maestro DeepSeek, Dev and Auditor `gpt-oss-120b`, the program compares two scripts | **6 of 8** |

- **The strong cheap model is not beaten.** DeepSeek V4.1 Flash alone got 8 of 8 even with ten traps (cost about a cent, about two minutes). The dial never took a strong model under 50%, so the rule cannot be met on this family of tasks: the team does not beat a strong model alone. If you can pay for one strong model, use one agent.
- **The team lifts a weak model, and it is not just more compute.** `gpt-oss-120b` alone is right in about a third of the runs; a vote over four runs does not help (3 of 8); the team, with a good Maestro and two independent scripts, is right in 6 of 8, as good as DeepSeek alone at seven traps (6 of 8). Against the 40 lone runs the difference has p of about 0.05 (Fisher, one side); against the vote, p of 0.16 with only eight data sets. Read it as a strong hint, not as proof.
- **What it costs.** A team run took one to four minutes and one to three cents (one run 16 cents); DeepSeek alone about a cent. The team only pays when the model you have to use is the weak one (open weights on your own machine, no access to a strong model).
- **The two misses of the team**, read in the logs: on seed 701 both scripts agreed (the diff printed `SAME`) on an answer with one name too many, so the program had nothing to compare; that is the error two independent writers share, which the N-version literature predicts and a diff cannot see. On seed 301 the scripts never agreed in four rounds (eleven messages, 16 cents), and the Maestro answered with a list that matches neither script, `Centro,Leste,Litoral,Norte,Sul`, after saying the rule text decided for the Auditor's script: the arbitration step in the Maestro's instructions is the weak part.
- **The weak Maestro is still the weak link:** every team here had a good Maestro (DeepSeek). The earlier tables show what a weak one does.

## Add your own runs

```bash
node test/challenge/run.mjs --inject --record runs.jsonl \
  --maestro 'opencode -m openrouter/anthropic/claude-haiku-5.5' --worker 'opencode -m openrouter/openai/gpt-oss-120b'
node test/challenge/summary.mjs < runs.jsonl

# the same task for one agent alone, no Maestro and no gates
node test/challenge/run.mjs --baseline --record runs.jsonl --maestro 'opencode -m openrouter/anthropic/claude-haiku-5.5'

# scenario C, the traps dial; the team with the program comparing two independent scripts; and the control with the same compute
node test/challenge/run.mjs --baseline --scenario c --traps 7 --record lone.jsonl --maestro 'opencode -m openrouter/openai/gpt-oss-120b'
node test/challenge/run.mjs --diff --scenario c --traps 7 --record team.jsonl \
  --maestro 'opencode -m openrouter/deepseek/deepseek-v4.1-flash' --worker 'opencode -m openrouter/openai/gpt-oss-120b'
node test/challenge/vote.mjs < lone.jsonl   # majority vote over several lone runs on the same data

# the Maestro gets only the goal and builds the plan; add --state for the program's state line
node test/challenge/run.mjs --free --scenario b --record runs.jsonl \
  --maestro 'opencode -m openrouter/anthropic/claude-haiku-5.5' --worker 'opencode -m openrouter/openai/gpt-oss-120b'

# scenario B (the ledger with traps), team with the Dev reading the files and --relay for the reviewer's words
node test/challenge/run.mjs --inject --relay --dev-reads --scenario b --record runs.jsonl \
  --maestro 'opencode -m openrouter/qwen/qwen3.7-flash' --worker 'opencode -m openrouter/openai/gpt-oss-120b'
```

Each run costs from one cent to thirty cents on OpenRouter with these models.
