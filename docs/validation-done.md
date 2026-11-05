---
title: What "done" means for the validation layer
---

# What "done" means for the validation layer

The layer is the part of openmaestri that judges work with the program instead of the model: `ask --check`, `--verdict`, `--then`, the loop guard, the Maestro watchdog, the report, the budget and `resume`. This page says when it counts as finished, and where it stands on 2026-11-04.

| Criterion | State |
|---|---|
| A failed check goes back to the teammate by itself, capped, with a clipped log | Done, tested |
| A verdict that is missing or malformed fails closed | Done, tested |
| The answer to the human says when a check was left failing | Done, tested |
| A reviewer's REJECTED against a passing check is flagged to the Maestro | Done, released in 0.25.0 |
| A loop of similar messages is warned at the 3rd and refused at the 5th | Done, tested |
| A Maestro that stops answering is reminded, at most twice | Done, tested |
| A spending limit stops terminals and one-shot agents, set only by the person | Done. Dollars of one-shot agents are not visible |
| The orchestration resumes after a crash | Done (`resume`) |
| Real runs show it works with cheap models | Done: 66 runs, 9 Maestros, 6 baselines ([models](models.html)) |
| The harness can tell the team from one agent alone | Done (`--baseline`) |
| **The team beats one agent alone on some task** | **Not shown.** On the flag task one agent is as right, faster and cheaper |
| Dangerous commands (`rm`, `git push`) approved by something other than the weak model | Not done. A box (`sandbox`) limits the damage; the commands are not filtered |
| Other agents (codex, goose, aider) as teammates in the challenge | Not done; no real run of those drivers |

## The three gaps left

1. **A task where one agent alone is often wrong.** Without it the layer's value is argued, not measured. Make a second scenario with a trap a single agent falls for (a rule hidden in a long file, a result that looks plausible and is not), run the baseline and the team on it, five runs each.
2. **More runs on the models that would be the default.** Three to six runs only separate a model that fails from one that works. Ten per model for Haiku 5.5, DeepSeek V4.1 Flash and GPT-OSS 120B would settle the default team.
3. **Dangerous commands.** Either a policy file the person writes (which programs an agent may run) or the box as the default for every teammate with real keys. The second already exists as an option.

Nothing else blocks calling the layer finished. The first gap decides whether to keep investing in it.
