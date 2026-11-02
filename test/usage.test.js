import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { Usage, parseUsageLine, parseCount, loadPrices, costOf, isPeak, stripAnsi, DEFAULT_PRICES } from '../src/usage.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-usage-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('parseCount and parseUsageLine read "Tokens: 1.2k sent, 340 received" and refuse everything else', () => {
  assert.equal(parseCount('1.2k'), 1200);
  assert.equal(parseCount('15,300'), 15300);
  assert.equal(parseCount('2m'), 2000000);
  for (const bad of ['', 'k', '1.2.3', '.5', '1e9', '-5', '99999999999', 'x'.repeat(40), '1.2345k']) assert.equal(parseCount(bad), null, bad);
  assert.deepEqual(parseUsageLine('Tokens: 4.5k sent, 1.2k received. Cost: $0.02 message'), { input: 4500, output: 1200 });
  assert.deepEqual(parseUsageLine('\x1b[1m\x1b[38;5;240mTokens: 10 input, 5 output\x1b[0m'), { input: 10, output: 5 });
  assert.deepEqual(parseUsageLine('Tokens: 7 sent'), { input: 7, output: 0 });
  assert.equal(parseUsageLine('I sent 5 files and received 3 replies'), null, 'needs the word tokens near the start');
  assert.equal(parseUsageLine('no numbers tokens here'), null);
  assert.equal(stripAnsi('a\x1b]0;title\x07b\x1b[2Jc'), 'abc');
});

test('hostile output cannot make the parser slow or unbounded', () => {
  const started = Date.now();
  for (const evil of ['Tokens: ' + '9'.repeat(200000), 'tokens ' + '1,'.repeat(100000), 'Tokens: ' + 'k '.repeat(100000), '\x1b[' + '1;'.repeat(100000)]) parseUsageLine(evil);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test('prices: DeepSeek peak and off-peak, override file is strictly validated', (t) => {
  const d = tmp(t);
  assert.equal(isPeak(new Date('2026-11-02T02:00:00Z')), true, 'Monday 02:00 UTC');
  assert.equal(isPeak(new Date('2026-11-02T05:00:00Z')), false);
  assert.equal(isPeak(new Date('2026-11-02T07:00:00Z')), true);
  assert.equal(isPeak(new Date('2026-11-01T02:00:00Z')), false, 'Sunday');
  const flash = DEFAULT_PRICES['deepseek-flash'];
  assert.ok(Math.abs(costOf(flash, 1e6, 1e6, new Date('2026-11-02T12:00:00Z')) - 0.75) < 1e-9, 'off-peak: 0.15 + 0.6');
  assert.ok(Math.abs(costOf(flash, 1e6, 1e6, new Date('2026-11-02T02:00:00Z')) - 1.5) < 1e-9, 'peak doubles');
  assert.equal(costOf(null, 5, 5), null);
  const f = path.join(d, 'prices.json');
  fs.writeFileSync(f, JSON.stringify({ 'my-model': { input: 1, output: 2 }, 'deepseek-flash': { input: 9, output: 9 }, bad: { input: -1, output: 2 }, '../x': { input: 1, output: 1 }, str: { input: '1', output: 2 }, nested: { input: 1, output: 1, peak: { input: 'x' } } }));
  const { prices, problems } = loadPrices(f);
  assert.equal(prices['my-model'].output, 2);
  assert.equal(prices['deepseek-flash'].input, 9, 'a valid override wins');
  assert.equal(prices.bad, undefined);
  assert.equal(prices.str, undefined);
  assert.equal(prices.nested.peak, undefined, 'a broken peak block is dropped, the rest is kept');
  assert.ok(problems.length >= 3);
  fs.writeFileSync(f, '{not json');
  assert.equal(loadPrices(f).prices['deepseek-flash'].input, 0.15);
  fs.writeFileSync(f, '[1,2]');
  assert.match(loadPrices(f).problems[0], /must be an object/);
});

test('reported and parsed tokens add up, cost needs a known model, and sources stay separate', (t) => {
  const d = tmp(t);
  const u = new Usage({ file: path.join(d, 'usage.json'), pricesFile: path.join(d, 'prices.json') });
  t.after(() => u.close());
  const at = new Date('2026-11-02T12:00:00Z');
  u.report('a', { input: 1000, output: 500, model: 'deepseek-flash' }, { at });
  let s = u.summary('a');
  assert.deepEqual(s.tokens, { input: 1000, output: 500 });
  assert.ok(Math.abs(s.costUsd - (1000 * 0.15 + 500 * 0.6) / 1e6) < 1e-12);
  assert.equal(s.source, 'reported');
  u.observe('a', 'Tokens: 2k sent, 1k received.\nnext line\npartial Tokens: 1', () => ({ at }));
  s = u.summary('a');
  assert.deepEqual(s.tokens, { input: 3000, output: 1500 });
  assert.equal(s.source, 'reported+parsed');
  u.observe('a', ' sent, 1 received\n', () => ({ at }));
  assert.equal(u.summary('a').tokens.input, 3001, 'a line split across chunks is still found');
  u.report('b', { input: 10, output: 10 }, { at });
  assert.equal(u.summary('b').costUsd, null, 'no model, no price: tokens only');
  u.report('b', { input: 1, output: 1, costUsd: 0.5 }, { at });
  assert.equal(u.summary('b').costUsd, 0.5, 'a reported bill replaces the table');
  assert.deepEqual(u.summary('none'), { turns: 0, activeSeconds: 0, tokens: null, costUsd: null, model: null, source: 'none' });
  u.turn('c'); u.turn('c'); u.tick('c');
  assert.equal(u.summary('c').turns, 2);
  assert.equal(u.summary('c').tokens, null, 'turns alone never produce a token figure');
  assert.equal(u.summary('a', { days: 1 }).tokens.input >= 0, true);
  for (const bad of [{ input: -1 }, { input: 1.5 }, { input: 2e9 }, { input: 'x' }, {}, { input: 1, model: '../etc' }, { input: 1, costUsd: -3 }]) assert.throws(() => u.report('z', bad), /whole numbers|at least one|model names|cost/, JSON.stringify(bad));
  u.close();
  const again = new Usage({ file: path.join(d, 'usage.json'), pricesFile: path.join(d, 'prices.json') });
  t.after(() => again.close());
  assert.equal(again.summary('a').tokens.input, 3001, 'survives a restart');
  fs.writeFileSync(path.join(d, 'usage.json'), '{broken');
  assert.deepEqual(new Usage({ file: path.join(d, 'usage.json'), pricesFile: path.join(d, 'p.json') }).data.terminals, {}, 'a damaged file starts empty instead of crashing');
});

test('forgetting a terminal archives its totals', (t) => {
  const d = tmp(t);
  const u = new Usage({ file: path.join(d, 'usage.json'), pricesFile: path.join(d, 'prices.json') });
  t.after(() => u.close());
  u.report('gone', { input: 5, output: 7, model: 'deepseek-flash' });
  u.turn('gone');
  u.forget('gone');
  assert.equal(u.summary('gone').source, 'none');
  assert.equal(u.data.archived.input, 5);
  assert.equal(u.data.archived.turns, 1);
});

test('CLI: agents report their own usage, see only themselves; a Maestro sees everyone and can reset', async (t) => {
  const dir = tmp(t);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  fs.writeFileSync(path.join(dir, 'data', 'prices.json'), JSON.stringify({ 'cheap-model': { input: 1, output: 2 } }));
  core.usage.reloadPrices();
  const boss = core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, cwd: dir });
  const w1 = core.store.createNode(ws, 'terminal', { name: 'W1', cwd: dir, preset: 'OpenCode (DeepSeek)' });
  const w2 = core.store.createNode(ws, 'terminal', { name: 'W2', cwd: dir });
  const rpc = (id, cmd, args = {}) => new Promise((resolve, reject) => {
    const c = net.createConnection(app.socketPath);
    let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify({ id: 1, ctx: { terminalId: id }, cmd, args }) + '\n'));
    c.on('data', (d) => { buf += d; if (buf.includes('\n')) { c.end(); resolve(JSON.parse(buf)); } });
    c.on('error', reject);
  });
  assert.equal((await rpc(w1.id, 'usage.report', { input: 2000, output: 1000 })).ok, true);
  assert.equal((await rpc(w2.id, 'usage.report', { input: 100, output: 50, model: 'cheap-model' })).ok, true);
  const mine = await rpc(w1.id, 'usage', { json: true });
  assert.equal(JSON.parse(mine.text).length, 1);
  assert.equal(JSON.parse(mine.text)[0].model, 'deepseek-flash', 'a DeepSeek preset implies the default model');
  assert.ok(JSON.parse(mine.text)[0].costUsd > 0);
  const all = await rpc(boss.id, 'usage', {});
  assert.match(all.text, /W1\s+0 turns.*2000 in \/ 1000 out/);
  assert.match(all.text, /W2.*100 in \/ 50 out.*cost \$0\.0002/);
  assert.match(all.text, /total/);
  const peek = await rpc(w1.id, 'usage', { terminal: 'W2' });
  assert.equal(peek.ok, false, 'a worker cannot read a peer it is not wired to');
  assert.equal((await rpc(w1.id, 'usage.reset', {})).ok, false);
  assert.equal((await rpc(boss.id, 'usage.reset', { terminal: 'W1' })).ok, true);
  assert.equal(JSON.parse((await rpc(boss.id, 'usage', { terminal: 'W1', json: true })).text)[0].tokens, null);
  assert.equal((await rpc(w2.id, 'usage.report', { input: -5 })).ok, false);
  // deleting the node archives its usage
  core.store.deleteNode(ws, w2.id);
  core.touch(ws);
  assert.equal(core.usage.data.terminals[w2.id], undefined);
  assert.equal(core.usage.data.archived.input, 100);
  void sleep;
});

test('a terminal that prints a usage line is counted without any cooperation', async (t) => {
  const dir = tmp(t);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 's.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  const node = core.store.createNode(ws, 'terminal', { name: 'Talker', cwd: dir, command: "printf 'Tokens: 3.5k sent, 900 received.\\n'; sleep 1", preset: 'Aider (DeepSeek)' });
  core.startTerminal(ws, node);
  const end = Date.now() + 8000;
  while (!core.usage.summary(node.id).tokens && Date.now() < end) await sleep(100);
  const s = core.usage.summary(node.id);
  assert.deepEqual(s.tokens, { input: 3500, output: 900 });
  assert.equal(s.source, 'parsed');
  assert.equal(s.model, 'deepseek-flash');
  assert.ok(s.costUsd > 0);
});
