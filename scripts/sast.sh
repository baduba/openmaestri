#!/usr/bin/env bash
# Run every static-analysis tool we use, locally. Missing tools are reported, not fatal.
#   scripts/sast.sh            all tools
# Install the optional ones with: pipx install semgrep ruff bandit njsscan shellcheck-py ; and trivy/gitleaks from their releases.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
fail=0
run() { local name="$1"; shift; if ! command -v "$1" >/dev/null 2>&1 && [ "$1" != npm ] && [ "$1" != npx ]; then echo "-- $name: SKIPPED ($1 not installed)"; return; fi
  echo "== $name"; if "$@"; then echo "   ok"; else echo "   FAILED"; fail=1; fi; }

run "eslint (security + no-unsanitized)" npm run -s lint
run "npm audit"                          npm audit --audit-level=low
run "semgrep" semgrep scan --metrics=off --quiet --error --exclude node_modules --exclude dist \
  --config p/javascript --config p/nodejs --config p/security-audit --config p/owasp-top-ten \
  --config p/secrets --config p/command-injection --config p/xss --config p/github-actions .
run "njsscan"   njsscan --exit-warning src bin web
run "gitleaks"  gitleaks detect --no-banner --redact -s . --log-opts="--all"
run "trivy"     trivy fs --quiet --scanners vuln,secret,misconfig --severity LOW,MEDIUM,HIGH,CRITICAL --exit-code 1 .
run "shellcheck" shellcheck scripts/*.sh bin/shims/openmaestri test/fixtures/*.sh
if [ -n "$(find . -name '*.py' -not -path './node_modules/*' -print -quit)" ]; then
  run "ruff" ruff check .
  run "bandit" bandit -q -r . -x ./node_modules
else
  echo "-- ruff/bandit: no Python files in this project"
fi
exit $fail
