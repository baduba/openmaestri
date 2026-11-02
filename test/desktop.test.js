import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNode, parseUiUrl, isExternalHttp, sameOrigin, startDaemon } from '../desktop/lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('parseUiUrl accepts only a loopback address that carries the token', () => {
  assert.equal(parseUiUrl('openmaestri running\n  UI:     http://127.0.0.1:7777/?token=abc123\n  socket: /x'), 'http://127.0.0.1:7777/?token=abc123');
  assert.equal(parseUiUrl('UI: http://127.0.0.1:9/?token=t'), 'http://127.0.0.1:9/?token=t');
  for (const bad of ['', 'UI: http://evil.example/?token=abc', 'UI: http://127.0.0.1:7777/', 'UI: https://127.0.0.1:7777/?token=a', 'UI: javascript:alert(1)', 'no ui line', 'UI: http://127.0.0.1.evil.com/?token=a']) assert.equal(parseUiUrl(bad), null, bad);
});

test('links: only web pages leave the app, and only the daemon origin stays', () => {
  assert.equal(isExternalHttp('https://example.com/a'), true);
  assert.equal(isExternalHttp('file:///etc/passwd'), false);
  assert.equal(isExternalHttp('javascript:alert(1)'), false);
  assert.equal(isExternalHttp('not a url'), false);
  assert.equal(sameOrigin('http://127.0.0.1:7777/x', 'http://127.0.0.1:7777/?token=a'), true);
  assert.equal(sameOrigin('http://127.0.0.1:7778/', 'http://127.0.0.1:7777/'), false);
  assert.equal(sameOrigin('http://localhost:7777/', 'http://127.0.0.1:7777/'), false);
  assert.equal(sameOrigin('bad', 'http://127.0.0.1:7777/'), false);
});

test('findNode finds a node of version 22 or newer', () => {
  assert.ok(findNode({ ...process.env, OPENMAESTRI_NODE: process.execPath }));
  assert.equal(findNode({ PATH: '/nonexistent', OPENMAESTRI_NODE: '/nonexistent/node' }), null);
});

test('startDaemon starts openmaestri, returns its address, and a second start reports "already running" without owning it', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-desk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, OPENMAESTRI_DATA_DIR: dir, OPENMAESTRI_PORT: String(port), OPENMAESTRI_SOCKET_PATH: path.join(dir, 's.sock'), OPENMAESTRI_NO_WELCOME: '1' };
  const first = await startDaemon({ node: process.execPath, root, env });
  t.after(() => first.child?.kill('SIGTERM'));
  assert.ok(first.child, 'the first start owns the daemon');
  assert.ok(first.url.startsWith(`http://127.0.0.1:${port}/?token=`));
  const res = await fetch(first.url, { redirect: 'manual' });
  assert.equal(res.status, 302, 'the token is accepted and swapped for a cookie');
  assert.equal((await fetch(first.url.split('?')[0], { redirect: 'manual' })).status, 403, 'without the token the page is refused');
  const second = await startDaemon({ node: process.execPath, root, env });
  assert.equal(second.child, null, 'a daemon that was already running is not ours to stop');
  assert.equal(second.url, first.url);
  await assert.rejects(startDaemon({ node: '/nonexistent/node', root, env }), /ENOENT/);
});

test('preferences over the WebSocket: only the listed switches change, and they are audited', { timeout: 60000 }, async (t) => {
  const { main } = await import('../src/server.js');
  const { WebSocket } = await import('ws');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-prefs-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const sock = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=${app.token}`, { headers: { origin: `http://127.0.0.1:${app.port}` } });
  const got = []; sock.on('message', (m) => got.push(JSON.parse(m)));
  await new Promise((r) => sock.on('open', r));
  const ask = async (msg) => { const n = got.length; sock.send(JSON.stringify(msg)); for (const end = Date.now() + 4000; !got.slice(n).some((x) => x.t === 'prefs') && Date.now() < end;) await new Promise((r) => setTimeout(r, 20)); return got.slice(n).find((x) => x.t === 'prefs')?.prefs; };
  const first = await ask({ t: 'prefs.get' });
  assert.match(first.version, /^\d+\.\d+\.\d+$/);
  assert.equal(first.dataDir, path.join(dir, 'data'));
  assert.equal(first.persistTerminals, false);
  const on = await ask({ t: 'prefs.set', persistTerminals: true, evil: 'ignored', dataDir: '/etc' });
  assert.equal(on.persistTerminals, true);
  assert.equal(on.dataDir, path.join(dir, 'data'), 'the data folder cannot be changed from the page');
  assert.equal(app.core.store.settings.persistTerminals, true);
  assert.equal((await ask({ t: 'prefs.set', persistTerminals: 'yes' })).persistTerminals, true, 'a non-boolean is ignored');
  app.core.store.settings.onboarded = true;
  assert.equal((await ask({ t: 'prefs.set', showWelcomeAgain: true })).onboarded, false);
  assert.ok(app.core.audit.read(10).some((e) => e.event === 'prefs.set'));
  sock.close();
});
