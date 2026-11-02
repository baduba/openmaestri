---
title: Accounts
---

# Accounts

An **account** is a named set of environment variables for an agent, so the same program can run as "work" or "personal": different keys, base URLs or organisations. It builds on [secrets](secrets.html): the key itself stays in the keyring, the account only points to it.

```bash
openmaestri secrets set work-anthropic                     # type the key once (hidden)
openmaestri accounts set work ANTHROPIC_API_KEY=secret://work-anthropic ANTHROPIC_BASE_URL=https://proxy.example
openmaestri accounts list                                  # names and variable names, never values
```

Then use it:

```bash
openmaestri recruit "Dev" --preset Claude --account work     # a terminal agent
openmaestri preset set Claude --account work                 # every agent from this preset
openmaestri agent claude "..." --account work                # a one-shot run
openmaestri run "..." --agents claude,codex --account work   # several one-shot runs
```

In the interface, the **New terminal** window shows an *Account* list as soon as one exists.

## Rules

- A variable whose name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` must be a `secret://name` reference. Plain settings (a base URL, an organisation id) may be written out.
- Names that change how a program starts are refused: `PATH`, `HOME`, `NODE_OPTIONS`, `LD_*`, `PYTHON*`, `GIT_*`, `SSH_*`, `OPENMAESTRI_*` and similar. An account is an environment, and these would turn it into a way to run code.
- The account wins over `~/.openmaestri/env` for terminals, and over the driver's own key list for one-shot runs: you chose it on purpose.
- A `secret://` reference that is not stored is left out with a warning; the reference text is never passed on as if it were the key.
- `accounts` runs only in your own shell, never inside an agent terminal. `accounts.json` is private (mode 0600). Every change is in the [audit log](audit.html), with names only.
