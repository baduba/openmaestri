import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { runHook, describeHook, checkCommand } from '../src/hooks.js';
import { Scheduler } from '../src/routines.js';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: ENV, stdio: 'pipe', encoding: 'utf8' }).trim();
const mk = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-hook-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('checkCommand', () => {
  assert.equal(checkCommand('  npm test '), 'npm test');
  for (const bad of ['', '   ', 'x'.repeat(501), 'a\0b', null, 5]) assert.throws(() => checkCommand(bad), /at most 500/);
});

test('runHook: exit codes, output tail, cwd, no input, no keys in the environment', async (t) => {
  const dir = mk(t);
  process.env.SOME_SECRET_TOKEN = 'must-not-leak';
  t.after(() => { delete process.env.SOME_SECRET_TOKEN; });
  const ok = await runHook('pwd; echo "tok=[$SOME_SECRET_TOKEN] om=[$OPENMAESTRI_HOOK]"; read -r x && echo got-input || echo no-input', { cwd: dir });
  assert.equal(ok.ok, true);
  assert.ok(ok.output.includes(fs.realpathSync(dir)));
  assert.match(ok.output, /tok=\[\] om=\[1\]/);
  assert.match(ok.output, /no-input/);
  const bad = await runHook('echo line1; echo oops >&2; exit 3', { cwd: dir });
  assert.deepEqual([bad.ok, bad.exitCode], [false, 3]);
  assert.match(describeHook('post-agent', bad), /post-agent hook FAILED \(exit 3\) in [\d.]+s\nline1\noops/);
  assert.match(describeHook('pre-land', ok), /^pre-land hook passed in/);
  const loud = await runHook('head -c 100000 /dev/zero | tr "\\0" "a"', { cwd: dir });
  assert.ok(loud.output.length <= 4096);
});

test('runHook: a time limit stops the command and what it started', async (t) => {
  const dir = mk(t);
  const marker = path.join(dir, 'child-alive');
  process.env.OPENMAESTRI_HOOK_TIMEOUT_MS = '1000';
  t.after(() => { delete process.env.OPENMAESTRI_HOOK_TIMEOUT_MS; });
  const r = await runHook(`(sleep 1.6; touch ${marker}) & sleep 30`, { cwd: dir });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.match(describeHook('x', r), /timed out/);
  await new Promise((res) => setTimeout(res, 2000));
  assert.equal(fs.existsSync(marker), false);
});

async function setup(t) {
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
  const dir = mk(t);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  const proj = path.join(dir, 'proj'); fs.mkdirSync(proj);
  git(proj, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(proj, 'a.txt'), 'a'); git(proj, 'add', '.'); git(proj, 'commit', '-qm', 'init');
  ws.dir = proj;
  const toolDir = mk(t);
  const agent = path.join(toolDir, 'agent'); fs.writeFileSync(agent, '#!/usr/bin/env bash\necho broken > "$PWD/agent.txt"\necho done\n', { mode: 0o755 });
  const failing = path.join(toolDir, 'failing'); fs.writeFileSync(failing, '#!/usr/bin/env bash\necho nope >&2; exit 2\n', { mode: 0o755 });
  core.store.settings.drivers = { agent: { bin: agent, args: ['{prompt}'] }, failing: { bin: failing, args: ['{prompt}'] } };
  const boss = core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, command: '' });
  const worker = core.store.createNode(ws, 'terminal', { name: 'Worker', maestro: false, command: '' });
  const cmd = (me, name, args = {}) => core.command({ terminalId: me.id }, name, args);
  return { proj, core, ws, boss, worker, cmd };
}

test('floor hooks: set, show, clear; ground and bad commands refused; Maestro only', async (t) => {
  const { boss, worker, cmd, core } = await setup(t);
  await cmd(boss, 'floor.create', { name: 'Work' });
  await assert.rejects(cmd(worker, 'floor.hooks', { name: 'Work' }), /only available to Maestro/);
  await assert.rejects(cmd(boss, 'floor.hooks', { name: 'Ground', postAgent: 'true' }), /ground floor has none/);
  await assert.rejects(cmd(boss, 'floor.hooks', { name: 'Work', postAgent: 'x'.repeat(600) }), /at most 500/);
  assert.match((await cmd(boss, 'floor.hooks', { name: 'Work' })).text, /after each agent: \(none\)/);
  const set = await cmd(boss, 'floor.hooks', { name: 'Work', postAgent: 'npm test', preLand: 'npm run lint', rollbackOnFail: true });
  assert.match(set.text, /after each agent: npm test\nbefore landing: npm run lint\nroll the files back when the after-agent hook fails: yes/);
  await cmd(boss, 'floor.hooks', { name: 'Work', clear: true });
  assert.deepEqual((await cmd(boss, 'floor.hooks', { name: 'Work' })).data, {});
  assert.ok(core.audit.read(10).some((e) => e.event === 'floor.hooks'));
});

test('run --floors: a passing hook is reported; a failing one keeps the files unless rollback is asked for; no hook after a failed agent', async (t) => {
  const { core, ws, boss, cmd } = await setup(t);
  await cmd(boss, 'floor.create', { name: 'Keep' });
  // run creates its own floors, so set the hooks through the workspace default created per run: use the floor created by run
  const runWith = async (hooks, agents = 'agent') => {
    const orig = core.doFloorCreate.bind(core);
    core.doFloorCreate = async (w, spec) => { const made = await orig(w, spec); Object.assign(w.floors.find((f) => f.name === spec.name), { hooks }); return made; };
    try { return await cmd(boss, 'run', { task: 'go', agents, floors: true }); } finally { core.doFloorCreate = orig; }
  };
  const passed = await runWith({ postAgent: 'test -f agent.txt' });
  assert.match(passed.text, /post-agent hook passed in/);
  const kept = await runWith({ postAgent: 'echo checks-failed; exit 1' });
  assert.match(kept.text, /post-agent hook FAILED \(exit 1\)[\s\S]*checks-failed/);
  const keptFloor = ws.floors.filter((f) => f.name.startsWith('run agent')).at(-1);
  assert.ok(fs.existsSync(path.join(keptFloor.dir, 'agent.txt')), 'without rollback the agent\'s work stays');
  const rolled = await runWith({ postAgent: 'exit 1', rollbackOnFail: true });
  assert.match(rolled.text, /The files were rolled back to before the agent/);
  const rolledFloor = ws.floors.filter((f) => f.name.startsWith('run agent')).at(-1);
  assert.equal(fs.existsSync(path.join(rolledFloor.dir, 'agent.txt')), false, 'the agent\'s file is gone');
  assert.match(rolled.text, /Snapshot \d{17}/, 'its work is still in the after snapshot');
  const skipped = await runWith({ postAgent: 'echo should-not-run' }, 'failing').catch((e) => e.message);
  assert.doesNotMatch(String(skipped), /post-agent hook/);
});

test('floor land: a failing pre-land hook stops it, --no-hooks overrides, a passing one lands', async (t) => {
  const { proj, boss, cmd } = await setup(t);
  const made = await cmd(boss, 'floor.create', { name: 'Work' });
  fs.writeFileSync(path.join(made.data.dir, 'feature.txt'), 'f'); git(made.data.dir, 'add', '.'); git(made.data.dir, 'commit', '-qm', 'feature');
  await cmd(boss, 'floor.hooks', { name: 'Work', preLand: 'echo lint-error; exit 1' });
  await assert.rejects(cmd(boss, 'floor.land', { name: 'Work', keepFloor: true }), /pre-land hook FAILED \(exit 1\)[\s\S]*lint-error[\s\S]*Nothing was landed/);
  assert.equal(fs.existsSync(path.join(proj, 'feature.txt')), false, 'nothing reached the main branch');
  await cmd(boss, 'floor.hooks', { name: 'Work', preLand: 'test -f feature.txt' });
  const landed = await cmd(boss, 'floor.land', { name: 'Work', keepFloor: true });
  assert.match(landed.text, /landed Work/);
  assert.equal(fs.existsSync(path.join(proj, 'feature.txt')), true);
  const again = await cmd(boss, 'floor.create', { name: 'Other' });
  fs.writeFileSync(path.join(again.data.dir, 'other.txt'), 'o'); git(again.data.dir, 'add', '.'); git(again.data.dir, 'commit', '-qm', 'other');
  await cmd(boss, 'floor.hooks', { name: 'Other', preLand: 'exit 1' });
  assert.match((await cmd(boss, 'floor.land', { name: 'Other', keepFloor: true, noHooks: true })).text, /landed Other/);
});

test('routine history: outcome, trigger and failure are kept, the last 20 only', async () => {
  const fired = [];
  let fail = false;
  const sched = new Scheduler({ workspaces: () => [], fire: (_ws, _r, text) => { if (fail) throw new Error('terminal is gone'); fired.push(text); }, changed: () => {} });
  const ws = { dir: os.tmpdir(), routines: [] };
  const r = sched.create(ws, { name: 'R', terminalId: 't', command: 'hello {{output}}', schedule: { kind: 'every', ms: 60000 }, preRun: 'echo from-pre' });
  await sched.runNow(ws, r, 'manual');
  await sched.runNow(ws, r, 'schedule');
  fail = true;
  await assert.rejects(sched.runNow(ws, r, 'schedule'), /terminal is gone/);
  assert.deepEqual(r.history.map((h) => [h.trigger, h.ok]), [['manual', true], ['schedule', true], ['schedule', false]]);
  assert.equal(r.history[2].error, 'terminal is gone');
  assert.equal(r.history[0].preRun, 'ok');
  assert.deepEqual(fired, ['hello from-pre', 'hello from-pre']);
  fail = false;
  for (let i = 0; i < 25; i += 1) await sched.runNow(ws, r, 'manual');
  assert.equal(r.history.length, 20);
  const bad = sched.create(ws, { name: 'B', terminalId: 't', command: 'x {{output}}', schedule: { kind: 'every', ms: 60000 }, preRun: 'exit 4' });
  await sched.runNow(ws, bad, 'manual');
  assert.equal(bad.history[0].preRun, 'failed');
});

test('routine history through the CLI command', async (t) => {
  const { boss, cmd } = await setup(t);
  await cmd(boss, 'routine.create', { name: 'Ping', command: 'echo hi', terminal: 'Worker', every: '1h' });
  assert.match((await cmd(boss, 'routine.history', { name: 'Ping' })).text, /has not run yet/);
  await cmd(boss, 'routine.run', { name: 'Ping' });
  const h = await cmd(boss, 'routine.history', { name: 'Ping' });
  assert.match(h.text, /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC {2}manual {3}ok +\d+ms/);
  assert.equal(h.data.length, 1);
});
