/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { main } from '../src/server.js';
import { agentChoices, checkFolder, writeInstructions } from '../src/welcome.js';

// the rest of the suite turns the welcome off; these tests are about it
delete process.env.OPENMAESTRI_NO_WELCOME;

const candidates = [process.env.CHROME_BIN, path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')];
try { candidates.push(chromium.executablePath()); } catch {}
const CHROME = candidates.find((p) => p && fs.existsSync(p));
const skip = CHROME ? false : 'no Chromium found (set CHROME_BIN or run: npx playwright-core install chromium)';
const mk = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-wel-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('agentChoices: real agents only, installed first, no duplicates', () => {
  const presets = [
    { name: 'Shell', command: '', maestro: false },
    { name: 'A', command: 'alpha --x', maestro: false },
    { name: 'B', command: 'beta', maestro: false },
    { name: 'A again', command: 'alpha --x', maestro: false },
    { name: 'Boss', command: 'alpha', maestro: true },
  ];
  const out = agentChoices(presets, (c) => c.startsWith('beta'));
  assert.deepEqual(out.map((a) => [a.name, a.installed]), [['B', true], ['A', false]]);
});

test('checkFolder: absolute, existing, a folder, not the root', (t) => {
  const dir = mk(t);
  assert.equal(checkFolder(dir), fs.realpathSync(dir));
  for (const bad of ['', 'relative/dir', '/definitely/not/here', '/', path.join(dir, 'a\0b'), null]) assert.throws(() => checkFolder(bad), /full path|does not exist|root/, String(bad));
  fs.writeFileSync(path.join(dir, 'f'), 'x');
  assert.throws(() => checkFolder(path.join(dir, 'f')), /not a folder/);
});

test('writeInstructions: right file per agent, never overwrites', (t) => {
  const dir = mk(t);
  assert.deepEqual(writeInstructions(dir, 'claude', 'Claude'), { file: 'CLAUDE.md', created: true });
  assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /openmaestri guide/);
  assert.deepEqual(writeInstructions(dir, 'claude', 'Claude'), { file: 'CLAUDE.md', created: false });
  assert.equal(writeInstructions(dir, 'opencode -m x', 'OpenCode').file, 'AGENTS.md');
  fs.writeFileSync(path.join(dir, 'GEMINI.md'), 'mine');
  assert.equal(writeInstructions(dir, 'gemini', 'Gemini').created, false);
  assert.equal(fs.readFileSync(path.join(dir, 'GEMINI.md'), 'utf8'), 'mine');
  assert.equal(writeInstructions(dir, 'weird-tool', 'Weird').file, 'AGENTS.md');
});

async function boot(t, { presets } = {}) {
  const dir = mk(t);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  if (presets) { app.core.store.settings.presets = presets; app.core.store.saveSettings(); }
  return { dir, app };
}

test('UI: first run shows the welcome, Start makes a Maestro in the chosen folder, and it does not come back', { skip, timeout: 90000 }, async (t) => {
  const bin = mk(t);
  const agent = path.join(bin, 'fakeagent'); fs.writeFileSync(agent, '#!/usr/bin/env bash\necho FAKE-AGENT-UP; sleep 30\n', { mode: 0o755 });
  const { dir, app } = await boot(t, { presets: [
    { name: 'Shell', command: '', maestro: false },
    { name: 'Fake agent', command: agent, maestro: false },
    { name: 'Ghost agent', command: '/no/such/agent-binary', maestro: false },
  ] });
  const proj = path.join(dir, 'my-project'); fs.mkdirSync(proj);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(app.url);
  await page.waitForSelector('dialog#dlg-welcome[open]');
  const labels = await page.locator('.welcome-agent').allTextContents();
  assert.match(labels[0], /Fake agent installed/, 'the installed agent comes first and is preselected');
  assert.match(labels[1], /Ghost agent not installed/);
  assert.equal(await page.locator('.welcome-agent input').first().isChecked(), true);
  await page.fill('dialog#dlg-welcome input[name=dir]', proj);
  await page.check('dialog#dlg-welcome input[name=instructions]');
  await page.click('dialog#dlg-welcome button.primary');
  await page.waitForSelector('.node .xterm');
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('FAKE-AGENT-UP'), null, { timeout: 15000 });
  const ws = app.core.store.workspaces.get(app.core.store.settings.activeWorkspaceId);
  assert.equal(ws.dir, fs.realpathSync(proj));
  assert.equal(ws.name, 'my-project');
  assert.equal(ws.nodes.length, 1);
  assert.equal(ws.nodes[0].maestro, true);
  assert.equal(ws.nodes[0].cwd, fs.realpathSync(proj));
  assert.ok(fs.existsSync(path.join(proj, 'AGENTS.md')));
  assert.equal(app.core.store.settings.onboarded, true);
  assert.ok(app.core.audit.read(5).some((e) => e.event === 'welcome.start'));
  await page.reload();
  await page.waitForSelector('.node .xterm');
  await page.waitForTimeout(600);
  assert.equal(await page.locator('dialog#dlg-welcome[open]').count(), 0, 'no welcome on the next visit');
  assert.deepEqual(errors, []);
});

test('UI: Skip never asks again; a bad folder is refused and nothing is created', { skip, timeout: 90000 }, async (t) => {
  const { app } = await boot(t, { presets: [{ name: 'Shell', command: '', maestro: false }, { name: 'Fake', command: '/bin/sh', maestro: false }] });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
  await page.goto(app.url);
  await page.waitForSelector('dialog#dlg-welcome[open]');
  await page.fill('dialog#dlg-welcome input[name=dir]', '/definitely/not/here');
  await page.click('dialog#dlg-welcome button.primary');
  await page.waitForSelector('#toasts .toast, .toast', { timeout: 5000 });
  const ws = app.core.store.workspaces.get(app.core.store.settings.activeWorkspaceId);
  assert.equal(ws.nodes.length, 0);
  assert.notEqual(app.core.store.settings.onboarded, true);
  await page.reload();
  await page.waitForSelector('dialog#dlg-welcome[open]');
  await page.click('dialog#dlg-welcome button:has-text("Skip")');
  await page.waitForFunction(() => !document.querySelector('dialog#dlg-welcome[open]'));
  await page.reload();
  await page.waitForSelector('#conn:not(.off)');
  await page.waitForTimeout(600);
  assert.equal(await page.locator('dialog#dlg-welcome[open]').count(), 0);
  assert.equal(app.core.store.settings.onboarded, true);
});

test('UI: a workspace that already has nodes never shows the welcome', { skip, timeout: 60000 }, async (t) => {
  const { app } = await boot(t);
  const ws = app.core.store.workspaces.get(app.core.store.settings.activeWorkspaceId);
  app.core.store.createNode(ws, 'note', { name: 'Existing' });
  app.core.touch(ws);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
  await page.goto(app.url);
  await page.waitForSelector('.node');
  await page.waitForTimeout(600);
  assert.equal(await page.locator('dialog#dlg-welcome').count(), 0);
});
