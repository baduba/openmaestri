import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';

async function daemon(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-expose-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  const saved = process.env.OPENMAESTRI_DEFAULT_SANDBOX;
  t.after(async () => {
    if (saved === undefined) delete process.env.OPENMAESTRI_DEFAULT_SANDBOX; else process.env.OPENMAESTRI_DEFAULT_SANDBOX = saved;
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  const maestro = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir });
  const run = (cmd, args) => core.command({ terminalId: maestro.id }, cmd, args);
  return { core, ws, dir, run };
}

test('recruit on this machine names the keys the teammate can read, never their values', async (t) => {
  const { core, dir, run } = await daemon(t);
  fs.writeFileSync(path.join(core.dataRoot, 'env'), 'OPENROUTER_API_KEY=sk-or-very-secret-value\nEDITOR_THEME=dark\n', { mode: 0o600 });
  const r = await run('recruit', { name: 'Dev', command: 'sleep 30', noCheck: true });
  assert.match(r.text, /Dev\nNote: Dev runs on this machine with access to your files and these keys: OPENROUTER_API_KEY\./);
  assert.doesNotMatch(r.text, /sk-or-very-secret-value|EDITOR_THEME/);
  assert.deepEqual(r.data.exposed, ['OPENROUTER_API_KEY']);
  core.store.createNode(core.store.workspaces.get(core.store.settings.activeWorkspaceId), 'terminal', { name: 'Boss', maestro: true, command: 'sleep 30', cwd: dir });
  const shown = await run('sandbox', {});
  assert.match(shown.text, /Default for new teammates: none/);
  assert.match(shown.text, /Dev: on this machine, can read the keys OPENROUTER_API_KEY/);
  assert.match(shown.text, /Boss: on this machine \(the Maestro cannot be boxed\), can read the keys OPENROUTER_API_KEY/);
});

test('no keys, no note; a plain shell and the Maestro never get one', async (t) => {
  const { run } = await daemon(t);
  const r = await run('recruit', { name: 'Dev', command: 'sleep 30', noCheck: true });
  assert.equal(r.text, 'Dev');
  assert.equal((await run('recruit', { name: 'Shell' })).text, 'Shell');
});

test('a default box applies to teammates but not to the Maestro or a shell, and --no-sandbox opts out', async (t) => {
  const { core, run } = await daemon(t);
  process.env.OPENMAESTRI_DEFAULT_SANDBOX = 'alpine:3';
  assert.equal(core.defaultSandbox(), 'alpine:3');
  assert.match((await run('sandbox', {})).text, /Default for new teammates: a box \(alpine:3\)/);
  // without docker the default cannot be honoured, and the message says how to get past it
  const path0 = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    await assert.rejects(run('recruit', { name: 'Dev', command: 'sleep 30', noCheck: true }), /default is to run teammates in a box \(alpine:3\), but "docker" was not found.*--no-sandbox/);
    const free = await run('recruit', { name: 'Free', command: 'sleep 30', noCheck: true, noSandbox: true });
    assert.match(free.text, /^Free/);
    assert.equal((await run('recruit', { name: 'Shell' })).text, 'Shell', 'a plain shell is not boxed by default');
  } finally { process.env.PATH = path0; }
  await assert.rejects(run('sandbox.set', { image: 'x' }), /unknown command/, 'an agent cannot change the default');
});
