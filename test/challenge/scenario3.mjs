// Scenario C of the orchestration challenge: the ledger of scenario B with a dial. `traps` (1 to 7) says how many rules have a
// trap in them, so the difficulty for one agent alone can be set until it fails often. Same contract as the other scenarios
// (flag.py prints the flagged names, one per line, sorted), so the harness, the checks and the summary work unchanged.
// The traps, in the order they are switched on:
//   1 amounts written two ways ("1.250,50" and "1250.50")        2 times in UTC or at -03:00 and a 08:00 to 18:00 window at UTC-3
//   3 a chargeback cancels the sale it names, anywhere in the file 4 a repeated txn_id counts once (the first row)
//   5 USD rows are converted at a fixed rate and rounded half to even, row by row
//   6 a refund takes part of a sale back (in the currency of the sale, converted and rounded the same way)
//   7 VIP accounts have a revenue limit one and a half times higher
import fs from 'node:fs';
import path from 'node:path';

export const ACCOUNTS = ['Norte', 'Sul', 'Leste', 'Oeste', 'Centro', 'Litoral'];
export const TRAPS = 7;
const VIP = ['Leste', 'Litoral'];
const USD_RATE_TENTHS = 51; // 5.10 BRL per USD, kept as an integer (tenths) so there is no float anywhere

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const pad = (n) => String(n).padStart(2, '0');
function formatAmount(cents, brazilian) {
  const whole = Math.floor(cents / 100);
  const frac = pad(cents % 100);
  if (!brazilian) return `${whole}.${frac}`;
  const digits = String(whole);
  let grouped = '';
  for (let i = 0; i < digits.length; i++) grouped += ((digits.length - i) % 3 === 0 && i > 0 ? '.' : '') + digits[i];
  return `${grouped},${frac}`;
}
/** "1.250,50" or "1250.50" to cents. Without the first trap every amount is written the plain way. */
const parseCents = (raw) => {
  const plain = raw.includes(',') ? raw.replaceAll('.', '').replace(',', '.') : raw;
  const [w, f = '0'] = plain.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0').slice(0, 2));
};
/** Cents of USD to cents of BRL at 5.10, half to even. */
export function usdToBrl(cents) {
  const n = cents * USD_RATE_TENTHS;
  let q = Math.floor(n / 10);
  const r = n % 10;
  if (r > 5 || (r === 5 && q % 2 === 1)) q += 1;
  return q;
}
function stamp(utcMs, local) {
  const d = new Date(local ? utcMs - 3 * 3600 * 1000 : utcMs);
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
  return local ? `${base}-03:00` : `${base}Z`;
}

/** The rule in numbers. `traps` is how many traps are on (the first ones), or a function n => boolean to switch single traps on and off. */
export function evaluateC(rows, { revenue, chargebackPct }, traps = TRAPS) {
  const on = typeof traps === 'function' ? traps : (n) => traps >= n;
  const charged = on(3) ? new Set(rows.filter((r) => r.status === 'CHARGEBACK').map((r) => r.ref)) : new Set();
  const refunds = new Map();
  if (on(6)) for (const r of rows) if (r.status === 'REFUND') refunds.set(r.ref, (refunds.get(r.ref) ?? 0) + (r.currency === 'USD' && on(5) ? usdToBrl(parseCents(r.amount)) : parseCents(r.amount)));
  const seen = new Set();
  const stats = Object.fromEntries(ACCOUNTS.map((a) => [a, { sales: 0, chargedBack: 0, revenue: 0 }]));
  for (const r of rows) {
    if (r.status !== 'SALE') continue;
    if (on(4) && seen.has(r.txn_id)) continue;
    seen.add(r.txn_id);
    const s = stats[r.account];
    s.sales++;
    if (charged.has(r.txn_id)) { s.chargedBack++; continue; }
    if (on(2)) {
      const hour = new Date(Date.parse(r.ts) - 3 * 3600 * 1000).getUTCHours();
      if (hour < 8 || hour >= 18) continue;
    }
    const base = parseCents(r.amount);
    const brl = r.currency === 'USD' && on(5) ? usdToBrl(base) : base;
    const back = on(6) ? Math.min(refunds.get(r.txn_id) ?? 0, brl) : 0;
    s.revenue += brl - back;
  }
  const limitOf = (a) => (on(7) && VIP.includes(a) ? Math.round(revenue * 1.5) : revenue);
  const flagged = ACCOUNTS.filter((a) => stats[a].revenue / 100 > limitOf(a) || (stats[a].sales && (stats[a].chargedBack / stats[a].sales) * 100 > chargebackPct)).sort((a, b) => a.localeCompare(b));
  return { stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...v, revenue: Math.round(v.revenue / 100) }])), flagged };
}

export function buildScenarioC(seed = 21, { traps = 5 } = {}) {
  const T = Math.min(Math.max(Math.trunc(traps), 1), TRAPS);
  for (let attempt = 0; attempt < 600; attempt++) {
    const rand = rng(seed + attempt);
    const day0 = Date.UTC(2026, 2, 2);
    const rows = [];
    const sales = [];
    for (let i = 1; i <= 320; i++) {
      const utcMs = day0 + Math.floor(rand() * 7) * 86400000 + Math.floor(rand() * 24) * 3600000 + Math.floor(rand() * 4) * 15 * 60000;
      const usd = T >= 5 && rand() < 0.3;
      const cents = usd ? (30 + Math.floor(rand() * 900)) * 100 + Math.floor(rand() * 100) : (200 + Math.floor(rand() * 4800)) * 100 + Math.floor(rand() * 100);
      const row = { txn_id: `T-${String(i).padStart(4, '0')}`, account: ACCOUNTS[Math.floor(rand() * ACCOUNTS.length)], ts: stamp(utcMs, T >= 2 && rand() < 0.5), amount: formatAmount(cents, rand() < 0.4), currency: usd ? 'USD' : 'BRL', status: 'SALE', ref: '' };
      rows.push(row);
      sales.push({ row, utcMs, cents });
    }
    for (const s of sales) {
      if (T >= 3 && rand() < 0.1) rows.splice(Math.floor(rand() * (rows.length + 1)), 0, { txn_id: `C-${s.row.txn_id.slice(2)}`, account: s.row.account, ts: stamp(s.utcMs + 2 * 86400000, rand() < 0.5), amount: s.row.amount, currency: s.row.currency, status: 'CHARGEBACK', ref: s.row.txn_id });
      else if (T >= 6 && rand() < 0.12) {
        const part = Math.max(100, Math.floor(s.cents * (0.2 + rand() * 0.5)));
        rows.splice(Math.floor(rand() * (rows.length + 1)), 0, { txn_id: `R-${s.row.txn_id.slice(2)}`, account: s.row.account, ts: stamp(s.utcMs + 86400000, rand() < 0.5), amount: formatAmount(part, rand() < 0.4), currency: s.row.currency, status: 'REFUND', ref: s.row.txn_id });
      }
    }
    if (T >= 4) for (let d = 0; d < 10; d++) rows.splice(Math.floor(rand() * rows.length), 0, { ...sales[Math.floor(rand() * 250)].row });
    const ranked = Object.values(evaluateC(rows, { revenue: 1e15, chargebackPct: Infinity }, T).stats).map((x) => x.revenue).sort((a, b) => b - a);
    const limits = { revenue: Math.round((ranked[2] + ranked[3]) / 2), chargebackPct: 13 };
    const { stats, flagged } = evaluateC(rows, limits, T);
    if (flagged.length < 2 || flagged.length > 3) continue;
    if (T === 1) return { rows, limits, stats, flagged, traps: T, matter: 1 };
    // the traps must matter: the plain reading (every trap off) must give another answer, and so must switching any single trap off, for most of them.
    // The first trap (two ways of writing a number) is always one that matters: read the plain way, "1.250,50" is not a number at all.
    if (evaluateC(rows, limits, 0).flagged.join() === flagged.join()) continue;
    let matter = 1;
    for (let n = 2; n <= T; n++) if (evaluateC(rows, limits, (k) => k <= T && k !== n).flagged.join() !== flagged.join()) matter++;
    if (matter >= Math.ceil(T * 0.6)) return { rows, limits, stats, flagged, traps: T, matter };
  }
  throw new Error('no scenario found');
}

const RULE_TEXT = {
  1: 'The `amount` is written in two ways: `1.250,50` (dots for thousands, a comma for the decimals) or `1250.50`. Both mean the same kind of number.',
  2: 'The `ts` is a moment in time, written either in UTC (ending in Z) or with the offset -03:00. A sale only counts toward revenue when its time, converted to UTC-3, is from 08:00 up to but not including 18:00.',
  3: 'A chargeback (`status` CHARGEBACK) cancels the sale whose `txn_id` is in its `ref` column; the chargeback row is not a sale itself and can be anywhere in the file. A cancelled sale earns no revenue.',
  4: 'A sale is only valid when its `txn_id` is the first one with that id in the file; later repeats are ignored.',
  5: 'Rows with `currency` USD are converted to BRL at 5.10 per dollar and the result is rounded to the cent, half to even (an exact half goes to the even cent), row by row, before anything is added.',
  6: 'A refund (`status` REFUND) takes back part of the sale named in its `ref`: its amount is converted and rounded like a sale (rule on USD rows) and subtracted from that sale, never below zero. The refund row is not a sale itself.',
  7: `The accounts ${VIP.join(' and ')} are VIP: their revenue limit is one and a half times the limit below (rounded to a whole number).`,
};

export function writeScenarioC(dir, sc) {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const field = (v) => (String(v).includes(',') ? `"${v}"` : String(v));
  const csv = ['txn_id,account,ts,amount,currency,status,ref', ...sc.rows.map((r) => [r.txn_id, r.account, r.ts, r.amount, r.currency, r.status, r.ref].map(field).join(','))].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'data', 'sales.csv'), csv);
  const rules = Array.from({ length: sc.traps }, (_, i) => `${i + 1}. ${RULE_TEXT[i + 1]}`).join('\n');
  fs.writeFileSync(path.join(dir, 'data', 'rules.md'), `# Account flag rules

Each row of the ledger is a sale (\`status\` SALE), a chargeback (CHARGEBACK) or a refund (REFUND). Read the rules in order; every one of them changes the result.

${rules}

The **revenue** of an account is the sum, in BRL, over its sales that count.

An account is **flagged** when its revenue is greater than ${sc.limits.revenue} (whole BRL) **or** more than ${sc.limits.chargebackPct}% of its distinct sales were cancelled by a chargeback.
`);
}

/** A flag.py with the hurried reading planted by the harness: only the amounts handled, every other rule forgotten. */
export function buggyFlagScriptC(limits) {
  return `import csv, collections
rows = list(csv.DictReader(open('data/sales.csv')))
def amt(a):
    return float(a.replace('.', '').replace(',', '.')) if ',' in a else float(a)
rev = collections.defaultdict(float)
for r in rows:
    if r['status'] == 'SALE':
        rev[r['account']] += amt(r['amount'])
for g in sorted(rev):
    if rev[g] > ${limits.revenue}:
        print(g)
`;
}
