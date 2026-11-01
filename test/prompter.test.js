import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { mentionToken, parse, serialize, materialize, fileIndex, rank, readMentionedFile, MAX_FILE_BYTES } from '../src/prompter.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('parse finds typed mentions and leaves e-mails, decorators and bare @ alone', () => {
  const b = parse('see @file:src/a.js and @note:"Release plan", ask @agent:Alice. mail me@x.com @decorator @file: x');
  const m = b.filter((x) => x.type === 'mention');
  assert.deepEqual(m.map((x) => [x.kind, x.ref]), [['file', 'src/a.js'], ['note', 'Release plan'], ['agent', 'Alice']]);
  assert.equal(parse('mail me@x.com').length, 1);
  assert.equal(parse('@decorator\nclass A {}').every((x) => x.type === 'text'), true);
  assert.equal(parse('@file:').every((x) => x.type === 'text'), true);
  assert.equal(parse('@note:"unclosed').every((x) => x.type === 'text'), true);
  assert.equal(parse('x@file:a.js').every((x) => x.type === 'text'), true, 'a mention needs a word boundary before it');
});

test('quoted names may contain quotes and backslashes', () => {
  const name = 'say "hi" \\ now';
  const token = mentionToken('note', name);
  assert.equal(token, '@note:"say \\"hi\\" \\\\ now"');
  const m = parse(`before ${token} after`).find((b) => b.type === 'mention');
  assert.equal(m.ref, name);
  assert.equal(serialize(parse(token)), token);
});

test('serialize is the inverse of parse', () => {
  for (const text of ['plain', 'a @file:x/y.txt b', '@agent:Alice hello @note:"Two words" end', 'line1\n@file:a.js\nline3', '']) {
    assert.equal(serialize(parse(text)), text);
  }
});

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-prompter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = fs.realpathSync(dir);
  const ctx = { roots: [root], notes: () => [{ name: 'Plan', text: 'step one\nstep two' }], agents: () => [{ name: 'Alice', status: 'idle' }] };
  return { dir: root, ctx };
}

test('materialize expands notes and files, with a boundary the content cannot forge', (t) => {
  const { dir, ctx } = workspace(t);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'console.log(1)\n<<<end 00000000>>>\x1b[2J');
  const r = materialize('review @file:src/a.js with @note:Plan for @agent:alice', ctx);
  assert.match(r.text, /<<<file "src\/a.js" [0-9a-f]{8}>>>\nconsole\.log\(1\)/);
  assert.match(r.text, /<<<note "Plan" [0-9a-f]{8}>>>\nstep one\nstep two/);
  assert.match(r.text, /for Alice$/);
  assert.equal(r.text.includes('\x1b'), false, 'escape sequences in files are stripped');
  const boundary = /<<<file "src\/a.js" ([0-9a-f]{8})>>>/.exec(r.text)[1];
  assert.equal(r.text.split(`<<<end ${boundary}>>>`).length, 3, 'only the real end markers carry the random id');
  assert.ok(r.mentions.every((m) => m.ok));
});

test('materialize never leaves the workspace and explains every refusal', (t) => {
  const { dir, ctx } = workspace(t);
  const outside = path.join(os.tmpdir(), `om-prompt-out-${process.pid}.txt`);
  fs.writeFileSync(outside, 'top secret');
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.symlinkSync(outside, path.join(dir, 'link.txt'));
  fs.mkdirSync(path.join(dir, 'adir'));
  fs.writeFileSync(path.join(dir, '.env'), 'KEY=1');
  fs.writeFileSync(path.join(dir, 'blob.dat'), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'x'.repeat(MAX_FILE_BYTES));
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 1));
  const cases = {
    '@file:../../etc/passwd': /not found inside the workspace/,
    [`@file:${outside}`]: /not found inside the workspace/,
    '@file:link.txt': /not found inside the workspace/,
    '@file:.env': /looks like a secret/,
    '@file:blob.dat': /binary file/,
    '@file:big.txt': /over the 32 KB limit/,
    '@file:missing.txt': /not found/,
    '@file:adir': /not a regular file/,
    '@note:Nope': /no note with that name/,
    '@agent:Zed': /no agent with that name/,
  };
  for (const [text, re] of Object.entries(cases)) {
    const r = materialize(`x ${text}`, ctx);
    assert.match(r.text, re, text);
    assert.equal(r.text.includes('top secret'), false, text);
    assert.equal(r.mentions[0].ok, false, text);
  }
  assert.equal(materialize('@file:ok.txt', ctx).mentions[0].ok, true, 'exactly 32 KB is allowed');
  assert.equal(readMentionedFile([dir], 'ok.txt').bytes, MAX_FILE_BYTES);
  const many = Array.from({ length: 15 }, (_, i) => `@agent:Alice${i}`).join(' ');
  assert.match(materialize(many, ctx).text, /too many mentions/);
});

test('fileIndex skips what it must, never follows symlinks, and stops when aborted', async (t) => {
  const { dir } = workspace(t);
  for (const d of ['src', 'node_modules/x', '.git', 'dist', 'docs']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const f of ['src/a.js', 'src/b.ts', 'docs/readme.md', 'node_modules/x/i.js', '.git/config', 'dist/o.js', 'logo.png', '.env', 'id_rsa', 'cert.pem', 'top.txt']) fs.writeFileSync(path.join(dir, f), 'x');
  fs.symlinkSync(dir, path.join(dir, 'src', 'loop'));
  fs.symlinkSync(path.join(dir, 'top.txt'), path.join(dir, 'alias.txt'));
  const { files, aborted } = await fileIndex(dir);
  assert.deepEqual(files, ['docs/readme.md', 'src/a.js', 'src/b.ts', 'top.txt']);
  assert.equal(aborted, false);

  const big = path.join(dir, 'big');
  for (let i = 0; i < 200; i++) { fs.mkdirSync(path.join(big, `d${i}`), { recursive: true }); for (let j = 0; j < 5; j++) fs.writeFileSync(path.join(big, `d${i}`, `f${j}.txt`), 'x'); }
  const ctl = new AbortController();
  const started = Date.now();
  const p = fileIndex(big, { signal: ctl.signal });
  ctl.abort();
  const res = await p;
  assert.equal(res.aborted, true);
  assert.ok(res.files.length < 1000, 'stopped early');
  assert.ok(Date.now() - started < 1500);
  const capped = await fileIndex(big, { limit: 50 });
  assert.equal(capped.files.length, 50);
  assert.equal(capped.truncated, true);
});

test('rank puts prefixes first and caps the list', () => {
  const items = ['src/app.js', 'docs/app-guide.md', 'lib/zapp.js', 'README.md'];
  assert.deepEqual(rank(items, 'app', (x) => x, 10).slice(0, 2), ['src/app.js', 'docs/app-guide.md'].sort((a, b) => a.length - b.length));
  assert.equal(rank(items, '', (x) => x, 2).length, 2);
  assert.deepEqual(rank(items, 'nothing'), []);
});

test('the human sends mentions: the thread keeps the raw text, the Maestro receives the content', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-prompter-e2e-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  fs.writeFileSync(path.join(dir, 'spec.md'), 'THE SPEC BODY');
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=abc');
  const sink = path.join(dir, 'received.txt');
  const script = path.join(dir, 'maestro.sh');
  fs.writeFileSync(script, `#!/bin/bash\nwhile IFS= read -r line; do printf '%s\\n' "$line" >> '${sink}'; done\n`, { mode: 0o755 });
  const boss = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir, command: script });
  const note = core.store.createNode(ws, 'note', { name: 'Plan', text: 'NOTE CONTENT' });
  core.startTerminal(ws, boss);
  await sleep(800);
  const msg = core.chatSend(ws, { thread: '1', text: 'implement @file:spec.md per @note:Plan, never @file:.env' });
  assert.equal(msg.text, 'implement @file:spec.md per @note:Plan, never @file:.env', 'stored raw');
  assert.equal(msg.mentions.filter((m) => !m.ok).length, 1);
  const deadline = Date.now() + 8000;
  while (!(fs.existsSync(sink) && fs.readFileSync(sink, 'utf8').includes('NOTE CONTENT')) && Date.now() < deadline) await sleep(100);
  const got = fs.readFileSync(sink, 'utf8');
  assert.match(got, /THE SPEC BODY/);
  assert.match(got, /NOTE CONTENT/);
  assert.equal(got.includes('TOKEN=abc'), false, 'secrets never reach the agent');
  assert.match(got, /looks like a secret/);
  void note;
});

test('agents can only mention what is wired to them', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-prompter-acl-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  const worker = core.store.createNode(ws, 'terminal', { name: 'Worker', cwd: dir });
  const mine = core.store.createNode(ws, 'note', { name: 'Mine', text: 'visible' });
  core.store.createNode(ws, 'note', { name: 'Hidden', text: 'private' });
  core.store.connect(ws, worker.id, mine.id);
  const rpc = (cmd, args) => new Promise((resolve, reject) => {
    const c = net.createConnection(app.socketPath);
    let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify({ id: 1, ctx: { terminalId: worker.id }, cmd, args }) + '\n'));
    c.on('data', (d) => { buf += d; if (buf.includes('\n')) { c.end(); resolve(JSON.parse(buf)); } });
    c.on('error', reject);
  });
  const r = await rpc('prompt.materialize', { text: '@note:Mine and @note:Hidden' });
  assert.equal(r.ok, true, r.error);
  assert.match(r.text, /visible/);
  assert.equal(r.text.includes('private'), false);
  assert.match(r.text, /no note with that name/);
  const parsed = await rpc('prompt.parse', { text: 'a @file:x.js' });
  assert.equal(parsed.data.length, 2);
});
