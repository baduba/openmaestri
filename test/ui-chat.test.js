/* global document, window */
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

test('UI: chat with the Maestro, seven threads, progress, attention, search, and no script injection', { skip, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-uichat-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  const script = path.join(dir, 'maestro.sh');
  fs.writeFileSync(script, '#!/bin/bash\nwhile IFS= read -r line; do\n  case "$line" in *"openmaestri chat"*) openmaestri say --progress "on it"; sleep 0.4; openmaestri say "echo: ${line:0:80}";; esac\ndone\n', { mode: 0o755 });
  const boss = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir, command: script });
  core.startTerminal(ws, boss);
  core.touch(ws);

  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept('Planning'));
  await page.goto(app.url);
  await page.waitForSelector('#chat-btn');
  await page.waitForTimeout(1000);

  await page.click('#chat-btn');
  await page.waitForSelector('#chat:not([hidden])');
  assert.equal(await page.locator('#chat-tabs .ctab').count(), 7);
  assert.match(await page.locator('.chat-empty').textContent(), /Nothing here yet/);

  // a message with markup must show as text and never run
  const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script> hello';
  await page.fill('#chat-input', payload);
  await page.press('#chat-input', 'Enter');
  await page.waitForSelector('.msg.human');
  assert.equal(await page.locator('.msg.human .msg-b').first().textContent(), payload);
  assert.equal(await page.locator('#chat-list img, #chat-list script').count(), 0, 'markup is text, not DOM');

  // progress line, then the real answer replaces it
  await page.waitForSelector('.msg.agent:not(.progress)', { timeout: 15000 });
  assert.match(await page.locator('.msg.agent:not(.progress) .msg-b').first().textContent(), /^echo: \[openmaestri chat, Thread 1\]/);
  assert.equal(await page.locator('.msg.progress').count(), 0, 'the progress line went away');
  assert.equal(await page.evaluate(() => window.__xss), undefined);

  // the Maestro needs the human: badge on the toolbar and on its node
  await page.click('#chat-close');
  await page.waitForSelector('.node.attn', { timeout: 8000 });
  assert.equal(await page.locator('#chat-badge').isVisible(), true);
  await page.locator('.node.attn .head').click();
  await page.waitForFunction(() => !document.querySelector('.node.attn'));

  // threads are separate
  await page.click('#chat-btn');
  await page.locator('#chat-tabs .ctab').nth(2).click();
  await page.waitForSelector('.chat-empty');
  assert.equal(await page.locator('.msg').count(), 0);
  await page.fill('#chat-input', 'second thread topic');
  await page.press('#chat-input', 'Enter');
  await page.waitForSelector('.msg.agent:not(.progress)', { timeout: 15000 });
  await page.locator('#chat-tabs .ctab').nth(0).click();
  await page.waitForFunction(() => document.querySelectorAll('.msg').length >= 2);
  assert.equal(core.chat.history(ws.id, 'thread-3').length >= 2, true);

  // search finds text in another thread and jumps to it
  await page.fill('#chat-search', 'second thread');
  await page.waitForSelector('.hit');
  await page.locator('.hit').first().click();
  await page.waitForFunction(() => document.querySelector('#chat-tabs .ctab.on .ctab-n')?.textContent === '3');

  // rename a thread
  await page.locator('#chat-tabs .ctab').nth(4).dblclick();
  await page.waitForFunction(() => document.querySelector('#chat-tabs .ctab:nth-child(5)')?.title.startsWith('Planning'));

  assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), []);
  await page.screenshot({ path: path.join(process.env.OM_SHOT_DIR || os.tmpdir(), 'openmaestri-chat.png') });
});
