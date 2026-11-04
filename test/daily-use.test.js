/* global document, DataTransfer, DragEvent */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { main } from '../src/server.js';
import { tree, summarize, stopProcess, ProcError } from '../src/procinfo.js';
import { rasterExt, isRasterImage } from '../src/images.js';
import { tokenize, languageOf } from '../web/highlight.js';
import { Files } from '../src/files.js';

const candidates = [process.env.CHROME_BIN, path.join(os.homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')];
try { candidates.push(chromium.executablePath()); } catch {}
const CHROME = candidates.find((p) => p && fs.existsSync(p));
const skip = CHROME ? false : 'no Chromium found';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-day-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

async function boot(t) {
  const dir = mk(t);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  const proj = path.join(dir, 'proj'); fs.mkdirSync(proj);
  ws.dir = proj;
  const boss = core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, command: '' });
  const worker = core.store.createNode(ws, 'terminal', { name: 'Worker', maestro: false, command: '' });
  const cmd = (me, name, args = {}) => core.command({ terminalId: me.id }, name, args);
  return { dir, proj, app, core, ws, boss, worker, cmd };
}

test('procinfo: the tree of a process, summaries, and stop only below the root', async () => {
  const child = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30; true'], { stdio: 'ignore' });
  await sleep(300);
  const procs = tree(child.pid);
  assert.ok(procs.length >= 2, `found ${procs.length}`);
  assert.equal(procs[0].pid, child.pid);
  const sum = summarize(procs);
  assert.ok(sum.processes >= 2 && sum.rssMb >= 0);
  assert.deepEqual(tree(1), [], 'init is never a terminal root');
  assert.deepEqual(tree(NaN), []);
  assert.throws(() => stopProcess(child.pid, child.pid), /the terminal itself/);
  assert.throws(() => stopProcess(child.pid, process.pid), /not running under this terminal/);
  assert.throws(() => stopProcess(child.pid, 1), ProcError);
  const victim = procs.find((p) => p.pid !== child.pid && p.comm === 'sleep');
  stopProcess(child.pid, victim.pid);
  await sleep(300);
  assert.ok(!tree(child.pid).some((p) => p.pid === victim.pid), 'the process below the terminal was stopped');
  child.kill('SIGKILL');
});

test('ps command: lists reachable terminals and stops a process inside one', async (t) => {
  const { core, ws, boss, worker, cmd } = await boot(t);
  await cmd(boss, 'recruit', { name: 'Busy', command: 'sleep 60', noCheck: true });
  const busy = ws.nodes.find((n) => n.name === 'Busy');
  for (const end = Date.now() + 8000; !core.terminals.pidOf(busy.id) && Date.now() < end;) await sleep(100);
  // the shell starts the program a moment later; on a loaded machine that moment is long, so wait for it to show up
  // while the shell starts, its own rows also contain the text "sleep 60"; the program itself is the row whose whole command is `sleep 60`
  const SLEEP_ROW = /^\s+(\d+)\s+\d+ MB\s+sleep 60\s*$/m;
  let out = await cmd(boss, 'ps', { all: true });
  for (const end = Date.now() + 10000; !SLEEP_ROW.test(out.text) && Date.now() < end;) { await sleep(200); out = await cmd(boss, 'ps', { all: true }); }
  assert.match(out.text, /Busy\s+\d+\s+\d+ proc\s+\d+ MB/);
  assert.match(out.text, /sleep 60/);
  await assert.rejects(cmd(worker, 'ps', {}), /only available to Maestro/);
  await assert.rejects(cmd(boss, 'ps', { stop: 'Busy', pid: String(process.pid) }), /not running under this terminal/);
  // a process can end between the listing and the stop (a loaded machine), so list again and retry
  let stopped = null;
  for (let i = 0; i < 3 && !stopped; i++) {
    const row = SLEEP_ROW.exec((await cmd(boss, 'ps', { all: true })).text);
    if (!row) break;
    try { stopped = await cmd(boss, 'ps', { stop: 'Busy', pid: row[1] }); } catch (e) { if (!/ESRCH/.test(e.message)) throw e; }
  }
  assert.match(stopped.text, /sent SIGTERM/);
  assert.ok(core.audit.read(5).some((e) => e.event === 'ps.stop'));
});

test('workspaces: icon and group, unload keeps data and stops processes', async (t) => {
  const { core, ws, boss, cmd } = await boot(t);
  await cmd(boss, 'recruit', { name: 'Runner', command: 'sleep 60', noCheck: true });
  const runner = ws.nodes.find((n) => n.name === 'Runner');
  for (const end = Date.now() + 8000; !core.terminals.has(runner.id) && Date.now() < end;) await sleep(100);
  const other = core.store.createWorkspace({ name: 'Other', dir: os.tmpdir() });
  const set = await cmd(boss, 'workspace.set', { name: 'Other', icon: '🚀', group: 'Clients' });
  assert.match(set.text, /icon 🚀, group Clients/);
  const row = core.summary().workspaces.find((w) => w.name === 'Other');
  assert.deepEqual([row.icon, row.group], ['🚀', 'Clients']);
  await assert.rejects(cmd(boss, 'workspace.set', { name: 'Other', icon: 'x'.repeat(20) }), /at most 8/);
  await assert.rejects(cmd(boss, 'workspace.set', { name: 'Other', group: 'a\u0007b' }), /control characters/);
  await assert.rejects(cmd(boss, 'workspace.set', { name: 'Nope', icon: 'x' }), /no workspace named/);
  assert.equal((await cmd(boss, 'workspace.set', { name: 'Other', icon: '' })).text.includes('icon (none)'), true);
  // unload another workspace that has a running terminal
  const t2 = core.store.createNode(other, 'terminal', { name: 'T2', command: 'sleep 60' });
  core.startTerminal(other, t2);
  assert.equal(core.summary().workspaces.find((w) => w.id === other.id).running, 1);
  const out = await cmd(boss, 'workspace.unload', { name: 'Other' });
  assert.match(out.text, /stopped 1 terminal; everything is kept/);
  assert.equal(core.terminals.has(t2.id), false);
  assert.ok(other.nodes.some((n) => n.id === t2.id), 'the node is still there');
  await assert.rejects(cmd(boss, 'workspace.unload', { name: ws.name }), /cannot unload itself/);
});

test('raster images are recognised by content, never by name', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
  assert.equal(rasterExt(png), 'png');
  assert.equal(rasterExt(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])), 'jpg');
  assert.equal(rasterExt(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)])), 'gif');
  assert.equal(rasterExt(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])), 'webp');
  assert.equal(isRasterImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), false);
  assert.equal(isRasterImage(Buffer.alloc(3)), false);
  assert.equal(isRasterImage('not a buffer'), false);
});

test('note.fromfile: a project file becomes a note; secrets, outside paths and missing files are refused', async (t) => {
  const { dir, proj, ws, core, boss, cmd } = await boot(t);
  fs.writeFileSync(path.join(proj, 'README.md'), '# Title\nbody');
  fs.writeFileSync(path.join(proj, '.env'), 'A=1');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'x');
  const out = await cmd(boss, 'note.fromfile', { path: 'README.md' });
  assert.equal(out.text, 'README.md');
  const note = ws.nodes.find((n) => n.kind === 'note' && n.name === 'README.md');
  assert.equal(core.store.readNote(ws.id, note.id), '# Title\nbody');
  await assert.rejects(cmd(boss, 'note.fromfile', { path: '.env' }), /looks like a secret/);
  await assert.rejects(cmd(boss, 'note.fromfile', { path: '../outside.txt' }), /not found inside the workspace/);
  await assert.rejects(cmd(boss, 'note.fromfile', { path: 'nope.md' }), /cannot make a note/);
});

test('chat: export a thread as Markdown with credentials masked, and a summary written by an agent you choose', async (t) => {
  const { dir, app, core, ws, boss, cmd } = await boot(t);
  const tid = core.chat.active(ws.id);
  // built at run time so no scanner mistakes a test value for a real credential
  const fakeToken = `${'abcd'}${'1234'}${'efgh'}${'5678'}`;
  const fakeKey = `sk-${'abcdefghij'}${'klmnopqrstuvwx'}`;
  core.chat.append(ws.id, tid, { role: 'human', sender: 'You', text: `use token=${fakeToken} for the build` });
  core.chat.append(ws.id, tid, { role: 'agent', sender: 'Maestro', text: `ok, key ${fakeKey} is in the file` });
  const res = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${app.port}/chat-export/${ws.id}/${tid}.md`, { headers: { cookie: `om_token=${app.token}`, host: `127.0.0.1:${app.port}` } }, (r) => {
      let body = ''; r.on('data', (c) => { body += c; }); r.on('end', () => resolve({ status: r.statusCode, body, type: r.headers['content-type'] }));
    });
  });
  assert.equal(res.status, 200, res.body);
  assert.match(res.type, /text\/markdown/);
  assert.match(res.body, /\*\*You\*\*/);
  assert.ok(!res.body.includes(fakeToken) && !res.body.includes(fakeKey));
  const noToken = await new Promise((resolve) => { http.get(`http://127.0.0.1:${app.port}/chat-export/${ws.id}/${tid}.md`, (r) => { r.resume(); resolve(r.statusCode); }); });
  assert.notEqual(noToken, 200, 'the export needs the token like everything else');
  // summary by a (fake) agent
  const toolDir = mk(t);
  const tool = path.join(toolDir, 'sum'); fs.writeFileSync(tool, `#!/usr/bin/env bash\ncat >/dev/null\necho "- decided to build; key ${fakeKey} leaked by the model"\n`, { mode: 0o755 });
  core.store.settings.drivers = { sum: { bin: tool, args: ['{prompt}'] } };
  const out = await cmd(boss, 'chat.summarize', { driver: 'sum' });
  assert.match(out.text, /saved a summary of 2 messages written by sum/);
  const recalled = await cmd(boss, 'recall', { summary: true });
  assert.match(recalled.text, /Summary written by sum on \d{4}-\d\d-\d\d \(2 messages\)/);
  assert.match(recalled.text, /decided to build/);
  assert.ok(!recalled.text.includes(fakeKey), 'a key the model repeated is masked before it is stored');
  await assert.rejects(cmd(boss, 'chat.summarize', {}), /usage: chat summarize/);
  await assert.rejects(cmd(boss, 'chat.summarize', { driver: 'ghost' }), /no driver named "ghost"/);
  void dir;
});

test('Files.search: plain text, case-insensitive, skips hidden and generated folders, links and binaries', (t) => {
  const dir = mk(t);
  const root = path.join(dir, 'proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules/x'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'src/a.js'), 'const Needle = 1;\nother\nneedle again');
  fs.writeFileSync(path.join(root, 'node_modules/x/b.js'), 'needle in a dependency');
  fs.writeFileSync(path.join(root, '.git/config'), 'needle in git');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 110, 101, 101, 100, 108, 101]));
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'needle outside');
  fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(root, 'link.txt'));
  fs.symlinkSync(dir, path.join(root, 'dirlink'));
  const f = new Files({ backupDir: () => path.join(dir, 'b') });
  const r = f.search(root, 'NEEDLE');
  assert.deepEqual(r.results.map((x) => `${x.path}:${x.line}`), ['src/a.js:1', 'src/a.js:3']);
  assert.equal(r.results[0].text, 'const Needle = 1;');
  assert.throws(() => f.search(root, 'a'), /at least two characters/);
  assert.throws(() => f.search(root, 'ok', '../'), /not allowed/);
  assert.deepEqual(f.search(root, 'zzzz-none').results, []);
});

test('highlight: comments, strings, numbers and keywords, nothing else', () => {
  const kinds = (code, lang) => tokenize(code, lang).filter(([, c]) => c).map(([t, c]) => `${c}:${t}`);
  assert.deepEqual(kinds('const a = "x" + 12; // note', 'js'), ['hl-k:const', 'hl-s:"x"', 'hl-n:12', 'hl-c:// note']);
  assert.deepEqual(kinds('def f(): return None # hi', 'py'), ['hl-k:def', 'hl-k:return', 'hl-k:None', 'hl-c:# hi']);
  assert.deepEqual(kinds('x = 1 /* c */', 'js'), ['hl-n:1', 'hl-c:/* c */']);
  assert.equal(tokenize('plain text', 'js').map(([t]) => t).join(''), 'plain text', 'the text is never altered');
  assert.equal(tokenize('"unclosed', 'js').map(([t]) => t).join(''), '"unclosed');
  assert.equal(languageOf('a/b/c.test.ts'), 'js');
  assert.equal(languageOf('Makefile'), null);
});

test('UI: tabs keep each file, search jumps to a line, notes preview Markdown and take pictures', { skip, timeout: 90000 }, async (t) => {
  const { proj, app, core, ws } = await boot(t);
  Object.assign(process.env, { OPENMAESTRI_NO_WELCOME: '1' });
  fs.writeFileSync(path.join(proj, 'one.js'), 'const one = 1; // first\n');
  fs.writeFileSync(path.join(proj, 'two.py'), 'def two():\n    return "second"\n');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const note = core.store.createNode(ws, 'note', { name: 'Pic', x: 900, y: 80 });
  core.touch(ws);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(app.url);
  await page.waitForSelector('.node');
  await page.click('#add-files');
  await page.waitForSelector('.ftree .fname');
  await page.locator('.fname', { hasText: 'one.js' }).click();
  await page.waitForFunction(() => document.querySelector('.feditor')?.value.startsWith('const one'));
  assert.ok(await page.locator('.fhl .hl-k').count() > 0, 'keywords are coloured');
  await page.fill('.feditor', 'const one = 2; // edited\n');
  await page.locator('.fname', { hasText: 'two.py' }).click();
  await page.waitForFunction(() => document.querySelector('.feditor')?.value.startsWith('def two'));
  assert.equal(await page.locator('.ftab').count(), 2);
  await page.locator('.ftab', { hasText: 'one.js' }).click();
  await page.waitForFunction(() => document.querySelector('.feditor')?.value.includes('edited'));
  assert.match(await page.locator('.ftab', { hasText: 'one.js' }).textContent(), /●/, 'the unsaved edit is kept and marked');
  await page.fill('.fsearch', 'second');
  await page.waitForSelector('.fhit');
  assert.match(await page.locator('.fhit').first().textContent(), /two\.py:2/);
  await page.locator('.fhit').first().click();
  await page.waitForFunction(() => document.querySelector('.feditor')?.value.startsWith('def two'));
  // note: preview and picture
  const noteBox = page.locator('.node', { hasText: 'Pic' });
  await noteBox.locator('.note-text').fill('# Heading\n\n**bold** text');
  await noteBox.locator('button', { hasText: 'Preview' }).click();
  await page.waitForSelector('.note-preview h1');
  assert.equal(await noteBox.locator('.note-preview strong').textContent(), 'bold');
  await noteBox.locator('button', { hasText: 'Edit' }).click();
  await page.evaluate((b64) => {
    const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer(); dt.items.add(new File([bytes], 'dot.png', { type: 'image/png' }));
    const ta = [...document.querySelectorAll('.note-text')].find((x) => x.closest('.node').textContent.includes('Pic'));
    ta.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, png.toString('base64'));
  await page.waitForFunction(() => [...document.querySelectorAll('.note-text')].some((x) => /!\[dot\.png\]\(\/attachment\//.test(x.value)));
  await noteBox.locator('button', { hasText: 'Preview' }).click();
  await page.waitForSelector('.note-preview img.md-img');
  assert.match(await noteBox.locator('.note-preview img').getAttribute('src'), /^\/attachment\/[0-9a-f-]{36}\/att_[0-9a-f]{16}$/);
  assert.deepEqual(errors, []);
  void note;
});

test('UI: workspaces appear grouped with their icon', { skip, timeout: 60000 }, async (t) => {
  const { app, core, boss, cmd } = await boot(t);
  Object.assign(process.env, { OPENMAESTRI_NO_WELCOME: '1' });
  core.store.createWorkspace({ name: 'Client A', dir: os.tmpdir() });
  await cmd(boss, 'workspace.set', { name: 'Client A', icon: '🚀', group: 'Clients' });
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(app.url);
  await page.waitForSelector('#ws-list .ws-group');
  assert.match(await page.locator('#ws-list .ws-group').textContent(), /Clients/);
  assert.match(await page.locator('#ws-list li', { hasText: 'Client A' }).textContent(), /🚀 Client A/);
  await page.locator('#ws-list .ws-group').click();
  await page.waitForFunction(() => !document.body.textContent.includes('Client A') || [...document.querySelectorAll('#ws-list li')].every((l) => !l.textContent.includes('Client A')));
});
