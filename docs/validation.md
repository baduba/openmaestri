---
title: Checking a teammate's work
---

# Checking a teammate's work

A cheap model is a poor judge of another model's answer. In our own runs a Maestro approved without looking, refused good work twice for no reason, sent the same message three times, and once asked the human a question instead of starting. So the judging is done by the program, not by the model.

## ask with a check

```bash
openmaestri ask "Dev" "Write flag.py that prints the flagged regions" --check "python3 flag.py" --retries 1 --then "Senior"
```

- `--check CMD` runs `CMD` in the teammate's folder (and in its container, if it runs in a box) with no API keys, no input and a time limit. Exit 0 means accepted. Only a Maestro can use it, because it runs a command on this machine.
- If the check fails, the failure goes back to the teammate by itself, in fixed wording, with the output cut to its first 20 and last 40 lines. The Maestro is not involved until the work passes or the corrections run out.
- `--retries N` is the number of corrections, 1 by default and never more than 2. A model that cannot fix it in two tries usually circles.
- `--then "Other"` hands the same task to another teammate when the first cannot pass.

The answer starts with one line the Maestro can act on without interpreting anything:

```
[gate] PASSED after 2 attempts
[gate] FAILED after 2 attempts: the check "python3 flag.py" exited with 1:
Traceback ...
```

## ask for a verdict

```bash
openmaestri ask "Auditor" "Judge this output against data/rules.md: Centro Leste Litoral Norte" --verdict
```

The reply must end in one line, and nothing else counts:

```
VERDICT: APPROVED - what was checked and found
VERDICT: REJECTED - Norte is listed but its revenue is under the limit
```

The older three-line block (`<<<VERDICT`, `STATUS: ...`, `REASON: ...`, `VERDICT>>>`) is still accepted. The single line is what weak models manage to write.

A loose "APPROVED", "NOT APPROVED", a missing reason or a placeholder such as `<reason>` is not a verdict. The program sends the reply back with the exact shape (as many times as `--retries` allows), and if it still does not fit, the answer is `[gate] FAILED ... no verdict line in the required shape`: the check fails closed. A valid `REJECTED` is a good answer, not a failure: `[gate] PASSED ... VERDICT: REJECTED: reason`.

## When a check failed and the Maestro answered anyway

If the Maestro answers the human while the last check on some teammate's work is a failure, the program adds a line to that chat message: `[openmaestri] Not verified: a check on the work of Dev: ... failed and was not fixed afterwards`. The human is not told "approved" about work that never passed, whatever the Maestro wrote. The report lists it as `unverified`.

## Loops

If the Maestro sends a teammate nearly the same message a third time within 15 minutes, the answer starts with a `[loop]` warning. The fifth is refused, with advice: say it differently with the exact error, or give the task to another teammate.

## One-shot agents

`agent` takes `--check` too. When the answer's work fails the check, the next driver of the fallback chain gets the task, the same way an exhausted account does:

```bash
openmaestri agent codex "Fix the failing test" --fallback opencode,kimi --check "npm test"
```

## Reminders to the Maestro

A weak Maestro often goes quiet after the human wrote: it asks a question the human already answered, says it "cannot run commands" without trying, or does the work itself. If the chat has no answer and its screen has not changed for 45 seconds, the program types a fixed reminder into its terminal, at most twice (`OPENMAESTRI_NO_NUDGE=1` turns it off). The report counts them.

## The report

```bash
openmaestri report          # or --json
```

One line per ask, check, verdict, correction, handoff and loop warning, in order, with the totals. It is written from what the program saw, so it does not depend on the Maestro remembering to tell you.

## Agents that wait for a human

Terminals that run an agent get `PAGER=cat`, `GIT_PAGER=cat`, `GIT_EDITOR=true`, `GIT_TERMINAL_PROMPT=0` and `DEBIAN_FRONTEND=noninteractive` unless you set them yourself. A model that runs `git log` or `git commit` without `-m` then fails at once instead of freezing the pane. A plain shell is left alone.

## Checking the checker

A reviewer's `verify.py` is only worth something if it can fail. The challenge checks that the Auditor's script prints the right list (an empty script or `sys.exit(0)` prints nothing) and that its output differs from the output of the script with the planted bug. If the oracle agrees with the bug, the run fails even when everything else looks green. Do the same in your own work: run the verifier once against something you know is wrong.

## Spending

```bash
OPENMAESTRI_BUDGET_USD=0.50 openmaestri      # when you start the daemon
openmaestri budget                           # read only, from any terminal
```

The program cannot see the API calls an agent makes, but a full-screen agent prints the session cost on its status line (OpenCode: `13.2K (10%) · $0.02`). openmaestri reads that number from each terminal, keeps the highest it has seen, and adds them up per workspace. At 80% of the limit you get a notification and a line in the report; at 100% every terminal of the workspace is stopped. Only the person sets the limit: there is no command for an agent to raise it. One-shot agents (`agent`, `run`) have no screen, so the dollars they spend are not counted. What the limit does for them: once it is reached, a one-shot agent that is running is stopped and a new one is refused (`agent`, `run`), so the cut has no back door. The stronger fence is a limit on the key itself at your provider (OpenRouter lets you put a credit limit on a key); use both.

## When the reviewer and the check disagree

A check is a fact (the command exited 0) and a verdict is an opinion. When a reviewer answers `REJECTED` right after the last check passed, the reply to the Maestro ends with a line saying so and asking it to run something that shows whether the reviewer's claim is true before it sends the Dev back to redo work that passed. The reviewer may still be right (a check can be incomplete), so nothing is overruled: the Maestro is only told, once, that the two disagree. The `report` lists it as a `conflict`.

## Where teammates run

```bash
openmaestri sandbox          # read only: in a box or on this machine, and which keys each one can read
OPENMAESTRI_DEFAULT_SANDBOX=my-agents:latest openmaestri    # every new teammate runs in this image
openmaestri recruit "Dev" --preset P --no-sandbox            # opt out for one
```

A teammate on this machine can read your files and the keys in your environment file and its account. `recruit` says so, by name and never by value: `Dev runs on this machine with access to your files and these keys: OPENROUTER_API_KEY`. The Maestro and a plain shell are never boxed by default. The default is the person's to set; an agent cannot change it. openmaestri does not see the commands an agent runs inside its own tool, so it cannot filter `rm -rf`; what it can do is keep the agent in a box where `rm -rf` only reaches that folder.

## Picking up after a restart

```bash
openmaestri resume
```

Every ask, check, verdict, correction, reminder and spending notice is saved with the workspace, so a restart or a crash does not erase it. `resume` prints the last events and what is still open (a check that failed and was not fixed afterwards). A Maestro started in a workspace that already has events gets the same text with its first message, so a replacement does not redo what already passed.

## What this does not do

It does not ask a second model to judge the first: two cheap models can agree on broken code. It does not accept a regex that is "close enough". And it does not hide the failure: when the corrections run out, the Maestro and the report both say so.
