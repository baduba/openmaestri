#!/usr/bin/env node
// A table of real challenge runs per model, from the lines `run.mjs --record FILE` appended.
//   node test/challenge/summary.mjs < runs.jsonl
import fs from 'node:fs';

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : null; };
const dollars = (n) => (n === null ? '-' : `$${n.toFixed(n < 1 ? 3 : 2)}`);

/** @param {object[]} lines the parsed record lines */
export function summarize(lines) {
  const groups = new Map();
  for (const l of lines) {
    const key = `${l.maestro} | ${l.worker}`;
    const g = groups.get(key) ?? { maestro: l.maestro, worker: l.worker, runs: 0, passed: 0, limited: 0, secs: 0, messages: 0, repeated: 0, rejected: 0, costsOfPasses: [] };
    g.runs++;
    if (l.passed) { g.passed++; if (l.cost) g.costsOfPasses.push(l.cost); }
    if (l.outcome === 'provider-limit') g.limited++;
    g.secs += l.seconds ?? 0;
    g.messages += l.messages ?? 0;
    g.repeated += l.repeated ?? 0;
    if (String(l.verdicts ?? '').includes('REJECTED')) g.rejected++;
    groups.set(key, g);
  }
  const rows = [...groups.values()].sort((a, b) => b.passed / b.runs - a.passed / a.runs || a.maestro.localeCompare(b.maestro));
  const head = '| Maestro | Teammates | Runs | Passed | Stopped by a limit | Avg seconds | Avg messages | Repeated messages | Runs with a REJECTED | Median cost per pass |\n|---|---|---|---|---|---|---|---|---|---|';
  return `${head}\n${rows.map((g) => `| ${g.maestro} | ${g.worker} | ${g.runs} | ${g.passed} | ${g.limited} | ${Math.round(g.secs / g.runs)} | ${(g.messages / g.runs).toFixed(1)} | ${g.repeated} | ${g.rejected} | ${dollars(median(g.costsOfPasses))} |`).join('\n')}`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').at(-1))) {
  // the records come on standard input, so no path from the command line is ever opened
  if (process.stdin.isTTY) { console.error('usage: node summary.mjs < runs.jsonl'); process.exit(2); }
  console.log(summarize(fs.readFileSync(0, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))));
}
