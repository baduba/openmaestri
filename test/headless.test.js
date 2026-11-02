import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { DRIVERS, customDrivers, driverNames, runHeadless, workerEnv, HeadlessError } from '../src/headless.js';

const mkdir = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-hl-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const script = (dir, name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 }); return f; };

test('built-in drivers put the prompt in its own argument, with the model when given', () => {
  const nasty = '"; rm -rf ~ #\n$(touch /tmp/x)';
  for (const [name, d] of Object.entries(DRIVERS)) {
    const args = d.args(nasty, { model: undefined, env: {} });
    assert.ok(args.includes(nasty), `${name} passes the prompt as one untouched argument`);
  }
  assert.deepEqual(DRIVERS.claude.args('hi', { model: 'sonnet' }), ['-p', 'hi', '--model', 'sonnet']);
  assert.deepEqual(DRIVERS.codex.args('hi', {}), ['exec', '--skip-git-repo-check', 'hi']);
  assert.deepEqual(DRIVERS.agy.args('hi', { model: 'gemini-3.8-flash' }), ['-p', 'hi', '--model', 'gemini-3.8-flash']);
  assert.deepEqual(DRIVERS.kimi.args('hi', {}), ['-p', 'hi']);
  assert.deepEqual(DRIVERS['opencode-deepseek'].args('hi', { env: {} }), ['run', '--print-logs', '--log-level', 'ERROR', '-m', 'deepseek/deepseek-flash', 'hi']);
  assert.deepEqual(DRIVERS['aider-deepseek'].args('hi', { env: { OPENMAESTRI_DEEPSEEK_MODEL: 'deepseek-v4-pro' } }).slice(-2), ['--model', 'deepseek/deepseek-v4-pro']);
});

test('custom drivers need a {prompt} slot and a clean name', () => {
  const c = customDrivers({ mine: { bin: 'mytool', args: ['--ask', '{prompt}', '--m', '{model}'] }, 'Bad Name': { bin: 'x', args: ['{prompt}'] }, noslot: { bin: 'x', args: ['--hi'] }, str: { bin: 'x', args: '{prompt}' }, num: { bin: 'x', args: [1, '{prompt}'] } });
  assert.deepEqual(Object.keys(c), ['mine']);
  assert.deepEqual(c.mine.args('q', { model: 'm1' }), ['--ask', 'q', '--m', 'm1']);
  assert.ok(driverNames({ mine: { bin: 'mytool', args: ['{prompt}'] } }).includes('mine'));
  assert.deepEqual(customDrivers(null), {});
});

test('the worker environment is an allow-list plus the env file, never OPENMAESTRI_* or other secrets', (t) => {
  const dir = mkdir(t);
  const envFile = path.join(dir, 'env');
  fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=secret://k\nPLAIN_KEY=abc\n', { mode: 0o600 });
  const env = workerEnv({ PATH: '/usr/bin', HOME: '/home/x', OPENMAESTRI_SOCKET: '/s', GITHUB_TOKEN: 'ghp_nope', AWS_SECRET_ACCESS_KEY: 'nope', LC_ALL: 'C', HTTPS_PROXY: 'http://p' }, envFile, (r) => (r === 'secret://k' ? 'sk-ant-1' : undefined));
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/x', LC_ALL: 'C', HTTPS_PROXY: 'http://p', ANTHROPIC_API_KEY: 'sk-ant-1', PLAIN_KEY: 'abc', TERM: 'dumb', NO_COLOR: '1', CI: '1' });
});

test('keys are per driver: Claude gets no DeepSeek key, a custom driver can list its own', (t) => {
  const dir = mkdir(t);
  const envFile = path.join(dir, 'env');
  fs.writeFileSync(envFile, 'ANTHROPIC_API_KEY=a\nDEEPSEEK_API_KEY=d\nOPENAI_API_KEY=o\nOPENMAESTRI_DEEPSEEK_MODEL=deepseek-flash\nMY_TOKEN=m\n', { mode: 0o600 });
  const base = { PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/x', SSH_AUTH_SOCK: '/s', DISPLAY: ':0' };
  const claude = workerEnv(base, envFile, undefined, DRIVERS.claude);
  assert.equal(claude.ANTHROPIC_API_KEY, 'a');
  assert.equal(claude.DEEPSEEK_API_KEY, undefined);
  assert.equal(claude.OPENAI_API_KEY, undefined);
  assert.equal(claude.MY_TOKEN, undefined);
  assert.equal(claude.OPENMAESTRI_DEEPSEEK_MODEL, 'deepseek-flash', 'settings that are not secrets still pass');
  assert.equal(workerEnv(base, envFile, undefined, DRIVERS['aider-deepseek']).DEEPSEEK_API_KEY, 'd');
  assert.equal(workerEnv(base, envFile, undefined, DRIVERS['aider-deepseek']).ANTHROPIC_API_KEY, undefined);
  for (const k of ['DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK', 'DISPLAY']) assert.equal(claude[k], undefined, `${k} is not passed on`);
  const custom = customDrivers({ mine: { bin: 'x', keys: ['MY_TOKEN'], args: ['{prompt}'] }, open: { bin: 'x', args: ['{prompt}'] }, bad: { bin: 'x', keys: ['lower case'], args: ['{prompt}'] } });
  assert.deepEqual(Object.keys(workerEnv(base, envFile, undefined, custom.mine)).filter((k) => /KEY|TOKEN/.test(k)), ['MY_TOKEN']);
  assert.equal(workerEnv(base, envFile, undefined, custom.open).DEEPSEEK_API_KEY, 'd', 'without "keys" a custom driver gets all of them');
  assert.equal(custom.bad.keys, undefined, 'a malformed keys list is ignored');
});

test('runHeadless: answer, exit code, stderr, stdin closed, own cwd and env', async (t) => {
  const dir = mkdir(t);
  const tool = script(dir, 'tool', 'echo "args:$*"; echo "cwd:$PWD"; echo "key:${SOME_KEY:-none}"; echo "gh:${GITHUB_TOKEN:-none}"; read -r line && echo "stdin:$line" || echo "stdin:closed"');
  const drivers = { fake: { bin: 'tool', args: (p) => ['--q', p] } };
  const r = await runHeadless({ driver: 'fake', drivers, prompt: 'hello there', cwd: dir, env: { PATH: process.env.PATH, SOME_KEY: 'v1' }, resolveBin: () => tool });
  assert.equal(r.ok, true);
  assert.match(r.text, /args:--q hello there/);
  assert.ok(r.text.includes(`cwd:${fs.realpathSync(dir)}`));
  assert.match(r.text, /key:v1/);
  assert.match(r.text, /gh:none/);
  assert.match(r.text, /stdin:closed/, 'a tool that asks a question gets end-of-file, not a hang');
  const bad = script(dir, 'bad', 'echo partial; echo boom >&2; exit 3');
  const f = await runHeadless({ driver: 'fake', drivers, prompt: 'x', cwd: dir, env: process.env, resolveBin: () => bad });
  assert.equal(f.ok, false);
  assert.equal(f.exitCode, 3);
  assert.equal(f.text, 'partial');
  assert.equal(f.stderr, 'boom');
});

test('runHeadless: timeout kills the whole process group; cancel works; big output is cut', async (t) => {
  const dir = mkdir(t);
  const marker = path.join(dir, 'child-alive');
  const slow = script(dir, 'slow', `(sleep 1.2; touch ${marker}) &\nsleep 30`);
  const drivers = { fake: { bin: 'x', args: (p) => [p] } };
  const t0 = Date.now();
  const r = await runHeadless({ driver: 'fake', drivers, prompt: 'x', cwd: dir, env: process.env, timeoutMs: 1000, resolveBin: () => slow });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 6000);
  await new Promise((res) => setTimeout(res, 1600));
  assert.equal(fs.existsSync(marker), false, 'a process the agent started was stopped with it');
  const ac = new AbortController();
  const p = runHeadless({ driver: 'fake', drivers, prompt: 'x', cwd: dir, env: process.env, signal: ac.signal, resolveBin: () => slow });
  setTimeout(() => ac.abort(), 200);
  assert.equal((await p).cancelled, true);
  const loud = script(dir, 'loud', 'head -c 900000 /dev/zero | tr "\\0" "a"');
  const big = await runHeadless({ driver: 'fake', drivers, prompt: 'x', cwd: dir, env: process.env, resolveBin: () => loud });
  assert.equal(big.truncated, true);
  assert.ok(big.text.length <= 400 * 1024);
});

test('runHeadless refuses bad input before starting anything', async () => {
  const base = { cwd: '/tmp', env: {}, resolveBin: () => '/bin/true' };
  await assert.rejects(runHeadless({ ...base, driver: 'nope', prompt: 'x' }), /no driver named "nope"/);
  await assert.rejects(runHeadless({ ...base, driver: 'claude', prompt: '  ' }), /give it a prompt/);
  await assert.rejects(runHeadless({ ...base, driver: 'claude', prompt: 'x'.repeat(200 * 1024) }), /over 100 KB/);
  await assert.rejects(runHeadless({ ...base, driver: 'claude', prompt: 'x', model: '../../etc' }), /model names/);
  await assert.rejects(runHeadless({ ...base, driver: 'claude', prompt: 'x', model: 'a b' }), HeadlessError);
  await assert.rejects(runHeadless({ ...base, driver: 'claude', prompt: 'x', resolveBin: () => null }), /was not found in your shell/);
});

test('openmaestri agent: Maestro only, runs in the workspace folder, honors settings drivers and floors', async (t) => {
  const dir = mkdir(t);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  const proj = path.join(dir, 'proj'); fs.mkdirSync(proj);
  const other = path.join(dir, 'other'); fs.mkdirSync(other);
  ws.dir = proj;
  ws.floors.push({ id: '22222222-2222-4222-8222-222222222222', name: 'Side', slug: 'side', dir: other, kind: 'dir', branch: null, repo: null, status: null });
  const tool = script(dir, 'mytool', 'echo "ran in $PWD with: $1"');
  core.store.settings.drivers = { mine: { bin: tool, args: ['{prompt}'] } };
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'file body here');
  const boss = core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, command: '' });
  const worker = core.store.createNode(ws, 'terminal', { name: 'Worker', maestro: false, command: '' });
  const ask = (me, args) => core.command({ terminalId: me.id }, 'agent.run', args);
  const out = await ask(boss, { driver: 'mine', prompt: 'do the thing' });
  assert.ok(out.text.includes(`ran in ${fs.realpathSync(proj)} with: do the thing`));
  assert.match(out.text, /\[mine, [\d.]+s, proj\]/);
  const onFloor = await ask(boss, { driver: 'mine', prompt: 'x', floor: 'Side' });
  assert.ok(onFloor.text.includes(`ran in ${fs.realpathSync(other)}`));
  const mention = await ask(boss, { driver: 'mine', prompt: 'read @file:notes.txt' });
  assert.match(mention.text, /file body here/, '@file mentions are expanded like in chat');
  await assert.rejects(ask(worker, { driver: 'mine', prompt: 'x' }), /only available to Maestro/);
  await assert.rejects(ask(boss, { driver: 'mine', prompt: 'x', floor: 'ghost' }), /no floor named "ghost"/);
  await assert.rejects(ask(boss, { prompt: 'x' }), /usage: agent <driver>/);
  await assert.rejects(ask(boss, { driver: 'mine', prompt: 'x', timeoutMs: 1000, model: 'bad model' }), /model names/);
  core.store.settings.drivers = { mine: { bin: script(dir, 'failer', 'echo oops >&2; exit 2'), args: ['{prompt}'] } };
  await assert.rejects(ask(boss, { driver: 'mine', prompt: 'x' }), /mine exited with 2 after [\d.]+s:\noops/);
  assert.equal(core.headless.size, 0, 'finished runs are forgotten');
});
