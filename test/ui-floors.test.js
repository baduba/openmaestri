/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { main } from '../src/server.js';

const candidates = [process.env.CHROME_BIN, path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')];
try { candidates.push(chromium.executablePath()); } catch {}
const CHROME = candidates.find((p) => p && fs.existsSync(p));
const skip = CHROME ? false : 'no Chromium found (set CHROME_BIN or run: npx playwright-core install chromium)';
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

test('UI: floors have their own canvas, switch from the bar, and report errors', { skip, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-uif-'));
  const repo = path.join(dir, 'proj');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-qm', 'init');
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const store = app.core.store;
  const ws = store.workspaces.get(store.settings.activeWorkspaceId);
  ws.dir = repo;
  store.createNode(ws, 'note', { name: 'On ground', text: 'g' });
  app.core.touch(ws);

  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());
  await page.goto(app.url);
  await page.waitForSelector('.floor-tab.on');
  assert.equal(await page.locator('.node').count(), 1);

  // create a floor from the dialog
  await page.click('.floor-tab.add');
  await page.fill('#dlg-floor input[name=name]', 'Feature X');
  await page.click('#form-floor button.primary');
  await page.waitForSelector('.floor-tab:has-text("Feature X")');
  await page.waitForFunction(() => document.querySelector('.floor-tab.on')?.textContent.includes('Feature X'));
  assert.equal(await page.locator('.node').count(), 0, 'a new floor starts with an empty canvas');
  assert.equal(ws.floors.length, 1);
  assert.ok(fs.existsSync(ws.floors[0].dir));

  // a note made here belongs to this floor only
  await page.click('#add-note');
  await page.waitForSelector('.node .note-text');
  assert.equal(await page.locator('.node').count(), 1);
  const made = ws.nodes.find((n) => n.floorId === ws.floors[0].id);
  assert.ok(made, 'the node is stored on the floor');
  await page.click('.floor-tab:has-text("Ground")');
  await page.waitForFunction(() => document.querySelectorAll('.node').length === 1 && document.querySelector('.node .title')?.textContent === 'On ground');

  // palette can jump to a node on another floor
  await page.keyboard.press('Control+k');
  await page.fill('#pal-input', 'go to floor feature');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.floor-tab.on')?.textContent.includes('Feature X'));

  // floor status shows up in the toolbar
  app.core.emit('workspace', ws.id);
  ws.floors[0].status = { text: 'tests running', state: 'working', progress: '1/3', by: 'Dev', at: new Date().toISOString() };
  app.core.touch(ws);
  await page.waitForFunction(() => document.querySelector('#floor-status.on')?.textContent.includes('tests running'));

  // creating a duplicate surfaces the server's error as a toast
  await page.click('.floor-tab.add');
  await page.fill('#dlg-floor input[name=name]', 'feature x');
  await page.click('#form-floor button.primary');
  await page.waitForSelector('.toast.err');
  assert.match(await page.locator('.toast.err').first().textContent(), /already exists/);

  // delete through the palette removes the floor and its checkout
  const dirOfFloor = ws.floors[0].dir;
  await page.keyboard.press('Control+k');
  await page.fill('#pal-input', 'delete floor');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.floor-tab:not(.add)').length === 1);
  assert.equal(ws.floors.length, 0);
  assert.equal(fs.existsSync(dirOfFloor), false);
  assert.equal(await page.locator('.floor-tab.on').textContent(), 'Ground');
  assert.deepEqual(errors.filter((e) => !/already exists|409|Failed to load resource/.test(e)), []);
});
