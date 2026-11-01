import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';

// the daemon under test runs git too (merges need an identity), and CI machines have none
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const rpc = (sock, id, cmd, args = {}) => new Promise((resolve, reject) => {
  const c = net.createConnection(sock);
  let buf = '';
  c.setEncoding('utf8');
  c.on('connect', () => c.write(JSON.stringify({ id: 1, ctx: { terminalId: id }, cmd, args }) + '\n'));
  c.on('data', (d) => { buf += d; if (buf.includes('\n')) { c.end(); resolve(JSON.parse(buf)); } });
  c.on('error', reject);
});

async function boot(t, { git = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-floor-'));
  const repo = path.join(dir, 'proj');
  fs.mkdirSync(repo);
  if (git) {
    sh(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-q', '-m', 'init');
  }
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const store = app.core.store;
  const ws = store.workspaces.get(store.settings.activeWorkspaceId);
  ws.dir = repo;
  const boss = store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, cwd: repo });
  const call = (cmd, args) => rpc(app.socketPath, boss.id, cmd, args);
  return { app, ws, repo, dir, boss, call, store, core: app.core };
}

test('a worktree floor gets its own branch, folder and canvas, and keeps the repo clean', async (t) => {
  const { ws, repo, call, store } = await boot(t);
  const r = await call('floor.create', { name: 'Feature A' });
  assert.equal(r.ok, true, r.error);
  const floor = ws.floors[0];
  assert.equal(floor.kind, 'worktree');
  assert.equal(floor.branch, 'floor/feature-a');
  assert.equal(floor.dir, path.join(repo, '.openmaestri', 'floors', 'feature-a'));
  assert.match(sh(repo, 'worktree', 'list'), /feature-a/);
  assert.equal(sh(repo, 'status', '--porcelain'), '', 'the floors folder is excluded from git status');
  assert.ok(fs.existsSync(path.join(floor.dir, 'a.txt')));

  // an agent recruited on that floor works in its folder and is wired to the Maestro
  const rec = await call('recruit', { name: 'Dev', floor: 'Feature A' });
  assert.equal(rec.ok, true, rec.error);
  const dev = ws.nodes.find((n) => n.name === 'Dev');
  assert.equal(dev.floorId, floor.id);
  assert.equal(dev.cwd, floor.dir);
  assert.ok(store.neighbors(ws, dev.id).some((n) => n.name === 'Boss'), 'cross-floor cable to the recruiter');
  // the Maestro sees its own floor plus what is cabled to it
  const list = await call('list');
  assert.match(list.text, /Dev/);

  // per-floor status
  assert.equal((await call('floor.status', { text: 'building', state: 'working', floor: 'Feature A' })).ok, true);
  assert.equal(floor.status.text, 'building');
  assert.equal(ws.floorStatus, null);
  const dup = await call('floor.create', { name: 'feature a' });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already exists/);
});

test('landing merges the floor branch into the project and removes the floor', async (t) => {
  const { ws, repo, call } = await boot(t);
  await call('floor.create', { name: 'Feat' });
  const floor = ws.floors[0];
  await call('recruit', { name: 'Dev', floor: 'Feat' });
  fs.writeFileSync(path.join(floor.dir, 'new.txt'), 'hello\n');
  const dirty = await call('floor.land', { name: 'Feat' });
  assert.equal(dirty.ok, false);
  assert.match(dirty.error, /uncommitted changes/);
  sh(floor.dir, 'add', '.');
  sh(floor.dir, 'commit', '-q', '-m', 'add new');
  assert.match((await call('floor.list')).text, /1 commit\(s\) ahead/);
  const landed = await call('floor.land', { name: 'Feat', deleteBranch: true });
  assert.equal(landed.ok, true, landed.error);
  assert.equal(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8'), 'hello\n');
  assert.equal(ws.floors.length, 0);
  assert.ok(!ws.nodes.some((n) => n.name === 'Dev'), 'the floor canvas went with it');
  assert.ok(!fs.existsSync(floor.dir));
  assert.equal(sh(repo, 'branch', '--list', 'floor/feat'), '', 'branch deleted on request');
});

test('a conflicting land changes nothing and says which files conflict', async (t) => {
  const { ws, repo, call } = await boot(t);
  await call('floor.create', { name: 'Clash' });
  const floor = ws.floors[0];
  fs.writeFileSync(path.join(floor.dir, 'a.txt'), 'from floor\n');
  sh(floor.dir, 'commit', '-qam', 'floor edit');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'from ground\n');
  sh(repo, 'commit', '-qam', 'ground edit');
  const head = sh(repo, 'rev-parse', 'HEAD');
  const r = await call('floor.land', { name: 'Clash' });
  assert.equal(r.ok, false);
  assert.match(r.error, /merge conflicts in:\s*a\.txt/);
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(sh(repo, 'status', '--porcelain'), '');
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')));
  assert.equal(ws.floors.length, 1, 'the floor is kept so the work is not lost');
});

test('delete refuses uncommitted work unless forced, and keeps unmerged branches', async (t) => {
  const { ws, repo, call } = await boot(t);
  await call('floor.create', { name: 'Tmp' });
  const floor = ws.floors[0];
  fs.writeFileSync(path.join(floor.dir, 'wip.txt'), 'x');
  const refused = await call('floor.delete', { name: 'Tmp' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /uncommitted changes/);
  assert.ok(fs.existsSync(floor.dir));
  const forced = await call('floor.delete', { name: 'Tmp', force: true });
  assert.equal(forced.ok, true, forced.error);
  assert.ok(!fs.existsSync(floor.dir));
  assert.equal(ws.floors.length, 0);
  // an unmerged branch survives a plain delete
  await call('floor.create', { name: 'Keep' });
  const f2 = ws.floors[0];
  fs.writeFileSync(path.join(f2.dir, 'k.txt'), 'k');
  sh(f2.dir, 'add', '.');
  sh(f2.dir, 'commit', '-qm', 'k');
  const del = await call('floor.delete', { name: 'Keep' });
  assert.equal(del.ok, true, del.error);
  assert.match(del.text, /not merged/);
  assert.match(sh(repo, 'branch', '--list', 'floor/keep'), /floor\/keep/);
});

test('copy floors are independent clones that can still land', async (t) => {
  const { ws, repo, call } = await boot(t);
  const r = await call('floor.create', { name: 'Iso', copy: true });
  assert.equal(r.ok, true, r.error);
  const floor = ws.floors[0];
  assert.equal(floor.kind, 'clone');
  assert.ok(fs.existsSync(path.join(floor.dir, '.git', 'HEAD')), 'a real clone, not a worktree link');
  fs.writeFileSync(path.join(floor.dir, 'iso.txt'), 'iso\n');
  sh(floor.dir, 'add', '.');
  sh(floor.dir, 'commit', '-qm', 'iso');
  const landed = await call('floor.land', { name: 'Iso' });
  assert.equal(landed.ok, true, landed.error);
  assert.equal(fs.readFileSync(path.join(repo, 'iso.txt'), 'utf8'), 'iso\n');
  assert.ok(!fs.existsSync(floor.dir));
});

test('non-git projects and existing folders get plain floors', async (t) => {
  const { ws, dir, call } = await boot(t, { git: false });
  const plain = await call('floor.create', { name: 'Notes' });
  assert.equal(plain.ok, true, plain.error);
  assert.equal(ws.floors[0].kind, 'plain');
  assert.equal(ws.floors[0].dir, ws.dir);
  const own = path.join(dir, 'elsewhere');
  fs.mkdirSync(own);
  assert.equal((await call('floor.create', { name: 'Mine', dir: own })).ok, true);
  assert.equal(ws.floors.find((f) => f.name === 'Mine').dir, own);
  assert.equal((await call('floor.create', { name: 'Gone', dir: path.join(dir, 'nope') })).ok, false);
  const nogit = await call('floor.land', { name: 'Notes' });
  assert.equal(nogit.ok, false);
  assert.match(nogit.error, /no branch of its own/);
  assert.equal((await call('floor.create', { name: 'C', copy: true })).ok, false);
});

test('hostile floor names and branches are rejected before git runs', async (t) => {
  const { ws, repo, call, dir } = await boot(t);
  for (const bad of ['Ground', 'ground', '', '   ', '!!!', 'x'.repeat(80)]) {
    assert.equal((await call('floor.create', { name: bad })).ok, false, JSON.stringify(bad));
  }
  const marker = path.join(dir, 'pwned');
  for (const branch of ['-x', '--upload-pack=touch ' + marker, 'a b', 'x;touch ' + marker, '$(touch ' + marker + ')', 'a..b', 'x~1']) {
    const r = await call('floor.create', { name: 'Evil', branch });
    assert.equal(r.ok, false, branch);
  }
  assert.equal((await call('floor.create', { name: '../../escape' })).ok, true);
  const f = ws.floors.find((x) => x.slug === 'escape');
  assert.ok(f.dir.startsWith(path.join(repo, '.openmaestri', 'floors')), 'the folder name is a slug, never a path');
  assert.equal(fs.existsSync(marker), false);
  const base = await call('floor.create', { name: 'Base', from: '../../etc' });
  assert.equal(base.ok, false);
});

test('non-maestro agents cannot manage floors', async (t) => {
  const { ws, store, app } = await boot(t);
  const worker = store.createNode(ws, 'terminal', { name: 'W' });
  const r = await rpc(app.socketPath, worker.id, 'floor.create', { name: 'Sneaky' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Maestro/);
});

test('landing explains a missing git identity instead of dumping git output', async (t) => {
  const { ws, call } = await boot(t);
  await call('floor.create', { name: 'Id' });
  const floor = ws.floors[0];
  fs.writeFileSync(path.join(floor.dir, 'x.txt'), 'x');
  sh(floor.dir, 'add', '.');
  sh(floor.dir, 'commit', '-qm', 'x');
  const saved = {};
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  const prev = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, SYS: process.env.GIT_CONFIG_NOSYSTEM, GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'om-nohome-'));
  process.env.XDG_CONFIG_HOME = path.join(process.env.HOME, '.config');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  // git also guesses an identity from the host name; forbid that so the check is deterministic
  const r = await call('floor.land', { name: 'Id' }).finally(() => {
    Object.assign(process.env, saved);
    process.env.HOME = prev.HOME;
    if (prev.XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev.XDG;
    if (prev.SYS === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = prev.SYS;
    if (prev.GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prev.GLOBAL;
  });
  // On hosts where git can still derive an identity this passes through; where it cannot, the message must be friendly.
  if (!r.ok) assert.match(r.error, /no name and email configured|uncommitted|conflict/);
});
