import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await sleep(50);
  }
}

/** Run a command line inside terminal `id` via the real pty, return what it printed. */
async function inTerm(core, id, line) {
  const marker = `__END_${Math.random().toString(36).slice(2)}__`;
  const from = core.terminals.cursorLine(id);
  core.terminals.write(id, `${line}; echo ${marker}\r`);
  await until(() => core.terminals.text(id, { fromLine: from }).split('\n').some((l) => l.trim() === marker));
  const text = core.terminals.text(id, { fromLine: from }).split('\n');
  // drop the echoed command line and the marker line
  // output sits between the line that echoes our command (contains the marker but is not only the marker) and the bare marker line
  const end = text.findIndex((l) => l.trim() === marker);
  const echoed = text.slice(0, end).findLastIndex((l) => l.includes(marker));
  return text.slice(echoed + 1, end).join('\n');
}

test('cli inside terminals: ask / check / notes / recruit / permissions', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-test-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;

  const boss = core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, cwd: dir });
  const worker = core.store.createNode(ws, 'terminal', { name: 'Worker', cwd: dir });
  const loner = core.store.createNode(ws, 'terminal', { name: 'Loner', cwd: dir });
  core.store.connect(ws, boss.id, worker.id);
  core.startTerminal(ws, boss);
  core.startTerminal(ws, worker);
  core.startTerminal(ws, loner);
  await sleep(600);

  await t.test('list shows only connected nodes', async () => {
    const out = await inTerm(core, boss.id, 'openmaestri list');
    assert.match(out, /agent\s+Worker/);
    // boss is maestro so it reaches everything, loner included
    assert.match(out, /Loner/);
    const out2 = await inTerm(core, worker.id, 'openmaestri list');
    assert.match(out2, /Boss/);
    assert.doesNotMatch(out2, /Loner/);
  });

  await t.test('ask delivers a prompt and returns what the target printed', async () => {
    const out = await inTerm(core, boss.id, `openmaestri ask Worker 'echo ping-$((20+22))'`);
    assert.match(out, /ping-42/);
  });

  await t.test('ask --raw sends keystrokes (Ctrl-C works)', async () => {
    core.terminals.write(worker.id, 'sleep 30\r');
    await sleep(300);
    await inTerm(core, boss.id, `openmaestri ask Worker --raw '\\x03'`);
    const out = await inTerm(core, boss.id, `openmaestri ask Worker 'echo alive'`);
    assert.match(out, /alive/);
  });

  await t.test('check reads the target screen', async () => {
    const out = await inTerm(core, boss.id, 'openmaestri check Worker --lines 20');
    assert.match(out, /alive/);
  });

  await t.test('non-connected agent is refused', async () => {
    const out = await inTerm(core, worker.id, `openmaestri ask Loner 'echo nope' 2>&1; echo rc=$?`);
    assert.match(out, /no terminal named "Loner" is connected/);
    assert.match(out, /rc=1/);
  });

  await t.test('maestro-only commands are refused for regular agents', async () => {
    const out = await inTerm(core, worker.id, `openmaestri recruit X 2>&1`);
    assert.match(out, /only available to Maestro/);
  });

  await t.test('notes: create/read/edit/write/delete', async () => {
    const name = (await inTerm(core, worker.id, `openmaestri note create 'hello world' --name Plan`)).trim();
    assert.equal(name, 'Plan');
    assert.equal((await inTerm(core, worker.id, 'openmaestri note read Plan')).trim(), 'hello world');
    await inTerm(core, worker.id, `openmaestri note edit Plan world there`);
    assert.equal((await inTerm(core, worker.id, 'openmaestri note read Plan')).trim(), 'hello there');
    await inTerm(core, worker.id, `openmaestri note write Plan 'second'`);
    const node = ws.nodes.find((n) => n.name === 'Plan');
    assert.equal(core.store.readNote(ws.id, node.id), 'second');
    // the note is wired to the creator, so Boss (maestro) and Worker both reach it; Loner is not allowed
    assert.ok(ws.connections.some((c) => [c.from, c.to].includes(node.id) && [c.from, c.to].includes(worker.id)));
    await inTerm(core, worker.id, 'openmaestri note delete Plan');
    assert.ok(!ws.nodes.some((n) => n.name === 'Plan'));
  });

  await t.test('recruit spawns a connected, running teammate', async () => {
    const name = (await inTerm(core, boss.id, `openmaestri recruit Helper --dir ${dir}`)).trim();
    assert.equal(name, 'Helper');
    const helper = ws.nodes.find((n) => n.name === 'Helper');
    assert.ok(helper);
    assert.ok(core.store.neighbors(ws, boss.id).some((n) => n.id === helper.id));
    assert.notEqual(core.terminals.status(helper.id), 'stopped');
    await inTerm(core, boss.id, 'openmaestri dismiss Helper');
    assert.ok(!ws.nodes.some((n) => n.name === 'Helper'));
  });

  await t.test('routine fires into the terminal', async () => {
    await inTerm(core, boss.id, `openmaestri routine create tick --command 'echo routine-fired' --terminal Worker --every 10s`);
    await inTerm(core, boss.id, 'openmaestri routine run tick');
    await until(() => core.terminals.text(worker.id).includes('routine-fired'));
  });

  await t.test('state survives a restart', async () => {
    core.store.flush();
    const saved = JSON.parse(fs.readFileSync(core.store.wsFile(ws.id), 'utf8'));
    assert.ok(saved.nodes.find((n) => n.name === 'Boss')?.maestro);
    assert.equal(saved.routines[0].name, 'tick');
  });
});

test('web server rejects requests without the token or with a foreign Host', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-test-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.port}`;
  assert.equal((await fetch(`${base}/`)).status, 403);
  assert.equal((await fetch(`${base}/?token=wrong`)).status, 403);
  assert.equal((await fetch(`${base}/vendor/xterm.mjs`)).status, 403);
  const ok = await fetch(`${base}/vendor/xterm.mjs?token=${app.token}`);
  assert.equal(ok.status, 200);
  const evil = await fetch(`${base}/?token=${app.token}`, { headers: { host: 'evil.example:80' } });
  assert.equal(evil.status, 403);
  assert.equal((await fetch(`${base}/..%2f..%2fpackage.json?token=${app.token}`)).status === 200, false);
});
