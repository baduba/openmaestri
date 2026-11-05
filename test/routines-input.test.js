import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { parseSchedule, parseCount, parseUntil, nextRun, MAX_EVERY_MS } from '../src/routines.js';

test('--every: from 10 seconds to a year, and nothing past the last date a Date can hold', () => {
  assert.equal(parseSchedule({ every: '10s' }).ms, 10000);
  assert.equal(parseSchedule({ every: '366d' }).ms, MAX_EVERY_MS);
  for (const bad of ['367d', '99999999999999999999d', '9999999999d']) assert.throws(() => parseSchedule({ every: bad }), /at most 366d/, bad);
  for (const bad of ['9s', '0s', '-5s', '1.5h', 'abc']) assert.throws(() => parseSchedule({ every: bad }), /10s|bad duration/, bad);
  // the next run of a valid schedule is always a date that can be written
  const next = nextRun(parseSchedule({ every: '366d' }));
  assert.doesNotThrow(() => new Date(next).toISOString());
});

test('--count is a whole number from 1: a word, a decimal or zero used to become a routine that never ends', () => {
  assert.equal(parseCount(undefined), null);
  assert.equal(parseCount(null), null);
  assert.equal(parseCount('3'), 3);
  assert.equal(parseCount(5), 5);
  for (const bad of ['abc', '1.5', '0', '-2', '', 'Infinity', '1e9', '0x10x']) assert.throws(() => parseCount(bad), /bad --count/, JSON.stringify(bad));
});

test('--until must be a date: the old code kept any text and the routine never stopped', () => {
  assert.equal(parseUntil(undefined), null);
  assert.equal(parseUntil(''), null);
  assert.equal(parseUntil('2026-12-31 18:00'), new Date('2026-12-31T18:00').toISOString());
  assert.equal(parseUntil('2026-12-31T18:00:00Z'), '2026-12-31T18:00:00.000Z');
  for (const bad of ['tomorrow', '2026-13-01', '2026-11-05 25:00', 'soon']) assert.throws(() => parseUntil(bad), /bad --until/, bad);
});

test('routine create refuses a bad --count and a bad --until, and a good one is kept as a number and an ISO date', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-routine-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  const maestro = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir });
  const create = (extra) => core.command({ terminalId: maestro.id }, 'routine.create', { name: `r${Math.random()}`, command: 'echo hi', every: '1h', ...extra });
  await assert.rejects(() => create({ count: 'abc' }), /bad --count/);
  await assert.rejects(() => create({ until: 'tomorrow' }), /bad --until/);
  await assert.rejects(() => create({ every: '400d' }), /at most 366d/);
  assert.equal(ws.routines.length, 0, 'a refused routine is not created');
  await create({ count: '2', until: '2099-01-01 08:00' });
  assert.equal(ws.routines[0].count, 2);
  assert.match(ws.routines[0].until, /^2099-01-01T/);
});
