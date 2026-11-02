/* global document, DataTransfer, DragEvent */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { WebSocket } from 'ws';
import { main } from '../src/server.js';

const candidates = [process.env.CHROME_BIN, path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')];
try { candidates.push(chromium.executablePath()); } catch {}
const CHROME = candidates.find((p) => p && fs.existsSync(p));
const skip = CHROME ? false : 'no Chromium found (set CHROME_BIN or run: npx playwright-core install chromium)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-up-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

async function boot(t) {
  const dir = mk(t);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  const script = path.join(dir, 'maestro.sh');
  // the fake Maestro answers every chat line with the attachment note it received
  fs.writeFileSync(script, '#!/bin/bash\nwhile IFS= read -r line; do\n  case "$line" in *"openmaestri chat"*) id=$(echo "$line" | sed -n \'s/.*recall attachment \\(att_[0-9a-f]*\\).*/\\1/p\'); openmaestri say "got:[${line:0:30}] att=$id"; if [ -n "$id" ]; then openmaestri say "content:$(head -c 40 $(openmaestri recall attachment $id))"; fi;; esac\ndone\n', { mode: 0o755 });
  const boss = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir, command: script });
  core.startTerminal(ws, boss);
  core.touch(ws);
  return { dir, app, core, ws };
}

test('chat.upload over the WebSocket: stored, shown in the thread, announced to the Maestro, refused when unsafe', async (t) => {
  const { app, core, ws } = await boot(t);
  const sock = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=${app.token}`, { headers: { origin: `http://127.0.0.1:${app.port}` } });
  const got = []; sock.on('message', (m) => got.push(JSON.parse(m)));
  await new Promise((r) => sock.on('open', r));
  const upload = (name, buf, text = '') => sock.send(JSON.stringify({ t: 'chat.upload', workspaceId: ws.id, name, data: buf.toString('base64'), text }));
  upload('notes.txt', Buffer.from('dropped file body'), 'please read this');
  const thread = core.chat.active(ws.id);
  const hist = () => JSON.stringify(core.chat.history(ws.id, thread));
  for (const end = Date.now() + 8000; !hist().includes('content:dropped') && Date.now() < end;) await sleep(100);
  const history = hist();
  assert.match(history, /"sender":"You"/);
  assert.match(history, /"name":"notes.txt"/);
  assert.match(history, /att=att_[0-9a-f]+/, 'the Maestro was told the attachment id');
  assert.match(history, /content:dropped file body/, 'and could read it back');
  assert.ok(core.audit.read(5).some((e) => e.event === 'chat.upload' && e.detail.name === 'notes.txt'));
  // refusals
  const before = got.length;
  upload('.env', Buffer.from('A=1'));
  upload('id_rsa', Buffer.from('x'));
  upload('key.txt', Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nabc'));
  upload('empty.txt', Buffer.alloc(0));
  upload('../../escape.txt', Buffer.from('path tricks'));
  for (const end = Date.now() + 5000; got.filter((m) => m.t === 'error').length < 4 && Date.now() < end;) await sleep(50);
  const errs = got.slice(before).filter((m) => m.t === 'error').map((m) => m.message).join('\n');
  assert.match(errs, /looks like it holds secrets/);
  assert.match(errs, /private key/);
  assert.match(errs, /empty/);
  const names = Object.values(core.chat.readVault(ws.id)).map((r) => r.name);
  assert.ok(names.includes('notes.txt') && names.includes('escape.txt'), `names: ${names}`);
  assert.ok(!names.some((n) => n.includes('..') || n.includes('/')), 'a name never carries a path');
  sock.close();
});

test('UI: dropping a file on the chat sends it', { skip, timeout: 90000 }, async (t) => {
  const { app, core, ws } = await boot(t);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(app.url);
  await page.click('#chat-btn');
  await page.waitForSelector('#chat:not([hidden])');
  await page.fill('#chat-input', 'see attached');
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['hello from a drop'], 'dropped.md', { type: 'text/markdown' }));
    const chat = document.querySelector('#chat');
    chat.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    chat.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('#chat a.att', { timeout: 8000 });
  assert.match(await page.locator('#chat a.att').first().textContent(), /dropped\.md/);
  assert.match(await page.locator('#chat .msg.human .msg-b').first().textContent(), /see attached/);
  await page.waitForFunction(() => document.body.textContent.includes('content:hello from a drop'), null, { timeout: 10000 });
  assert.equal(await page.inputValue('#chat-input'), '', 'the caption moved into the message');
  assert.deepEqual(errors, []);
  void core; void ws;
});
