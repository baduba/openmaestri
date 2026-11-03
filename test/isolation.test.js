import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../src/server.js';
import { freePortBase, floorVars, PORT_START, PORT_STEP, PORT_SLOTS } from '../src/ports.js';
import { dockerArgs, dockerTerminalCommand } from '../src/headless.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timeout'); await sleep(50); } };
const docker = spawnSync('docker', ['image', 'inspect', 'alpine:3'], { stdio: 'ignore' }).status === 0;
const skipBox = docker ? false : 'docker with the alpine:3 image is not available';

test('port blocks: the first free one, never twice, and a full range says so', () => {
  assert.equal(freePortBase([]), PORT_START);
  assert.equal(freePortBase([PORT_START, PORT_START + PORT_STEP]), PORT_START + 2 * PORT_STEP);
  assert.equal(freePortBase(Array.from({ length: PORT_SLOTS }, (_, i) => PORT_START + i * PORT_STEP)), null);
});

test('floor variables: ground only learns its block, a real floor also gets PORT and its own compose project', () => {
  const ws = { id: 'ABC123-xyz' };
  assert.deepEqual(floorVars(ws, null, 20000), { OPENMAESTRI_FLOOR: 'ground', OPENMAESTRI_PORT_BASE: '20000' });
  const v = floorVars(ws, { name: 'Login Form' }, 20100);
  assert.equal(v.PORT, '20100');
  assert.equal(v.OPENMAESTRI_PORT_BASE, '20100');
  assert.equal(v.COMPOSE_PROJECT_NAME, 'om-abc123-login-form');
});

test('dockerTerminalCommand: a tty, only the folder, one quoted command line', () => {
  const args = dockerArgs({ image: 'alpine:3' }, { name: 'om-t-x', cwd: '/tmp/p', bin: 'sh', args: ['-c', "echo it's"], envNames: ['A_KEY'], tty: true });
  assert.equal(args[1], '-it');
  const line = dockerTerminalCommand({ image: 'alpine:3', network: 'none' }, { name: 'om-t-x', cwd: '/tmp/p q', command: "echo it's", envNames: [], docker: '/usr/bin/docker' });
  assert.match(line, /^'\/usr\/bin\/docker' 'run' '-it'/);
  assert.match(line, /'--network' 'none'/);
  assert.match(line, /'\/tmp\/p q:\/work'/);
  assert.ok(line.includes("'echo it'\\''s'"), 'the agent command is one quoted word');
  assert.doesNotMatch(line, /OPENMAESTRI|\.sock/);
});

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-iso-'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = work;
  const boss = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: work });
  const cmd = (c, a) => core.command({ terminalId: boss.id }, c, a);
  return { core, ws, boss, cmd, work };
}

test('terminals in different floors get different blocks; the ground floor keeps its own PORT', async (t) => {
  const { core, ws, work } = await setup(t);
  const gitq = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: work });
  gitq('init', '-q'); gitq('commit', '-q', '--allow-empty', '-m', 'init');
  await core.command({ terminalId: ws.nodes[0].id }, 'floor.create', { name: 'one' });
  await core.command({ terminalId: ws.nodes[0].id }, 'floor.create', { name: 'two' });
  const [one, two] = ws.floors;
  const e1 = core.floorEnv(ws, one);
  const e2 = core.floorEnv(ws, two);
  const eg = core.floorEnv(ws, null);
  assert.notEqual(e1.OPENMAESTRI_PORT_BASE, e2.OPENMAESTRI_PORT_BASE);
  assert.notEqual(e1.OPENMAESTRI_PORT_BASE, eg.OPENMAESTRI_PORT_BASE);
  assert.equal(core.floorEnv(ws, one).OPENMAESTRI_PORT_BASE, e1.OPENMAESTRI_PORT_BASE, 'stable');
  assert.equal(eg.PORT, undefined);
  assert.notEqual(e1.COMPOSE_PROJECT_NAME, e2.COMPOSE_PROJECT_NAME);
  // a terminal started in floor "one" really sees them
  const node = core.store.createNode(ws, 'terminal', { name: 'W', cwd: one.dir, floorId: one.id });
  core.startTerminal(ws, node);
  await sleep(500);
  core.terminals.write(node.id, 'echo "P=$PORT B=$OPENMAESTRI_PORT_BASE F=$OPENMAESTRI_FLOOR"\r');
  await until(() => core.terminals.text(node.id).includes(`P=${e1.PORT} B=${e1.OPENMAESTRI_PORT_BASE} F=one`));
});

test('a person\'s own PORT is not overwritten', async (t) => {
  const { core, ws, work } = await setup(t);
  const gitq = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: work });
  gitq('init', '-q'); gitq('commit', '-q', '--allow-empty', '-m', 'init');
  await core.command({ terminalId: ws.nodes[0].id }, 'floor.create', { name: 'one' });
  fs.writeFileSync(path.join(core.dataRoot, 'env'), 'PORT=4321\n', { mode: 0o600 });
  const node = core.store.createNode(ws, 'terminal', { name: 'W', cwd: ws.floors[0].dir, floorId: ws.floors[0].id });
  core.startTerminal(ws, node);
  await sleep(500);
  core.terminals.write(node.id, 'echo "P=$PORT"\r');
  await until(() => core.terminals.text(node.id).includes('P=4321'));
});

test('recruit --sandbox refuses the Maestro and a plain shell', async (t) => {
  const { core, ws, cmd } = await setup(t);
  core.store.settings.presets.push({ name: 'Boss', command: 'claude', maestro: true });
  await assert.rejects(cmd('recruit', { name: 'B', preset: 'Boss', sandbox: 'alpine:3' }), /Maestro cannot run in a box/);
  await assert.rejects(cmd('recruit', { name: 'S', preset: 'Shell', sandbox: 'alpine:3' }), /plain shell/);
  await assert.rejects(cmd('recruit', { name: 'S', command: 'x', sandbox: '--privileged' }), /sandbox needs an image/);
  assert.equal(ws.nodes.length, 1);
});

test('a worker in a box sees only its folder, has no daemon variables, and its container goes with it', { skip: skipBox }, async (t) => {
  const { core, ws, cmd, work } = await setup(t);
  fs.writeFileSync(path.join(work, 'visible.txt'), 'in the folder\n');
  process.env.OM_TEST_SECRET = 'host-only';
  t.after(() => { delete process.env.OM_TEST_SECRET; });
  const r = await cmd('recruit', { name: 'Boxed', command: 'sh -c \'echo up; cat visible.txt; env | grep -c OPENMAESTRI; ls /root 2>&1 | head -1; echo "S=${OM_TEST_SECRET:-none}"; while read l; do echo "got: $l"; done\'', sandbox: 'alpine:3', noNetwork: true });
  assert.match(r.text, /Boxed/);
  const node = ws.nodes.find((n) => n.name === 'Boxed');
  assert.equal(node.sandbox.network, 'none');
  await until(() => core.terminals.text(node.id).includes('S=none'));
  const screen = core.terminals.text(node.id);
  assert.match(screen, /in the folder/);
  assert.match(screen, /\n0\r?\n/, 'no OPENMAESTRI_* variable inside');
  assert.doesNotMatch(screen, /host-only/);
  core.terminals.deliver(node.id, 'hello');
  await until(() => core.terminals.text(node.id).includes('got: hello'));
  const name = core.terminals.get(node.id).box.name;
  const alive = () => spawnSync('docker', ['ps', '-q', '--filter', `name=${name}`], { encoding: 'utf8' }).stdout.trim();
  assert.ok(alive(), 'the container is running');
  core.terminals.dispose(node.id);
  await until(() => !alive(), 15000);
});

test('when the agent in a box ends, the pane ends: there is no host shell behind it', { skip: skipBox }, async (t) => {
  const { core, ws, cmd } = await setup(t);
  await cmd('recruit', { name: 'Short', command: 'sh -c "echo bye"', sandbox: 'alpine:3' });
  const node = ws.nodes.find((n) => n.name === 'Short');
  await until(() => core.terminals.get(node.id)?.status === 'exited');
  assert.equal(core.terminals.agentRunning(node.id), false);
});
