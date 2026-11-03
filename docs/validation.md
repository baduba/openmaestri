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

The reply must end in this block, and nothing else counts:

```
<<<VERDICT
STATUS: APPROVED or REJECTED
REASON: what was checked and found
VERDICT>>>
```

A loose "APPROVED", "NOT APPROVED", a missing reason or an unclosed block is not a verdict. The program sends the reply back once with the exact shape, and if it still does not fit, the answer is `[gate] FAILED ... no verdict block in the required shape`: the check fails closed. A valid `REJECTED` is a good answer, not a failure: `[gate] PASSED ... VERDICT: REJECTED: reason`.

## Loops

If the Maestro sends a teammate nearly the same message a third time within 15 minutes, the answer starts with a `[loop]` warning. The fifth is refused, with advice: say it differently with the exact error, or give the task to another teammate.

## One-shot agents

`agent` takes `--check` too. When the answer's work fails the check, the next driver of the fallback chain gets the task, the same way an exhausted account does:

```bash
openmaestri agent codex "Fix the failing test" --fallback opencode,kimi --check "npm test"
```

## The report

```bash
openmaestri report          # or --json
```

One line per ask, check, verdict, correction, handoff and loop warning, in order, with the totals. It is written from what the program saw, so it does not depend on the Maestro remembering to tell you.

## Agents that wait for a human

Terminals that run an agent get `PAGER=cat`, `GIT_PAGER=cat`, `GIT_EDITOR=true`, `GIT_TERMINAL_PROMPT=0` and `DEBIAN_FRONTEND=noninteractive` unless you set them yourself. A model that runs `git log` or `git commit` without `-m` then fails at once instead of freezing the pane. A plain shell is left alone.

## What this does not do

It does not ask a second model to judge the first: two cheap models can agree on broken code. It does not accept a regex that is "close enough". And it does not hide the failure: when the corrections run out, the Maestro and the report both say so.
