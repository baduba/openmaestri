#!/usr/bin/env bash
# The CI, on this machine. Same checks the GitHub workflows ran, nothing leaves the computer.
#   scripts/check.sh               quick: syntax, lint, tests (what a pull request needs before merge)
#   scripts/check.sh --full        quick + scripts/sast.sh + the .deb build and its smoke test
#   scripts/check.sh --dast        also scripts/dast.sh (our attack checks and OWASP ZAP; --dast-full for the active scan)
#   scripts/check.sh --matrix      run the tests on Node 22 and 24, each in a clean copy (needs nvm; installs a missing version)
#   scripts/check.sh --release     what a tag needs: version in package.json equals the tag (give TAG=vX.Y.Z), tests, .deb
# Flags combine. Each step prints ok or FAILED; the exit code is 1 if any step failed. A summary closes the run.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

full=0 dast=0 dastflag="" matrix=0 release=0
for a in "$@"; do case "$a" in
  --full) full=1 ;; --dast) dast=1 ;; --dast-full) dast=1; dastflag="--full" ;;
  --matrix) matrix=1 ;; --release) release=1; full=1 ;;
  -h|--help) sed -n 2,10p "$0"; exit 0 ;;
  *) echo "unknown option: $a" >&2; exit 2 ;;
esac; done

results=()
step() { local name="$1"; shift; echo; echo "== $name"; local t0=$SECONDS
  if "$@"; then results+=("ok      $name ($((SECONDS - t0))s)"); else results+=("FAILED  $name ($((SECONDS - t0))s)"); fail=1; fi; }
fail=0

# Chromium for the UI test: installed once, cached in ~/.cache/ms-playwright.
# shellcheck disable=SC2329  # called through step()
ensure_chromium() { ls "$HOME"/.cache/ms-playwright/chromium-* >/dev/null 2>&1 || ./node_modules/.bin/playwright-core install chromium; }

# The suite starts many daemons and browsers at once, so on a busy machine a timing-sensitive test can fail
# while it passes alone. A failed file is rerun alone once; the summary says so, and a real failure fails twice.
# shellcheck disable=SC2329  # called through step()
run_tests() {
  local log code; log=$(mktemp)
  npm test 2>&1 | tee "$log"; code=${PIPESTATUS[0]}
  if [[ "$code" == 0 ]]; then rm -f "$log"; return 0; fi
  local files; mapfile -t files < <(grep -oE '^test at test/[^:]+' "$log" | sed 's/^test at //' | sort -u)
  rm -f "$log"
  [[ "${#files[@]}" -gt 0 ]] || return 1
  echo "-- rerunning ${#files[@]} failed file(s) alone: ${files[*]}"
  OPENMAESTRI_NO_WELCOME=1 node --test --test-timeout=240000 "${files[@]}" && echo "-- PASSED ON RERUN (flaky under load): ${files[*]}"
}

# shellcheck disable=SC2329  # called through step()
smoke_deb() {
  local pkg tmp; tmp=$(mktemp -d); pkg=$(find dist -name "*.deb" -printf "%T@ %p\n" | sort -rn | head -1 | cut -d" " -f2-)
  dpkg-deb -I "$pkg" >/dev/null && dpkg-deb -x "$pkg" "$tmp" \
    && node "$tmp/usr/lib/openmaestri/bin/openmaestri.js" version \
    && node -e "require('$tmp/usr/lib/openmaestri/node_modules/node-pty')"
  local code=$?; rm -rf "$tmp"; return "$code"
}

# shellcheck disable=SC2329  # called through step()
tag_matches() {
  [[ -n "${TAG:-}" ]] || { echo "set TAG=vX.Y.Z"; return 1; }
  [[ "v$(node -p "require('./package.json').version")" == "$TAG" ]] || { echo "package.json says v$(node -p "require('./package.json').version"), tag is $TAG"; return 1; }
}

# Tests on each Node version, in a copy without node_modules, so node-pty is built for that ABI and the working tree stays untouched.
# shellcheck disable=SC2329  # called through step()
matrix_test() {
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" 2>/dev/null || { echo "nvm not found"; return 1; }
  local rc=0 v tmp
  for v in 22 24; do
    nvm ls "$v" >/dev/null 2>&1 || nvm install "$v" >/dev/null || { echo "could not install node $v"; return 1; }
    tmp=$(mktemp -d)
    tar --exclude=./node_modules --exclude=./dist --exclude=./.git -cf - . | tar -xf - -C "$tmp"
    echo "-- node $v"
    ( cd "$tmp" && nvm exec "$v" npm ci --no-audit --no-fund >/dev/null && nvm exec "$v" npm test ) || { echo "FAILED on node $v"; rc=1; }
    rm -rf "$tmp"
  done
  return "$rc"
}

[[ "$release" == 1 ]] && step "tag matches package.json" tag_matches
step "syntax (npm run check)" npm run -s check
step "lint (npm run lint)" npm run -s lint
step "chromium for the UI test" ensure_chromium
if [[ "$matrix" == 1 ]]; then step "tests on Node 22 and 24" matrix_test; else step "tests (npm test)" run_tests; fi
if [[ "$full" == 1 ]]; then
  step "static analysis (scripts/sast.sh)" scripts/sast.sh
  step ".deb build" scripts/build-deb.sh
  step ".deb smoke test" smoke_deb
fi
[[ "$dast" == 1 ]] && step "dynamic tests (scripts/dast.sh)" scripts/dast.sh $dastflag

echo; echo "== summary"; printf '%s\n' "${results[@]}"
exit $fail
