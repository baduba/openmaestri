// A spending limit for a workspace. The program cannot see the API calls an agent makes, but a full-screen agent
// prints what the session has cost on its own status line (OpenCode: "13.2K (10%) · $0.02"). That number is read
// from the screen, the highest seen per terminal is kept, and when the total passes the limit the terminals are stopped.
// The limit comes from the person (OPENMAESTRI_BUDGET_USD when the daemon starts), never from an agent: an agent that
// could raise it would defeat it. A limit on the key itself, at the provider, is still the stronger fence.

export const WARN_AT = 0.8;

const LABELS = ['session cost', 'total cost', 'cost so far', 'spent'];

/** The number right after a dollar sign at `at`, or null. */
function dollarsAt(line, at) {
  let end = at + 1;
  while (end < line.length && end - at <= 12 && ('0123456789.'.includes(line[end]))) end++;
  const n = Number(line.slice(at + 1, end));
  return end > at + 1 && Number.isFinite(n) ? n : null;
}

/** The cost a single screen row states: OpenCode's "(10%) · $0.02" or a labelled "session cost: $0.12"; null for any other dollar amount. */
function rowCost(line) {
  const low = line.toLowerCase();
  const labelled = LABELS.some((l) => low.includes(l));
  const footer = line.includes('%)');
  let best = null;
  for (let i = line.indexOf('$'); i >= 0; i = line.indexOf('$', i + 1)) {
    const n = dollarsAt(line, i);
    const afterDot = line.slice(Math.max(0, i - 4), i).includes('·');
    if (n !== null && ((footer && afterDot) || labelled)) best = Math.max(best ?? 0, n);
  }
  return best;
}

/** The session cost an agent shows on its screen (the largest figure in the last rows), or null. */
export function screenCost(lines, rows = 12) {
  let best = null;
  for (const l of lines.filter((x) => x.trim()).slice(-rows)) {
    const n = rowCost(l);
    if (n !== null) best = Math.max(best ?? 0, n);
  }
  return best;
}

/** The limit in dollars, or null when there is none or the value is not a positive number. */
export function budgetLimit(env = process.env) {
  const v = Number(env.OPENMAESTRI_BUDGET_USD);
  return Number.isFinite(v) && v > 0 && v < 100000 ? v : null;
}

/** 'ok', 'warn' (80% reached) or 'cut' (limit reached) for a total. */
export function budgetState(total, limit) {
  if (limit === null) return 'ok';
  if (total >= limit) return 'cut';
  return total >= limit * WARN_AT ? 'warn' : 'ok';
}

export const money = (n) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

/** One line for `report` and `budget`: what the screens say was spent, per agent, against the limit. */
export function spendText(perAgent, limit) {
  const total = perAgent.reduce((a, x) => a + x.cost, 0);
  const who = perAgent.filter((x) => x.cost > 0).map((x) => `${x.name} ${money(x.cost)}`).join(', ');
  const cap = limit === null ? 'no limit set (OPENMAESTRI_BUDGET_USD)' : `limit ${money(limit)}`;
  return `Spent, as the agents' screens show it: ${money(total)}${who ? ` (${who})` : ''}; ${cap}.`;
}
