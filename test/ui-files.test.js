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

test('UI: Files node browses, edits, saves with Ctrl+S, previews markdown safely', { skip, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-ui-files-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'docs', 'guide.md'), '# Title\n\nHello **bold** <img src=x onerror="window.__xss=1"> [ok](https://example.com) [bad](javascript:alert(1))\n\n- one\n- two\n');
  fs.writeFileSync(path.join(proj, 'hello.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'TOP SECRET');
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(proj, 'leak.txt'));
  const ws = app.core.store.workspaces.get(app.core.store.settings.activeWorkspaceId);
  ws.dir = proj;

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(app.url);
  await page.waitForSelector('#conn:not(.off)');
  await page.click('#add-files');
  await page.waitForSelector('.ftree .fname');
  const names = await page.locator('.ftree .fname').allTextContents();
  assert.deepEqual(names.map((n) => n.trim()), ['▸ docs', 'hello.txt'], 'a link that leaves the folder is not listed');

  await page.locator('.fname', { hasText: 'hello.txt' }).click();
  await page.waitForFunction(() => document.querySelector('.feditor')?.value === 'hello');
  assert.equal(await page.locator('.fdirty').textContent(), '');
  await page.fill('.feditor', 'hello world');
  assert.equal(await page.locator('.fdirty').textContent(), '●');
  await page.locator('.feditor').press('Control+s');
  await page.waitForFunction(() => document.querySelector('.fdirty')?.textContent === '');
  assert.equal(fs.readFileSync(path.join(proj, 'hello.txt'), 'utf8'), 'hello world');
  await page.waitForFunction(() => document.querySelectorAll('.fbar select option').length === 2, null, { timeout: 5000 });

  await page.locator('.fname', { hasText: 'docs' }).click();
  await page.locator('.fname', { hasText: 'guide.md' }).click();
  await page.waitForFunction(() => document.querySelector('.feditor')?.value.startsWith('# Title'));
  await page.locator('.fbar button', { hasText: 'Preview' }).click();
  await page.waitForSelector('.fpreview h1');
  assert.equal(await page.locator('.fpreview h1').textContent(), 'Title');
  assert.equal(await page.locator('.fpreview strong').textContent(), 'bold');
  assert.equal(await page.locator('.fpreview img').count(), 0, 'raw HTML in markdown is text, not markup');
  assert.equal(await page.locator('.fpreview a').count(), 1, 'only http(s) links become links');
  assert.equal(await page.locator('.fpreview a').getAttribute('href'), 'https://example.com/');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('.fpreview li').count(), 2);
  assert.deepEqual(errors, []);
});
