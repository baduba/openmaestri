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

test('UI: bands, stacks, palette, tidy, undo, export and a held-back imported command', { skip, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-ui2-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const store = core.store;
  const ws = store.workspaces.get(store.settings.activeWorkspaceId);
  ws.dir = dir;
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());

  await page.goto(app.url);
  await page.waitForSelector('#conn:not(.off)');

  // build structure on the server, as an agent would
  const boss = store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, cwd: dir, x: 600, y: 500 });
  const a = store.createNode(ws, 'terminal', { name: 'Alpha', cwd: dir, x: 0, y: 0 });
  const b = store.createNode(ws, 'terminal', { name: 'Beta', cwd: dir, x: 700, y: 0 });
  store.connect(ws, boss.id, a.id);
  store.createBand(ws, 'Crew', [a.id, b.id]);
  const n1 = store.createNode(ws, 'note', { name: 'First', text: 'one' });
  const n2 = store.createNode(ws, 'note', { name: 'Second', text: 'two' });
  const st = store.createNode(ws, 'stack', { name: 'Docs', x: 100, y: 700 });
  store.addToStack(ws, n1.id, st.id);
  store.addToStack(ws, n2.id, st.id);
  core.touch(ws);

  await page.waitForSelector('.band');
  assert.equal(await page.locator('.band .band-label .title').textContent(), 'Crew');
  // stacked notes are not separate nodes on the canvas; the stack shows tabs
  await page.waitForSelector('.tabs .tab');
  assert.equal(await page.locator('.tabs .tab-label').count(), 2);
  assert.equal(await page.locator('.node .note-text').first().inputValue(), 'one');
  await page.locator('.tab-label', { hasText: 'Second' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.node .note-text')].some((t) => t.value === 'two'));
  assert.equal(st.front, n2.id, 'the server remembers the front tab');

  // editing the open tab writes the right note file
  const ta = page.locator('.node', { hasText: 'Docs' }).locator('.note-text');
  await ta.fill('two, edited');
  await ta.blur();
  // the UI saves after a short debounce; on a slow runner that can take longer than a fixed pause
  const savedBy = Date.now() + 8000;
  while (Date.now() < savedBy && store.readNote(ws.id, n2.id) !== 'two, edited') await page.waitForTimeout(100);
  assert.equal(store.readNote(ws.id, n2.id), 'two, edited');
  assert.equal(store.readNote(ws.id, n1.id), 'one');

  // a CLI-style change shows up live in the stack
  store.writeNote(ws.id, n2.id, 'changed elsewhere');
  app.core.emit('workspace', ws.id);
  await page.waitForFunction(() => [...document.querySelectorAll('.node .note-text')].some((t) => t.value === 'changed elsewhere'));

  // tidy via the command palette (Ctrl+K), then it is undoable
  const before = JSON.stringify(ws.nodes.map((n) => [n.x, n.y]));
  await page.keyboard.press('Control+k');
  await page.waitForSelector('#palette[open]');
  await page.fill('#pal-input', 'tidy');
  await page.keyboard.press('Enter');
  await page.waitForFunction((b) => JSON.stringify(window.__om.state.ws.nodes.map((n) => [n.x, n.y])) !== b, before);
  assert.notEqual(JSON.stringify(ws.nodes.map((n) => [n.x, n.y])), before);
  await page.waitForFunction(() => !document.querySelector('#undo').disabled);
  const tidied = JSON.stringify(ws.nodes.map((n) => [n.x, n.y]));
  await page.click('#undo');
  await page.waitForFunction((x) => JSON.stringify(window.__om.state.ws.nodes.map((n) => [n.x, n.y])) !== x, tidied);
  await page.waitForFunction(() => !document.querySelector('#redo').disabled);

  // palette navigation: go to a node
  await page.keyboard.press('Control+k');
  await page.fill('#pal-input', 'go to boss');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.node.sel .title')?.textContent === 'Boss');

  // export downloads a bundle
  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+k').then(() => page.fill('#pal-input', 'export this')).then(() => page.keyboard.press('Enter'))]);
  const exportPath = path.join(dir, 'export.json');
  await dl.saveAs(exportPath);
  const bundle = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  assert.equal(bundle.format, 'openmaestri-workspace');
  assert.equal(bundle.nodes.filter((n) => n.kind === 'terminal').length, 3);
  assert.ok(bundle.nodes.some((n) => n.kind === 'band'));

  // import a file whose terminal carries a command: it must NOT run until trusted
  const marker = path.join(dir, 'imported-ran');
  bundle.nodes.find((n) => n.name === 'Boss').command = `touch ${marker}`;
  const importPath = path.join(dir, 'hostile.json');
  fs.writeFileSync(importPath, JSON.stringify(bundle));
  await page.setInputFiles('#import-file', importPath);
  await page.waitForFunction(() => document.querySelector('#ws-list').children.length === 2);
  await page.waitForSelector('.node .exited.on');
  const overlay = await page.locator('.node .exited.on').first().textContent();
  assert.match(overlay, /NOT run/);
  await page.waitForTimeout(1500);
  assert.equal(fs.existsSync(marker), false, 'held-back command did not run');
  await page.locator('.node .exited.on button', { hasText: 'Trust' }).click();
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await page.waitForTimeout(100);
  assert.equal(fs.existsSync(marker), true, 'after trusting, the command runs');

  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(process.env.OM_SHOT_DIR || os.tmpdir(), 'openmaestri-ui2.png') });
});
