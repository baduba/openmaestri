// Scenario B of the orchestration challenge: a ledger with traps a single agent can fall for. Same contract as scenario A
// (flag.py prints the flagged names, one per line, sorted), so the same harness, checks and summary work for both.
import fs from 'node:fs';
import path from 'node:path';

const ACCOUNTS = ['Norte', 'Sul', 'Leste', 'Oeste', 'Centro', 'Litoral'];

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const pad = (n) => String(n).padStart(2, '0');
/** "1.250,50" (dots for thousands, comma for decimals) or "1250.50". */
function formatAmount(cents, brazilian) {
  const whole = Math.floor(cents / 100);
  const frac = pad(cents % 100);
  if (!brazilian) return `${whole}.${frac}`;
  const digits = String(whole);
  let grouped = '';
  for (let i = 0; i < digits.length; i++) grouped += ((digits.length - i) % 3 === 0 && i > 0 ? '.' : '') + digits[i];
  return `${grouped},${frac}`;
}
const parseAmount = (raw) => (raw.includes(',') ? Number(raw.replaceAll('.', '').replace(',', '.')) : Number(raw));

/** A moment written in UTC ("...Z") or with the -03:00 offset; both mean the same instant. */
function stamp(utcMs, local) {
  const d = new Date(local ? utcMs - 3 * 3600 * 1000 : utcMs);
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
  return local ? `${base}-03:00` : `${base}Z`;
}

/** The rule in numbers. A valid sale: status SALE, the first row with that txn_id, between 08:00 and 18:00 at UTC-3, and not charged back. */
export function evaluateB(rows, { revenue, chargebackPct }) {
  const charged = new Set(rows.filter((r) => r.status === 'CHARGEBACK').map((r) => r.ref));
  const seen = new Set();
  const stats = Object.fromEntries(ACCOUNTS.map((a) => [a, { sales: 0, chargedBack: 0, revenue: 0 }]));
  for (const r of rows) {
    if (r.status !== 'SALE' || seen.has(r.txn_id)) continue;
    seen.add(r.txn_id);
    const s = stats[r.account];
    s.sales++;
    if (charged.has(r.txn_id)) { s.chargedBack++; continue; }
    const hour = new Date(Date.parse(r.ts) - 3 * 3600 * 1000).getUTCHours();
    if (hour >= 8 && hour < 18) s.revenue += parseAmount(r.amount);
  }
  const flagged = ACCOUNTS.filter((a) => stats[a].revenue > revenue || (stats[a].sales && (stats[a].chargedBack / stats[a].sales) * 100 > chargebackPct)).sort((a, b) => a.localeCompare(b));
  return { stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...v, revenue: Math.round(v.revenue) }])), flagged };
}

/** What a hurried reading gives: every SALE row once, amounts parsed right, no chargebacks, no time window. Must differ from the rule. */
function hurried(rows, limits) {
  const seen = new Set();
  const rev = Object.fromEntries(ACCOUNTS.map((a) => [a, 0]));
  for (const r of rows) {
    if (r.status !== 'SALE' || seen.has(r.txn_id)) continue;
    seen.add(r.txn_id);
    rev[r.account] += parseAmount(r.amount);
  }
  return ACCOUNTS.filter((a) => rev[a] > limits.revenue).sort((a, b) => a.localeCompare(b));
}

export function buildScenarioB(seed = 11) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const rand = rng(seed + attempt);
    const day0 = Date.UTC(2026, 2, 2);
    const rows = [];
    const sales = [];
    for (let i = 1; i <= 300; i++) {
      const utcMs = day0 + Math.floor(rand() * 7) * 86400000 + Math.floor(rand() * 24) * 3600000 + Math.floor(rand() * 4) * 15 * 60000;
      const cents = (200 + Math.floor(rand() * 4800)) * 100 + Math.floor(rand() * 100);
      const row = { txn_id: `T-${String(i).padStart(4, '0')}`, account: ACCOUNTS[Math.floor(rand() * ACCOUNTS.length)], ts: stamp(utcMs, rand() < 0.5), amount: formatAmount(cents, rand() < 0.4), status: 'SALE', ref: '' };
      rows.push(row);
      sales.push({ row, utcMs, cents });
    }
    // chargebacks come later in the file than the sale they cancel, or earlier: the reference is the only link
    for (const s of sales) {
      if (rand() < 0.1) {
        const cb = { txn_id: `C-${s.row.txn_id.slice(2)}`, account: s.row.account, ts: stamp(s.utcMs + 2 * 86400000, rand() < 0.5), amount: s.row.amount, status: 'CHARGEBACK', ref: s.row.txn_id };
        rows.splice(Math.floor(rand() * (rows.length + 1)), 0, cb);
      }
    }
    for (let d = 0; d < 10; d++) rows.splice(Math.floor(rand() * rows.length), 0, { ...sales[Math.floor(rand() * 250)].row });
    const ranked = Object.values(evaluateB(rows, { revenue: Infinity, chargebackPct: Infinity }).stats).map((x) => x.revenue).sort((a, b) => b - a);
    const limits = { revenue: Math.round((ranked[2] + ranked[3]) / 2), chargebackPct: 13 };
    const { stats, flagged } = evaluateB(rows, limits);
    if (flagged.length >= 2 && flagged.length <= 3 && hurried(rows, limits).join() !== flagged.join()) return { rows, limits, stats, flagged };
  }
  throw new Error('no scenario found');
}

export function writeScenarioB(dir, sc) {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  // an amount like 1.250,50 has a comma in it, so it is quoted the way CSV says
  const field = (v) => (String(v).includes(',') ? `"${v}"` : String(v));
  const csv = ['txn_id,account,ts,amount,status,ref', ...sc.rows.map((r) => [r.txn_id, r.account, r.ts, r.amount, r.status, r.ref].map(field).join(','))].join('\n') + '\n';
  // the scenario-A contract names the data file sales.csv in the task text; here it is the same file under that name
  fs.writeFileSync(path.join(dir, 'data', 'sales.csv'), csv);
  fs.writeFileSync(path.join(dir, 'data', 'rules.md'), `# Account flag rules

Each row of the ledger is a sale (\`status\` SALE) or a chargeback (\`status\` CHARGEBACK). A chargeback cancels the sale whose \`txn_id\` is in its \`ref\` column; the chargeback row is not a sale itself and can be anywhere in the file.

The \`amount\` is written in two ways: \`1.250,50\` (dots for thousands, a comma for the decimals) or \`1250.50\`. Both are in the same currency. The \`ts\` is a moment in time, written either in UTC (ending in Z) or with the offset -03:00.

A sale is **valid** when all of these hold: its \`txn_id\` is the first one with that id in the file (repeats are ignored); it is not cancelled by a chargeback; and its time, converted to UTC-3, is from 08:00 up to but not including 18:00.

The **revenue** of an account is the sum of \`amount\` over its valid sales.

An account is **flagged** when its revenue is greater than ${sc.limits.revenue} **or** more than ${sc.limits.chargebackPct}% of its distinct sales (sales counted once per \`txn_id\`, valid or not) were cancelled by a chargeback.
`);
}

/** A flag.py with the hurried reading (chargebacks and the time window forgotten), planted by the harness for the review to catch. */
export function buggyFlagScriptB(limits) {
  return `import csv, collections
rows = list(csv.DictReader(open('data/sales.csv')))
def amt(a):
    return float(a.replace('.', '').replace(',', '.')) if ',' in a else float(a)
rev = collections.defaultdict(float)
seen = set()
for r in rows:
    if r['status'] != 'SALE' or r['txn_id'] in seen:
        continue
    seen.add(r['txn_id'])
    rev[r['account']] += amt(r['amount'])
for g in sorted(rev):
    if rev[g] > ${limits.revenue}:
        print(g)
`;
}
