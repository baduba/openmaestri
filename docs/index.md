---
title: openmaestri
---

# openmaestri

A spatial canvas terminal workspace for AI agents. Open source, local, works with open models such as DeepSeek.

[Download the .deb](https://github.com/baduba/openmaestri/releases/latest) · [Source](https://github.com/baduba/openmaestri) · [Report a bug](reporting-bugs.html)

## Start here

1. [Getting started](getting-started.html): install, first terminal, first connection.
2. [DeepSeek and open models](deepseek.html): presets, OpenCode and Aider.
   [API keys and secrets](secrets.html): keys for any agent, kept out of files.
   [Audit log and workspace files](audit.html): what is recorded, and the strict import format.
   [Accounts](accounts.html): work and personal keys for the same agent.
   [Everyday tools](everyday.html): processes, workspace groups, note pictures, chat summaries.
   [Persistent terminals](persistent-terminals.html) and the [desktop window](desktop.html).
   [Roadmap](roadmap.html): what is done and what comes next.
3. [Floors](floors.html): one branch and one canvas per task.
4. [Portals](portals.html): a browser you and your agents share.
5. [Files](files.html): browse and edit the project folder from the canvas.
6. [Chat](chat.html): talk to your Maestro; seven threads with memory.
7. [One-shot agents](oneshot.html): ask any agent CLI a question without a terminal.
8. [Orchestration challenge](functional-test.html): a functional test where a Maestro coordinates teammates through several round trips.
9. [Saved prompts, usage and roles](agents.html): reuse prompts, see tokens and cost, install roles.
10. [CLI reference](cli.html): every `openmaestri` command agents can run.
11. [Architecture](architecture.html): how the daemon, socket and UI fit together.
12. [Troubleshooting](troubleshooting.html) and [how to report a bug](reporting-bugs.html).

## The idea in one minute

Run several coding agents side by side on an infinite canvas. Draw cables between them and they can `ask` each other for work. Mark one agent as **Maestro** and it recruits teammates, splits a goal into pieces, runs them in parallel, and reads the results, all through the `openmaestri` command that exists in every terminal.

## Contribute

openmaestri is a community project. Read the [contributing guide](https://github.com/baduba/openmaestri/blob/main/CONTRIBUTING.md), pick an issue labelled `good first issue`, and open a pull request.
