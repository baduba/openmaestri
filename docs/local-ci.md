---
title: Local CI
---

# Local CI

The GitHub workflows for CI and Security are disabled to save runner minutes. Everything they ran now runs on your machine with one script, when you ask for it.

```bash
scripts/check.sh               # quick: syntax, lint, the whole test suite (what a pull request needs)
scripts/check.sh --full        # quick + scripts/sast.sh + the .deb build and its smoke test
scripts/check.sh --dast        # also the dynamic tests (our attack checks and OWASP ZAP baseline, needs Docker)
scripts/check.sh --dast-full   # same, with the ZAP active scan (up to 10 minutes)
scripts/check.sh --matrix      # tests on Node 22 and 24, each in a clean copy (installs a missing version with nvm)
TAG=v1.2.3 scripts/check.sh --release   # version equals the tag, tests, .deb build and smoke test
```

Flags combine. Each step prints `ok` or `FAILED` with its time, a summary closes the run, and the exit code is 1 when any step failed.

| Step | Replaces |
|---|---|
| syntax, lint, tests | the `test` job of the CI workflow |
| `.deb` build and smoke test | the `deb` job |
| `scripts/sast.sh` | ESLint, `npm audit`, Semgrep, gitleaks and Trivy of the Security workflow (plus njsscan and shellcheck) |
| `scripts/dast.sh` | nothing before; it was already local only |
| `--matrix` | the Node 22 and 24 matrix |
| `--release` | the tag check of the Release workflow |

Two things are not replaced: **CodeQL** (no local run yet; Semgrep covers part of the same ground) and the **UI test's Chromium**, which the script installs once into `~/.cache/ms-playwright` when it is missing.

The suite starts many daemons and browsers at once. On a busy machine a timing-sensitive test can fail while it passes alone, so a failed file is rerun alone once. The summary prints `PASSED ON RERUN` when that happens; a real failure fails both times.

## Still on GitHub

The Release workflow still runs when you push a `v*` tag: it repeats the tests, builds the `.deb` and publishes the release (the only workflow that still spends minutes, and only on a tag). Dependabot keeps opening weekly update pull requests. To turn the CI and Security workflows back on: `gh workflow enable CI` and `gh workflow enable Security`.
