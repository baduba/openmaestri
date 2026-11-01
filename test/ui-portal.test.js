/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { main } from '../src/server.js';
import { findChrome } from '../src/portals.js';

process.env.OPENMAESTRI_CHROME_NO_SANDBOX = '1';
const candidates = [process.env.CHROME_BIN, path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')];
try { candidates.push(chromium.executablePath()); } catch {}
const UI_CHROME = candidates.find((p) => p && fs.existsSync(p));
const skip = UI_CHROME && findChrome() ? false : 'no Chrome/Chromium found';

const PAGE = '<!doctype html><title>Portal UI</title><body style="margin:0;background:#fff"><input id="t" style="position:absolute;left:20px;top:20px;width:400px;height:50px;font-size:24px"><button id="b" style="position:absolute;left:20px;top:100px;width:300px;height:60px;font-size:24px" onclick="document.title=\'clicked\'">Press</button></body>';

test('UI: a portal shows the real page, takes mouse and keys, and has a working address bar', { skip, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-uip-'));
  const site = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url === '/two' ? '<title>Two</title><h1>two</h1>' : PAGE); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}/`;
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  const browser = await chromium.launch({ executablePath: UI_CHROME, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); await app.close(); site.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const store = app.core.store;
  const ws = store.workspaces.get(store.settings.activeWorkspaceId);
  const node = store.createNode(ws, 'portal', { name: 'Site', url: base, x: 0, y: 0, w: 700, h: 500 });
  app.core.touch(ws);

  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(app.url);
  await page.waitForSelector('canvas.pv');
  await page.waitForFunction(() => { const n = document.querySelector('.pv-stage .portal-msg'); return n && n.style.display === 'none'; }, null, { timeout: 20000 });
  assert.equal(await page.locator('.node .urlbar input').inputValue(), base);

  const portal = () => app.core.portals.get(node);
  const toClient = (px, py) => page.evaluate(([x, y]) => {
    const c = document.querySelector('canvas.pv');
    const r = c.getBoundingClientRect();
    const k = Math.min(r.width / c.width, r.height / c.height);
    return { x: r.left + (r.width - c.width * k) / 2 + x * k, y: r.top + (r.height - c.height * k) / 2 + y * k };
  }, [px, py]);

  // human typing into a field on the page
  const field = await toClient(100, 45);
  await page.mouse.click(field.x, field.y);
  await page.keyboard.type('hello world');
  // keys travel browser -> daemon -> CDP, so read the field until they have all landed
  const typedBy = Date.now() + 5000;
  while (Date.now() < typedBy && (await portal().evaluate('document.getElementById("t").value')) !== 'hello world') await page.waitForTimeout(50);
  assert.equal(await portal().evaluate('document.getElementById("t").value'), 'hello world');

  // human clicking a button on the page
  const btn = await toClient(100, 130);
  await page.mouse.click(btn.x, btn.y);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (await portal().evaluate('document.title')) !== 'clicked') await page.waitForTimeout(100);
  assert.equal(await portal().evaluate('document.title'), 'clicked');

  // address bar, back button
  await page.fill('.node .urlbar input', `${base}two`);
  await page.press('.node .urlbar input', 'Enter');
  await page.waitForFunction((u) => document.querySelector('.node .urlbar input').value === u, `${base}two`, { timeout: 15000 });
  assert.equal(await portal().evaluate('location.pathname'), '/two');
  await page.click('.node .urlbar button[title="Back"]');
  await page.waitForFunction((u) => document.querySelector('.node .urlbar input').value === u, base, { timeout: 15000 });

  // an agent acting on the same page is visible to the human view (same browser)
  await portal().fill('#t', 'from the agent');
  assert.equal(await portal().evaluate('document.getElementById("t").value'), 'from the agent');

  // closing the tab releases the stream
  await page.close();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(app.core.portals.map.get(node.id).viewers, 0);
  assert.deepEqual(errors, []);
});
