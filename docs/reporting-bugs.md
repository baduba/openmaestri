---
title: How to report a bug
---

# How to report a bug

Good reports get fixed fast. It takes about five minutes.

1. **Search first.** Look through [open and closed issues](https://github.com/baduba/openmaestri/issues?q=is%3Aissue) for the same symptom.
2. **Update.** Make sure you are on the latest [release](https://github.com/baduba/openmaestri/releases/latest) or `main`.
3. **Collect diagnostics.** In the affected terminal run:
   ```bash
   openmaestri debug
   openmaestri version
   node --version
   uname -a
   ```
4. **Find a minimal reproduction.** Ideally with a plain Shell terminal instead of a paid agent: `openmaestri ask "Shell 2" "echo hi"` is easier for us to reproduce than a long agent session.
5. **Open the issue** with [this form](https://github.com/baduba/openmaestri/issues/new?template=bug_report.yml). Fill in what you expected, what happened, steps, and the diagnostics.
6. **Redact secrets.** Never paste API keys, tokens (the `?token=` part of the UI URL), or private code. If a log may contain them, trim it.

## Security problems

Do **not** open a public issue for a vulnerability. Use [private vulnerability reporting](https://github.com/baduba/openmaestri/security/advisories/new). See [SECURITY.md](https://github.com/baduba/openmaestri/blob/main/SECURITY.md).

## Feature ideas and questions

Use the [feature request form](https://github.com/baduba/openmaestri/issues/new?template=feature_request.yml) for ideas, and [Discussions](https://github.com/baduba/openmaestri/discussions) for questions.

## What happens next

A maintainer will label the issue (`bug`, `needs-info`, `good first issue`, `help wanted`). If it is labelled `help wanted`, you are welcome to fix it: see [CONTRIBUTING.md](https://github.com/baduba/openmaestri/blob/main/CONTRIBUTING.md).
