---
title: Security scanning
---

# Security scanning

Every pull request runs static analysis. You can run the same tools locally with one command:

```bash
scripts/sast.sh
```

| Tool | What it checks | Where |
|---|---|---|
| ESLint + `eslint-plugin-security` + `no-unsanitized` | unsafe patterns, regex DoS, `child_process`, DOM sinks | `npm run lint`, CI |
| Semgrep (javascript, nodejs, security-audit, owasp-top-ten, secrets, command-injection, xss, github-actions) | taint and misuse rules, workflow hardening | CI, local |
| njsscan | Node.js specific rules | local |
| CodeQL (`security-extended`) | data-flow analysis | CI (weekly and per PR) |
| gitleaks | secrets in the tree and in git history | CI, local |
| Trivy | vulnerable dependencies, secrets, misconfiguration | CI, local |
| `npm audit` | known advisories, including dev dependencies | CI, local |
| shellcheck | the shell scripts (packaging, shims, fixtures) | local |
| ruff, bandit | Python (there is none today; enabled automatically if any appears) | local |

GitHub Actions are pinned to commit SHAs and Dependabot proposes updates with a 7-day cooldown. `.npmrc` sets `min-release-age=7` so freshly published packages are not installed immediately.

## Two noisy ESLint rules are off, on purpose

`security/detect-non-literal-fs-filename` and `security/detect-object-injection` fire on every dynamic path or property access and cannot tell safe from unsafe. The risks they stand for are handled in code and covered by `test/security.test.js`:

- ids that become file names go through `safeId()` and must be canonical UUIDs
- lookups keyed by external input use `Object.hasOwn` (commands, node kinds, MIME types, vendor paths)
- node fields from the UI are type- and range-checked before they are stored

## Accepted risks

- `routine create --pre-run` runs a user-written shell command in the daemon. It has the same privileges as the terminals, a 60 s timeout and a 1 MiB output cap, and is marked with an `eslint-disable` that explains why.
- Agents run with your privileges. See [SECURITY.md](https://github.com/baduba/openmaestri/blob/main/SECURITY.md).
