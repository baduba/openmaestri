/* global window */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { main } from '../src/server.js';

const candidates = [process.env.CHROME_BIN, path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')];
try { candidates.push(chromium.executablePath()); } catch {}
const CHROME = candidates.find((p) => p && fs.existsSync(p));
const skip = CHROME ? false : 'no Chromium found (set CHROME_BIN or run: npx playwright-core install chromium)';

test('UI: @mentions popup, keyboard selection, markup-safe names, preview, and what the Maestro gets', { skip, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-uipr-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  fs.writeFileSync(path.join(dir, 'spec.md'), 'THE SPEC BODY');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=1');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'spec-dep.js'), 'x');
  const sink = path.join(dir, 'received.txt');
  const script = path.join(dir, 'maestro.sh');
  fs.writeFileSync(script, `#!/bin/bash\nwhile IFS= read -r line; do printf '%s\\n' "$line" >> '${sink}'; done\n`, { mode: 0o755 });
  const boss = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir, command: script });
  core.store.createNode(ws, 'note', { name: '<img src=x onerror="window.__xss=1">', text: 'weird note' });
  core.startTerminal(ws, boss);
  core.touch(ws);

  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(app.url);
  await page.waitForSelector('#chat-btn');
  await page.waitForTimeout(800);
  await page.click('#chat-btn');
  await page.waitForSelector('#chat:not([hidden])');

  // typing @sp lists the file, not the ignored or secret ones
  await page.click('#chat-input');
  await page.keyboard.type('please read @sp');
  await page.waitForSelector('#chat-mentions:not([hidden]) li');
  const items = await page.locator('#chat-mentions li').allTextContents();
  assert.ok(items.some((x) => x.includes('spec.md')), items.join('|'));
  assert.equal(items.some((x) => x.includes('spec-dep.js') || x.includes('.env')), false);
  await page.keyboard.press('Tab');
  assert.equal(await page.inputValue('#chat-input'), 'please read @file:spec.md ');
  assert.equal(await page.locator('#chat-mentions').isHidden(), true);

  // Escape closes the popup without touching the text
  await page.keyboard.type('and @');
  await page.waitForSelector('#chat-mentions:not([hidden]) li');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#chat-mentions').isHidden(), true);
  await page.keyboard.press('Backspace');

  // a note whose name is markup is shown as text and quoted correctly when inserted
  await page.keyboard.type('@note:<img');
  await page.waitForSelector('#chat-mentions:not([hidden]) li');
  assert.equal(await page.locator('#chat-mentions img').count(), 0);
  assert.ok((await page.locator('#chat-mentions li').first().textContent()).includes('<img src=x'));
  await page.keyboard.press('Enter');
  assert.match(await page.inputValue('#chat-input'), /@note:"<img src=x onerror=\\"window\.__xss=1\\">" $/);
  assert.equal(await page.evaluate(() => window.__xss), undefined);

  // the preview shows exactly what the Maestro will receive, and what was refused
  await page.keyboard.type('and @file:.env');
  await page.click('#chat-preview');
  await page.waitForSelector('#chat-preview-box:not([hidden])');
  const preview = await page.locator('#chat-preview-text').textContent();
  assert.match(preview, /THE SPEC BODY/);
  assert.match(preview, /weird note/);
  assert.match(preview, /looks like a secret/);
  assert.equal(preview.includes('TOKEN=1'), false);
  assert.equal(await page.locator('#chat-preview-text img').count(), 0);
  await page.click('#chat-preview-close');

  // sending delivers the content to the Maestro terminal and keeps the raw text in the thread
  await page.click('#chat-send');
  const deadline = Date.now() + 8000;
  while (!(fs.existsSync(sink) && fs.readFileSync(sink, 'utf8').includes('weird note')) && Date.now() < deadline) await page.waitForTimeout(100);
  const got = fs.readFileSync(sink, 'utf8');
  assert.match(got, /THE SPEC BODY/);
  assert.equal(got.includes('TOKEN=1'), false);
  assert.match(core.chat.history(ws.id, 'thread-1')[0].text, /^please read @file:spec\.md /);
  assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), []);
});
