import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runChallenge, PROVIDER_LIMIT } from './challenge/run.mjs';
import { buildScenario, evaluate } from './challenge/scenario.mjs';

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
