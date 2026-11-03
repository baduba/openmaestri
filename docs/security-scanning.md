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

## Dynamic tests (DAST)

Static analysis reads the code; these attack a running daemon.

```bash
scripts/dast.sh            # our attack checks, then the OWASP ZAP baseline (needs Docker)
scripts/dast.sh --no-zap   # only our checks
scripts/dast.sh --full     # our checks, then the ZAP active scan (up to 10 minutes)
```

`test/dast.mjs` starts the real daemon in a temporary data folder and sends it what an attacker would: no token, a wrong token, a forged cookie, foreign `Host` and `Origin` headers (DNS rebinding, `Origin: null`), path traversal in every route, odd HTTP methods, 200 KB URLs and 100 KB headers, a request-smuggling attempt, a half-open connection, and on the WebSocket a foreign origin, hostile messages (`null`, prototype keys), and a frame over the 8 MB limit. It also checks the headers and the CSP, that the port listens on `127.0.0.1` only, and the modes of the data folder, token file and agent socket. It fails if the daemon dies at any point.

The ZAP baseline is a passive scan plus a spider with the token in the URL. It reports four warnings that are the design, not defects: the token cookie (session management), `Cache-Control: no-store` (non-storable content), the token in the first URL (printed once, then the browser is redirected to `/` and `Referrer-Policy: no-referrer` keeps it out of other sites), and the cookie being set from that URL (it only happens when the value already equals the real token).

The first run of these checks found three ways to stop the daemon, now fixed and covered by `test/security.test.js`: an `Origin: null` header (what a sandboxed frame on any web page sends), a WebSocket message that is JSON `null`, and a WebSocket frame over the size limit.

## Two noisy ESLint rules are off, on purpose

`security/detect-non-literal-fs-filename` and `security/detect-object-injection` fire on every dynamic path or property access and cannot tell safe from unsafe. The risks they stand for are handled in code and covered by `test/security.test.js`:

- ids that become file names go through `safeId()` and must be canonical UUIDs
- lookups keyed by external input use `Object.hasOwn` (commands, node kinds, MIME types, vendor paths)
- node fields from the UI are type- and range-checked before they are stored

## Accepted risks

- `routine create --pre-run` runs a user-written shell command in the daemon. It has the same privileges as the terminals, a 60 s timeout and a 1 MiB output cap, and is marked with an `eslint-disable` that explains why.
- Agents run with your privileges. See [SECURITY.md](https://github.com/baduba/openmaestri/blob/main/SECURITY.md).
