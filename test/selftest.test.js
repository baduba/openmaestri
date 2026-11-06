import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, intFlag, selftest } from '../src/selftest.js';

const fake = (corrects) => {
  const calls = [];
  const runChallenge = async (o) => { calls.push(o); const correct = corrects[calls.length - 1]; return { correct, outcome: 'answered', seconds: 5, roundTrips: 3, cost: 0.01, reportDir: '/tmp/x' }; };
  return { calls, runChallenge };
};
const env = { OPENROUTER_API_KEY: 'k' };
const available = () => ({ ok: true });
const userEnv = {};

test('summarize: all right, none right and in between say different things, and never promise', () => {
  const r = (correct) => ({ correct, cost: 0.01 });
  assert.match(summarize([r(true), r(true)], { solo: false }), /right in 2 of 2.*works on this task.*not that it always does/s);
  assert.match(summarize([r(false), r(false)], { solo: false }), /never got the task right/);
  assert.match(summarize([r(true), r(false)], { solo: false }), /1 of 2 times.*not steady/s);
  assert.match(summarize([r(true)], { solo: true }), /One agent alone: right in 1 of 1.*solves the task alone/s);
  assert.match(summarize([], { solo: false }), /No run finished/);
});

test('intFlag accepts whole numbers in range and refuses the rest', () => {
  assert.equal(intFlag({}, 'runs', 2, 1, 10), 2);
  assert.equal(intFlag({ runs: '4' }, 'runs', 2, 1, 10), 4);
  for (const bad of ['0', '11', '2.5', 'abc', '']) assert.throws(() => intFlag({ runs: bad }, 'runs', 2, 1, 10), /--runs must be a whole number/);
});

test('selftest runs the team on scenario C in diff mode and exits 0 only when every run is right', async () => {
  const lines = [];
  const a = fake([true, true]);
  assert.equal(await selftest({ runs: '2', traps: '7' }, { runChallenge: a.runChallenge, log: (s) => lines.push(s), env, available, userEnv }), 0);
  assert.equal(a.calls.length, 2);
  assert.equal(a.calls[0].scenario, 'c');
  assert.equal(a.calls[0].traps, 7);
  assert.equal(a.calls[0].diff, true);
  assert.equal(a.calls[0].baseline, false);
  assert.notEqual(a.calls[0].seed, a.calls[1].seed);
  assert.match(a.calls[0].maestro, /deepseek-v4\.1-flash/);
  assert.match(a.calls[0].worker, /gpt-oss-120b/);
  assert.match(lines.join('\n'), /run 1: RIGHT/);
  const b = fake([true, false]);
  assert.equal(await selftest({ runs: '2' }, { runChallenge: b.runChallenge, log: () => {}, env, available, userEnv }), 1);
});

test('selftest --solo runs the Maestro model alone as a control', async () => {
  const a = fake([true]);
  assert.equal(await selftest({ runs: '1', solo: true, maestro: 'opencode -m openrouter/x/y' }, { runChallenge: a.runChallenge, log: () => {}, env, available, userEnv }), 0);
  assert.equal(a.calls[0].baseline, true);
  assert.equal(a.calls[0].diff, false);
  assert.equal(a.calls[0].maestro, 'opencode -m openrouter/x/y');
});

test('selftest stops when the budget is used, and refuses bad flags or a missing key before spending anything', async () => {
  const a = fake([true, true, true]);
  const lines = [];
  await selftest({ runs: '3', budget: '0.01' }, { runChallenge: a.runChallenge, log: (s) => lines.push(s), env, available, userEnv });
  assert.equal(a.calls.length, 1);
  assert.match(lines.join('\n'), /budget of \$0\.01 is used/);
  const none = fake([]);
  assert.equal(await selftest({ runs: '99' }, { runChallenge: none.runChallenge, log: () => {}, env, available, userEnv }), 2);
  assert.equal(await selftest({ budget: '-1' }, { runChallenge: none.runChallenge, log: () => {}, env, available, userEnv }), 2);
  const before = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const out = [];
    assert.equal(await selftest({ maestro: 'opencode -m openrouter/x/y', worker: 'opencode -m openrouter/x/y' }, { runChallenge: none.runChallenge, log: (s) => out.push(s), env: {}, available, userEnv }), 2);
    assert.equal(none.calls.length, 0);
    assert.match(out.join('\n'), /OPENROUTER_API_KEY is not set/);
  } finally { if (before !== undefined) process.env.OPENROUTER_API_KEY = before; }
});

test('the wide challenge names every worker and asks for a plurality of at least 3, so seven agents are one Maestro and six workers', async () => {
  const { CHALLENGE_WIDE } = await import('./challenge/scenario.mjs');
  const text = CHALLENGE_WIDE('/w', 6);
  for (const n of [1, 2, 3, 4, 5, 6]) assert.match(text, new RegExp(`W${n}\\b`));
  assert.doesNotMatch(text, /W7/);
  assert.match(text, /at least 3/);
  assert.match(text, /Do NOT read sales\.csv/);
});
