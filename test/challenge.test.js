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
  assert.match(table, /\| openrouter\/a\/big \| openrouter\/b\/small \| 2 \| 1 \| 2 \| 1 \| 100 \| 5\.0 \| 0 \| 2 \| - \|/);
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

test('challenge: the baseline is judged by the answer alone, and the summary puts it next to the team', async () => {
  const { soloChecks, isCorrect, recordLine } = await import('./challenge/run.mjs');
  const { summarize } = await import('./challenge/summary.mjs');
  const good = soloChecks({ final: 'VERDICT: APPROVED\nFLAGGED: A,B', answered: ['A', 'B'], scriptOut: ['A', 'B'], key: ['A', 'B'] });
  assert.equal(isCorrect(good), true);
  assert.equal(isCorrect(soloChecks({ final: 'VERDICT: APPROVED', answered: ['A'], scriptOut: ['A', 'B'], key: ['A', 'B'] })), false, 'a wrong answer is not right');
  assert.equal(isCorrect(soloChecks({ final: 'VERDICT: APPROVED', answered: ['A', 'B'], scriptOut: null, key: ['A', 'B'] })), false, 'no script, not right');
  const model = 'opencode -m openrouter/a/big';
  const solo = recordLine({ outcome: 'answered', baseline: true, passed: true, correct: true, seconds: 90, roundTrips: 0, repeated: 0, leaked: 0, gated: 0, gatesFailed: 0, verdicts: [], checks: good, cost: 0.02 }, { maestro: model, worker: model, seed: 7 });
  assert.equal(solo.mode, 'solo');
  assert.equal(solo.correct, true);
  const team = { ...solo, mode: 'team', correct: true, passed: false, failed: ['no message to a teammate was sent twice'] };
  const table = summarize([solo, team]);
  assert.match(table, /alone, no gates \| 1 \| 1 \| 1 \|/);
  assert.match(table, /openrouter\/a\/big \| 1 \| 0 \| 1 \|/, 'the team run was right but broke a process rule: right 1, passed 0');
  // lines recorded before the field existed: right when neither correctness check failed
  assert.match(summarize([{ maestro: 'm', worker: 'w', passed: false, failed: ['no message to a teammate was sent twice'] }, { maestro: 'm', worker: 'w', passed: false, failed: ['flag.py exists and prints the answer key'] }]), /\| m \| w \| 2 \| 0 \| 1 \|/);
});

for (const seed of [11, 13]) test(`challenge scenario B (seed ${seed}): the key agrees with an independent reading of the file, and the planted bug does not`, async () => {
  const { buildScenarioB, writeScenarioB, buggyFlagScriptB } = await import('./challenge/scenario2.mjs');
  const sc = buildScenarioB(seed);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-b-'));
  writeScenarioB(dir, sc);
  const reference = `
import csv, datetime as dt, collections, re
rows = list(csv.DictReader(open('data/sales.csv')))
assert all(len(r) == 6 and None not in r for r in rows), 'a row did not parse into 6 columns'
rules = open('data/rules.md').read()
lim = int(re.search(r'revenue is greater than (\\d+)', rules).group(1))
pct = int(re.search(r'more than (\\d+)%', rules).group(1))
cb = {r['ref'] for r in rows if r['status'] == 'CHARGEBACK'}
amt = lambda a: float(a.replace('.', '').replace(',', '.')) if ',' in a else float(a)
tz = dt.timezone(dt.timedelta(hours=-3))
seen, sales, chg, rev = set(), collections.Counter(), collections.Counter(), collections.Counter()
for r in rows:
    if r['status'] != 'SALE' or r['txn_id'] in seen: continue
    seen.add(r['txn_id']); a = r['account']; sales[a] += 1
    if r['txn_id'] in cb: chg[a] += 1; continue
    t = dt.datetime.fromisoformat(r['ts'].replace('Z', '+00:00')).astimezone(tz)
    if 8 <= t.hour < 18: rev[a] += amt(r['amount'])
print('\\n'.join(sorted(a for a in sales if rev[a] > lim or chg[a] / sales[a] * 100 > pct)))
`;
  const ref = spawnSync('python3', ['-c', reference], { cwd: dir, encoding: 'utf8' });
  assert.equal(ref.status, 0, ref.stderr);
  assert.deepEqual(ref.stdout.split('\n').filter(Boolean), sc.flagged, 'the key and the independent reading disagree');
  assert.ok(sc.flagged.length >= 2 && sc.flagged.length <= 3);
  fs.writeFileSync(path.join(dir, 'flag.py'), buggyFlagScriptB(sc.limits));
  const bug = spawnSync('python3', ['flag.py'], { cwd: dir, encoding: 'utf8' });
  assert.equal(bug.status, 0, bug.stderr);
  assert.notDeepEqual(bug.stdout.split('\n').filter(Boolean), sc.flagged);
});

test('challenge: a final answer with a literal backslash-n instead of a line break still names the same regions', async () => {
  const { answeredNames } = await import('./challenge/run.mjs');
  assert.deepEqual(answeredNames('VERDICT: APPROVED\nFLAGGED: Sul,Leste,Oeste\nROUNDS: 1'), ['Leste', 'Oeste', 'Sul']);
  assert.deepEqual(answeredNames('VERDICT: APPROVED\\nFLAGGED: Leste,Oeste,Sul\\nROUNDS: 1'), ['Leste', 'Oeste', 'Sul'], 'a literal \\n ends the line');
  assert.deepEqual(answeredNames('VERDICT: FAILED'), []);
});

test('challenge: a Maestro given only the goal is judged by the answer, the script and having used a team', async () => {
  const { freeChecks, isCorrect, recordLine } = await import('./challenge/run.mjs');
  const { summarize } = await import('./challenge/summary.mjs');
  const args = { final: 'VERDICT: APPROVED\nFLAGGED: A,B', answered: ['A', 'B'], scriptOut: ['A', 'B'], key: ['A', 'B'] };
  const team = freeChecks({ ...args, asked: 4 });
  assert.equal(isCorrect(team), true);
  assert.equal(team['a teammate was recruited and asked'], true);
  const alone = freeChecks({ ...args, asked: 0 });
  assert.equal(isCorrect(alone), true, 'right is right');
  assert.equal(alone['a teammate was recruited and asked'], false, 'but it did not use a team, and the run says so');
  const model = 'opencode -m openrouter/a/big';
  const line = recordLine({ outcome: 'answered', free: true, state: true, passed: true, correct: true, seconds: 200, roundTrips: 4, repeated: 0, leaked: 0, gated: 2, gatesFailed: 0, verdicts: [], checks: team, cost: 0.1 }, { maestro: model, worker: model, seed: 7 });
  assert.equal(line.mode, 'team-free+state');
  assert.match(summarize([line]), /Maestro plans alone, state line/);
});
