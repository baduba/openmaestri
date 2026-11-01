/* global document */
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

test('UI: save a prompt from the chat box, reuse it, delete and undo, and see edits made on disk', { skip, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-uilib-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  let answers = ['Daily review'];
  page.on('dialog', (d) => { if (d.type() === 'prompt') d.accept(answers.shift() ?? 'x'); else d.dismiss(); });
  await page.goto(app.url);
  await page.waitForSelector('#chat-btn');
  await page.click('#chat-btn');
  await page.click('#chat-lib');
  await page.waitForSelector('#chat-lib-list .lib-empty');

  await page.fill('#chat-input', 'Summarise today for <b>everyone</b>');
  await page.click('#chat-lib-save');
  await page.waitForSelector('#chat-lib-list .lib-item');
  assert.equal(await page.locator('.lib-item b').first().textContent(), 'Daily review');
  assert.equal(await page.locator('.lib-scope').first().textContent(), 'workspace');
  assert.equal(await page.locator('.lib-prev').first().textContent(), 'Summarise today for <b>everyone</b>');
  assert.equal(await page.locator('#chat-lib-list b b').count(), 0, 'markup in a prompt is shown as text');
  assert.equal(core.prompts.get(ws.id, 'Daily review').text, 'Summarise today for <b>everyone</b>');

  // using it puts the text in the box
  await page.fill('#chat-input', '');
  await page.locator('.lib-main').first().click();
  await page.waitForFunction(() => document.querySelector('#chat-input').value.startsWith('Summarise today'));

  // delete, then undo
  await page.locator('.lib-del').first().click();
  await page.waitForSelector('#chat-undo:not([hidden])');
  await page.waitForSelector('#chat-lib-list .lib-empty');
  await page.click('#chat-undo-btn');
  await page.waitForSelector('#chat-lib-list .lib-item');
  assert.equal(core.prompts.get(ws.id, 'Daily review').text, 'Summarise today for <b>everyone</b>');

  // a file edited with another program shows up without reloading
  fs.writeFileSync(path.join(core.prompts.dir(ws.id, 'workspace'), 'From editor.md'), 'written elsewhere');
  await page.waitForFunction(() => document.querySelectorAll('#chat-lib-list .lib-item').length === 2, null, { timeout: 8000 });

  // a bad name is refused by the server and reported
  answers = ['../evil'];
  await page.fill('#chat-input', 'x');
  await page.click('#chat-lib-save');
  await page.waitForSelector('.toast.err');
  assert.match(await page.locator('.toast.err').first().textContent(), /prompt name/);
  assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), []);
});
