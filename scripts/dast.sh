#!/usr/bin/env bash
# Dynamic security tests against a running daemon.
#   scripts/dast.sh            our own attack checks (test/dast.mjs), then OWASP ZAP baseline when Docker is there
#   scripts/dast.sh --no-zap   only our checks
#   scripts/dast.sh --full     our checks, then the ZAP active scan (attacks the pages for up to 10 minutes) instead of the baseline
# ZAP runs as a container on the host network against a throwaway daemon with its own data folder.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
fail=0
echo "== openmaestri attack checks"
node test/dast.mjs || fail=1
if [[ "${1:-}" == "--no-zap" ]] || ! command -v docker >/dev/null 2>&1; then
  [[ "${1:-}" == "--no-zap" ]] || echo "-- ZAP: SKIPPED (docker not installed)"
  exit $fail
fi
echo "== OWASP ZAP baseline"
data=$(mktemp -d); out=$(mktemp -d); chmod 777 "$out"
port=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
OPENMAESTRI_DATA_DIR="$data" OPENMAESTRI_PORT="$port" OPENMAESTRI_SOCKET_PATH="$data/ipc.sock" OPENMAESTRI_NO_WELCOME=1 HOME="$data" node bin/openmaestri.js serve >"$data/log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null; rm -rf "$data"' EXIT
for _ in $(seq 1 50); do [[ -s "$data/token" ]] && break; sleep 0.2; done
sleep 1
token=$(cat "$data/token")
if [[ "${1:-}" == "--full" ]]; then zap=(zap-full-scan.py -m 2 -T 10); else zap=(zap-baseline.py -m 2); fi
docker run --rm --network host -v "$out:/zap/wrk:rw" ghcr.io/zaproxy/zaproxy:stable \
  "${zap[@]}" -t "http://127.0.0.1:$port/?token=$token" -J zap.json -r zap.html -I >"$out/zap.log" 2>&1
code=$?
echo "ZAP exit code $code (0 clean, 1 failures, 2 warnings); report: $out/zap.json"
grep -E "^(PASS|WARN-NEW|FAIL-NEW|INFO):|FAIL-NEW|WARN-NEW" "$out/zap.log" | sed 's/\[[0-9]*\]//' | sort | uniq -c | sort -rn | head -30
# the summary line starts with "FAIL-NEW: 0" when nothing failed, so only a count above zero is a failure
if grep -qE "^FAIL-NEW: [1-9][0-9]*[[:space:]]+FAIL-INPROG" "$out/zap.log"; then fail=1; fi
kill -0 "$pid" 2>/dev/null || { echo "FAIL  the daemon died during the ZAP scan"; tail -5 "$data/log"; fail=1; }
exit $fail
