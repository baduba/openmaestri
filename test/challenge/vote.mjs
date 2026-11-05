#!/usr/bin/env node
// The control a team has to beat: the same lone agent run several times on the same data, the answer taken by majority vote.
//   node test/challenge/vote.mjs < runs.jsonl
// Lines come from `run.mjs --baseline --record`. Runs are grouped by model, scenario, traps and seed; a group of 3 or more is one vote.
// A tie is not an answer. The key is rebuilt from the scenario and the seed, so the record does not have to carry it.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildScenario } from './scenario.mjs';
import { buildScenarioB } from './scenario2.mjs';
import { buildScenarioC } from './scenario3.mjs';

const KEYS = { a: (seed) => buildScenario(seed), b: (seed) => buildScenarioB(seed), c: (seed, traps) => buildScenarioC(seed, { traps }) };
const asKey = (list) => JSON.stringify([...(list ?? [])].sort((x, y) => x.localeCompare(y)));

/** @param {object[]} lines record lines (lone runs only) */
export function voteTable(lines, minVotes = 3) {
  const groups = new Map();
  for (const l of lines) {
    if (l.mode !== 'solo' || !Array.isArray(l.answered)) continue;
    const id = `${l.maestro}|${l.scenario ?? 'a'}|${l.traps ?? ''}|${l.seed}`;
    groups.set(id, [...(groups.get(id) ?? []), l]);
  }
  const rows = new Map();
  for (const [id, runs] of groups) {
    if (runs.length < minVotes) continue;
    const [model, scenario, traps, seed] = id.split('|');
    const key = asKey(KEYS[scenario](Number(seed), Number(traps) || undefined).flagged);
    const counts = new Map();
    for (const r of runs) counts.set(asKey(r.answered), (counts.get(asKey(r.answered)) ?? 0) + 1);
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    const tie = ranked.length > 1 && ranked[0][1] === ranked[1][1];
    const voted = !tie && ranked[0][0] === key;
    const rowKey = `${model}|${scenario}|${traps}`;
    const row = rows.get(rowKey) ?? { model, scenario, traps, seeds: 0, runs: 0, single: 0, voted: 0 };
    row.seeds++;
    row.runs += runs.length;
    row.single += runs.filter((r) => r.correct).length;
    row.voted += voted ? 1 : 0;
    rows.set(rowKey, row);
  }
  const head = '| Lone agent | Task | Data sets | Runs | One run right | Majority vote right |\n|---|---|---|---|---|---|';
  const body = [...rows.values()].map((r) => `| ${r.model} | ${r.scenario.toUpperCase()}${r.traps ? ` (${r.traps} traps)` : ''} | ${r.seeds} | ${r.runs} | ${r.single} of ${r.runs} | ${r.voted} of ${r.seeds} |`);
  return `${head}\n${body.join('\n')}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.stdin.isTTY) { console.error('usage: node vote.mjs < runs.jsonl'); process.exit(2); }
  console.log(voteTable(fs.readFileSync(0, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))));
}
