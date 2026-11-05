// The data and the answer key of the orchestration challenge. Deterministic for a seed, so a run can be compared with the truth.
import fs from 'node:fs';
import path from 'node:path';

const REGIONS = ['Norte', 'Sul', 'Leste', 'Oeste', 'Centro', 'Litoral'];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** The rule in numbers: revenue counts valid rows only (units > 0, first row of each order_id); a region is flagged on revenue or on its share of invalid rows. */
export function evaluate(rows, { revenue, invalidPct }) {
  const seen = new Set();
  const stats = Object.fromEntries(REGIONS.map((r) => [r, { rows: 0, invalid: 0, revenue: 0 }]));
  for (const r of rows) {
    const s = stats[r.region];
    s.rows++;
    const dup = seen.has(r.order_id);
    seen.add(r.order_id);
    if (r.units <= 0 || dup) s.invalid++; else s.revenue += r.units * r.unit_price;
  }
  const flagged = REGIONS.filter((g) => stats[g].revenue > revenue || (stats[g].invalid / stats[g].rows) * 100 > invalidPct).sort((a, b) => a.localeCompare(b));
  return { stats, flagged };
}

/** A naive reading (every row counts) must give another answer than the rule, or the challenge would not need the feedback loop. */
function naive(rows, limits) {
  const copy = rows.map((r) => ({ ...r, order_id: `${r.order_id}-${Math.random()}`, units: Math.abs(r.units) }));
  return evaluate(copy, limits).flagged;
}

export function buildScenario(seed = 7) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rand = rng(seed + attempt);
    const rows = [];
    for (let i = 1; i <= 240; i++) {
      const region = REGIONS[Math.floor(rand() * REGIONS.length)];
      const units = rand() < 0.04 ? -Math.ceil(rand() * 5) : Math.ceil(rand() * 9);
      rows.push({ order_id: `ORD-${String(i).padStart(4, '0')}`, region, product: `P${Math.ceil(rand() * 12)}`, units, unit_price: 10 + Math.floor(rand() * 90) });
    }
    for (let d = 0; d < 12; d++) rows.splice(Math.floor(rand() * rows.length), 0, { ...rows[Math.floor(rand() * 200)] });
    const ranked = Object.values(evaluate(rows, { revenue: Infinity, invalidPct: Infinity }).stats).map((s) => s.revenue).sort((a, b) => b - a);
    const limits = { revenue: Math.round((ranked[2] + ranked[3]) / 2), invalidPct: 9 };
    const { stats, flagged } = evaluate(rows, limits);
    if (flagged.length >= 2 && flagged.length <= 3 && naive(rows, limits).join() !== flagged.join()) return { rows, limits, stats, flagged };
  }
  throw new Error('no scenario found');
}

export function writeScenario(dir, sc) {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const csv = ['order_id,region,product,units,unit_price', ...sc.rows.map((r) => `${r.order_id},${r.region},${r.product},${r.units},${r.unit_price}`)].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'data', 'sales.csv'), csv);
  fs.writeFileSync(path.join(dir, 'data', 'rules.md'), `# Regional flag rules

A row is **valid** when \`units\` is greater than zero and it is the first row with that \`order_id\` in the file. Every other row is **invalid** (refunds, repeated orders).

The **revenue** of a region is the sum of \`units * unit_price\` over its valid rows only.

A region is **flagged** when its revenue is greater than ${sc.limits.revenue} **or** more than ${sc.limits.invalidPct}% of its rows are invalid.
`);
}

/** A flag.py with the classic mistake (every row counts), planted by the harness so the review has something real to catch. */
export function buggyFlagScript(limits) {
  return `import csv, collections
rows = list(csv.DictReader(open('data/sales.csv')))
rev = collections.defaultdict(int)
n = collections.Counter()
for r in rows:
    n[r['region']] += 1
    rev[r['region']] += abs(int(r['units'])) * int(r['unit_price'])
for g in sorted(n):
    if rev[g] > ${limits.revenue}:
        print(g)
`;
}

export const CHALLENGE = (dir, { relay = false, devReads = false } = {}) => `CHALLENGE. Work folder: ${dir}. It has data/sales.csv and data/rules.md.
Goal: find which regions are flagged by the rules, with a script that is proven right by an independent check.

How you must work (the point is to coordinate others, not to do it yourself):
1. Do NOT read sales.csv and do NOT compute anything yourself. You may only read this message and use openmaestri commands. Do NOT use your own built-in sub-agent, task or explore tools: the teammates must be real openmaestri terminals that the human can see.
2. Recruit a teammate named Auditor. Ask it to read data/rules.md and answer with the rules in its own short words (no code).
3. Ask the Auditor again to write verify.py in ${dir}: it reads data/sales.csv, applies the rules from data/rules.md and prints the flagged region names, one per line, sorted. Add --check "python3 verify.py" so a crash comes back to the Auditor by itself.
4. Recruit a teammate named Dev. ${devReads ? 'Tell Dev to read data/rules.md and data/sales.csv itself (do not summarize the rules for it)' : "Give Dev the Auditor's rules text (not the file path to rules.md)"} and ask it to write flag.py in ${dir}: it reads data/sales.csv, applies the rules and prints the flagged region names, one per line, sorted. Add --check "python3 flag.py > flag.out && python3 verify.py > verify.out && diff flag.out verify.out" and --retries 2: the program then compares Dev's script with the Auditor's and sends any difference back to Dev by itself.
5. Run \`python3 flag.py\` in ${dir} yourself. Send its output to the Auditor with ask --verdict, to judge against data/rules.md. The reply starts with a line saying [gate] PASSED and carries VERDICT: APPROVED or REJECTED with the reason.
6. If REJECTED, ask Dev for a fixed flag.py and go back to step 5. At most 5 rounds.${relay ? '\n   Send it with --relay "Auditor" and one sentence of your own: the program then attaches the Auditor\'s reply word for word, so do not retell the reason yourself.' : '\n   Send the Auditor\'s reason to Dev.'}
7. When APPROVED, answer the human with openmaestri say, in exactly this shape:
VERDICT: APPROVED
FLAGGED: Name1,Name2
ROUNDS: <how many times you ran flag.py>
If you cannot get an approval, say VERDICT: FAILED and why.
Rules for every message: never put sales figures or the answer in a message to a teammate (they must read the files and compute for themselves). Read the reply in the output of ask; do not send the same message again because the reply looked short or messy.`;

/** The same task for one agent working alone: no teammates, no independent check, no gates. The baseline the team is compared with. */
export const SOLO = (dir) => `SOLO TASK. Work folder: ${dir}. It has data/sales.csv and data/rules.md.
Goal: find which regions are flagged by the rules in data/rules.md.
Write flag.py in ${dir}: it reads data/sales.csv, applies the rules and prints the flagged region names, one per line, sorted. Run it and check the result.
When you are done, write a file named answer.txt in ${dir}, in exactly this shape:
VERDICT: APPROVED
FLAGGED: Name1,Name2
ROUNDS: <how many times you ran flag.py>
If you cannot solve it, write VERDICT: FAILED and why. Do the work yourself, in this terminal.`;

/** The goal alone, as a person would write it: no steps, no roles, no gates. The Maestro has to build the plan itself from what its instructions teach it. */
export const FREE = (dir) => `TASK. Work folder: ${dir}. It has data/sales.csv and data/rules.md.
Goal: find which names (regions or accounts, as the data calls them) are flagged by the rules in data/rules.md, and be sure the answer is right. The script that gives it must be flag.py in ${dir}: it reads data/sales.csv, applies the rules and prints the flagged names, one per line, sorted.
You lead a team: decide yourself who to recruit, what to ask each one, what to check and when you are done. Use real openmaestri teammates (terminals the human can see), not your own built-in sub-agent tools. Use the preset named Worker for the teammates you recruit.
Work only inside the work folder: do not open, list or search any file outside it, and do not search the machine. Everything you need is in the folder.
When you are done, answer the human with openmaestri say, in exactly this shape:
VERDICT: APPROVED
FLAGGED: Name1,Name2
ROUNDS: <how many times you ran flag.py>
If you cannot get a result you trust, say VERDICT: FAILED and why.`;

/**
 * The program decides, two independent implementations are compared: the Auditor writes verify.py from the rules alone (it never sees the
 * Dev's code), the Dev writes flag.py, and the Maestro runs a diff of their outputs. Only when they differ does the Maestro act.
 */
export const CHALLENGE_DIFF = (dir) => `CHALLENGE. Work folder: ${dir}. It has data/sales.csv and data/rules.md.
Goal: find which names (regions or accounts, as the data calls them) are flagged by the rules, with a script proven right by a second, independent script.

How you must work:
1. Do NOT read sales.csv and do NOT compute anything yourself. Use only openmaestri commands and your shell for the diff in step 4. Do NOT use your own built-in sub-agent, task or explore tools: the teammates must be real openmaestri terminals that the human can see. Use the preset named Worker for both teammates.
2. Recruit a teammate named Auditor. Tell it to read data/rules.md and write verify.py in ${dir}: it reads data/sales.csv, applies the rules and prints the flagged names, one per line, sorted. Tell it not to look at flag.py and not to talk to Dev. Add --check "cd ${dir} && python3 verify.py".
3. Recruit a teammate named Dev. Tell it to read data/rules.md and data/sales.csv itself (do not summarize the rules for it) and write flag.py in ${dir} with the same output. Do not show it verify.py. Add --check "cd ${dir} && python3 flag.py".
4. The program decides, not a teammate. Run in ${dir}: diff <(python3 flag.py) <(python3 verify.py) && echo SAME
   If it prints SAME, the two independent scripts agree: answer the human (step 6).
5. If they differ, the diff lines are facts. Send the diff to each teammate separately, exactly as printed (do not retell it), and ask it to re-read data/rules.md, quote the rule line that explains the first differing name, and fix its own script if it was wrong. Then run the diff again. At most 4 rounds. If the scripts still differ, ask each teammate to quote the rule line it relies on and decide by the rule text.
6. Answer the human with openmaestri say, in exactly this shape:
VERDICT: APPROVED
FLAGGED: Name1,Name2
ROUNDS: <how many times you ran the diff>
If you cannot get the scripts to agree, say VERDICT: FAILED and why.
Rules for every message: never put sales figures or the answer in a message to a teammate. Read the reply in the output of ask; do not send the same message again because the reply looked short or messy.`;
