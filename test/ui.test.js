import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { main } from '../src/server.js';

// CHROME_BIN wins; then a Chromium already in the Playwright cache; then the one playwright-core would install.
const candidates = [process.env.CHROME_BIN, path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')];
try { candidates.push(chromium.executablePath()); } catch {}
const CHROME = candidates.find((p) => p && fs.existsSync(p));
const skip = CHROME ? false : 'no Chromium found (set CHROME_BIN or run: npx playwright-core install chromium)';

test('UI: create terminal + note, run the CLI from the UI terminal, drag, reload keeps state', { skip, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-ui-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(app.url);
  await page.waitForSelector('#conn:not(.off)');
  assert.equal(await page.locator('.node').count(), 0);

  // terminal via dialog, flagged as maestro so it may use maestro-only commands
  await page.click('#add-term');
  await page.fill('#dlg-term input[name=name]', 'Boss');
  await page.check('#dlg-term input[name=maestro]');
  await page.click('#form-term button.primary');
  await page.waitForSelector('.node .xterm');
  await page.click('#add-note');
  await page.waitForSelector('.note-text');
  assert.equal(await page.locator('.node').count(), 2);

  // connect note <-> terminal using the link button
  await page.locator('.node', { hasText: 'Boss' }).locator('button[title^="Connect"]').click();
  await page.locator('.node', { hasText: 'Note' }).locator('.head').click();
  await page.waitForFunction(() => document.querySelectorAll('#links path').length === 1);

  // type in the real terminal: the CLI is on PATH and sees the note
  await page.locator('.node .xterm').click();
  await page.keyboard.type('openmaestri list && echo UI_OK_$((6*7))');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('UI_OK_42'), null, { timeout: 15000 });
  assert.match(await page.locator('.xterm-rows').first().textContent(), /Note/);

  // CLI-driven change shows up live in the UI
  await page.keyboard.type(`openmaestri note write Note 'written by the agent'`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.note-text')?.value === 'written by the agent', null, { timeout: 10000 });

  // typing in the note reaches the file on disk
  await page.locator('.note-text').fill('from the human');
  await page.locator('.note-text').blur();
  await page.waitForTimeout(600);
  const ws = app.core.store.workspaces.get(app.core.store.settings.activeWorkspaceId);
  const note = ws.nodes.find((n) => n.kind === 'note');
  assert.equal(app.core.store.readNote(ws.id, note.id), 'from the human');

  // drag the terminal header
  const before = ws.nodes.find((n) => n.kind === 'terminal');
  const x0 = before.x;
  const box = await page.locator('.node', { hasText: 'Boss' }).locator('.head').boundingBox();
  await page.mouse.move(box.x + 60, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 60, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  assert.ok(ws.nodes.find((n) => n.kind === 'terminal').x > x0 + 50, 'drag persisted on the server');

  // reload: state restored, terminal re-attached with scrollback
  await page.reload();
  await page.waitForSelector('.node .xterm');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('UI_OK_42'), null, { timeout: 10000 });
  assert.equal(await page.locator('.node').count(), 2);
  await page.screenshot({ path: path.join(process.env.OM_SHOT_DIR || os.tmpdir(), 'openmaestri-ui.png') });
  assert.deepEqual(errors, []);
});
