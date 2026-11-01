import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { findChrome, parseKey, checkUrl } from '../src/portals.js';

process.env.OPENMAESTRI_CHROME_NO_SANDBOX = '1';
const chrome = findChrome();
const skip = chrome ? false : 'no Chrome/Chromium found (set OPENMAESTRI_CHROME)';

const PAGE = `<!doctype html><html><head><title>Test page</title></head><body>
<h1>Demo</h1>
<a href="/other">Other page</a>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Hello, ' + document.getElementById('name').value;">
  <label for="name">Name</label><input id="name" type="text">
  <label for="color">Color</label><select id="color"><option>Red</option><option>Green</option><option>Blue</option></select>
  <label><input id="agree" type="checkbox"> I agree</label>
  <button id="go" type="submit">Greet</button>
</form>
<p id="out">nobody yet</p>
<input id="keys" placeholder="keys"><span id="keylog"></span>
<script>
  document.getElementById('keys').addEventListener('keydown', e => { document.getElementById('keylog').textContent += (e.ctrlKey ? 'ctrl+' : '') + (e.shiftKey ? 'shift+' : '') + e.key + ';'; });
  setTimeout(() => { const b = document.createElement('button'); b.id = 'late'; b.textContent = 'Late button'; document.body.append(b); }, 600);
  console.log('hello from the page');
  document.getElementById('go').addEventListener('click', () => console.warn('greeting sent'));
</script>
<input id="file" type="file">
<div style="height:3000px">tall</div><div id="bottom">bottom</div>
</body></html>`;

async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-portal-'));
  const site = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/other' ? '<title>Second</title><h1>Second page</h1>' : PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); site.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const store = app.core.store;
  const ws = store.workspaces.get(store.settings.activeWorkspaceId);
  ws.dir = dir;
  const boss = store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, cwd: dir });
  const call = (cmd, args, id = boss.id) => new Promise((resolve, reject) => {
    const c = net.createConnection(app.socketPath);
    let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify({ id: 1, ctx: { terminalId: id }, cmd, args }) + '\n'));
    c.on('data', (d) => { buf += d; if (buf.includes('\n')) { c.end(); resolve(JSON.parse(buf)); } });
    c.on('error', reject);
  });
  const act = async (op, ...rest) => {
    const r = await call('portal.act', { op, name: 'App', rest });
    return r;
  };
  return { app, ws, dir, site, url, boss, call, act, store };
}

test('parseKey understands names, modifiers and editing shortcuts', () => {
  assert.equal(parseKey('Enter').vk, 13);
  assert.equal(parseKey('shift+tab').modifiers, 8);
  assert.equal(parseKey('ctrl+a').commands[0], 'selectAll');
  assert.equal(parseKey('cmd+c').commands[0], 'copy');
  assert.equal(parseKey('a').text, 'a');
  assert.throws(() => parseKey('Bogus'), /unknown key/);
  assert.equal(checkUrl('example.com'), 'http://example.com/');
  assert.throws(() => checkUrl('file:///etc/passwd'), /only http and https/);
  assert.throws(() => checkUrl('chrome://settings'), /only http and https/);
  assert.throws(() => checkUrl('javascript:alert(1)'), /only http and https/);
});

test('an agent can read and drive a real page through a portal', { skip, timeout: 120000 }, async (t) => {
  const { url, call, act, dir } = await boot(t);
  const created = await call('portal.create', { url: 'about:blank', name: 'App' });
  assert.equal(created.ok, true, created.error);

  const nav = await act('navigate', url);
  assert.equal(nav.ok, true, nav.error);
  assert.match(nav.text, /Test page/);

  const snap = (await act('snapshot')).text;
  assert.match(snap, /heading "Demo"/);
  const ref = (re) => { const m = re.exec(snap); assert.ok(m, `no match for ${re}\n${snap}`); return `@${m[1]}`; };
  const nameRef = ref(/@(e\d+) textbox "Name"/);
  const goRef = ref(/@(e\d+) button "Greet"/);
  const colorRef = ref(/@(e\d+) combobox "Color"/);
  const agreeRef = ref(/@(e\d+) checkbox "I agree"/);
  const linkRef = ref(/@(e\d+) link "Other page"/);

  // fill and click change the page
  assert.equal((await act('fill', nameRef, 'Ada')).ok, true);
  assert.equal((await act('click', goRef)).ok, true);
  assert.equal((await act('text', '#out')).text, 'Hello, Ada');

  // select and checkbox state
  assert.match((await act('select', colorRef, 'Blue')).text, /Blue/);
  assert.equal((await act('evaluate', 'document.getElementById("color").value')).text, 'Blue');
  const bad = await act('select', colorRef, 'Purple');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Options: Red \| Green \| Blue/);
  await act('check', agreeRef);
  assert.equal((await act('evaluate', 'document.getElementById("agree").checked')).text, 'true');
  await act('check', agreeRef);
  assert.equal((await act('evaluate', 'document.getElementById("agree").checked')).text, 'true', 'checking twice stays checked');
  await act('uncheck', agreeRef);
  assert.equal((await act('evaluate', 'document.getElementById("agree").checked')).text, 'false');

  // keys: plain, modified, and focus movement
  await act('click', '#keys');
  await act('key', 'Enter');
  await act('key', 'shift+a');
  await act('key', 'ctrl+b');
  const log = (await act('text', '#keylog')).text;
  assert.match(log, /Enter;/);
  assert.match(log, /shift\+A;|shift\+a;/);
  assert.match(log, /ctrl\+b;/);
  await act('focus', '#name');
  await act('key', 'shift+Tab');
  assert.notEqual((await act('evaluate', 'document.activeElement.id')).text, 'name');
  await act('type', 'zzz');

  // late element, and a timeout that reports clearly
  assert.equal((await act('wait', '#late', '5000')).ok, true);
  const timeout = await act('wait', '#never', '600');
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /timed out waiting/);

  // evaluate returns JSON and surfaces page errors
  assert.equal((await act('evaluate', '({a: 1, b: [2, 3]})')).text, '{"a":1,"b":[2,3]}');
  const boom = await act('evaluate', 'nope.nope');
  assert.equal(boom.ok, false);
  assert.match(boom.error, /ReferenceError/);

  // console capture
  assert.equal((await act('logs-start')).ok, true);
  await act('reload');
  await act('click', '#go');
  const logs = (await act('logs')).text;
  assert.match(logs, /hello from the page/);
  assert.match(logs, /warning|warn.*greeting sent/);

  // scrolling reaches the bottom
  await act('scroll', 'down', '5000');
  assert.ok(Number((await act('evaluate', 'Math.round(scrollY)')).text) > 1000);

  // screenshots are real PNGs inside the data dir
  const shot = (await act('screenshot')).text;
  assert.ok(shot.startsWith(path.join(dir, 'data', 'portals')));
  assert.equal(fs.readFileSync(shot).subarray(1, 4).toString(), 'PNG');
  assert.equal((await act('check')).text.startsWith('screenshot: '), true, 'check with no target peeks');

  // viewport and user agent
  assert.match((await act('resize', '390', '844')).text, /390x844/);
  assert.equal((await act('evaluate', 'innerWidth')).text, '390');
  await act('ua', 'iphone-nope').then((r) => assert.equal(r.ok, false));
  assert.equal((await act('ua', 'ios')).ok, true);
  assert.match((await act('evaluate', 'navigator.userAgent')).text, /iPhone/);

  // history
  await act('resize', '1000', '700');
  await act('navigate', `${url}other`);
  assert.match((await act('html')).text, /Second page/);
  assert.equal((await act('back')).text, url);
  assert.equal((await act('forward')).text, `${url}other`);

  // refs go stale on navigation and the error says what to do
  const snap2 = (await act('snapshot')).text;
  const h = /@(e\d+) heading/.exec(snap2)[1];
  await act('navigate', url);
  const stale = await act('click', `@${h}`);
  assert.equal(stale.ok, false);
  assert.match(stale.error, /Run `portal snapshot`/);
  assert.equal((await act('click', linkRef)).ok, false, 'refs from an older snapshot are rejected');
});

test('portals only open web pages and only upload files from the workspace', { skip, timeout: 90000 }, async (t) => {
  const { url, call, act, dir } = await boot(t);
  await call('portal.create', { url: 'about:blank', name: 'App' });
  await act('navigate', url);
  for (const bad of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'view-source:http://x']) {
    const r = await act('navigate', bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.error, /only http and https/);
  }
  // a page that tries to navigate itself to file: is blocked by the browser
  await act('evaluate', 'location.href = "file:///etc/passwd"');
  await new Promise((r) => setTimeout(r, 800));
  assert.match((await act('evaluate', 'location.href')).text, /^http:\/\/127\.0\.0\.1/);

  const inside = path.join(dir, 'doc.txt');
  fs.writeFileSync(inside, 'hello');
  assert.equal((await act('upload', '#file', inside)).ok, true);
  assert.equal((await act('evaluate', 'document.getElementById("file").files[0].name')).text, 'doc.txt');
  const outside = path.join(os.tmpdir(), `om-outside-${process.pid}.txt`);
  fs.writeFileSync(outside, 'secret');
  t.after(() => fs.rmSync(outside, { force: true }));
  const refused = await act('upload', '#file', outside);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /outside the workspace/);
  const traversal = await act('upload', '#file', `${dir}/../${path.basename(outside)}`);
  assert.equal(traversal.ok, false);
});

test('agents only reach portals connected to them, and deleting the node closes the browser', { skip, timeout: 90000 }, async (t) => {
  const { app, ws, call, act, store, url } = await boot(t);
  await call('portal.create', { url: 'about:blank', name: 'App' });
  await act('navigate', url);
  const portalNode = ws.nodes.find((n) => n.kind === 'portal');
  const stranger = store.createNode(ws, 'terminal', { name: 'Stranger' });
  const denied = await call('portal.act', { op: 'snapshot', name: 'App' }, stranger.id);
  assert.equal(denied.ok, false);
  assert.match(denied.error, /no portal named "App" is connected/);
  const runtime = app.core.portals.map.get(portalNode.id);
  const child = runtime.child;
  assert.equal(child.exitCode, null, 'the browser is running');
  store.deleteNode(ws, portalNode.id);
  app.core.touch(ws);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(app.core.portals.map.has(portalNode.id), false);
  assert.notEqual(child.exitCode === null && child.signalCode === null, true, 'the browser process was ended');
});

test('without a browser, portal commands explain what to install', async (t) => {
  const { app, call, act } = await boot(t);
  app.core.portals.chrome = null;
  await call('portal.create', { url: 'about:blank', name: 'App' });
  const r = await act('snapshot');
  assert.equal(r.ok, false);
  assert.match(r.error, /no Chrome or Chromium found/);
});
