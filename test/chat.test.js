import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { THREAD_IDS, cleanText, looksSecret, threadId } from '../src/chat.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timeout'); await sleep(50); } };

async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-chat-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const store = app.core.store;
  const ws = store.workspaces.get(store.settings.activeWorkspaceId);
  ws.dir = dir;
  const rpc = (id, cmd, args = {}) => new Promise((resolve, reject) => {
    const c = net.createConnection(app.socketPath);
    let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify({ id: 1, ctx: { terminalId: id }, cmd, args }) + '\n'));
    c.on('data', (d) => { buf += d; if (buf.includes('\n')) { c.end(); resolve(JSON.parse(buf)); } });
    c.on('error', reject);
  });
  return { app, ws, dir, store, chat: app.core.chat, core: app.core, rpc };
}

test('every workspace has exactly seven fixed threads, all empty at first', async (t) => {
  const { chat, ws } = await boot(t);
  const list = chat.list(ws.id);
  assert.deepEqual(list.map((x) => x.id), THREAD_IDS);
  assert.equal(list.length, 7);
  assert.ok(list.every((x) => x.empty));
  assert.equal(list.filter((x) => x.active).length, 1);
  assert.equal(threadId('3'), 'thread-3');
  assert.throws(() => threadId('8'), /numbered 1 to 7/);
  assert.throws(() => threadId('../x'), /numbered 1 to 7/);
});

test('messages persist outside workspace.json; threads are isolated; progress is never stored', async (t) => {
  const { chat, ws, store } = await boot(t);
  chat.append(ws.id, 'thread-1', { role: 'human', sender: 'You', text: 'hello' });
  chat.append(ws.id, 'thread-1', { role: 'agent', sender: 'Boss', text: 'hi there' });
  chat.append(ws.id, 'thread-2', { role: 'human', sender: 'You', text: 'other thread' });
  const seen = [];
  chat.on('progress', (_w, m) => seen.push(m.text));
  chat.append(ws.id, 'thread-1', { role: 'agent', sender: 'Boss', text: 'thinking...', progress: true });
  assert.deepEqual(seen, ['thinking...']);
  assert.equal(chat.history(ws.id, 'thread-1').length, 2, 'progress is not persisted');
  assert.equal(chat.pendingProgress(ws.id, 'thread-1').length, 1);
  chat.append(ws.id, 'thread-1', { role: 'agent', sender: 'Boss', text: 'done' });
  assert.equal(chat.pendingProgress(ws.id, 'thread-1').length, 0, 'the final answer replaces the progress line');
  assert.equal(chat.list(ws.id)[0].turnCount, 3);
  assert.equal(chat.list(ws.id)[1].turnCount, 1);
  store.flush();
  assert.ok(!fs.readFileSync(store.wsFile(ws.id), 'utf8').includes('hi there'), 'chat text is not in workspace.json');
  const file = chat.threadFile(ws.id, 'thread-1');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  chat.clear(ws.id, 'thread-1');
  assert.equal(chat.history(ws.id, 'thread-1').length, 0);
  assert.equal(chat.history(ws.id, 'thread-2').length, 1, 'clearing one thread leaves the others');
  assert.equal(chat.list(ws.id)[0].empty, true);
});

test('history filters by count and by date, and survives a damaged line', async (t) => {
  const { chat, ws } = await boot(t);
  for (let i = 0; i < 10; i++) chat.append(ws.id, 'thread-1', { role: 'human', sender: 'You', text: `m${i}` });
  assert.deepEqual(chat.history(ws.id, 'thread-1', { turns: 3 }).map((m) => m.text), ['m7', 'm8', 'm9']);
  const all = chat.history(ws.id, 'thread-1', { turns: 100 });
  const mid = all[5].ts;
  assert.ok(chat.history(ws.id, 'thread-1', { since: mid, turns: 100 }).every((m) => m.ts >= mid));
  assert.ok(chat.history(ws.id, 'thread-1', { until: mid, turns: 100 }).every((m) => m.ts <= mid));
  fs.appendFileSync(chat.threadFile(ws.id, 'thread-1'), '{"torn":\n');
  chat.append(ws.id, 'thread-1', { role: 'human', sender: 'You', text: 'after damage' });
  assert.equal(chat.history(ws.id, 'thread-1', { turns: 1 })[0].text, 'after damage');
  assert.ok(chat.history(ws.id, 'thread-1', { turns: 100 }).length >= 11);
  assert.deepEqual(chat.search(ws.id, 'm3').map((h) => h.snippet), ['m3']);
  assert.deepEqual(chat.search(ws.id, 'x'), [], 'too-short queries return nothing');
  assert.deepEqual(chat.search(ws.id, 'm', { isCancelled: () => true }), []);
});

test('control characters never reach the store or a terminal', () => {
  assert.equal(cleanText('a\x1b[31mred\x07\x00b\tc\nd'), 'a[31mredb\tc\nd');
  assert.equal(cleanText('x'.repeat(50000)).length, 20000);
});

test('attachments: vault copy, dedup, and the refusals', async (t) => {
  const { chat, ws, dir } = await boot(t);
  const doc = path.join(dir, 'notes.txt');
  fs.writeFileSync(doc, 'hello vault');
  const a = chat.attach(ws.id, doc);
  const b = chat.attach(ws.id, doc);
  assert.equal(a.id, b.id, 'same content, same attachment');
  assert.match(a.id, /^att_[0-9a-f]{16}$/);
  const stored = chat.attachmentPath(ws.id, a.id);
  assert.ok(stored.startsWith(path.join(chat.dir(ws.id), 'vault')));
  assert.equal(fs.readFileSync(stored, 'utf8'), 'hello vault');
  assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
  fs.writeFileSync(doc, 'changed after');
  assert.equal(fs.readFileSync(chat.attachmentPath(ws.id, a.id), 'utf8'), 'hello vault', 'the vault copy is immutable');

  for (const name of ['.env', '.env.local', 'id_rsa', 'server.pem', 'my_secret_plan.txt', 'credentials.json', '.npmrc']) {
    assert.equal(looksSecret(name), true, name);
    const f = path.join(dir, name);
    fs.writeFileSync(f, 'x');
    assert.throws(() => chat.attach(ws.id, f), /secrets/, name);
  }
  const outside = path.join(os.tmpdir(), `om-out-${process.pid}.txt`);
  fs.writeFileSync(outside, 'nope');
  t.after(() => fs.rmSync(outside, { force: true }));
  assert.throws(() => chat.attach(ws.id, outside), /inside the workspace/);
  const link = path.join(dir, 'sneaky.txt');
  fs.symlinkSync(outside, link);
  assert.throws(() => chat.attach(ws.id, link), /inside the workspace/, 'a symlink out of the workspace is followed and refused');
  assert.throws(() => chat.attach(ws.id, dir), /regular file/);
  assert.throws(() => chat.attach(ws.id, path.join(dir, 'missing')), /no such file/);
  const big = path.join(dir, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
  assert.throws(() => chat.attach(ws.id, big), /limited to 10 MB/);
  assert.throws(() => chat.attachmentPath(ws.id, '../../etc/passwd'), /no attachment/);
});

test('say and recall from inside an agent: attribution, active thread, ACL and rate limit', async (t) => {
  const { ws, store, rpc, chat } = await boot(t);
  const boss = store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, cwd: ws.dir });
  const worker = store.createNode(ws, 'terminal', { name: 'Worker', cwd: ws.dir });
  const r1 = await rpc(boss.id, 'say', { text: 'hello human' });
  assert.equal(r1.ok, true, r1.error);
  assert.equal(chat.history(ws.id, 'thread-1')[0].sender, 'Boss');
  await rpc(boss.id, 'say', { text: 'thread two note', thread: '2' });
  assert.equal(chat.history(ws.id, 'thread-2').length, 1);
  const denied = await rpc(worker.id, 'say', { text: 'x', thread: '2' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /only a Maestro/);

  const listed = (await rpc(worker.id, 'recall', { list: true })).text;
  assert.match(listed, /1\s+Thread 1\s+1 turns/);
  assert.match(listed, /3\s+Thread 3\s+\(empty\)/);
  assert.match((await rpc(worker.id, 'recall', {})).text, /Boss: hello human/);
  const other = await rpc(worker.id, 'recall', { thread: '2' });
  assert.equal(other.ok, false);
  assert.match(other.error, /only recall the active thread/);
  const all = await rpc(worker.id, 'recall', { all: true });
  assert.equal(all.ok, false);
  assert.match(all.error, /only a Maestro/);
  const mAll = await rpc(boss.id, 'recall', { all: true, json: true });
  assert.equal(JSON.parse(mAll.text).length, 2);
  assert.equal((await rpc(boss.id, 'recall', { last: 'year' })).ok, false);
  assert.equal((await rpc(boss.id, 'recall', { from: 'not a date' })).ok, false);

  for (let i = 0; i < 40; i++) await rpc(worker.id, 'say', { text: `spam ${i}` });
  const limited = await rpc(worker.id, 'say', { text: 'one more' });
  assert.equal(limited.ok, false);
  assert.match(limited.error, /rate limit/);
});

test('say --file and --attach honour the vault rules', async (t) => {
  const { ws, store, rpc, chat, dir } = await boot(t);
  const boss = store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, cwd: dir });
  const txt = path.join(dir, 'reply.txt');
  fs.writeFileSync(txt, 'a long reply\nwith lines');
  assert.equal((await rpc(boss.id, 'say', { file: txt })).ok, true);
  assert.equal(chat.history(ws.id, 'thread-1')[0].text, 'a long reply\nwith lines');
  const shot = path.join(dir, 'shot.png');
  fs.writeFileSync(shot, Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.equal((await rpc(boss.id, 'say', { text: 'see this', attach: [shot] })).ok, true);
  const last = chat.history(ws.id, 'thread-1', { turns: 1 })[0];
  assert.equal(last.attachments[0].name, 'shot.png');
  const got = await rpc(boss.id, 'recall', { attachment: last.attachments[0].id });
  assert.ok(got.text.startsWith(path.join(chat.dir(ws.id), 'vault')));
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, 'KEY=1');
  const refused = await rpc(boss.id, 'say', { text: 'leak', attach: [env] });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /secrets/);
  assert.equal(chat.history(ws.id, 'thread-1', { turns: 50 }).some((m) => m.text === 'leak'), false, 'a refused attachment sends nothing');
  const bin = path.join(dir, 'data.bin');
  fs.writeFileSync(bin, Buffer.from([0, 1, 2, 3]));
  const binary = await rpc(boss.id, 'say', { file: bin });
  assert.equal(binary.ok, false);
});

test('the human talks to the Maestro: message stored, typed into its terminal, answer comes back through say', async (t) => {
  const { ws, store, core, chat, dir } = await boot(t);
  // a stand-in Maestro: reads each line and answers through the real CLI
  const script = path.join(dir, 'fake-maestro.sh');
  fs.writeFileSync(script, '#!/bin/bash\nwhile IFS= read -r line; do\n  case "$line" in *"openmaestri chat"*) openmaestri say --progress "working on it"; sleep 0.3; openmaestri say "answered: ${line:0:60}";; esac\ndone\n', { mode: 0o755 });
  const boss = store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir, command: script });
  core.startTerminal(ws, boss);
  await sleep(800);
  const events = [];
  core.on('chat-message', (_w, m) => events.push(m));
  core.chatSend(ws, { thread: '1', text: 'please plan\x1b[2J the release\x03' });
  await until(() => chat.history(ws.id, 'thread-1').some((m) => m.role === 'agent'));
  const rows = chat.history(ws.id, 'thread-1');
  assert.equal(rows[0].role, 'human');
  assert.equal(rows[0].text, 'please plan[2J the release', 'escape and control bytes are stripped before storing and typing');
  assert.match(rows[1].text, /answered: \[openmaestri chat, Thread 1\] please plan/);
  assert.equal(rows[1].sender, 'Maestro');
  assert.equal(core.chatState(ws).maestroAttention, true, 'the Maestro answered, so it needs the human');
  core.chatSend(ws, { thread: '1', text: 'thanks' });
  assert.equal(core.chatState(ws).maestroAttention, false, 'a new human message clears the attention flag');
  await until(() => chat.history(ws.id, 'thread-1').filter((m) => m.role === 'agent').length === 2);
  assert.ok(events.length >= 3);
});

test('chat without a Maestro explains what to do', async (t) => {
  const { core, ws } = await boot(t);
  assert.throws(() => core.chatSend(ws, { thread: '1', text: 'hello?' }), /no Maestro yet/);
  assert.throws(() => core.chatSend(ws, { thread: '1', text: '   ' }), /no Maestro yet|write something/);
});
