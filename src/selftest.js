// `openmaestri selftest`: runs the ledger challenge with scenario C and the models you would use, and says whether this team gets it right on this machine.
// It is the same harness the project's own runs used (test/challenge/run.mjs), so what it prints can be compared with docs/models.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRESETS, dataDir } from './store.js';
import { readUserEnv, commandAvailable } from './terminals.js';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'challenge', 'run.mjs');
const presetCommand = (name) => DEFAULT_PRESETS.find((p) => p.name === name).command;

/** The flags as numbers inside a range, or the default; a non-number is an error the person should see. */
export function intFlag(flags, name, def, min, max) {
  const raw = flags[name];
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What the person is told at the end, from the list of runs (each has `correct`). Pure, so it is tested without a model. */
export function summarize(results, { solo }) {
  const right = results.filter((r) => r.correct).length;
  const n = results.length;
  const cost = results.reduce((a, r) => a + (r.cost ?? 0), 0);
  const who = solo ? 'One agent alone' : 'The team';
  const spent = cost ? `, about $${cost.toFixed(2)} spent` : '';
  const head = `${who}: right in ${right} of ${n} runs${spent}.`;
  let verdict;
  if (n === 0) verdict = 'No run finished, so there is nothing to say about this team.';
  else if (right === n) verdict = solo ? 'This model solves the task alone.' : 'This team works on this task with your models. (A few runs show that it can, not that it always does.)';
  else if (right === 0) verdict = 'It never got the task right. Read the reports below: a model that cannot hold the instructions, a missing key and a provider limit all look like this.';
  else verdict = `It got it right ${right} of ${n} times. That is not steady. Run more (--runs 6) before trusting it, or try another Maestro (docs/starter-team.md).`;
  return `${head}\n${verdict}`;
}

/** The numbers the person typed, checked; throws with a message to show. */
function readOptions(flags) {
  const budget = flags.budget === undefined ? 1 : Number(flags.budget);
  if (!(budget > 0)) throw new Error('--budget must be a positive number of dollars');
  return {
    runs: intFlag(flags, 'runs', 2, 1, 10),
    traps: intFlag(flags, 'traps', 7, 1, 10),
    seed: intFlag(flags, 'seed', 601, 1, 1e6),
    budget,
    solo: flags.solo === true || flags.solo === 'true',
  };
}

/** What is missing before a run can start (nothing is spent until this list is empty). */
function missingThings({ maestro, worker, withKeys, available, hasHarness }) {
  const problems = [];
  if (!fs.existsSync('/usr/bin/python3')) problems.push('/usr/bin/python3 is missing (the challenge checks the agents\' scripts with it)');
  const agentBin = /^\s*(\S+)/.exec(maestro)?.[1];
  if (agentBin && !available(agentBin).ok) problems.push(`${agentBin} is not installed (openmaestri doctor says how)`);
  if (/openrouter/.test(`${maestro} ${worker}`) && !withKeys.OPENROUTER_API_KEY) problems.push(`OPENROUTER_API_KEY is not set (put it in ${path.join(dataDir(), 'env')})`);
  if (!hasHarness) problems.push('the challenge harness (test/challenge) is not part of this installation; use a clone of the repository or the npm package');
  return problems;
}

const costOf = (results) => results.reduce((a, r) => a + (r.cost ?? 0), 0);

/** One line about a finished run. */
function runLine(i, r) {
  const money = r.cost ? `, $${r.cost.toFixed(3)}` : '';
  return `  run ${i + 1}: ${r.correct ? 'RIGHT' : 'WRONG'} (${r.outcome}, ${r.seconds}s, ${plural(r.roundTrips, 'message')} to teammates${money}). Report: ${r.reportDir}/report.md`;
}

/**
 * @param {Record<string, string|boolean>} flags --maestro, --worker, --runs, --traps, --budget, --solo, --seed
 * @param {{ runChallenge?: Function, log?: (s: string) => void, env?: NodeJS.ProcessEnv, available?: (cmd: string) => { ok: boolean }, userEnv?: Record<string, string> }} deps
 * @returns {Promise<number>} the exit code: 0 all right, 1 not all right, 2 could not start
 */
export async function selftest(flags, { runChallenge, log = (s) => console.log(s), env = process.env, available = commandAvailable, userEnv } = {}) {
  let o;
  try { o = readOptions(flags); } catch (e) { log(`openmaestri selftest: ${e.message}`); return 2; }
  const { runs, traps, seed, budget, solo } = o;
  const maestro = typeof flags.maestro === 'string' ? flags.maestro : presetCommand('Starter Maestro (DeepSeek V4.1 Flash)');
  const worker = typeof flags.worker === 'string' ? flags.worker : presetCommand('Starter Auditor (gpt-oss-120b)');

  // keys the person keeps in ~/.openmaestri/env reach the agents the same way they do in the app
  const fileEnv = userEnv ?? readUserEnv(path.join(dataDir(), 'env'));
  const withKeys = { ...fileEnv, ...env };
  for (const [k, v] of Object.entries(fileEnv)) if (env[k] === undefined) process.env[k] = v;

  const problems = missingThings({ maestro, worker, withKeys, available, hasHarness: !!runChallenge || fs.existsSync(HARNESS) });
  if (problems.length) { log(`openmaestri selftest cannot start:\n${problems.map((p) => `  - ${p}`).join('\n')}`); return 2; }

  const run = runChallenge ?? (await import(HARNESS)).runChallenge;
  const roster = solo ? '' : `\n  Workers: ${worker}`;
  log(`Self-test: ${solo ? 'one agent alone' : 'a team'}, scenario C with ${traps} traps, ${plural(runs, 'run')}, stops after $${budget} spent.\n  Maestro: ${maestro}${roster}`);
  const results = [];
  for (let i = 0; i < runs && costOf(results) < budget; i++) {
    // one run at a time on purpose: two teams on one machine slow each other down and the timings stop meaning anything
    const r = await run({ // NOSONAR
      maestro, worker: solo ? maestro : worker, seed: seed + i * 100, scenario: 'c', traps, diff: !solo, baseline: solo,
      timeoutMs: 15 * 60 * 1000, stallMs: 5 * 60 * 1000, bootMs: 15000, log: () => {},
    });
    results.push(r);
    log(runLine(i, r));
  }
  if (results.length < runs) log(`Stopped after ${plural(results.length, 'run')}: the budget of $${budget} is used.`);
  log(`\n${summarize(results, { solo })}`);
  return results.length > 0 && results.every((r) => r.correct) ? 0 : 1;
}
