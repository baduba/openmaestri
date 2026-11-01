import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { PromptLib, validName, MAX_PROMPT_BYTES } from '../src/promptlib.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lib(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-plib-'));
  const l = new PromptLib({ globalDir: path.join(dir, 'global'), localDir: (id) => path.join(dir, 'ws', id, 'prompts') });
  t.after(() => { l.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { l, dir };
}

test('names: only safe characters, no traversal, bounded', () => {
  for (const ok of ['Review', 'code review 2', 'release-notes_v1.2', 'Revisão técnica']) assert.equal(validName(ok), ok);
  for (const bad of ['', '   ', '../x', 'a/b', 'a\\b', '.hidden', '..', 'a..b', 'x'.repeat(61), 'with\0nul', 'semi;colon', '$(x)', '-lead', '.trash', 'a\nb']) {
    assert.throws(() => validName(bad), /prompt name/, JSON.stringify(bad));
  }
});

test('save, read, list, overwrite rules and the 64 KB cap', (t) => {
  const { l } = lib(t);
  l.save('w1', 'Review', 'Please review @file:src/a.js carefully');
  assert.equal(l.get('w1', 'Review').text, 'Please review @file:src/a.js carefully', 'mentions are kept raw');
  assert.throws(() => l.save('w1', 'Review', 'other'), /already exists/);
  l.save('w1', 'Review', 'second version', { overwrite: true });
  assert.equal(l.get('w1', 'review'.replace('r', 'R')).text, 'second version');
  assert.throws(() => l.save('w1', 'Empty', '   '), /needs some text/);
  assert.throws(() => l.save('w1', 'Huge', 'x'.repeat(MAX_PROMPT_BYTES + 1)), /limited to 64 KB/);
  assert.throws(() => l.get('w1', 'Missing'), /no saved prompt/);
  assert.equal(fs.statSync(path.join(l.dir('w1', 'workspace'), 'Review.md')).mode & 0o777, 0o600);
  assert.equal(l.availableName('w1', 'Review'), 'Review 2');
  assert.deepEqual(l.list('w1').map((p) => [p.name, p.scope]), [['Review', 'workspace']]);
});

test('a workspace prompt hides a global one of the same name; other workspaces still see the global', (t) => {
  const { l } = lib(t);
  l.save('w1', 'Intro', 'global text', { scope: 'global' });
  l.save('w1', 'Intro', 'local text', { scope: 'workspace' });
  assert.equal(l.get('w1', 'Intro').text, 'local text');
  assert.equal(l.get('w1', 'Intro', 'global').text, 'global text');
  const mine = l.list('w1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].scope, 'workspace');
  assert.equal(mine[0].shadows, true);
  assert.equal(l.get('w2', 'Intro').text, 'global text');
  assert.deepEqual(l.list('w2').map((p) => p.scope), ['global']);
});

test('delete moves to the trash and undo brings the exact bytes back', (t) => {
  const { l } = lib(t);
  const text = 'line one\nline twoé\n\ttabbed';
  l.save('w1', 'Keep', text);
  l.remove('w1', 'Keep');
  assert.throws(() => l.get('w1', 'Keep'), /no saved prompt/);
  assert.equal(fs.readdirSync(path.join(l.dir('w1', 'workspace'), '.trash')).length, 1);
  assert.deepEqual(l.undo('w1'), { name: 'Keep', scope: 'workspace' });
  assert.equal(l.get('w1', 'Keep').text, text);
  assert.throws(() => l.undo('w1'), /nothing to restore/);
  // undo refuses to clobber a prompt that was recreated in the meantime
  l.remove('w1', 'Keep');
  l.save('w1', 'Keep', 'new one');
  assert.throws(() => l.undo('w1'), /exists again/);
  assert.equal(l.get('w1', 'Keep').text, 'new one');
});

test('the trash is purged after 30 days and never listed', (t) => {
  const { l } = lib(t);
  l.save('w1', 'Old', 'x');
  l.remove('w1', 'Old');
  const trash = path.join(l.dir('w1', 'workspace'), '.trash');
  const f = path.join(trash, fs.readdirSync(trash)[0]);
  const old = new Date(Date.now() - 31 * 86400000);
  fs.utimesSync(f, old, old);
  l.purgeTrash('w1');
  assert.equal(fs.readdirSync(trash).length, 0);
  assert.deepEqual(l.list('w1'), []);
});

test('symlinks, FIFOs, oversized and oddly named files are never read', async (t) => {
  const { l, dir } = lib(t);
  const folder = l.ensure(l.dir('w1', 'workspace'));
  const secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, 'TOP SECRET');
  fs.symlinkSync(secret, path.join(folder, 'Linked.md'));
  fs.writeFileSync(path.join(folder, 'Big.md'), 'x'.repeat(MAX_PROMPT_BYTES + 1));
  fs.writeFileSync(path.join(folder, '.hidden.md'), 'x');
  fs.writeFileSync(path.join(folder, 'bad;name.md'), 'x');
  const { execFileSync } = await import('node:child_process');
  execFileSync('mkfifo', [path.join(folder, 'Pipe.md')]);
  l.save('w1', 'Fine', 'ok');
  const started = Date.now();
  assert.deepEqual(l.list('w1').map((p) => p.name), ['Fine']);
  assert.ok(Date.now() - started < 1500, 'a FIFO did not hang the listing');
  assert.throws(() => l.get('w1', 'Linked'), /no saved prompt/);
  assert.equal(JSON.stringify(l.list('w1')).includes('TOP SECRET'), false);
});

test('edits made outside the app are announced', async (t) => {
  const { l } = lib(t);
  l.save('w1', 'Seed', 'x');
  l.list('w1');
  const seen = [];
  l.on('changed', (id) => seen.push(id));
  fs.writeFileSync(path.join(l.dir('w1', 'workspace'), 'Edited.md'), 'from an editor');
  const deadline = Date.now() + 3000;
  while (!seen.includes('w1') && Date.now() < deadline) await sleep(50);
  assert.ok(seen.includes('w1'));
  fs.writeFileSync(path.join(l.dir('w1', 'global'), 'G.md'), 'global edit');
  const d2 = Date.now() + 3000;
  while (!seen.includes(null) && Date.now() < d2) await sleep(50);
  assert.ok(seen.includes(null), 'global changes concern every workspace');
});

test('two saves at once with different names both land; the same name only one wins', (t) => {
  const { l } = lib(t);
  l.save('w1', 'A', 'a');
  l.save('w1', 'B', 'b');
  assert.equal(l.list('w1').length, 2);
  let winners = 0;
  for (let i = 0; i < 5; i++) { try { l.save('w1', 'Same', `v${i}`); winners++; } catch { /* lost the race */ } }
  assert.equal(winners, 1);
});

test('CLI: agents can read prompts; only a Maestro can save or delete; use materializes mentions', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-plib-cli-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  fs.writeFileSync(path.join(dir, 'spec.md'), 'SPEC TEXT');
  const boss = core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, cwd: dir });
  const worker = core.store.createNode(ws, 'terminal', { name: 'Worker', cwd: dir });
  const rpc = (id, cmd, args = {}) => new Promise((resolve, reject) => {
    const c = net.createConnection(app.socketPath);
    let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify({ id: 1, ctx: { terminalId: id }, cmd, args }) + '\n'));
    c.on('data', (d) => { buf += d; if (buf.includes('\n')) { c.end(); resolve(JSON.parse(buf)); } });
    c.on('error', reject);
  });
  assert.equal((await rpc(boss.id, 'prompt.save', { name: 'Spec review', text: 'Review @file:spec.md now' })).ok, true);
  assert.match((await rpc(worker.id, 'prompt.list')).text, /Spec review\s+\[workspace\]/);
  assert.equal((await rpc(worker.id, 'prompt.read', { name: 'Spec review' })).text, 'Review @file:spec.md now');
  assert.match((await rpc(worker.id, 'prompt.use', { name: 'Spec review' })).text, /<<<file "spec\.md" [0-9a-f]{8}>>>\nSPEC TEXT/);
  const denied = await rpc(worker.id, 'prompt.save', { name: 'Evil', text: 'x' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Maestro/);
  assert.equal((await rpc(worker.id, 'prompt.delete', { name: 'Spec review' })).ok, false);
  assert.equal((await rpc(boss.id, 'prompt.save', { name: '../escape', text: 'x' })).ok, false);
  assert.equal((await rpc(boss.id, 'prompt.delete', { name: 'Spec review' })).ok, true);
  assert.equal((await rpc(boss.id, 'prompt.undo')).ok, true);
  assert.equal((await rpc(worker.id, 'prompt.read', { name: 'Spec review' })).ok, true);
  assert.equal(fs.existsSync(path.join(dir, '..', 'escape.md')), false);
});
