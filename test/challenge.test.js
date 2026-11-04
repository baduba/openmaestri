import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runChallenge, PROVIDER_LIMIT } from './challenge/run.mjs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildScenario, evaluate, writeScenario, buggyFlagScript } from './challenge/scenario.mjs';

const AGENTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'challenge', 'agents');

test('challenge scenario: the answer key follows the rules and differs from a naive reading', () => {
  const sc = buildScenario(7);
  assert.ok(sc.flagged.length >= 2 && sc.flagged.length <= 3);
  assert.deepEqual(evaluate(sc.rows, sc.limits).flagged, sc.flagged);
  assert.ok(sc.rows.some((r) => r.units < 0) && new Set(sc.rows.map((r) => r.order_id)).size < sc.rows.length, 'refunds and repeated orders are in the data');
  assert.deepEqual(buildScenario(7).flagged, sc.flagged, 'same seed, same key');
});

test('challenge: scripted Maestro, Auditor and Dev go back and forth until the review approves', async (t) => {
  const r = await runChallenge({ maestro: `bash ${AGENTS}/maestro.sh`, worker: `bash ${AGENTS}/worker.sh`, bootMs: 1500, bootstrap: false, timeoutMs: 120000, stallMs: 60000 });
  t.after(() => fs.rmSync(r.reportDir, { recursive: true, force: true }));
  assert.equal(r.outcome, 'answered');
  assert.deepEqual(r.checks, Object.fromEntries(Object.keys(r.checks).map((k) => [k, true])), JSON.stringify(r.checks));
  assert.ok(r.toDev >= 2, 'Dev got feedback and a second try');
  assert.ok(r.toAuditor >= 3, 'Auditor was asked for the rules and reviewed twice');
  assert.match(fs.readFileSync(path.join(r.reportDir, 'report.md'), 'utf8'), /Orchestration challenge: PASSED/);
});

test('challenge: the lines agents print when a free tier ends are recognised', () => {
  for (const line of ['Rate limit exceeded: free-models-per-day. Add 10 credits', 'AI_APICallError: Free usage limit reached.', 'Error: insufficient credits', 'quota exceeded for this key']) assert.match(line, PROVIDER_LIMIT);
  for (const line of ['Created flag.py', 'The rules state a rate of 9%']) assert.doesNotMatch(line, PROVIDER_LIMIT);
});

test('challenge: the planted flag.py runs and gives an answer that is not the key', (t) => {
  const sc = buildScenario(7);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-bug-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeScenario(dir, sc);
  fs.writeFileSync(path.join(dir, 'flag.py'), buggyFlagScript(sc.limits));
  const r = spawnSync('python3', ['flag.py'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.notDeepEqual(r.stdout.split('\n').filter(Boolean), sc.flagged);
});

test('challenge: a record line names the models, and the summary counts passes per pair', async () => {
  const { recordLine } = await import('./challenge/run.mjs');
  const { summarize } = await import('./challenge/summary.mjs');
  const base = { outcome: 'answered', passed: true, seconds: 100, roundTrips: 5, repeated: 0, leaked: 0, gated: 2, gatesFailed: 1, verdicts: ['REJECTED', 'APPROVED'], checks: { a: true, b: false } };
  const line = recordLine(base, { maestro: 'env PATH=/x opencode -m openrouter/a/big', worker: 'opencode -m openrouter/b/small', seed: 7, inject: true });
  assert.equal(line.maestro, 'openrouter/a/big');
  assert.equal(line.worker, 'openrouter/b/small');
  assert.deepEqual(line.failed, ['b']);
  const priced = recordLine({ ...base, cost: 0.04 }, { maestro: 'opencode -m openrouter/a/big', worker: 'opencode -m openrouter/b/small', seed: 7 });
  assert.equal(priced.cost, 0.04);
  const table = summarize([line, { ...line, passed: false, outcome: 'provider-limit' }]);
  assert.match(table, /\| openrouter\/a\/big \| openrouter\/b\/small \| 2 \| 1 \| 1 \| 100 \| 5\.0 \| 0 \| 2 \| - \|/);
  // the median is over the runs that passed and show a cost; a model that never shows one gets a dash
  assert.match(summarize([priced, { ...priced, cost: 0.02 }, { ...priced, cost: 0.9, passed: false }]), /\| \$0\.030 \|/);
});

test('challenge: an oracle that prints nothing, or the planted bug\'s answer, is caught by the harness', async () => {
  const { buildChecks } = await import('./challenge/run.mjs');
  const base = { inject: true, final: 'VERDICT: APPROVED', answered: ['A'], scriptOut: ['A'], key: ['A'], team: [{ name: 'Auditor' }, { name: 'Dev' }], toName: () => 2, reads: 0, repeated: 0, leaked: 0, planted: 'x', verdicts: ['REJECTED'], checksFailed: 1, finalHash: 'y', buggyOut: ['A', 'B'] };
  const good = buildChecks({ ...base, verifyOut: ['A'] });
  assert.equal(good['the Auditor\'s verify.py prints the answer key'], true);
  assert.equal(good['the Auditor\'s verify.py tells the planted bug apart'], true);
  const empty = buildChecks({ ...base, verifyOut: [] });
  assert.equal(empty['the Auditor\'s verify.py prints the answer key'], false, 'a verify.py that prints nothing is not an oracle');
  const same = buildChecks({ ...base, verifyOut: ['A', 'B'] });
  assert.equal(same['the Auditor\'s verify.py tells the planted bug apart'], false, 'a verify.py that agrees with the bug is not an oracle');
  assert.equal(buildChecks({ ...base, verifyOut: null })['the Auditor\'s verify.py prints the answer key'], false, 'no verify.py at all');
});

test('challenge: the program\'s own correction sent twice is not a message the Maestro repeated', async () => {
  const { repeatedCount } = await import('./challenge/run.mjs');
  const { correction } = await import('../src/gate.js');
  const fix = correction({ kind: 'check', command: 'diff a b', exitCode: 1, output: 'x' }).replace(/\s+/g, ' ');
  const trace = [{ to: 'Dev', text: 'write flag.py' }, { to: 'Dev', text: fix }, { to: 'Dev', text: fix }];
  assert.equal(repeatedCount(trace), 0);
  assert.equal(repeatedCount([...trace, { to: 'Dev', text: 'write flag.py' }]), 1);
});

test('challenge: two long messages that start alike but end differently are not a repeat', async () => {
  const { repeatedCount } = await import('./challenge/run.mjs');
  const head = 'Here are the rules: '.padEnd(300, 'x');
  const a = { to: 'Dev', text: head.slice(0, 300), whole: 'h1' };
  assert.equal(repeatedCount([a, { ...a, whole: 'h2' }]), 0);
  assert.equal(repeatedCount([a, { ...a }]), 1);
});
