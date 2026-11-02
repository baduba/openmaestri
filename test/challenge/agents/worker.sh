#!/bin/bash
# Scripted teammate for the orchestration challenge. Auditor reads rules and judges; Dev writes flag.py, wrong the first time on purpose.
name="${OPENMAESTRI_TERMINAL_NAME:-worker}"
echo "[$name] ready"
fix=0
write_flag() { # $1 = how many regions to cut off the end of the output (the deliberate bug)
cat > flag.py <<PY
import csv, re
rules = open('data/rules.md').read()
limit = float(re.search(r'revenue is greater than (\d+)', rules).group(1))
pct = float(re.search(r'more than (\d+)% of', rules).group(1))
seen, st = set(), {}
for r in csv.DictReader(open('data/sales.csv')):
    s = st.setdefault(r['region'], [0, 0, 0.0])
    s[0] += 1
    u, dup = int(r['units']), r['order_id'] in seen
    seen.add(r['order_id'])
    if u <= 0 or dup: s[1] += 1
    else: s[2] += u * int(r['unit_price'])
out = sorted(g for g, s in st.items() if s[2] > limit or s[1] * 100 / s[0] > pct)
print('\n'.join(out[:len(out) - $1]))
PY
}
while IFS= read -r line; do
  sleep 0.3
  case "$name" in
    Auditor)
      if [[ "$line" == *"Read "*rules.md* ]]; then
        f=$(printf '%s' "$line" | grep -o '/[^ ]*rules.md' | head -1)
        echo "RESULT: valid row = units > 0 and first row of its order_id; revenue = sum units*price of valid rows; flagged if revenue > $(grep -o 'greater than [0-9]*' "$f" | grep -o '[0-9]*') or more than $(grep -o 'than [0-9]*%' "$f" | grep -o '[0-9]*')% of rows invalid"
      elif [[ "$line" == *"Review this flag.py"* ]]; then
        d=$(printf '%s' "$line" | grep -o '/[^ ]*/work' | head -1)
        given=$(printf '%s' "${line##*: }" | tr ' ' '\n' | grep -v '^$' | sort | tr '\n' ' ')
        want=$(cd "$d" && python3 - <<'PY'
import csv, re
rules = open('data/rules.md').read()
limit = float(re.search(r'revenue is greater than (\d+)', rules).group(1))
pct = float(re.search(r'more than (\d+)% of', rules).group(1))
seen, st = set(), {}
for r in csv.DictReader(open('data/sales.csv')):
    s = st.setdefault(r['region'], [0, 0, 0.0]); s[0] += 1
    u, dup = int(r['units']), r['order_id'] in seen
    seen.add(r['order_id'])
    if u <= 0 or dup: s[1] += 1
    else: s[2] += u * int(r['unit_price'])
print(' '.join(sorted(g for g, s in st.items() if s[2] > limit or s[1] * 100 / s[0] > pct)) + ' ')
PY
)
        if [ "$given" = "$want" ]; then echo "RESULT: APPROVED"; else echo "RESULT: REJECTED the list does not match the rules, at least one flagged region is missing"; fi
      else echo "RESULT: ok"; fi ;;
    Dev)
      d=$(printf '%s' "$line" | grep -o '/[^ ]*/work' | head -1)
      cd "$d" || continue
      if [[ "$line" == *REJECTED* ]]; then write_flag 0; echo "RESULT: fixed flag.py"; else write_flag 1; echo "RESULT: wrote flag.py"; fi ;;
    *) echo "RESULT: ok" ;;
  esac
done
