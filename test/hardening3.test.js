import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { runHook } from '../src/hooks.js';

const dockerPath = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout.trim();
import { explainDocker } from '../src/headless.js';
import { runDoctor, formatDoctor } from '../src/doctor.js';
import { Persist } from '../src/persist.js';

const CLI = path.resolve('bin/openmaestri.js');
const docker = spawnSync('docker', ['image', 'inspect', 'alpine:3'], { stdio: 'ignore' }).status === 0;
const tmuxBin = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
const mk = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-h3-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: ENV, stdio: 'pipe', encoding: 'utf8' }).trim();

test('explainDocker turns Docker\'s long errors into what to do', () => {
  assert.match(explainDocker('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 'node:22'), /service is not running.*systemctl start docker/);
  assert.match(explainDocker('permission denied while trying to connect to the docker API at unix:///var/run/docker.sock', 'node:22'), /docker group/);
  assert.match(explainDocker('Unable to find image \'my/agents:1\' locally\ndocker: Error response from daemon: pull access denied', { image: 'my/agents:1' }), /image my\/agents:1 was not found.*docker pull my\/agents:1/);
  assert.equal(explainDocker('some other failure', 'x'), 'some other failure');
});

test('a hook can run in a container: same folder rule, no host files, no network on request', { skip: docker ? false : 'docker with alpine:3 is not available', timeout: 90000 }, async (t) => {
  const dir = mk(t);
  fs.writeFileSync(path.join(dir, 'in.txt'), 'project file');
  const hostFile = path.join(os.homedir(), '.openmaestri-hook-marker');
  const r = await runHook(`pwd; cat in.txt; test -e ${hostFile} && echo LEAK || echo isolated; id -u`, { cwd: dir, sandbox: 'alpine:3', docker: dockerPath });
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /^\/work$/m);
  assert.match(r.output, /project file/);
  assert.match(r.output, /isolated/);
  assert.ok(r.output.split('\n').includes(String(process.getuid())));
  const offline = await runHook('cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d " "', { cwd: dir, sandbox: { image: 'alpine:3', network: 'none' }, docker: dockerPath });
  assert.equal(offline.output.trim(), 'lo');
  await assert.rejects(async () => runHook('true', { cwd: dir, sandbox: '--privileged', docker: dockerPath }), /sandbox needs an image name/);
  await assert.rejects(async () => runHook('true', { cwd: dir, sandbox: 'alpine:3' }), /needs the path of the docker program/);
});

test('floor hooks: a sandbox can be set for them, shown, and cleared; a run in a container checks in a container', { skip: docker ? false : 'docker with alpine:3 is not available', timeout: 120000 }, async (t) => {
  Object.assign(process.env, ENV);
  const dir = mk(t);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  const proj = path.join(dir, 'proj'); fs.mkdirSync(proj);
  git(proj, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(proj, 'a.txt'), 'a'); git(proj, 'add', '.'); git(proj, 'commit', '-qm', 'init');
  ws.dir = proj;
  core.store.settings.drivers = { boxed: { bin: 'sh', args: ['-c', 'echo made > "$PWD/by-agent.txt"; echo {prompt}'] } };
  const boss = core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, command: '' });
  const cmd = (name, args) => core.command({ terminalId: boss.id }, name, args);
  await cmd('floor.create', { name: 'Work' });
  assert.match((await cmd('floor.hooks', { name: 'Work', sandbox: 'alpine:3' })).text, /run hooks in a container: alpine:3/);
  await assert.rejects(cmd('floor.hooks', { name: 'Work', sandbox: '--privileged' }), /sandbox needs an image name/);
  assert.match((await cmd('floor.hooks', { name: 'Work', sandbox: '' })).text, /run hooks in a container: no/);
  // a run in a container, with a hook that proves where it runs
  const orig = core.doFloorCreate.bind(core);
  core.doFloorCreate = async (w, spec) => { const made = await orig(w, spec); Object.assign(w.floors.find((f) => f.name === spec.name), { hooks: { postAgent: 'test -f by-agent.txt && test "$(pwd)" = /work && echo checked-in-container' } }); return made; };
  const out = await cmd('run', { task: 'go', agents: 'boxed', floors: true, sandbox: 'alpine:3' });
  assert.match(out.text, /post-agent hook passed/, out.text);
  core.doFloorCreate = orig;
});

test('doctor reports Docker, persistent sessions, file permissions and the desktop window', async (t) => {
  const dir = mk(t);
  fs.writeFileSync(path.join(dir, 'accounts.json'), '{}', { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'secrets.json'), '{}', { mode: 0o600 });
  const rows = await runDoctor({ env: { ...process.env, OPENMAESTRI_SECRETS_BACKEND: 'file' }, root: dir, socketPath: path.join(dir, 'none.sock') });
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.ok(byName['Docker (sandbox)']);
  assert.equal(byName['accounts.json permissions'].level, 'warn');
  assert.match(byName['accounts.json permissions'].fix, /chmod 600/);
  assert.equal(byName['secrets.json permissions'].level, 'ok');
  assert.match(byName['Desktop window (Electron)'].detail, /installed/);
  assert.doesNotMatch(formatDoctor(rows), /sk-|secret:\/\/[a-z]/);
});

test('persist list / stop in your own shell, and ps marks terminals kept in tmux', { skip: tmuxBin ? false : 'tmux is not installed', timeout: 60000 }, async (t) => {
  const socket = `omh3${process.pid}${Math.random().toString(36).slice(2, 6)}`;
  Object.assign(process.env, { OPENMAESTRI_PERSIST: 'tmux', OPENMAESTRI_TMUX_SOCKET: socket });
  t.after(() => { delete process.env.OPENMAESTRI_PERSIST; delete process.env.OPENMAESTRI_TMUX_SOCKET; spawnSync(tmuxBin, ['-L', socket, 'kill-server'], { stdio: 'ignore' }); });
  const dir = mk(t);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  const boss = core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, command: '' });
  const keeper = core.store.createNode(ws, 'terminal', { name: 'Keeper', command: 'sleep 60' });
  core.startTerminal(ws, keeper);
  for (const end = Date.now() + 8000; !core.terminals.pidOf(keeper.id) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
  const ps = await core.command({ terminalId: boss.id }, 'ps', {});
  assert.match(ps.text, /Keeper.*\[kept in tmux\]/);
  const env = { ...process.env, OPENMAESTRI_DATA_DIR: path.join(dir, 'data') }; delete env.OPENMAESTRI_SOCKET;
  const cli = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const list = cli(['persist', 'list']);
  assert.ok(list.stdout.startsWith(`${keeper.id}  since `));
  assert.match(list.stdout, /running: /);
  const refused = cli(['persist', 'stop']);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /Run again with --yes/);
  assert.equal(new Persist({ bin: tmuxBin, socket }).sessions().length, 1, 'nothing was ended without --yes');
  assert.match(cli(['persist', 'stop', '--yes']).stdout, /ended 1 session/);
  assert.equal(new Persist({ bin: tmuxBin, socket }).sessions().length, 0);
  assert.equal(cli(['persist', 'list'], { OPENMAESTRI_SOCKET: '/x.sock', OPENMAESTRI_TERMINAL_ID: 'x' }).status, 2, 'refused inside an agent terminal');
  assert.match(fs.readFileSync(path.join(dir, 'data', 'audit.log'), 'utf8'), /persist\.stop/);
});
