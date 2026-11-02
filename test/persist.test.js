import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { Persist } from '../src/persist.js';

const tmuxBin = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
const skip = tmuxBin ? false : 'tmux is not installed';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timeout'); await sleep(100); } };

function env(t) {
  const socket = `omt${process.pid}${Math.random().toString(36).slice(2, 7)}`;
  Object.assign(process.env, { OPENMAESTRI_PERSIST: 'tmux', OPENMAESTRI_TMUX_SOCKET: socket });
  t.after(() => {
    delete process.env.OPENMAESTRI_PERSIST; delete process.env.OPENMAESTRI_TMUX_SOCKET;
    spawnSync(tmuxBin, ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  });
  return socket;
}

test('Persist: names, minimal server environment, sessions listed and swept', { skip }, (t) => {
  const socket = env(t);
  const p = Persist.detect();
  assert.equal(p.socket, socket);
  assert.throws(() => p.name('../x'), /not a terminal id/);
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  process.env.SECRET_FROM_FIRST = 'first-terminal-key';
  t.after(() => { delete process.env.SECRET_FROM_FIRST; });
  const base = { PATH: process.env.PATH, HOME: os.homedir(), TERM: 'xterm-256color' };
  assert.equal(p.create(a, { cwd: os.tmpdir(), env: { ...base, SECRET_FROM_FIRST: 'first-terminal-key' }, argv: ['/bin/sh', '-c', 'sleep 60'], cols: 80, rows: 24 }), true);
  assert.equal(p.create(b, { cwd: os.tmpdir(), env: { ...base, MARK: 'second' }, argv: ['/bin/sh', '-c', 'sleep 60'], cols: 80, rows: 24 }), true);
  assert.deepEqual(p.sessions().sort(), [a, b].sort());
  assert.equal(p.has(a), true);
  // the second terminal must not inherit what only the first one had
  const envOf = (id) => spawnSync(tmuxBin, ['-L', socket, 'show-environment', '-t', `=om-${id}`], { encoding: 'utf8' }).stdout;
  assert.match(envOf(a), /SECRET_FROM_FIRST=first-terminal-key/);
  assert.doesNotMatch(envOf(b), /SECRET_FROM_FIRST/);
  assert.match(envOf(b), /MARK=second/);
  assert.equal(p.sweep([a]), 1);
  assert.deepEqual(p.sessions(), [a]);
  assert.equal(p.kill(a), true);
  assert.equal(p.has(a), false);
});

test('a terminal survives a restart of openmaestri and is picked up again; dismissing it ends the session', { skip, timeout: 60000 }, async (t) => {
  const socket = env(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-persist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const boot = () => main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  let app = await boot();
  let ws = app.core.store.workspaces.get(app.core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  const pidFile = path.join(dir, 'pid');
  const node = app.core.store.createNode(ws, 'terminal', { name: 'Keeper', cwd: dir, command: `echo $$ > ${pidFile}; echo BEFORE-RESTART; i=0; while true; do i=$((i+1)); sleep 1; done` });
  app.core.startTerminal(ws, node);
  app.core.touch(ws);
  await until(() => app.core.terminals.text(node.id).includes('BEFORE-RESTART'));
  assert.equal(app.core.terminals.get(node.id).persistent, true);
  const pidBefore = fs.readFileSync(pidFile, 'utf8').trim();
  await app.close();
  const alive = spawnSync(tmuxBin, ['-L', socket, 'has-session', '-t', `=om-${node.id}`]).status;
  assert.equal(alive, 0, 'the tmux session outlived openmaestri');
  assert.doesNotThrow(() => process.kill(Number(pidBefore), 0), 'and so did the program inside it');

  app = await boot();
  ws = app.core.store.workspaces.get(app.core.store.settings.activeWorkspaceId);
  const again = ws.nodes.find((n) => n.name === 'Keeper');
  app.core.startTerminal(ws, again);
  await until(() => app.core.terminals.text(again.id).includes('BEFORE-RESTART'));
  assert.equal(app.core.terminals.get(again.id).reattached ?? true, true);
  assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), pidBefore, 'the command was not started a second time');
  app.core.terminals.write(again.id, '\x03');
  // dismissing ends the session for good
  app.core.terminals.dispose(again.id);
  await until(() => spawnSync(tmuxBin, ['-L', socket, 'has-session', '-t', `=om-${node.id}`]).status !== 0, 5000);
  await app.close();
});

test('sessions of terminals deleted while openmaestri was stopped are swept at start', { skip, timeout: 60000 }, async (t) => {
  const socket = env(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-persist2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ghost = '33333333-3333-4333-8333-333333333333';
  const p = Persist.detect();
  assert.equal(p.create(ghost, { cwd: dir, env: { PATH: process.env.PATH, HOME: os.homedir() }, argv: ['/bin/sh', '-c', 'sleep 60'], cols: 80, rows: 24 }), true);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  assert.notEqual(spawnSync(tmuxBin, ['-L', socket, 'has-session', '-t', `=om-${ghost}`]).status, 0);
});

test('without tmux asked for, terminals are plain', { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-plain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  delete process.env.OPENMAESTRI_PERSIST;
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  const ws = app.core.store.workspaces.get(app.core.store.settings.activeWorkspaceId);
  const node = app.core.store.createNode(ws, 'terminal', { name: 'Plain', command: 'echo hi' });
  app.core.startTerminal(ws, node);
  assert.equal(app.core.terminals.get(node.id).persistent, false);
});
