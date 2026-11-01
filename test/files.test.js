import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { main } from '../src/server.js';
import { Files, segments, MAX_EDIT_BYTES } from '../src/files.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# hi');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'console.log(1)\n');
  const f = new Files({ backupDir: (id) => path.join(dir, 'backups', id) });
  return { dir, root, f };
}

test('segments refuses every way out of the folder', () => {
  assert.deepEqual(segments('src/a.js'), ['src', 'a.js']);
  assert.deepEqual(segments('./src//a.js'), ['src', 'a.js']);
  assert.deepEqual(segments(''), []);
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'a\\b', 'a\0b', '.git/config', 'src/.git/HEAD', '.openmaestri/floors', 'x'.repeat(300), null, 5]) {
    assert.throws(() => segments(bad), /relative|not allowed|not available|too long|required/, JSON.stringify(bad));
  }
});

test('list: folders first, .git and .openmaestri hidden, escaping links hidden, inside links shown', (t) => {
  const { dir, root, f } = setup(t);
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.openmaestri'));
  fs.writeFileSync(path.join(root, 'b.txt'), 'x');
  const outside = path.join(dir, 'secret.txt');
  fs.writeFileSync(outside, 'TOP SECRET');
  fs.symlinkSync(outside, path.join(root, 'leak.txt'));
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'srclink'));
  const { entries } = f.list(root);
  assert.deepEqual(entries.map((e) => `${e.type}:${e.name}`), ['dir:src', 'dir:srclink', 'file:b.txt', 'file:README.md']);
  assert.deepEqual(f.list(root, 'src').entries.map((e) => e.name), ['a.js']);
  assert.throws(() => f.list(root, '..'), /not allowed/);
  assert.throws(() => f.list(root, 'nope'), /no such file/);
});

test('read: text, binary, too large, and no way to a file outside the folder', (t) => {
  const { dir, root, f } = setup(t);
  assert.equal(f.read(root, 'src/a.js').text, 'console.log(1)\n');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  assert.equal(f.read(root, 'bin.dat').binary, true);
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(MAX_EDIT_BYTES + 1));
  const big = f.read(root, 'big.txt');
  assert.equal(big.tooLarge, true);
  assert.equal(big.text, '');
  const outside = path.join(dir, 'secret.txt');
  fs.writeFileSync(outside, 'TOP SECRET');
  fs.symlinkSync(outside, path.join(root, 'leak.txt'));
  assert.throws(() => f.read(root, 'leak.txt'), /leaves the folder/);
  fs.symlinkSync(path.join(root, 'src', 'a.js'), path.join(root, 'ok-link.js'));
  assert.equal(f.read(root, 'ok-link.js').text, 'console.log(1)\n', 'a link that stays inside is fine to read');
  fs.symlinkSync(dir, path.join(root, 'dirlink'));
  assert.throws(() => f.read(root, 'dirlink/secret.txt'), /leaves the folder/, 'a folder link out is not a way around the check');
  assert.throws(() => f.read(root, '../secret.txt'), /not allowed/);
  assert.throws(() => f.read(root, 'src'), /not a file/);
  const { execFileSync: ex } = { execFileSync };
  ex('mkfifo', [path.join(root, 'pipe')]);
  const started = Date.now();
  assert.throws(() => f.read(root, 'pipe'), /not a file/);
  assert.ok(Date.now() - started < 1500, 'a FIFO does not hang the daemon');
});

test('write: atomic, keeps versions, refuses stale saves, symlinks, oversize and mode loss', (t) => {
  const { root, f } = setup(t);
  const file = path.join(root, 'src', 'a.js');
  fs.chmodSync(file, 0o750);
  const first = f.read(root, 'src/a.js');
  const w = f.write(root, 'src/a.js', 'console.log(2)\n', { wsId: 'w1', expectedMtime: first.mtimeMs });
  assert.equal(fs.readFileSync(file, 'utf8'), 'console.log(2)\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o750, 'permissions are kept');
  assert.equal(fs.readdirSync(path.join(root, 'src')).some((n) => n.endsWith('.tmp')), false, 'no temp file is left behind');
  const versions = f.versions('w1', root, 'src/a.js');
  assert.equal(versions.length, 1);
  assert.equal(f.version('w1', root, 'src/a.js', versions[0].id), 'console.log(1)\n', 'the previous content was kept');
  // someone else edits the file: the old editor must not overwrite it
  fs.writeFileSync(file, 'changed elsewhere');
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.throws(() => f.write(root, 'src/a.js', 'mine', { wsId: 'w1', expectedMtime: w.mtimeMs }), /changed on disk/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'changed elsewhere');
  assert.throws(() => f.write(root, 'src/a.js', 'x'.repeat(MAX_EDIT_BYTES + 1), { wsId: 'w1' }), /over 1 MB/);
  assert.throws(() => f.write(root, 'src/a.js', 5, { wsId: 'w1' }), /nothing to save/);
  fs.symlinkSync(path.join(root, 'README.md'), path.join(root, 'link.md'));
  assert.throws(() => f.write(root, 'link.md', 'x', { wsId: 'w1' }), /symbolic link/);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# hi', 'the target of the link was not touched');
  for (let i = 0; i < 14; i++) { fs.writeFileSync(file, `v${i}`); f.write(root, 'src/a.js', `n${i}`, { wsId: 'w1' }); }
  assert.ok(f.versions('w1', root, 'src/a.js').length <= 10, 'only the last 10 versions are kept');
  assert.throws(() => f.version('w1', root, 'src/a.js', '../../etc/passwd'), /unknown version/);
});

test('create, rename and delete (to a trash) stay inside the folder', (t) => {
  const { dir, root, f } = setup(t);
  f.create(root, 'src/new.js', 'file');
  f.create(root, 'docs', 'dir');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'new.js'), 'utf8'), '');
  assert.throws(() => f.create(root, 'src/new.js', 'file'), /already exists/);
  assert.throws(() => f.create(root, 'nodir/x.js', 'file'), /does not exist/);
  assert.throws(() => f.create(root, '../evil.js', 'file'), /not allowed/);
  assert.throws(() => f.create(root, '', 'file'), /give it a name|relative/);
  fs.symlinkSync(dir, path.join(root, 'out'));
  assert.throws(() => f.create(root, 'out/evil.js', 'file'), /leaves the folder/);
  assert.equal(fs.existsSync(path.join(dir, 'evil.js')), false);
  f.rename(root, 'src/new.js', 'docs/moved.js');
  assert.equal(fs.existsSync(path.join(root, 'docs', 'moved.js')), true);
  assert.throws(() => f.rename(root, 'docs/moved.js', 'README.md'), /already exists/);
  assert.throws(() => f.rename(root, 'docs', 'docs/inner'), /into itself/);
  assert.throws(() => f.rename(root, 'docs/moved.js', '../gone.js'), /not allowed/);
  fs.writeFileSync(path.join(root, 'docs', 'moved.js'), 'keep me');
  const { trashed } = f.remove(root, 'docs/moved.js', 'w1');
  assert.equal(fs.existsSync(path.join(root, 'docs', 'moved.js')), false);
  assert.equal(fs.readFileSync(trashed, 'utf8'), 'keep me', 'deleting moves to a trash, it is recoverable');
  assert.throws(() => f.remove(root, '', 'w1'), /cannot be deleted/);
  assert.throws(() => f.remove(root, '.git', 'w1'), /not available/);
  assert.equal(fs.existsSync(root), true);
});

test('status shows modified, new and deleted files through git', async (t) => {
  const { root, f } = setup(t);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (...a) => execFileSync('git', a, { cwd: root, env, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '.'); g('commit', '-qm', 'init');
  fs.writeFileSync(path.join(root, 'README.md'), '# changed');
  fs.writeFileSync(path.join(root, 'fresh.txt'), 'new');
  fs.rmSync(path.join(root, 'src', 'a.js'));
  assert.deepEqual(await f.status(root), { 'README.md': 'M', 'fresh.txt': '?', 'src/a.js': 'D' });
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'om-nogit-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.deepEqual(await f.status(plain), {});
});

test('over the WebSocket: only a files node can browse, and a floor browses its own folder', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-files-ws-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'main.txt'), 'ground file');
  ws.dir = proj;
  const other = path.join(dir, 'floor-dir');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'floor.txt'), 'floor file');
  ws.floors.push({ id: '11111111-1111-4111-8111-111111111111', name: 'F', slug: 'f', dir: other, kind: 'dir', branch: null, repo: null, status: null });
  const node = core.store.createNode(ws, 'files', { name: 'Browser' });
  const fnode = core.store.createNode(ws, 'files', { name: 'FloorBrowser', floorId: '11111111-1111-4111-8111-111111111111' });
  const note = core.store.createNode(ws, 'note', { name: 'N' });
  const sock = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=${app.token}`, { headers: { origin: `http://127.0.0.1:${app.port}` } });
  const got = [];
  sock.on('message', (m) => got.push(JSON.parse(m)));
  await new Promise((r) => sock.on('open', r));
  const ask = async (msg) => { const n = got.length; sock.send(JSON.stringify({ workspaceId: ws.id, t: 'files.op', reqId: Math.random(), ...msg })); const end = Date.now() + 4000; while (got.length === n && Date.now() < end) await sleep(20); return got.slice(n).find((x) => x.t === 'files.result' || x.t === 'error'); };
  assert.deepEqual((await ask({ id: node.id, op: 'list' })).entries.map((e) => e.name), ['main.txt']);
  assert.deepEqual((await ask({ id: fnode.id, op: 'list' })).entries.map((e) => e.name), ['floor.txt']);
  assert.equal((await ask({ id: node.id, op: 'read', path: 'main.txt' })).text, 'ground file');
  assert.match((await ask({ id: node.id, op: 'read', path: '../secret' })).message, /not allowed/);
  assert.match((await ask({ id: note.id, op: 'list' })).message, /not a file browser/);
  const saved = await ask({ id: node.id, op: 'write', path: 'main.txt', text: 'edited', expectedMtime: 0 });
  assert.match(saved.message, /changed on disk/);
  const r = await ask({ id: node.id, op: 'read', path: 'main.txt' });
  const ok = await ask({ id: node.id, op: 'write', path: 'main.txt', text: 'edited', expectedMtime: r.mtimeMs });
  assert.equal(ok.op, 'write');
  assert.equal(fs.readFileSync(path.join(proj, 'main.txt'), 'utf8'), 'edited');
  assert.match((await ask({ id: node.id, op: 'bogus' })).message, /unknown file operation/);
  sock.close();
});
