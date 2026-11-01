import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { digest, redact, renderChapter } from '../src/memory.js';

async function boot(t, memory) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-mem-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ws = app.core.store.workspaces.get(app.core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  if (memory) Object.assign(app.core.chat.memory, memory);
  const rpc = (id, cmd, args = {}) => new Promise((resolve, reject) => {
    const c = net.createConnection(app.socketPath);
    let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify({ id: 1, ctx: { terminalId: id }, cmd, args }) + '\n'));
    c.on('data', (d) => { buf += d; if (buf.includes('\n')) { c.end(); resolve(JSON.parse(buf)); } });
    c.on('error', reject);
  });
  return { app, ws, chat: app.core.chat, core: app.core, store: app.core.store, rpc, dir };
}

const fill = (chat, ws, n, { tid = 'thread-1', textOf = (i) => `message number ${i}` } = {}) => {
  for (let i = 0; i < n; i++) chat.append(ws.id, tid, { role: i % 2 ? 'agent' : 'human', sender: i % 2 ? 'Maestro' : 'You', text: textOf(i) });
};

test('redact masks credentials and keeps ordinary text', () => {
  assert.equal(redact('use key sk-abcdefghijklmnopqrstuvwx now'), 'use key [key removed] now');
  assert.equal(redact('AKIAIOSFODNN7EXAMPLE leaked'), '[key removed] leaked');
  assert.equal(redact('token ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'token [token removed]');
  assert.equal(redact('password: hunter22 and api_key=abcd1234'), 'password: [removed] and api_key=[removed]');
  const dashes = '-'.repeat(5);
  assert.equal(redact(`${dashes}BEGIN RSA PRIVATE KEY${dashes}\nMIIabc\n${dashes}END RSA PRIVATE KEY${dashes} tail`), '[private key removed] tail');
  assert.equal(redact(`before ${dashes}BEGIN PRIVATE KEY${dashes}\ncut off`), 'before [private key removed]');
  assert.equal(redact(`${dashes}BEGIN CERTIFICATE${dashes}\nabc`), `${dashes}BEGIN CERTIFICATE${dashes}\nabc`, 'public certificates are not touched');
  assert.equal(redact('the password policy is documented'), 'the password policy is documented');
});

test('digest is deterministic and only quotes what was said', () => {
  const msgs = [
    { id: 'a', ts: 1000, role: 'human', sender: 'You', text: 'Should the parser live in src/parser.js?', attachments: [] },
    { id: 'b', ts: 2000, role: 'agent', sender: 'Maestro', text: 'We decided to keep it in src/parser.js and never use eval.\nsecond line', attachments: [{ id: 'att_1', name: 'spec.pdf' }] },
    { id: 'c', ts: 3000, role: 'human', sender: 'You', text: 'ok, my key is sk-abcdefghijklmnopqrstuvwx see lib/util.ts', attachments: [] },
  ];
  const d1 = digest(msgs);
  assert.deepEqual(digest(msgs), d1, 'same input, same digest');
  assert.equal(d1.count, 3);
  assert.deepEqual(d1.files, ['src/parser.js', 'lib/util.ts'].sort((a, b) => (d1.files.indexOf(a) - d1.files.indexOf(b))));
  assert.match(d1.decisions[0], /Maestro: We decided to keep it in src\/parser\.js and never use eval\./);
  assert.match(d1.questions[0], /Should the parser live/);
  assert.deepEqual(d1.attachments, ['spec.pdf (att_1)']);
  const text = JSON.stringify(d1);
  assert.equal(text.includes('sk-abcdefghijklmnopqrstuvwx'), false, 'the key never reaches the summary');
  assert.match(renderChapter(d1, 1), /Earlier, part 1: 3 messages/);
  // containment: every decision/topic is a piece of what was actually written (after masking)
  const said = redact(msgs.map((m) => m.text).join('\n')).replace(/\s+/g, ' ');
  for (const frag of [...d1.topics, ...d1.questions]) assert.ok(said.includes(frag.replace(/…$/, '')), frag);
});

test('a long thread is condensed: archive first, tail kept, nothing lost, no network', async (t) => {
  const { chat, ws } = await boot(t, { compressAt: 1000 });
  fill(chat, ws, 120, { textOf: (i) => (i === 10 ? 'We decided to use SQLite in db/store.js' : i === 20 ? 'api_key=SUPERSECRET123 rotate it' : `message number ${i}`) });
  const all = chat.readAll(ws.id, 'thread-1').map((m) => m.id);
  const realConnect = net.Socket.prototype.connect;
  let touchedNetwork = false;
  net.Socket.prototype.connect = function (...a) { touchedNetwork = true; return realConnect.apply(this, a); };
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { touchedNetwork = true; throw new Error('no network allowed'); };
  let r;
  try { r = chat.memory.compress(ws.id, 'thread-1', { keep: 30 }); } finally { net.Socket.prototype.connect = realConnect; globalThis.fetch = realFetch; }
  assert.equal(touchedNetwork, false, 'condensing is fully local');
  assert.deepEqual(r, { archived: 90, kept: 30, chapters: 1 });
  assert.equal(chat.readAll(ws.id, 'thread-1').length, 30);
  assert.deepEqual(chat.readAll(ws.id, 'thread-1').map((m) => m.id), all.slice(-30), 'the newest messages stay, in order');
  assert.deepEqual(chat.memory.readArchive(ws.id, 'thread-1').map((m) => m.id), all.slice(0, 90), 'the oldest are in the archive, in order');
  const sum = chat.memory.summary(ws.id, 'thread-1');
  assert.match(sum, /We decided to use SQLite in db\/store\.js/);
  assert.match(sum, /db\/store\.js/);
  assert.equal(sum.includes('SUPERSECRET123'), false, 'credentials are masked in the summary');
  assert.equal(chat.memory.compress(ws.id, 'thread-1', { keep: 30 }), null, 'a short thread is left alone');
  assert.equal(fs.statSync(chat.memory.archiveFile(ws.id, 'thread-1')).mode & 0o777, 0o600);
  // history reaches back into the archive on request or when the date range asks for it
  assert.equal(chat.history(ws.id, 'thread-1', { turns: 1000, archive: true }).length, 120);
  assert.equal(chat.history(ws.id, 'thread-1', { turns: 1000 }).length, 30);
  assert.equal(chat.history(ws.id, 'thread-1', { turns: 1000, since: 0 }).length, 120, 'a range that predates the active file includes the archive');
});

test('if compression is interrupted after the archive write, no message is lost or duplicated', async (t) => {
  const { chat, ws } = await boot(t, { compressAt: 1000 });
  fill(chat, ws, 80);
  const ids = chat.readAll(ws.id, 'thread-1').map((m) => m.id);
  // simulate a crash: the archive got the old messages but the active file was never rewritten
  const old = chat.readAll(ws.id, 'thread-1').slice(0, 40);
  fs.mkdirSync(path.dirname(chat.memory.archiveFile(ws.id, 'thread-1')), { recursive: true });
  fs.writeFileSync(chat.memory.archiveFile(ws.id, 'thread-1'), old.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const merged = chat.history(ws.id, 'thread-1', { turns: 1000, archive: true }).map((m) => m.id);
  assert.deepEqual(merged, ids, 'each message appears once, in order');
  chat.memory.compress(ws.id, 'thread-1', { keep: 30 });
  assert.equal(chat.history(ws.id, 'thread-1', { turns: 1000, archive: true }).length, 80, 'still 80 distinct messages after the retry');
});

test('a thread condenses itself when it gets long, and recall remembers', async (t) => {
  const { chat, ws, store, rpc } = await boot(t, { compressAt: 60, keep: 20 });
  const boss = store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, cwd: ws.dir });
  fill(chat, ws, 59, { textOf: (i) => (i === 3 ? 'Rule: we will never touch config/prod.yaml' : `chatter ${i}`) });
  assert.equal(chat.readAll(ws.id, 'thread-1').length, 59);
  chat.append(ws.id, 'thread-1', { role: 'human', sender: 'You', text: 'one more please' });
  assert.equal(chat.readAll(ws.id, 'thread-1').length, 20, 'the 60th message triggered it');
  const plain = await rpc(boss.id, 'recall', {});
  assert.match(plain.text, /^Earlier, part 1: 40 messages/);
  assert.match(plain.text, /never touch config\/prod\.yaml/);
  assert.match(plain.text, /Recent messages:\n/);
  assert.match(plain.text, /one more please/);
  const only = await rpc(boss.id, 'recall', { summary: true });
  assert.match(only.text, /Earlier, part 1/);
  assert.equal(only.text.includes('one more please'), false);
  const everything = await rpc(boss.id, 'recall', { archive: true, turns: 500 });
  assert.match(everything.text, /chatter 5/, 'the archive is readable on demand');
  const status = await rpc(boss.id, 'memory.status', {});
  assert.match(status.text, /^1: 20 active, 40 archived, 1 summary part/m);
  assert.equal((await rpc(boss.id, 'memory.compress', {})).ok, true);
});

test('only a Maestro condenses, and a worker sees only the active thread status', async (t) => {
  const { ws, store, rpc } = await boot(t);
  const worker = store.createNode(ws, 'terminal', { name: 'Worker', cwd: ws.dir });
  assert.match((await rpc(worker.id, 'memory.compress', {})).error, /Maestro/);
  assert.match((await rpc(worker.id, 'memory.status', {})).error, /only look at the active thread/);
  assert.equal((await rpc(worker.id, 'memory.status', { thread: '1' })).ok, true);
});

test('summaries stay at eight parts and say how many older ones exist', async (t) => {
  const { chat, ws } = await boot(t, { compressAt: 100000 });
  for (let round = 0; round < 10; round++) { fill(chat, ws, 60, { textOf: (i) => `round ${round} line ${i}` }); chat.memory.compress(ws.id, 'thread-1', { keep: 10 }); }
  const sum = chat.memory.summary(ws.id, 'thread-1');
  assert.match(sum, /^\(2 older parts are only in the archive\)/);
  assert.equal((sum.match(/Earlier, part/g) ?? []).length, 8);
});
