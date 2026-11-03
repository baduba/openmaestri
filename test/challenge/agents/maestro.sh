#!/bin/bash
# Scripted Maestro for the orchestration challenge: no model, it only follows the steps, so the harness itself can be tested.
IFS= read -r line
dir=$(printf '%s' "$line" | grep -o '/[^ ]*/work' | head -1)
echo "[maestro] folder $dir"
openmaestri recruit Auditor --preset Worker >/dev/null
openmaestri recruit Dev --preset Worker >/dev/null
sleep 2
ans() { grep '^RESULT:' | tail -1; }
rules=$(openmaestri ask Auditor "Read $dir/data/rules.md and answer with the rules in your own short words" --timeout 30s | ans)
echo "[maestro] rules: $rules"
openmaestri ask Dev "Write flag.py in $dir. Rules: $rules" --timeout 30s >/dev/null
round=0
while [[ $round -lt 5 ]]; do
  round=$((round + 1))
  out=$(cd "$dir" && python3 flag.py | tr '\n' ' ')
  echo "[maestro] round $round flag.py printed: $out"
  verdict=$(openmaestri ask Auditor "Review this flag.py output against $dir/data/rules.md and answer APPROVED or REJECTED with a reason: $out" --timeout 30s | ans)
  echo "[maestro] verdict: $verdict"
  case "$verdict" in *APPROVED*) break ;;
    *) ;; esac
  openmaestri ask Dev "REJECTED: $verdict. Fix flag.py in $dir and tell me when done" --timeout 30s >/dev/null
done
flagged=$(printf '%s' "$out" | xargs | tr ' ' ',')
openmaestri say "VERDICT: APPROVED
FLAGGED: $flagged
ROUNDS: $round"
sleep 600
