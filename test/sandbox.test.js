import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { checkSandbox, dockerArgs, customDrivers, runHeadless } from '../src/headless.js';

const docker = spawnSync('docker', ['image', 'inspect', 'alpine:3'], { stdio: 'ignore' }).status === 0;
const skip = docker ? false : 'docker with the alpine:3 image is not available';
const mk = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-box-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('checkSandbox: an image name, bridge or none, a memory size; nothing else', () => {
  assert.deepEqual(checkSandbox('node:22'), { image: 'node:22', network: 'bridge', memory: '2g' });
  assert.deepEqual(checkSandbox({ image: 'my/agents:latest', network: 'none', memory: '512m' }), { image: 'my/agents:latest', network: 'none', memory: '512m' });
  for (const bad of ['', '-v /:/host', '--privileged', 'a b', 'img;rm -rf /', '../x', { image: 'ok', network: 'host' }, { image: 'ok', memory: 'lots' }, null, 5]) assert.throws(() => checkSandbox(bad), /sandbox/, JSON.stringify(bad));
});

test('dockerArgs: only the folder is shared, privileges dropped, variables by name, prompt as one argument', () => {
  const a = dockerArgs({ image: 'node:22', network: 'none', memory: '1g' }, { name: 'om-x', cwd: '/proj', bin: 'claude', args: ['-p', '"; rm -rf / #'], envNames: ['ANTHROPIC_API_KEY', 'PATH', 'HOME', 'bad name', 'TERM'] });
  assert.equal(a[0], 'run');
  for (const flag of ['--rm', '--init', '--cap-drop', 'ALL', 'no-new-privileges', '--pids-limit']) assert.ok(a.includes(flag), flag);
  assert.equal(a[a.indexOf('--network') + 1], 'none');
  assert.equal(a[a.indexOf('-v') + 1], '/proj:/work');
  assert.ok(a.includes('ANTHROPIC_API_KEY') && a.includes('TERM'));
  assert.ok(!a.includes('PATH') && !a.includes('bad name') && !a.includes('--privileged'));
  assert.ok(!a.some((x) => /^(ANTHROPIC_API_KEY)=/.test(x)), 'a value never appears on the command line');
  assert.deepEqual(a.slice(a.indexOf('node:22')), ['node:22', 'claude', '-p', '"; rm -rf / #']);
  assert.match(a[a.indexOf('--user') + 1], /^\d+:\d+$/);
});

test('custom drivers can carry a sandbox; a bad one is dropped', () => {
  const c = customDrivers({ boxed: { bin: 'tool', sandbox: 'node:22', args: ['{prompt}'] }, bad: { bin: 'tool', sandbox: '--privileged', args: ['{prompt}'] } });
  assert.deepEqual(Object.keys(c), ['boxed']);
  assert.equal(c.boxed.sandbox.image, 'node:22');
});

test('the sandbox needs docker, and says so', async () => {
  await assert.rejects(runHeadless({ driver: 'claude', prompt: 'x', cwd: '/tmp', env: {}, sandbox: 'node:22', resolveBin: () => null }), /"docker" was not found/);
});

test('in a container: the folder is shared, the host is not, variables are passed by name, no network on request, a timeout kills it', { skip, timeout: 120000 }, async (t) => {
  const dir = mk(t);
  fs.writeFileSync(path.join(dir, 'in.txt'), 'from the host');
  const hostSecret = path.join(os.homedir(), '.openmaestri-test-marker');
  const drivers = { sh: { bin: 'sh', keys: undefined, args: (p) => ['-c', p] } };
  const resolveBin = (b) => spawnSync('sh', ['-c', `command -v ${b}`], { encoding: 'utf8' }).stdout.trim() || null;
  const env = { PATH: process.env.PATH, HOME: os.homedir(), BOXED_VALUE: 'value-from-env', NOT_LISTED: undefined };
  const run = (prompt, extra = {}) => runHeadless({ driver: 'sh', drivers, prompt, cwd: dir, env, sandbox: { image: 'alpine:3', ...extra }, resolveBin, timeoutMs: 20000 });

  const r = await run('pwd; cat in.txt; echo "v=$BOXED_VALUE"; echo "home=$HOME"; id -u; echo made > out.txt; ls /root /home 2>&1 | head -3');
  assert.equal(r.ok, true, r.stderr);
  assert.match(r.text, /^\/work$/m);
  assert.match(r.text, /from the host/);
  assert.match(r.text, /v=value-from-env/);
  assert.match(r.text, /home=\/tmp/);
  assert.ok(r.text.split("\n").includes(String(process.getuid())));
  assert.equal(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8').trim(), 'made', 'files written in /work reach the host folder');
  assert.equal(fs.statSync(path.join(dir, 'out.txt')).uid, process.getuid(), 'and belong to you, not to root');

  const host = await run(`ls ${os.homedir()} 2>&1 | head -1; test -e ${hostSecret} && echo LEAK || echo isolated`);
  assert.match(host.text, /isolated/);

  const offline = await run('cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d " "', { network: 'none' });
  assert.equal(offline.text.trim(), 'lo', 'only the loopback exists');

  const t0 = Date.now();
  const slow = await runHeadless({ driver: 'sh', drivers, prompt: 'sleep 60', cwd: dir, env, sandbox: { image: 'alpine:3' }, resolveBin, timeoutMs: 2000 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - t0 < 15000);
  await new Promise((r2) => setTimeout(r2, 1500));
  const left = spawnSync('docker', ['ps', '-q', '--filter', 'name=om-'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(left, '', 'no container is left running after the time limit');
});

test('agent --sandbox through the core: preflight skips the host program, docker is required', { skip, timeout: 120000 }, async (t) => {
  const dir = mk(t);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  const proj = path.join(dir, 'proj'); fs.mkdirSync(proj);
  ws.dir = proj;
  core.store.settings.drivers = { boxed: { bin: 'sh', args: ['-c', '{prompt}'] } };
  const boss = core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, command: '' });
  const cmd = (name, args) => core.command({ terminalId: boss.id }, name, args);
  const out = await cmd('agent.run', { driver: 'boxed', prompt: 'echo inside $(pwd)', sandbox: 'alpine:3' });
  assert.match(out.text, /inside \/work/);
  const offline = await cmd('run', { task: 'echo online-or-not; cat /proc/net/dev | wc -l', agents: 'boxed', sandbox: 'alpine:3', noNetwork: true });
  assert.match(offline.text, /1 of 1 agents finished/);
  await assert.rejects(cmd('agent.run', { driver: 'boxed', prompt: 'x', sandbox: '--privileged' }), /sandbox needs an image name/);
});
