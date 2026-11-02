import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { parseAgents, planText, reportText } from '../src/taskrun.js';

const script = (dir, name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 }); return f; };

test('parseAgents: commas or spaces, lowercase, no duplicates', () => {
  assert.deepEqual(parseAgents('Claude, codex  claude'), ['claude', 'codex']);
  assert.deepEqual(parseAgents(['A', 'b']), ['a', 'b']);
  assert.deepEqual(parseAgents(undefined), []);
});

test('report is deterministic, quotes answers and marks failures', () => {
  const results = [
    { driver: 'a', ok: true, text: 'answer A', ms: 1500, floor: { name: 'run a 1', dir: '/x/a', branch: 'floor/run-a-1' } },
    { driver: 'b', ok: false, text: '', stderr: 'boom', ms: 900, exitCode: 2 },
    { driver: 'c', ok: false, problem: 'the floor could not be created: nope' },
    { driver: 'd', ok: false, timedOut: true, text: 'partial', ms: 5000 },
  ];
  const a = reportText({ task: 'do it', results, floors: true });
  assert.equal(a, reportText({ task: 'do it', results, floors: true }));
  assert.match(a, /1 of 4 agents finished, each on its own floor/);
  assert.match(a, /## a: ok \(1\.5s\)\nFloor: run a 1, branch floor\/run-a-1, \/x\/a\n\nanswer A/);
  assert.match(a, /## b: failed \(exit 2\) \(0\.9s\)[\s\S]*stderr: boom/);
  assert.match(a, /## c: not run\nthe floor could not be created/);
  assert.match(a, /## d: timed out[\s\S]*partial/);
  assert.match(a, /floor land NAME/);
  assert.match(reportText({ task: 'x', results: [{ driver: 'a', ok: true, text: 'y'.repeat(7000), ms: 1 }], floors: false }), /\[cut: 1000 more characters\]/);
  assert.match(planText({ task: 't', agents: ['a'], floors: false }), /same folder/);
});

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-run-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  const proj = path.join(dir, 'proj'); fs.mkdirSync(proj);
  ws.dir = proj;
  const good = script(dir, 'good', 'echo "good ran in $PWD"; echo "changed" > "$PWD/by-good.txt"');
  const bad = script(dir, 'bad', 'echo nope >&2; exit 4');
  const slow = script(dir, 'slow', 'sleep 30');
  core.store.settings.drivers = {
    good: { bin: good, args: ['{prompt}'] },
    good2: { bin: good, args: ['{prompt}'] },
    bad: { bin: bad, args: ['{prompt}'] },
    slow: { bin: slow, args: ['{prompt}'] },
    ghost: { bin: path.join(dir, 'does-not-exist'), args: ['{prompt}'] },
  };
  const boss = core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, command: '' });
  const worker = core.store.createNode(ws, 'terminal', { name: 'Worker', maestro: false, command: '' });
  const run = (me, args) => core.command({ terminalId: me.id }, 'run', args);
  return { dir, proj, core, ws, boss, worker, run };
}

test('run: dry run starts nothing and creates nothing', async (t) => {
  const { proj, core, ws, boss, run } = await setup(t);
  const before = ws.nodes.length;
  const out = await run(boss, { task: 'refactor it', agents: 'good,good2', dryRun: true });
  assert.match(out.text, /Agents \(2\): good, good2/);
  assert.match(out.text, /Dry run: nothing was started/);
  assert.equal(ws.nodes.length, before);
  assert.equal(core.headless.size, 0);
  assert.equal(fs.existsSync(path.join(proj, 'by-good.txt')), false);
});

test('run: refuses bad requests before starting', async (t) => {
  const { worker, boss, run } = await setup(t);
  await assert.rejects(run(worker, { task: 'x', agents: 'good' }), /only available to Maestro/);
  await assert.rejects(run(boss, { task: '', agents: 'good' }), /usage: run/);
  await assert.rejects(run(boss, { task: 'x', agents: '' }), /usage: run/);
  await assert.rejects(run(boss, { task: 'x', agents: 'good,nope' }), /no driver named "nope"/);
  await assert.rejects(run(boss, { task: 'x', agents: 'good,ghost' }), /"[^"]*does-not-exist" \(driver ghost\) was not found/);
  await assert.rejects(run(boss, { task: 'x', agents: 'a,b,c,d,e,f,g' }), /at most 6 agents/);
  await assert.rejects(run(boss, { task: 'x', agents: 'good', floors: true }), /needs the workspace folder to be a git repository/);
});

test('run: agents work in parallel in one folder, a failure does not hide the others, the report is a connected note', async (t) => {
  const { proj, core, ws, boss, run } = await setup(t);
  const out = await run(boss, { task: 'summarise', agents: 'good,bad' });
  assert.match(out.text, /1 of 2 agents finished/);
  assert.match(out.text, /## good: ok/);
  assert.match(out.text, /## bad: failed \(exit 4\)[\s\S]*stderr: nope/);
  assert.ok(out.text.includes(`good ran in ${fs.realpathSync(proj)}`));
  const note = ws.nodes.find((n) => n.kind === 'note' && n.name.startsWith('Run '));
  assert.ok(note, 'the report is on the canvas');
  assert.match(core.store.readNote(ws.id, note.id), /# Run: summarise/);
  assert.ok(core.store.neighbors(ws, boss.id).some((n) => n.id === note.id), 'and connected to the Maestro');
  assert.equal(core.headless.size, 0);
  await assert.rejects(run(boss, { task: 'x', agents: 'bad' }), /0 of 1 agents finished/, 'when every agent fails the command fails too');
});

test('run --floors: each agent gets its own git worktree and branch, the main folder stays clean', async (t) => {
  const { proj, ws, boss, run } = await setup(t);
  const git = (...a) => execFileSync('git', a, { cwd: proj, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(proj, 'a.txt'), 'a'); git('add', '.'); git('commit', '-qm', 'init');
  const out = await run(boss, { task: 'edit things', agents: 'good,good2', floors: true });
  assert.match(out.text, /2 of 2 agents finished, each on its own floor/);
  assert.equal(ws.floors.length, 2);
  const dirs = ws.floors.map((f) => f.dir);
  assert.notEqual(dirs[0], dirs[1]);
  for (const f of ws.floors) {
    assert.equal(fs.readFileSync(path.join(f.dir, 'by-good.txt'), 'utf8').trim(), 'changed', `${f.name} edited its own copy`);
    assert.match(f.branch, /^floor\/run-/);
  }
  assert.equal(fs.existsSync(path.join(proj, 'by-good.txt')), false, 'the main folder was not touched');
  assert.match(out.text, /floor land NAME/);
});

test('run: too many one-shot agents at once is refused', async (t) => {
  const { core, boss, run } = await setup(t);
  for (let i = 0; i < 5; i += 1) core.headless.add(new AbortController());
  await assert.rejects(run(boss, { task: 'x', agents: 'good,good2' }), /5 one-shot agents are already running/);
  core.headless.clear();
});

test('run: a program that lives inside the project is refused (a repo cannot shadow an agent CLI)', async (t) => {
  const { proj, core, boss, run } = await setup(t);
  const planted = script(proj, 'planted', 'echo pwned');
  core.store.settings.drivers = { evil: { bin: planted, args: ['{prompt}'] } };
  await assert.rejects(run(boss, { task: 'x', agents: 'evil' }), /inside the project/);
  await assert.rejects(core.command({ terminalId: boss.id }, 'agent.run', { driver: 'evil', prompt: 'x' }), /inside the project/);
  const link = path.join(path.dirname(proj), 'innocent');
  fs.symlinkSync(planted, link);
  core.store.settings.drivers = { evil: { bin: link, args: ['{prompt}'] } };
  await assert.rejects(run(boss, { task: 'x', agents: 'evil' }), /inside the project/, 'a link from outside into the project is followed');
});

test('run: two runs started together cannot both pass the concurrency limit', async (t) => {
  const { dir, core, boss, run } = await setup(t);
  const hold = script(dir, 'hold', 'sleep 1');
  core.store.settings.drivers = { a: { bin: hold, args: ['{prompt}'] }, b: { bin: hold, args: ['{prompt}'] }, c: { bin: hold, args: ['{prompt}'] }, d: { bin: hold, args: ['{prompt}'] } };
  const first = run(boss, { task: 'x', agents: 'a,b,c,d' });
  const second = run(boss, { task: 'y', agents: 'a,b,c' });
  const settled = await Promise.allSettled([first, second]);
  assert.equal(settled[0].status, 'fulfilled');
  assert.equal(settled[1].status, 'rejected');
  assert.match(String(settled[1].reason.message), /already running/);
  assert.equal(core.headless.size, 0);
});
