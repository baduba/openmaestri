import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/server.js';
import { readUserEnv } from '../src/terminals.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.sh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timeout'); await sleep(50); } };

async function run(core, id, line) {
  const marker = `__M${Math.random().toString(36).slice(2)}__`;
  const from = core.terminals.cursorLine(id);
  core.terminals.write(id, `${line}; echo ${marker}\r`);
  await until(() => core.terminals.text(id, { fromLine: from }).split('\n').some((l) => l.trim() === marker));
  const lines = core.terminals.text(id, { fromLine: from }).split('\n');
  // output sits between the line that echoes our command (contains the marker but is not only the marker) and the bare marker line
  const end = lines.findIndex((l) => l.trim() === marker);
  const echoed = lines.slice(0, end).findLastIndex((l) => l.includes(marker));
  return lines.slice(echoed + 1, end).join('\n');
}

/** A daemon in a temporary folder, with its active workspace and a Maestro terminal (not started); closed and removed when the test ends. */
async function startDaemon(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  const maestro = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir });
  return { core, ws, dir, maestro };
}

test('a Maestro recruits workers and coordinates them in parallel', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-orch-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  const maestro = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir });
  core.startTerminal(ws, maestro);
  await sleep(500);

  await run(core, maestro.id, `openmaestri preset create Fake --command '${FAKE} \${OPENMAESTRI_TERMINAL_NAME}'`);
  assert.match(await run(core, maestro.id, 'openmaestri preset list'), /Fake/);
  await run(core, maestro.id, 'openmaestri recruit Alice --preset Fake');
  await run(core, maestro.id, 'openmaestri recruit Bob --preset Fake');
  await until(() => ['Alice', 'Bob'].every((n) => core.terminals.text(ws.nodes.find((x) => x.name === n).id).includes(`[${n}] ready`)));

  const out = await run(core, maestro.id, `openmaestri ask --batch '{"Alice":"task one","Bob":"task two"}' --timeout 20s`);
  const results = JSON.parse(out);
  assert.equal(results.length, 2);
  const byAgent = Object.fromEntries(results.map((r) => [r.agent, r]));
  assert.match(byAgent.Alice.output, /\[Alice\] done: task one/);
  assert.match(byAgent.Bob.output, /\[Bob\] done: task two/);
  // answers are not mixed up between agents
  assert.doesNotMatch(byAgent.Alice.output, /task two/);

  // shared note is visible to the workers the Maestro wires it to
  await run(core, maestro.id, `openmaestri note create 'goal: ship it' --name Goal`);
  await run(core, maestro.id, 'openmaestri connect Goal Alice');
  const aliceId = ws.nodes.find((n) => n.name === 'Alice').id;
  assert.ok(core.store.neighbors(ws, aliceId).some((n) => n.name === 'Goal'));
  assert.match(await run(core, maestro.id, 'openmaestri guide'), /How to orchestrate well/);
});

test('user env file feeds terminals but is not stored in the workspace', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-env-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'env'), '# keys\nexport DEEPSEEK_API_KEY="sk-test-123"\nOPENMAESTRI_DEEPSEEK_MODEL=deepseek-reasoner\n', { mode: 0o600 });
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  const n = core.store.createNode(ws, 'terminal', { name: 'T', cwd: dir });
  core.startTerminal(ws, n);
  await sleep(500);
  assert.equal((await run(core, n.id, 'echo $DEEPSEEK_API_KEY/$OPENMAESTRI_DEEPSEEK_MODEL')).trim(), 'sk-test-123/deepseek-reasoner');
  core.store.flush();
  assert.ok(!fs.readFileSync(core.store.wsFile(ws.id), 'utf8').includes('sk-test-123'));
  assert.deepEqual(readUserEnv('/nonexistent'), {});
});

test('DeepSeek presets ship by default', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-pre-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const names = app.core.store.settings.presets.map((p) => p.name);
  for (const n of ['OpenCode (DeepSeek)', 'Aider (DeepSeek)', 'Maestro (OpenCode + DeepSeek)']) assert.ok(names.includes(n), n);
  const m = app.core.store.settings.presets.find((p) => p.name === 'Maestro (OpenCode + DeepSeek)');
  assert.equal(m.maestro, true);
  assert.match(m.command, /opencode -m "deepseek\//);
});

test('ask waits for a slow agent that shows "esc to interrupt" while its model thinks, instead of returning the echo', async (t) => {
  const { core, ws, dir, maestro } = await startDaemon(t, 'om-slow-');
  const slow = core.store.createNode(ws, 'terminal', { name: 'Slow', cwd: dir, command: `bash -c 'echo booted; read -r q; echo "> $q"; printf "  working  esc to interrupt\\r"; sleep 5; printf "\\033[2K\\rANSWER-42 is the reply\\n"; sleep 30'` });
  core.startTerminal(ws, slow);
  await sleep(500);
  const t0 = Date.now();
  const r = await core.command({ terminalId: maestro.id }, 'ask', { name: 'Slow', prompt: 'what is the answer', timeoutMs: 20000 });
  const took = Date.now() - t0;
  assert.ok(took >= 4500, `returned after ${took} ms, before the agent finished`);
  assert.ok(took < 15000, `waited ${took} ms: it did not notice the agent had finished`);
  assert.match(r.data.output, /ANSWER-42 is the reply/);
  assert.doesNotMatch(r.data.output, /esc to interrupt/);
});

test('ask to a teammate that is still starting waits until its screen is drawn, so the prompt is not lost', async (t) => {
  const { core, ws, dir, maestro } = await startDaemon(t, 'om-boot-');
  // it ignores the keyboard for 3 seconds (a TUI loading), discards what was typed then, and only afterwards reads a line
  const slow = core.store.createNode(ws, 'terminal', { name: 'Late', cwd: dir, command: `bash -c 'sleep 3; read -r -t 0.3 -N 10000 _; echo "ready now"; read -r -t 8 q; echo "got: $q"; sleep 20'` });
  core.startTerminal(ws, slow);
  await sleep(300);
  const r = await core.command({ terminalId: maestro.id }, 'ask', { name: 'Late', prompt: 'hello there', timeoutMs: 20000 });
  assert.match(r.data.output, /got: hello there/);
});

test('an agent terminal gets guards against pagers and editors; a plain shell and a person\'s own values are left alone', async (t) => {
  const { core, ws, dir } = await startDaemon(t, 'om-env-');
  const agent = core.store.createNode(ws, 'terminal', { name: 'Agent', cwd: dir, command: 'echo "pager=$GIT_PAGER editor=$GIT_EDITOR prompt=$GIT_TERMINAL_PROMPT"; sleep 30' });
  core.startTerminal(ws, agent);
  const plain = core.store.createNode(ws, 'terminal', { name: 'Plain', cwd: dir });
  core.startTerminal(ws, plain);
  await sleep(1500);
  core.terminals.write(plain.id, 'echo "pager=[$GIT_PAGER]"\r');
  await sleep(1000);
  assert.match(core.terminals.text(agent.id), /pager=cat editor=true prompt=0/);
  assert.match(core.terminals.text(plain.id), /pager=\[\]/);
});
