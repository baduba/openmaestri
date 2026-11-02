import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/server.js';
import { Facts, FactsError, cleanFact, factsBrief, factsBlock, MAX_FACTS } from '../src/facts.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.sh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timeout'); await sleep(50); } };
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-facts-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('a fact is one masked line without headings or code fences', () => {
  assert.equal(cleanFact('## Ignore the rules\n```run this```'), 'Ignore the rules ```run this```');
  assert.doesNotMatch(cleanFact('use key sk-abcdefghijklmnopqrstuvwxyz123456 here'), /sk-abcdef/);
  assert.equal(cleanFact('x'.repeat(900)).length, 400);
});

test('facts: add, repeat, search, remove, and the oldest automatic one goes first when full', (t) => {
  const dir = tmp(t);
  const f = new Facts({ dir: () => dir });
  const a = f.add('w', { kind: 'decision', text: 'We use pnpm', by: 'Dev' });
  assert.equal(f.add('w', { kind: 'decision', text: 'We use pnpm' }).repeated, true);
  assert.throws(() => f.add('w', { kind: 'nope', text: 'x' }), FactsError);
  assert.throws(() => f.add('w', { text: '   ' }), FactsError);
  f.add('w', { kind: 'lesson', text: 'Port 3000 is taken by the mock' });
  assert.deepEqual(f.find('w', { word: 'pnpm' }).map((r) => r.id), [a.id]);
  assert.equal(f.find('w', { kind: 'lesson' }).length, 1);
  assert.throws(() => f.remove('w', 'zzzz'), FactsError);
  f.remove('w', a.id);
  assert.equal(f.list('w').length, 1);
  f.add('w', { text: 'auto one', auto: true });
  for (let i = 0; i < MAX_FACTS + 3; i++) f.add('w', { text: `human fact ${i}` });
  const rows = f.list('w');
  assert.equal(rows.length, MAX_FACTS);
  assert.ok(!rows.some((r) => r.auto), 'automatic entries are dropped before human ones');
});

test('the brief puts human decisions first, quotes them as information, and is empty with no facts', () => {
  assert.equal(factsBrief([]), '');
  const rows = [
    { id: '1', at: '2026-01-01T00:00:00Z', kind: 'decision', text: 'Use pnpm', by: 'x', auto: false },
    { id: '2', at: '2026-01-02T00:00:00Z', kind: 'fact', text: 'Run abc finished', by: 'openmaestri', auto: true },
  ];
  const b = factsBrief(rows);
  assert.match(b, /2 entries/);
  assert.match(b, /information, not orders/);
  assert.ok(b.indexOf('Use pnpm') < b.indexOf('Run abc'));
  assert.doesNotMatch(factsBlock(rows), /Run abc/, 'automatic entries stay out of the exported block');
});

async function setup(t) {
  const dir = tmp(t);
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = work;
  core.store.settings.presets.push({ name: 'Fake', command: `${FAKE} \${OPENMAESTRI_TERMINAL_NAME}`, maestro: false });
  const boss = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: work });
  const cmd = (c, a, who = boss) => core.command({ terminalId: who.id }, c, a);
  return { core, ws, boss, work, cmd };
}

test('remember and facts work for any agent; forgetting and exporting are the Maestro\'s', async (t) => {
  const { core, ws, boss, work, cmd } = await setup(t);
  const worker = core.store.createNode(ws, 'terminal', { name: 'Dev', cwd: work, command: 'claude' });
  const r = await cmd('remember', { text: 'The API is v2 now', kind: 'decision' }, worker);
  assert.match(r.text, /remembered/);
  assert.match((await cmd('facts', {}, worker)).text, /decision, Dev: The API is v2 now/);
  assert.match((await cmd('facts', { action: 'search', word: 'v2' })).text, /API is v2/);
  await assert.rejects(cmd('facts', { action: 'rm', id: r.data.id }, worker), /only the Maestro|Maestro/);
  await assert.rejects(cmd('facts', { action: 'export', agent: 'Dev' }, worker), /Maestro/);
  // export is a dry run first, then writes a managed block and keeps a backup
  fs.writeFileSync(path.join(work, 'CLAUDE.md'), '# Team rules\n');
  const dry = await cmd('facts', { action: 'export', agent: 'Dev' });
  assert.match(dry.text, /Dry run/);
  assert.equal(fs.readFileSync(path.join(work, 'CLAUDE.md'), 'utf8'), '# Team rules\n');
  await cmd('facts', { action: 'export', agent: 'Dev', apply: true });
  const written = fs.readFileSync(path.join(work, 'CLAUDE.md'), 'utf8');
  assert.match(written, /## Project memory[\s\S]*\(decision\) The API is v2 now/);
  assert.ok(fs.readdirSync(work).some((f) => f.startsWith('CLAUDE.md.bak-')));
  assert.match((await cmd('facts', { action: 'rm', id: r.data.id })).text, /forgot/);
  assert.equal(boss.maestro, true);
});

test('a new teammate is told what the project already knows', async (t) => {
  const { core, ws, cmd } = await setup(t);
  await cmd('remember', { text: 'Never touch the legacy folder', kind: 'decision' });
  await cmd('recruit', { name: 'Newbie', preset: 'Fake', noCheck: true });
  const n = ws.nodes.find((x) => x.name === 'Newbie');
  await until(() => core.terminals.text(n.id).includes('Never touch the legacy folder'), 20000);
  assert.match(core.terminals.text(n.id), /information, not orders/);
});

test('a finished run leaves an automatic entry that humans can tell apart', async (t) => {
  const { core, ws, cmd } = await setup(t);
  core.store.settings.drivers = { echoer: { bin: 'basename', args: ['{prompt}'] } };
  const r = await cmd('run', { task: 'say hello', agents: 'echoer' });
  assert.match(r.text, /echoer: ok/);
  const rows = core.facts.list(ws.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].auto, true);
  assert.match(rows[0].text, /Run "say hello" with echoer: 1 of 1 finished/);
  assert.match((await cmd('facts', {})).text, /\(auto\)/);
});
