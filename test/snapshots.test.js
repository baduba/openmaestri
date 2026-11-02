import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: ENV, stdio: 'pipe', encoding: 'utf8' }).trim();
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const tree = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git' || e.name === '.openmaestri') continue; const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(`${path.relative(dir, f)}=${fs.readFileSync(f, 'utf8')}`); } };
  walk(dir);
  return out.sort();
};

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-snapt-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  const proj = path.join(dir, 'proj'); fs.mkdirSync(proj);
  git(proj, 'init', '-q', '-b', 'main');
  write(proj, 'a.txt', 'a'); write(proj, 'src/b.js', 'b'); write(proj, '.gitignore', 'ignored.log\n');
  git(proj, 'add', '.'); git(proj, 'commit', '-qm', 'init');
  ws.dir = proj;
  const boss = core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, command: '' });
  const worker = core.store.createNode(ws, 'terminal', { name: 'Worker', maestro: false, command: '' });
  const cmd = (me, name, args = {}) => core.command({ terminalId: me.id }, name, args);
  return { dir, proj, core, ws, boss, worker, cmd };
}

test('snapshot then rollback restores edits, deletions and new files, and leaves ignored files alone', async (t) => {
  const { proj, ws, boss, cmd } = await setup(t);
  const made = await cmd(boss, 'floor.create', { name: 'Work' });
  const dir = made.data.dir;
  write(dir, 'a.txt', 'a edited'); write(dir, 'new/file.txt', 'brand new'); write(dir, 'ignored.log', 'keep me');
  const snap = await cmd(boss, 'floor.snapshot', { name: 'Work', label: 'good state' });
  assert.match(snap.text, /snapshot \d{17}-[0-9a-f]{4} of Work \(good state\)/);
  const good = tree(dir);
  // the agent messes up
  write(dir, 'a.txt', 'garbage'); fs.rmSync(path.join(dir, 'src'), { recursive: true }); write(dir, 'junk/x.txt', 'x'); fs.rmSync(path.join(dir, 'new/file.txt')); write(dir, 'ignored.log', 'changed ignored');
  assert.notDeepEqual(tree(dir), good);
  const out = await cmd(boss, 'floor.rollback', { name: 'Work', id: snap.data.id });
  assert.match(out.text, /files restored, \d+ removed/);
  assert.match(out.text, /Undo this rollback with: floor rollback "Work" \d{17}-[0-9a-f]{4}/);
  const after = tree(dir).filter((l) => !l.startsWith('ignored.log'));
  assert.deepEqual(after, good.filter((l) => !l.startsWith('ignored.log')), 'the tree is exactly as it was');
  assert.equal(read(dir, 'ignored.log'), 'changed ignored', 'ignored files are not touched');
  assert.equal(fs.existsSync(path.join(dir, 'junk')), false, 'empty folders left by removed files are cleaned');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'floor/work', 'the branch was not moved');
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), '', 'nothing was staged by the snapshot or the rollback');
  assert.equal(git(proj, 'status', '--porcelain'), '', 'the main checkout was never touched');
  void ws;
});

test('a rollback can itself be rolled back; the list is newest first', async (t) => {
  const { boss, cmd } = await setup(t);
  const dir = (await cmd(boss, 'floor.create', { name: 'Work' })).data.dir;
  write(dir, 'a.txt', 'one');
  const s1 = await cmd(boss, 'floor.snapshot', { name: 'Work', label: 'one' });
  write(dir, 'a.txt', 'two');
  const rb = await cmd(boss, 'floor.rollback', { name: 'Work', id: s1.data.id });
  assert.equal(read(dir, 'a.txt'), 'one');
  const safety = /floor rollback "Work" (\S+)/.exec(rb.text)[1];
  await cmd(boss, 'floor.rollback', { name: 'Work', id: safety });
  assert.equal(read(dir, 'a.txt'), 'two', 'the state before the rollback came back');
  const list = await cmd(boss, 'floor.snapshots', { name: 'Work' });
  const ids = list.data.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort().reverse());
  assert.ok(list.data.some((r) => r.label === 'one'));
  assert.match(list.text, /before rollback to/);
});

test('default is the latest snapshot; unknown ids, empty floors and bad ids are refused', async (t) => {
  const { boss, cmd } = await setup(t);
  const dir = (await cmd(boss, 'floor.create', { name: 'Work' })).data.dir;
  await assert.rejects(cmd(boss, 'floor.rollback', { name: 'Work' }), /has no snapshots yet/);
  assert.match((await cmd(boss, 'floor.snapshots', { name: 'Work' })).text, /No snapshots on Work/);
  write(dir, 'a.txt', 'v1'); await cmd(boss, 'floor.snapshot', { name: 'Work' });
  write(dir, 'a.txt', 'v2');
  await cmd(boss, 'floor.rollback', { name: 'Work' });
  assert.equal(read(dir, 'a.txt'), 'v1');
  await assert.rejects(cmd(boss, 'floor.rollback', { name: 'Work', id: '99999999999999999-abcd' }), /no snapshot "99999999999999999-abcd"/);
  await assert.rejects(cmd(boss, 'floor.rollback', { name: 'Work', id: '../../etc' }), /no snapshot/);
  await assert.rejects(cmd(boss, 'floor.rollback', {}), /usage: floor rollback/);
  await assert.rejects(cmd(boss, 'floor.snapshot', { name: 'Nope' }), /no floor named/);
});

test('the ground floor works, and a Maestro is required', async (t) => {
  const { proj, boss, worker, cmd } = await setup(t);
  await assert.rejects(cmd(worker, 'floor.snapshot', { name: 'Ground' }), /only available to Maestro/);
  write(proj, 'a.txt', 'ground edit'); write(proj, 'untracked.txt', 'u');
  const s = await cmd(boss, 'floor.snapshot', { name: 'Ground' });
  write(proj, 'a.txt', 'oops'); fs.rmSync(path.join(proj, 'untracked.txt'));
  await cmd(boss, 'floor.rollback', { name: 'Ground', id: s.data.id });
  assert.equal(read(proj, 'a.txt'), 'ground edit');
  assert.equal(read(proj, 'untracked.txt'), 'u');
});

test('a branch that moved is reported, not undone; folders that are not repositories are refused', async (t) => {
  const { dir: tmp, proj, ws, boss, cmd } = await setup(t);
  const made = await cmd(boss, 'floor.create', { name: 'Work' });
  const dir = made.data.dir;
  const s = await cmd(boss, 'floor.snapshot', { name: 'Work' });
  write(dir, 'c.txt', 'c'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'more');
  const out = await cmd(boss, 'floor.rollback', { name: 'Work', id: s.data.id });
  assert.match(out.text, /the branch has new commits since the snapshot; they stay/);
  assert.equal(git(dir, 'log', '--oneline').split('\n').length, 2);
  const plain = path.join(tmp, 'plain'); fs.mkdirSync(plain);
  ws.floors.push({ id: '33333333-3333-4333-8333-333333333333', name: 'Loose', slug: 'loose', dir: plain, kind: 'dir', branch: null, repo: null, status: null });
  await assert.rejects(cmd(boss, 'floor.snapshot', { name: 'Loose' }), /not in a git repository/);
  const sub = path.join(proj, 'src');
  ws.floors.push({ id: '44444444-4444-4444-8444-444444444444', name: 'Sub', slug: 'sub', dir: sub, kind: 'dir', branch: null, repo: null, status: null });
  await assert.rejects(cmd(boss, 'floor.snapshot', { name: 'Sub' }), /top of one/);
});

test('only the last 20 are kept; deleting the floor forgets them; landing takes a snapshot first', async (t) => {
  const { proj, boss, cmd } = await setup(t);
  const made = await cmd(boss, 'floor.create', { name: 'Work' });
  const dir = made.data.dir;
  for (let i = 0; i < 23; i += 1) { write(dir, 'a.txt', `v${i}`); await cmd(boss, 'floor.snapshot', { name: 'Work', label: `n${i}` }); }
  const list = await cmd(boss, 'floor.snapshots', { name: 'Work' });
  assert.equal(list.data.length, 20);
  assert.equal(list.data[0].label, 'n22');
  assert.equal(list.data.at(-1).label, 'n3');
  write(dir, 'a.txt', 'to land'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'work');
  await cmd(boss, 'floor.land', { name: 'Work', keepFloor: true });
  assert.ok((await cmd(boss, 'floor.snapshots', { name: 'Work' })).data.some((r) => r.label === 'before land'));
  assert.ok(git(proj, 'for-each-ref', 'refs/openmaestri/snapshots/work/').length > 0);
  await cmd(boss, 'floor.delete', { name: 'Work', force: true });
  assert.equal(git(proj, 'for-each-ref', 'refs/openmaestri/snapshots/work/'), '', 'a deleted floor leaves no snapshots behind');
});

test('run --floors leaves a snapshot per agent in the report', async (t) => {
  const { dir: tmp, core, boss, cmd } = await setup(t);
  const tool = path.join(tmp, 'tool'); fs.writeFileSync(tool, '#!/usr/bin/env bash\necho "by agent" > "$PWD/agent.txt"\necho done\n', { mode: 0o755 });
  core.store.settings.drivers = { mine: { bin: tool, args: ['{prompt}'] } };
  const out = await cmd(boss, 'run', { task: 'do it', agents: 'mine', floors: true });
  const id = /Snapshot (\d{17}-[0-9a-f]{4})/.exec(out.text)?.[1];
  assert.ok(id, out.text);
  const floorName = /Floor: (run mine [0-9a-f]{4})/.exec(out.text)[1];
  const floor = core.store.workspaces.get(core.store.settings.activeWorkspaceId).floors.find((f) => f.name === floorName);
  fs.rmSync(path.join(floor.dir, 'agent.txt'));
  await cmd(boss, 'floor.rollback', { name: floorName, id });
  assert.equal(read(floor.dir, 'agent.txt').trim(), 'by agent', 'what the agent produced can be brought back');
});
