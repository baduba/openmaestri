import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../src/server.js';
import { handoffText, takeoverLine } from '../src/handoff.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.sh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timeout'); await sleep(50); } };

test('handoffText: facts, own words, masked credentials, and no invention', () => {
  const t = handoffText({
    name: 'Dev', at: new Date('2026-11-02T10:00:00Z'), folder: 'api', floor: 'login', branch: 'floor/login', command: 'claude',
    status: ' M src/a.js\n?? src/b.js', diffstat: ' src/a.js | 4 ++--', notes: ['Plan'], selfReport: 'GOAL: add login\nNEXT: tests',
    screen: 'building...\nexport API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\ndone',
  });
  assert.match(t, /^# Handoff from Dev/);
  assert.match(t, /2026-11-02 10:00 UTC/);
  assert.match(t, /floor login \(branch floor\/login\)/);
  assert.match(t, /## In its own words\nGOAL: add login/);
  assert.match(t, /M src\/a\.js/);
  assert.match(t, /- Plan/);
  assert.doesNotMatch(t, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(t, /removed/);
  assert.match(handoffText({ name: 'X' }), /No uncommitted changes/);
  assert.match(takeoverLine('Handoff: Dev 10:00', 'Dev'), /read the note "Handoff: Dev 10:00"/);
});

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-ho-'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const git = (...a) => execFileSync('git', a, { cwd: work, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.writeFileSync(path.join(work, 'draft.txt'), 'half done\n');
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = work;
  core.store.settings.presets.push({ name: 'Fake', command: `${FAKE} \${OPENMAESTRI_TERMINAL_NAME}`, maestro: false });
  const boss = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: work });
  const old = core.store.createNode(ws, 'terminal', { name: 'Dev', command: `${FAKE} Dev`, cwd: work });
  core.store.connect(ws, boss.id, old.id);
  core.startTerminal(ws, old);
  await until(() => core.terminals.text(old.id).includes('[Dev] ready'));
  const cmd = (c, a) => core.command({ terminalId: boss.id }, c, a);
  return { core, ws, boss, old, cmd };
}

test('handoff leaves a note with the screen and the git state, cabled to the agent', async (t) => {
  const { core, ws, old, cmd } = await setup(t);
  core.terminals.deliver(old.id, 'write the login form');
  await until(() => core.terminals.text(old.id).includes('done: write the login form'));
  const r = await cmd('handoff', { name: 'Dev' });
  assert.match(r.text, /Handoff: Dev/);
  const note = ws.nodes.find((n) => n.kind === 'note' && n.name.startsWith('Handoff: Dev'));
  assert.ok(note);
  const text = core.store.readNote(ws.id, note.id);
  assert.match(text, /done: write the login form/);
  assert.match(text, /\?\? draft\.txt/);
  assert.ok(core.store.neighbors(ws, old.id).some((n) => n.id === note.id), 'the agent itself sees the note');
});

test('handoff --ask has the agent write its own part', async (t) => {
  const { core, cmd, ws } = await setup(t);
  await cmd('handoff', { name: 'Dev', ask: true });
  const note = ws.nodes.find((n) => n.kind === 'note' && n.name.startsWith('Handoff: Dev'));
  assert.match(core.store.readNote(ws.id, note.id), /## In its own words[\s\S]*You are about to be replaced/);
});

test('recruit --replace writes the handoff first and tells the new agent to read it', async (t) => {
  const { core, ws, old, cmd } = await setup(t);
  const r = await cmd('recruit', { name: 'Dev2', preset: 'Fake', replace: 'Dev', noCheck: true });
  assert.match(r.text, /handoff note: Handoff: Dev/);
  assert.equal(old.name, 'Dev2');
  await until(() => core.terminals.text(old.id).includes('taking over from Dev'), 20000);
  assert.ok(ws.nodes.some((n) => n.kind === 'note' && n.name.startsWith('Handoff: Dev')));
  const skip = await cmd('recruit', { name: 'Dev3', preset: 'Fake', replace: 'Dev2', noCheck: true, noHandoff: true });
  assert.doesNotMatch(skip.text, /handoff/);
});
