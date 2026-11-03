import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { main } from '../src/server.js';
import { Store, safeId } from '../src/store.js';

async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-sec-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ws = app.core.store.workspaces.get(app.core.store.settings.activeWorkspaceId);
  return { app, ws, dir };
}

const rpc = (socketPath, ctx, cmd, args = {}) => new Promise((resolve, reject) => {
  const c = net.createConnection(socketPath);
  let buf = '';
  c.setEncoding('utf8');
  c.on('connect', () => c.write(JSON.stringify({ id: 1, ctx, cmd, args }) + '\n'));
  c.on('data', (d) => { buf += d; if (buf.includes('\n')) { c.end(); resolve(JSON.parse(buf)); } });
  c.on('error', reject);
});

test('prototype keys are not commands or node kinds', async (t) => {
  const { app, ws } = await boot(t);
  const me = app.core.store.createNode(ws, 'terminal', { name: 'Me' });
  for (const cmd of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'handlers']) {
    const r = await rpc(app.socketPath, { terminalId: me.id }, cmd);
    assert.equal(r.ok, false, cmd);
    assert.match(r.error, /unknown command/, cmd);
  }
  for (const kind of ['constructor', '__proto__', 'toString']) {
    assert.throws(() => app.core.store.createNode(ws, kind, {}), /unknown node kind/);
  }
});

test('ids are validated before they reach file paths', async (t) => {
  const { app, ws, dir } = await boot(t);
  for (const bad of ['../../etc/passwd', '..', 'a/b', '', 'x'.repeat(40), null, 42]) {
    assert.throws(() => safeId(bad), /invalid id/);
  }
  assert.throws(() => app.core.store.noteFile(ws.id, '../../../../tmp/x'), /invalid id/);
  assert.throws(() => app.core.store.writeNote(ws.id, '../escape', 'x'), /invalid id/);
  // a workspace directory whose workspace.json claims a non-UUID id is ignored on load
  const evil = path.join(dir, 'data', 'workspaces', 'evil');
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(path.join(evil, 'workspace.json'), JSON.stringify({ id: 'evil', name: 'x', dir: '/', nodes: [], connections: [] }));
  const s = new Store(path.join(dir, 'data'));
  s.load();
  assert.ok(![...s.workspaces.keys()].includes('evil'));
});

test('node patches and creates reject wrong types instead of storing them', async (t) => {
  const { app, ws } = await boot(t);
  const n = app.core.store.createNode(ws, 'note', { name: 'N', x: 'oops', y: {}, w: Infinity, color: 5 });
  assert.equal(typeof n.x, 'number');
  assert.equal(typeof n.y, 'number');
  assert.ok(Number.isFinite(n.w) && n.w >= 160);
  assert.equal(n.color, null);
  assert.throws(() => app.core.store.patchNode(ws, n.id, { x: '10' }), /invalid value for x/);
  assert.throws(() => app.core.store.patchNode(ws, n.id, { url: { a: 1 } }), /invalid value for url/);
  assert.throws(() => app.core.store.patchNode(ws, n.id, { maestro: 'yes' }), /invalid value for maestro/);
  app.core.store.patchNode(ws, n.id, { x: 12, name: 'Renamed', unknownField: 'ignored' });
  assert.equal(n.x, 12);
  assert.equal(n.name, 'Renamed');
  assert.equal(Object.hasOwn(n, 'unknownField'), false);
});

test('internal errors do not leak details to the CLI', async (t) => {
  const { app, ws } = await boot(t);
  const me = app.core.store.createNode(ws, 'terminal', { name: 'Me' });
  const boom = new Error('secret path /home/someone/.ssh');
  app.core.handlers.list = () => { throw boom; };
  const quiet = console.error;
  console.error = () => {};
  const r = await rpc(app.socketPath, { terminalId: me.id }, 'list');
  console.error = quiet;
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /secret|\.ssh/);
});

test('notifications are rate limited per terminal', async (t) => {
  const { app, ws } = await boot(t);
  const me = app.core.store.createNode(ws, 'terminal', { name: 'Me' });
  let refused = 0;
  for (let i = 0; i < 25; i++) {
    const r = await rpc(app.socketPath, { terminalId: me.id }, 'notify', { message: `m${i}` });
    if (!r.ok && /rate limit/.test(r.error)) refused++;
  }
  assert.equal(refused, 5);
});

test('HTTP responses carry hardening headers; CSP forbids inline script and framing', async (t) => {
  const { app } = await boot(t);
  const res = await fetch(`${app.url}`, { redirect: 'manual' });
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  // the forbidden page is hardened too
  const denied = await fetch(`http://127.0.0.1:${app.port}/`);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('x-content-type-options'), 'nosniff');
});

test('WebSocket needs the token and a same-origin Origin', async (t) => {
  const { app } = await boot(t);
  const open = (url, headers) => new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_q, r) => resolve(r.statusCode));
    ws.on('error', () => resolve('error'));
  });
  const base = `ws://127.0.0.1:${app.port}/ws`;
  assert.equal(await open(base, {}), 403);
  assert.equal(await open(`${base}?token=wrong`, {}), 403);
  assert.equal(await open(`${base}?token=${app.token}`, { origin: 'http://evil.example' }), 403);
  assert.equal(await open(`${base}?token=${app.token}`, { origin: `http://127.0.0.1:${app.port}` }), 'open');
});

test('static server does not serve files outside web/ or vendor/', async (t) => {
  const { app } = await boot(t);
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/vendor/../../package.json', '/node_modules/ws/package.json', '/__proto__', '/constructor', '/src/server.js']) {
    const r = await fetch(`http://127.0.0.1:${app.port}${p}?token=${app.token}`);
    assert.notEqual(r.status, 200, p);
  }
});

test('the env file with loose permissions is flagged', async (t) => {
  const { readUserEnv } = await import('../src/terminals.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-envperm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'env');
  fs.writeFileSync(f, 'A=1\n', { mode: 0o644 });
  const warns = [];
  const w = console.warn;
  console.warn = (m) => warns.push(m);
  readUserEnv(f);
  console.warn = w;
  assert.ok(warns.some((m) => /chmod 600/.test(m)));
});

// A web page can make the browser send "Origin: null" (a sandboxed frame, a data: page) to 127.0.0.1. That used to
// throw inside the request handler and take the whole daemon down. Found by scripts/dast.mjs.
test('a request the server cannot parse is answered, it does not crash the daemon', async (t) => {
  const { app } = await boot(t);
  const send = (lines) => new Promise((resolve) => {
    const c = net.connect(app.port, '127.0.0.1');
    let out = '';
    c.setTimeout(3000, () => { c.destroy(); resolve(out); });
    c.on('data', (d) => { out += d; });
    c.on('close', () => resolve(out));
    c.on('error', () => resolve(out));
    c.write(`${lines.join('\r\n')}\r\n\r\n`);
  });
  const host = `host: 127.0.0.1:${app.port}`;
  const status = (r) => Number(/^HTTP\/1\.1 (\d+)/.exec(r)?.[1] ?? 0);
  for (const origin of ['null', 'not a url', 'http://', '://x', 'chrome-extension://abc']) {
    assert.equal(status(await send([`GET /?token=${app.token} HTTP/1.1`, host, `origin: ${origin}`, 'connection: close'])), 403, `Origin: ${origin}`);
  }
  assert.equal(status(await send(['GET //[ HTTP/1.1', host, 'connection: close'])), 400, 'a target that is not a URL');
  // the same on the WebSocket upgrade
  const up = await send([`GET /ws?token=${app.token} HTTP/1.1`, host, 'origin: null', 'connection: Upgrade', 'upgrade: websocket', 'sec-websocket-version: 13', 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==']);
  assert.match(up, /^HTTP\/1\.1 403/);
  assert.equal(status(await send([`GET /index.html?token=${app.token} HTTP/1.1`, host, 'connection: close'])), 200, 'and the server is still up');
});

test('WebSocket messages that are not objects are ignored, they do not crash the daemon', async (t) => {
  const { app } = await boot(t);
  const crashes = [];
  const onRejection = (e) => crashes.push(e);
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  const w = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=${app.token}`, { origin: `http://127.0.0.1:${app.port}` });
  await new Promise((resolve, reject) => { w.on('open', resolve); w.on('error', reject); });
  for (const junk of ['null', '123', '"text"', 'true', '[]', '[1,2]', '{}', '{"t":5}']) w.send(junk);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(crashes.map(String), []);
  assert.equal(w.readyState, 1, 'the connection is still open');
  w.close();
});

test('a WebSocket frame over the size limit closes that connection, not the daemon', async (t) => {
  const { app } = await boot(t);
  const crashes = [];
  const onException = (e) => crashes.push(e);
  process.on('uncaughtException', onException);
  t.after(() => process.off('uncaughtException', onException));
  const w = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=${app.token}`, { origin: `http://127.0.0.1:${app.port}` });
  await new Promise((resolve, reject) => { w.on('open', resolve); w.on('error', reject); });
  const closed = new Promise((resolve) => { w.on('close', resolve); w.on('error', () => {}); });
  w.send(Buffer.alloc(9 * 1024 * 1024, 'a'));
  await closed;
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(crashes.map(String), []);
  const again = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=${app.token}`, { origin: `http://127.0.0.1:${app.port}` });
  await new Promise((resolve, reject) => { again.on('open', resolve); again.on('error', reject); });
  again.close();
});
