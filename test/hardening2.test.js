import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { checkUrl, isLinkLocal, findChrome } from '../src/portals.js';
import { firstWord, commandAvailable, TerminalError } from '../src/terminals.js';
import { runDoctor, formatDoctor } from '../src/doctor.js';

process.env.OPENMAESTRI_CHROME_NO_SANDBOX = '1';
const chrome = findChrome();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });

async function boot(t, { repo = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-h2-'));
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  if (repo) { sh(proj, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(proj, 'a.txt'), 'x'); sh(proj, 'add', '.'); sh(proj, 'commit', '-qm', 'init'); }
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ws = app.core.store.workspaces.get(app.core.store.settings.activeWorkspaceId);
  ws.dir = proj;
  const boss = app.core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, cwd: proj });
  const rpc = (cmd, args = {}, id = boss.id) => new Promise((resolve, reject) => {
    const c = net.createConnection(app.socketPath);
    let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify({ id: 1, ctx: { terminalId: id }, cmd, args }) + '\n'));
    c.on('data', (d) => { buf += d; if (buf.includes('\n')) { c.end(); resolve(JSON.parse(buf)); } });
    c.on('error', reject);
  });
  return { app, ws, dir, proj, boss, rpc, core: app.core, store: app.core.store };
}

test('URL policy: cloud metadata and the control port are refused, ordinary localhost is not', () => {
  for (const bad of ['http://169.254.169.254/latest/meta-data/', 'http://169.254.1.1', 'https://169.254.169.254', 'http://metadata.google.internal/computeMetadata/v1/', 'http://[fd00:ec2::254]/', 'http://100.100.100.200/', 'http://168.63.129.16/', 'http://2852039166/']) {
    assert.throws(() => checkUrl(bad), /blocked|only http/, bad);
  }
  assert.equal(checkUrl('localhost:3000'), 'http://localhost:3000/');
  assert.equal(checkUrl('127.0.0.1:8080/app'), 'http://127.0.0.1:8080/app');
  for (const ok of ['http://localhost:3000', 'http://127.0.0.1:8080/app', 'https://example.com', 'about:blank', 'example.com/path']) assert.doesNotThrow(() => checkUrl(ok), ok);
  for (const own of ['http://localhost:7777/', 'http://127.0.0.1:7777/?token=x', 'http://[::1]:7777/', 'http://0.0.0.0:7777']) assert.throws(() => checkUrl(own, { selfPorts: [7777] }), /openmaestri itself/, own);
  assert.doesNotThrow(() => checkUrl('http://localhost:7778', { selfPorts: [7777] }));
  assert.equal(isLinkLocal('169.254.9.9'), true);
  assert.equal(isLinkLocal('169.253.9.9'), false);
  assert.equal(isLinkLocal('example.com'), false);
});

test('a portal cannot be pointed at openmaestri itself or at a metadata service', { skip: chrome ? false : 'no Chrome', timeout: 90000 }, async (t) => {
  const { core, ws, rpc, app } = await boot(t);
  const created = await rpc('portal.create', { url: 'about:blank', name: 'App' });
  assert.equal(created.ok, true, created.error);
  const own = await rpc('portal.act', { op: 'navigate', name: 'App', rest: [`http://127.0.0.1:${app.port}/`] });
  assert.equal(own.ok, false);
  assert.match(own.error, /openmaestri itself/);
  assert.equal((await rpc('portal.create', { url: `http://localhost:${app.port}`, name: 'Self' })).ok, false);
  assert.equal((await rpc('portal.create', { url: 'http://169.254.169.254/', name: 'Meta' })).ok, false);
  assert.equal((await rpc('portal.edit', { name: 'App', url: 'http://169.254.169.254/' })).ok, false);

  // a page that tries to reach them by itself is stopped inside the browser
  const site = http.createServer((_q, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>t</title>ok'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  t.after(() => site.close());
  assert.equal((await rpc('portal.act', { op: 'navigate', name: 'App', rest: [`http://127.0.0.1:${site.address().port}/`] })).ok, true);
  const probe = async (u) => (await rpc('portal.act', { op: 'evaluate', name: 'App', rest: [`fetch(${JSON.stringify(u)}, {mode: 'no-cors'}).then(() => 'reached', (e) => 'blocked:' + e.name)`] })).text;
  const started = Date.now();
  assert.equal(await probe('http://169.254.169.254/latest/meta-data/'), 'blocked:TypeError');
  assert.equal(await probe(`http://127.0.0.1:${app.port}/`), 'blocked:TypeError');
  assert.ok(Date.now() - started < 5000, 'refused at once, not after a network timeout');
  assert.equal(await probe(`http://127.0.0.1:${site.address().port}/`), 'reached', 'other localhost ports still work');
  void core; void ws;
});

test('git hooks do not run during floor operations unless opted in', async (t) => {
  const { proj, rpc, ws } = await boot(t, { repo: true });
  const marker = path.join(proj, 'hook-ran');
  const hook = path.join(proj, '.git', 'hooks', 'post-checkout');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  assert.equal((await rpc('floor.create', { name: 'Quiet' })).ok, true);
  await sleep(300);
  assert.equal(fs.existsSync(marker), false, 'the repository hook did not run');
  process.env.OPENMAESTRI_GIT_HOOKS = '1';
  try { assert.equal((await rpc('floor.create', { name: 'Loud' })).ok, true); } finally { delete process.env.OPENMAESTRI_GIT_HOOKS; }
  await sleep(300);
  assert.equal(fs.existsSync(marker), true, 'the opt-in runs them');
  void ws;
});

test('there is a ceiling on running terminals, and the error says how to raise it', async (t) => {
  const { core, ws, store, rpc } = await boot(t);
  process.env.OPENMAESTRI_MAX_TERMINALS = '2';
  t.after(() => { delete process.env.OPENMAESTRI_MAX_TERMINALS; });
  const a = store.createNode(ws, 'terminal', { name: 'A', cwd: ws.dir });
  const b = store.createNode(ws, 'terminal', { name: 'B', cwd: ws.dir });
  const c = store.createNode(ws, 'terminal', { name: 'C', cwd: ws.dir });
  core.startTerminal(ws, a);
  core.startTerminal(ws, b);
  assert.throws(() => core.startTerminal(ws, c), (e) => e instanceof TerminalError && /limit is 2/.test(e.message) && /OPENMAESTRI_MAX_TERMINALS/.test(e.message));
  const viaCli = await rpc('recruit', { name: 'D', noCheck: true });
  assert.equal(viaCli.ok, false);
  assert.match(viaCli.error, /terminals are already running/);
  core.terminals.dispose(a.id);
  assert.doesNotThrow(() => core.startTerminal(ws, c));
});

test('exports and workspace files never contain the UI token or an API key', async (t) => {
  const { app, core, store, ws, dir } = await boot(t);
  const secret = 'sk-live-1234567890abcdefghijkl';
  fs.writeFileSync(path.join(dir, 'data', 'env'), `DEEPSEEK_API_KEY=${secret}\n`, { mode: 0o600 });
  const node = store.createNode(ws, 'terminal', { name: 'W', cwd: ws.dir, preset: 'OpenCode (DeepSeek)', command: 'echo hi' });
  core.usage.report(node.id, { input: 5, output: 5, model: 'deepseek-flash' });
  core.chat.append(ws.id, 'thread-1', { role: 'human', sender: 'You', text: 'hello' });
  store.flush();
  core.usage.save();
  const res = await fetch(`http://127.0.0.1:${app.port}/export/${ws.id}.json?token=${app.token}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body.includes(app.token), false, 'the UI token is not in an export');
  assert.equal(body.includes(secret), false, 'no API key is in an export');
  for (const f of [store.wsFile(ws.id), path.join(dir, 'data', 'usage.json'), path.join(dir, 'data', 'settings.json')]) {
    const text = fs.readFileSync(f, 'utf8');
    assert.equal(text.includes(app.token), false, f);
    assert.equal(text.includes(secret), false, f);
  }
});

test('firstWord and commandAvailable', () => {
  assert.equal(firstWord('opencode -m "deepseek/x"'), 'opencode');
  assert.equal(firstWord("OPENMAESTRI_DEEPSEEK_MODEL='x' aider --model y"), 'aider');
  assert.equal(firstWord('A=1 B=2 /usr/bin/env node'), '/usr/bin/env');
  assert.equal(firstWord(''), '');
  assert.deepEqual(commandAvailable(''), { ok: true, word: '' });
  assert.equal(commandAvailable('definitely-not-a-real-program-xyz').ok, false);
  assert.equal(commandAvailable('ls').ok, true);
  assert.equal(commandAvailable('/bin/sh -c x').ok, true);
  assert.equal(commandAvailable('/nonexistent/prog').ok, false);
});

test('recruit checks the agent exists, can pick a DeepSeek model, and refuses odd input', async (t) => {
  const { ws, store, rpc } = await boot(t);
  store.settings.presets.push({ name: 'Ghost', command: 'ghost-agent-xyz --go', maestro: false });
  store.settings.presets.push({ name: 'Fake DeepSeek', command: 'sleep 30 # deepseek ${OPENMAESTRI_DEEPSEEK_MODEL:-deepseek-flash}', maestro: false });
  const missing = await rpc('recruit', { name: 'G', preset: 'Ghost' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /"ghost-agent-xyz" was not found in your shell/);
  assert.equal(ws.nodes.some((n) => n.name === 'G'), false);
  assert.equal((await rpc('recruit', { name: 'G', preset: 'Ghost', noCheck: true })).ok, true, '--no-check goes ahead');
  const m = await rpc('recruit', { name: 'M', preset: 'Fake DeepSeek', model: 'deepseek-v4-pro' });
  assert.equal(m.ok, true, m.error);
  const node = ws.nodes.find((n) => n.name === 'M');
  assert.match(node.command, /^OPENMAESTRI_DEEPSEEK_MODEL='deepseek-v4-pro' sleep 30/);
  assert.equal(node.usageModel, 'deepseek-v4-pro');
  for (const bad of ["x'; touch pwned; '", '../etc', '/abs', 'a b', '']) {
    const r = await rpc('recruit', { name: `B${bad.length}`, preset: 'Fake DeepSeek', model: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  const noModel = await rpc('recruit', { name: 'NM', preset: 'Shell', model: 'deepseek-flash' });
  assert.match(noModel.error, /no model setting/);
});

test('doctor reports what is set without ever printing a key', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-doctor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = 'sk-very-secret-value-0123456789';
  fs.writeFileSync(path.join(dir, 'env'), `DEEPSEEK_API_KEY=${key}\nOPENMAESTRI_DEEPSEEK_MODEL=deepseek-v4-pro\n`, { mode: 0o644 });
  fs.chmodSync(dir, 0o755);
  const rows = await runDoctor({ env: { ...process.env, DEEPSEEK_API_KEY: '' }, root: dir, socketPath: path.join(dir, 'nope.sock') });
  const text = formatDoctor(rows);
  assert.equal(text.includes(key), false);
  assert.equal(JSON.stringify(rows).includes(key), false);
  const by = (n) => rows.find((r) => r.name === n);
  assert.equal(by('DeepSeek API key').level, 'ok');
  assert.equal(by('Keys file permissions').level, 'warn');
  assert.match(by('Keys file permissions').fix, /chmod 600/);
  assert.equal(by('Data folder').level, 'warn');
  assert.equal(by('openmaestri daemon').level, 'warn');
  assert.equal(by('DeepSeek model').detail, 'deepseek-v4-pro');
  assert.equal(by('Node.js').level, 'ok');
  assert.match(text, /fix: chmod 600/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'om-doctor2-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const none = await runDoctor({ env: { PATH: process.env.PATH }, root: empty, socketPath: path.join(empty, 'x.sock') });
  assert.equal(none.find((r) => r.name === 'DeepSeek API key').level, 'warn');
  assert.match(formatDoctor(none), /DEEPSEEK_API_KEY=\.\.\./);
});
