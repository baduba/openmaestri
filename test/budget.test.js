import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { screenCost, budgetLimit, budgetState, spendText } from '../src/budget.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FOOTER = (cost) => `   /tmp/work        13.2K (10%) · $${cost}  ctrl+p commands`;

test('screenCost reads the session cost an agent prints, and nothing else with a dollar sign', () => {
  assert.equal(screenCost(['hello', FOOTER('0.02')]), 0.02);
  assert.equal(screenCost([FOOTER('0.30'), 'other', FOOTER('1.25')]), 1.25);
  assert.equal(screenCost(['Session cost: $0.42']), 0.42);
  assert.equal(screenCost(['The price is $5 per month', 'echo "$HOME costs $9"']), null, 'a dollar amount in ordinary text is not a cost');
  assert.equal(screenCost(['  13.2K (10%)  ctrl+p']), null);
  assert.equal(screenCost([]), null);
});

test('budget limit comes only from a positive number in the environment; states at 80% and 100%', () => {
  assert.equal(budgetLimit({ OPENMAESTRI_BUDGET_USD: '0.5' }), 0.5);
  for (const bad of ['', 'abc', '-1', '0', 'Infinity', '1e9']) assert.equal(budgetLimit({ OPENMAESTRI_BUDGET_USD: bad }), null, bad);
  assert.equal(budgetLimit({}), null);
  assert.deepEqual([0.1, 0.4, 0.5, 0.9].map((t) => budgetState(t, 0.5)), ['ok', 'warn', 'cut', 'cut']);
  assert.equal(budgetState(99, null), 'ok');
  assert.match(spendText([{ name: 'Dev', cost: 0.03 }, { name: 'Maestro', cost: 0 }], 0.5), /\$0\.030 \(Dev \$0\.030\); limit \$0\.500/);
});

async function daemon(t, limit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-budget-'));
  const saved = { b: process.env.OPENMAESTRI_BUDGET_USD, t: process.env.OPENMAESTRI_BUDGET_TICK_MS };
  process.env.OPENMAESTRI_BUDGET_USD = limit;
  process.env.OPENMAESTRI_BUDGET_TICK_MS = '100';
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => {
    for (const [k, v] of [['OPENMAESTRI_BUDGET_USD', saved.b], ['OPENMAESTRI_BUDGET_TICK_MS', saved.t]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  const agent = (name, cost) => {
    const n = core.store.createNode(ws, 'terminal', { name, cwd: dir, command: `bash -c 'echo ready; printf "%s\\n" "   /tmp  13.2K (10%%) · \\$${cost}  ctrl+p commands"; sleep 60'` });
    core.startTerminal(ws, n);
    return n;
  };
  const maestro = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir });
  return { core, ws, agent, maestro };
}

test('spending: a warning at 80%, every terminal stopped at the limit, and the report says so', async (t) => {
  const { core, ws, agent, maestro } = await daemon(t, '0.35');
  const dev = agent('Dev', '0.30');
  await sleep(1500);
  assert.equal(core.events.get(ws.id).filter((e) => e.kind === 'budget').length, 1, 'the warning');
  assert.equal(core.terminals.rt.get(dev.id).status, 'running');
  const aud = agent('Auditor', '0.10');
  await sleep(1500);
  const ev = core.events.get(ws.id).filter((e) => e.kind === 'budget');
  assert.equal(ev.length, 2);
  assert.match(ev[1].note, /limit \$0\.350 reached .*stopped/);
  assert.notEqual(core.terminals.rt.get(dev.id).status, 'running');
  assert.notEqual(core.terminals.rt.get(aud.id).status, 'running');
  core.startTerminal(ws, maestro);
  await sleep(300);
  const rep = await core.command({ terminalId: maestro.id }, 'report', {});
  assert.match(rep.text, /Spent, as the agents' screens show it: \$0\.400 \(Dev \$0\.300, Auditor \$0\.100\); limit \$0\.350/);
  assert.match((await core.command({ terminalId: maestro.id }, 'budget', {})).text, /limit \$0\.350/);
});

test('without a limit nothing is stopped, and an agent has no command to set one', async (t) => {
  const { core, ws, agent, maestro } = await daemon(t, '');
  const dev = agent('Dev', '9.99');
  await sleep(1000);
  assert.equal(core.terminals.rt.get(dev.id).status, 'running');
  assert.equal(core.events.get(ws.id)?.filter((e) => e.kind === 'budget').length ?? 0, 0);
  await assert.rejects(core.command({ terminalId: maestro.id }, 'budget.set', { usd: 100 }), /unknown command/);
});
