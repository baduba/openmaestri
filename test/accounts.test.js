import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { Accounts, AccountError, checkVar } from '../src/accounts.js';
import { Secrets } from '../src/secrets.js';
import { exportPartitura, importPartitura } from '../src/transfer.js';

const CLI = path.resolve('bin/openmaestri.js');
const mk = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-acc-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('checkVar: keys must be secret references, program-changing names are refused', () => {
  checkVar('ANTHROPIC_API_KEY', 'secret://work');
  checkVar('ANTHROPIC_BASE_URL', 'https://example.com');
  checkVar('OPENAI_ORG', 'org-123');
  for (const [k, v, re] of [
    ['ANTHROPIC_API_KEY', 'sk-ant-literal', /must be a secret reference/],
    ['MY_TOKEN', 'abc', /must be a secret reference/],
    ['ANTHROPIC_API_KEY', 'secret://BAD NAME', /not a valid secret reference/],
    ['PATH', '/evil', /changes how programs start/],
    ['LD_PRELOAD', '/evil.so', /changes how programs start/],
    ['NODE_OPTIONS', '--require /x', /changes how programs start/],
    ['OPENMAESTRI_SOCKET', '/x', /changes how programs start/],
    ['GIT_SSH_COMMAND', 'x', /changes how programs start/],
    ['lower', 'x', /not a valid variable name/],
    ['A', 'two\nlines', /one line/],
    ['A', '', /one line/],
  ]) assert.throws(() => checkVar(k, v), re, `${k}=${v}`);
});

test('Accounts: set, merge, list names only, remove, resolve secrets, private file', (t) => {
  const dir = mk(t);
  const secrets = new Secrets({ root: dir, env: { OPENMAESTRI_SECRETS_BACKEND: 'file' } });
  secrets.set('work-key', 'sk-work-1');
  const a = new Accounts(path.join(dir, 'accounts.json'));
  a.set('work', { ANTHROPIC_API_KEY: 'secret://work-key', ANTHROPIC_BASE_URL: 'https://proxy.example' });
  a.set('work', { OPENAI_ORG: 'org-9' });
  a.set('home', { ANTHROPIC_API_KEY: 'secret://missing' });
  assert.deepEqual(a.list(), [{ name: 'home', vars: ['ANTHROPIC_API_KEY'] }, { name: 'work', vars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_ORG'] }]);
  assert.equal(fs.statSync(path.join(dir, 'accounts.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(a.list()), /sk-work/);
  assert.deepEqual(a.env('work', (r) => secrets.resolve(r)), { ANTHROPIC_API_KEY: 'sk-work-1', ANTHROPIC_BASE_URL: 'https://proxy.example', OPENAI_ORG: 'org-9' });
  const warn = console.warn; console.warn = () => {};
  try { assert.deepEqual(a.env('home', (r) => secrets.resolve(r)), {}, 'a dangling reference is left out'); } finally { console.warn = warn; }
  assert.throws(() => a.env('nope'), /no account named "nope"/);
  assert.deepEqual(a.env(null), {});
  assert.equal(a.has('work'), true);
  assert.equal(a.has('constructor'), false);
  assert.equal(a.unset('work', ['OPENAI_ORG']), true);
  assert.equal(a.remove('home'), true);
  assert.equal(a.remove('home'), false);
  assert.throws(() => a.set('Bad Name', { A: 'x' }), AccountError);
  assert.throws(() => a.set('x', {}), /usage/);
  fs.writeFileSync(path.join(dir, 'accounts.json'), '{broken');
  assert.throws(() => a.list(), /cannot be read/);
  assert.equal(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'), '{broken', 'a damaged file is not overwritten');
});

async function boot(t) {
  const dir = mk(t);
  const env = { OPENMAESTRI_SECRETS_BACKEND: 'file' };
  Object.assign(process.env, env);
  t.after(() => { delete process.env.OPENMAESTRI_SECRETS_BACKEND; });
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  const boss = core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, command: '' });
  const cmd = (name, args) => core.command({ terminalId: boss.id }, name, args);
  return { dir, app, core, ws, boss, cmd };
}

test('a recruited agent runs with its account, a preset can carry a default account, and unknown accounts are refused', async (t) => {
  const { core, ws, cmd } = await boot(t);
  const secrets = new Secrets({ root: path.join(core.dataRoot), env: { OPENMAESTRI_SECRETS_BACKEND: 'file' } });
  secrets.set('work-key', 'sk-work-777');
  core.accounts.set('work', { DEMO_API_KEY: 'secret://work-key', DEMO_BASE_URL: 'https://proxy.example' });
  await assert.rejects(cmd('recruit', { name: 'X', command: 'true', account: 'ghost', noCheck: true }), /no account named "ghost"/);
  await cmd('recruit', { name: 'Dev', command: 'echo KEY=$DEMO_API_KEY URL=$DEMO_BASE_URL', account: 'work', noCheck: true });
  const dev = ws.nodes.find((n) => n.name === 'Dev');
  assert.equal(dev.account, 'work');
  for (const end = Date.now() + 8000; !core.terminals.text(dev.id).includes('KEY=sk-work-777') && Date.now() < end;) await sleep(100);
  assert.match(core.terminals.text(dev.id), /KEY=sk-work-777 URL=https:\/\/proxy\.example/);
  // a preset with an account gives it to the agents recruited from it
  await cmd('preset.create', { name: 'Echoer', command: 'echo ACC=$DEMO_BASE_URL', account: 'work' });
  await cmd('recruit', { name: 'Dev2', preset: 'Echoer', noCheck: true });
  const dev2 = ws.nodes.find((n) => n.name === 'Dev2');
  assert.equal(dev2.account, 'work');
  for (const end = Date.now() + 8000; !core.terminals.text(dev2.id).includes('ACC=https://proxy.example') && Date.now() < end;) await sleep(100);
  assert.match(core.terminals.text(dev2.id), /ACC=https:\/\/proxy\.example/);
  await assert.rejects(cmd('preset.set', { name: 'Echoer', account: 'ghost' }), /no account named/);
  await cmd('preset.set', { name: 'Echoer', account: '' });
  assert.equal(core.store.settings.presets.find((p) => p.name === 'Echoer').account, undefined);
  // the keys of other accounts and the secret itself never reach a terminal without the account
  await cmd('recruit', { name: 'Plain', command: 'echo PLAIN=[$DEMO_API_KEY]', noCheck: true });
  const plain = ws.nodes.find((n) => n.name === 'Plain');
  for (const end = Date.now() + 8000; !core.terminals.text(plain.id).includes('PLAIN=[') && Date.now() < end;) await sleep(100);
  assert.match(core.terminals.text(plain.id), /PLAIN=\[\]/);
});

test('one-shot agents take --account, and it overrides the driver key list', async (t) => {
  const { core, ws, cmd } = await boot(t);
  const secrets = new Secrets({ root: core.dataRoot, env: { OPENMAESTRI_SECRETS_BACKEND: 'file' } });
  secrets.set('k', 'sk-acc-1');
  core.accounts.set('acc', { OTHER_API_KEY: 'secret://k', OTHER_REGION: 'eu' });
  const toolDir = mk(t); // outside the workspace folder, or the planted-program rule refuses it
  const tool = path.join(toolDir, 'tool'); fs.writeFileSync(tool, '#!/usr/bin/env bash\necho "key=${OTHER_API_KEY:-none} region=${OTHER_REGION:-none}"\n', { mode: 0o755 });
  core.store.settings.drivers = { mine: { bin: tool, keys: ['SOMETHING_ELSE'], args: ['{prompt}'] } };
  const withAcc = await cmd('agent.run', { driver: 'mine', prompt: 'x', account: 'acc' });
  assert.match(withAcc.text, /key=sk-acc-1 region=eu/);
  const without = await cmd('agent.run', { driver: 'mine', prompt: 'x' });
  assert.match(without.text, /key=none region=none/);
  await assert.rejects(cmd('agent.run', { driver: 'mine', prompt: 'x', account: 'ghost' }), /no account named/);
  const run = await cmd('run', { task: 'go', agents: 'mine', account: 'acc' });
  assert.match(run.text, /key=sk-acc-1 region=eu/);
  await assert.rejects(cmd('run', { task: 'go', agents: 'mine', account: 'ghost' }), /no account named/);
  const log = fs.readFileSync(path.join(core.dataRoot, 'audit.log'), 'utf8');
  assert.match(log, /"account":"acc"/);
  assert.doesNotMatch(log, /sk-acc-1/);
  void ws;
});

test('CLI: accounts set/list/rm in your own shell, never inside a terminal, never printing values', (t) => {
  const dir = mk(t);
  const env = { ...process.env, OPENMAESTRI_DATA_DIR: dir, OPENMAESTRI_SECRETS_BACKEND: 'file' }; delete env.OPENMAESTRI_SOCKET;
  const cli = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  assert.equal(cli(['accounts', 'set', 'work', 'ANTHROPIC_API_KEY=secret://k1', 'REGION=eu']).status, 0);
  const bad = cli(['accounts', 'set', 'work', 'ANTHROPIC_API_KEY=sk-literal']);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /must be a secret reference/);
  assert.equal(cli(['accounts', 'set', 'work', 'PATH=/x']).status, 1);
  assert.equal(cli(['accounts', 'set', 'work', 'noequals']).status, 1);
  const list = cli(['accounts', 'list']);
  assert.match(list.stdout, /work {2}ANTHROPIC_API_KEY REGION/);
  assert.doesNotMatch(list.stdout, /eu|k1/);
  assert.equal(cli(['accounts', 'rm', 'work', 'REGION']).status, 0);
  assert.match(cli(['accounts', 'list']).stdout, /work {2}ANTHROPIC_API_KEY$/m);
  assert.equal(cli(['accounts', 'bogus']).status, 2);
  const inside = cli(['accounts', 'list'], { OPENMAESTRI_SOCKET: '/x.sock', OPENMAESTRI_TERMINAL_ID: 'x' });
  assert.equal(inside.status, 2);
  assert.match(inside.stderr, /not inside an agent terminal/);
  assert.equal(cli(['accounts', 'rm', 'work']).status, 0);
  assert.equal(cli(['accounts', 'list']).stdout, '');
  assert.match(fs.readFileSync(path.join(dir, 'audit.log'), 'utf8'), /account\.set/);
});

const layout = () => ({
  format: 'openmaestri-partitura', version: 1, name: 'Duo', description: 'two agents', icon: null, color: null,
  nodes: [
    { key: 'n0', kind: 'terminal', name: 'A', x: 0, y: 0, w: 300, h: 200, color: null, icon: null, command: 'touch /tmp/should-not-run-yet', maestro: false, role: null, preset: null, cwdRel: null },
    { key: 'n1', kind: 'note', name: 'N', x: 320, y: 0, w: 300, h: 200, color: null, icon: null, text: 'hello', stackKey: null },
  ],
  connections: [{ from: 'n0', to: 'n1' }],
});

test('partitura files: closed format, exported without ids, imported with commands held back', async (t) => {
  assert.throws(() => importPartitura({ ...layout(), format: 'x' }), /not an openmaestri partitura/);
  assert.throws(() => importPartitura({ ...layout(), version: 2 }), /unsupported partitura version/);
  assert.throws(() => importPartitura({ ...layout(), hook: 'x' }), /unknown top-level field: hook/);
  const evil = layout(); evil.nodes[0].shell = 'curl x | sh';
  assert.throws(() => importPartitura(evil), /does not define: shell/);
  assert.throws(() => importPartitura({ ...layout(), nodes: [] }), /non-empty list/);
  assert.throws(() => importPartitura({ ...layout(), name: '   ' }), /needs a name/);
  const part = importPartitura(layout(), { name: 'Renamed' });
  assert.equal(part.name, 'Renamed');
  assert.equal(part.nodes[0].untrustedCommand, true);
  assert.deepEqual(exportPartitura(part).nodes, layout().nodes, 'exporting again leaves the format clean');

  const { dir, core, ws, boss, cmd } = await boot(t);
  const file = path.join(dir, 'layout.json');
  fs.writeFileSync(file, JSON.stringify(layout()));
  const imported = await cmd('partitura.import', { file: layout() });
  assert.match(imported.text, /imported Duo: 2 items.*will not run until you trust/);
  await assert.rejects(cmd('partitura.import', { file: layout() }), /already exists/);
  const before = ws.nodes.length;
  await cmd('partitura.insert', { name: 'Duo' });
  assert.equal(ws.nodes.length, before + 2);
  const term = ws.nodes.find((n) => n.name === 'A');
  assert.equal(term.untrusted, true, 'the imported command is held back');
  assert.equal(fs.existsSync('/tmp/should-not-run-yet'), false);
  const out = await cmd('partitura.export', { name: 'Duo' });
  const exported = JSON.parse(out.text);
  assert.equal(exported.format, 'openmaestri-partitura');
  assert.ok(!JSON.stringify(exported).includes('"id"'), 'no ids leave the machine');
  assert.deepEqual(importPartitura(exported, { name: 'Again' }).nodes.length, 2, 'what we export we accept');
  assert.ok(core.audit.read(10).some((e) => e.event === 'partitura.import' && e.detail.commandsHeldBack === 1));
  void boss;
});
