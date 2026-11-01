import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Secrets, SecretError, refName, validName } from '../src/secrets.js';
import { readUserEnv } from '../src/terminals.js';
import { runDoctor, formatDoctor } from '../src/doctor.js';

const CLI = path.resolve('bin/openmaestri.js');
const mk = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-sec-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const fileStore = (root) => new Secrets({ root, env: { OPENMAESTRI_SECRETS_BACKEND: 'file' } });

test('names: only simple lowercase names, no traversal', () => {
  assert.equal(validName('deepseek'), 'deepseek');
  for (const bad of ['', 'A', '../x', 'a/b', '.hidden', 'a b', 'x'.repeat(65), null]) assert.throws(() => validName(bad), SecretError, String(bad));
  assert.equal(refName('secret://anthropic'), 'anthropic');
  assert.equal(refName('secret://../x'), null);
  assert.equal(refName('plain'), null);
});

test('file backend: set, resolve, list, remove, mode 0600, names only in listings', (t) => {
  const root = mk(t);
  const s = fileStore(root);
  s.set('deepseek', 'sk-test-123\n');
  s.set('openai', 'sk-other');
  assert.equal(s.resolve('secret://deepseek'), 'sk-test-123', 'the trailing newline from a pipe is dropped');
  assert.equal(s.resolve('secret://missing'), undefined);
  assert.equal(s.resolve('not-a-ref'), undefined);
  assert.deepEqual(s.list(), ['deepseek', 'openai']);
  assert.equal(fs.statSync(path.join(root, 'secrets.json')).mode & 0o777, 0o600);
  assert.equal(s.remove('openai'), true);
  assert.equal(s.remove('openai'), false);
  assert.throws(() => s.set('x', ''), /needs a value/);
  assert.throws(() => s.set('x', 'a\nb'), /one line/);
  assert.throws(() => s.set('x', 'z'.repeat(20000)), /too long/);
});

test('file backend: a corrupt file is reported, never silently replaced', (t) => {
  const root = mk(t);
  fs.writeFileSync(path.join(root, 'secrets.json'), '{not json', { mode: 0o600 });
  const s = fileStore(root);
  assert.throws(() => s.set('a', 'b'), /cannot be read/);
  assert.equal(fs.readFileSync(path.join(root, 'secrets.json'), 'utf8'), '{not json');
  fs.rmSync(path.join(root, 'secrets.json'));
  fs.symlinkSync('/etc/passwd', path.join(root, 'secrets.json'));
  assert.throws(() => fileStore(root).list(), /cannot be read/, 'a symlinked store is refused');
});

test('env file: secret:// resolves, unknown references drop the variable', (t) => {
  const root = mk(t);
  const s = fileStore(root);
  s.set('deepseek', 'sk-real');
  const envFile = path.join(root, 'env');
  fs.writeFileSync(envFile, 'DEEPSEEK_API_KEY=secret://deepseek\nANTHROPIC_API_KEY=secret://nope\nPLAIN=value\nexport OPENAI_API_KEY="secret://deepseek"\n', { mode: 0o600 });
  const warn = console.warn; const warnings = []; console.warn = (m) => warnings.push(m);
  let env;
  try { env = readUserEnv(envFile, (r) => s.resolve(r)); } finally { console.warn = warn; }
  assert.deepEqual(env, { DEEPSEEK_API_KEY: 'sk-real', PLAIN: 'value', OPENAI_API_KEY: 'sk-real' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'a dangling reference is not passed on as text');
  assert.match(warnings.join('\n'), /secrets set nope/);
  assert.doesNotMatch(warnings.join('\n'), /sk-real/);
  assert.equal(readUserEnv(envFile).DEEPSEEK_API_KEY, undefined, 'without a resolver a reference is not leaked as the key');
});

test('keyring backend through secret-tool (fake tool via OPENMAESTRI_SECRET_TOOL)', (t) => {
  const root = mk(t);
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const db = path.join(root, 'db');
  fs.writeFileSync(path.join(bin, 'secret-tool'), `#!/usr/bin/env bash
db="${db}"; mkdir -p "$db"
cmd="$1"; shift
case "$cmd" in
  lookup) name="\${@: -1}"; [ -f "$db/$name" ] && { cat "$db/$name"; exit 0; } || exit 1 ;;
  store) name="\${@: -1}"; cat > "$db/$name" ;;
  clear) name="\${@: -1}"; rm -f "$db/$name" ;;
  search) for f in "$db"/*; do [ -f "$f" ] && echo "attribute.name = $(basename "$f")"; done; exit 0 ;;
esac
`, { mode: 0o755 });
  process.env.OPENMAESTRI_SECRET_TOOL = path.join(bin, 'secret-tool');
  t.after(() => { delete process.env.OPENMAESTRI_SECRET_TOOL; });
  const s = new Secrets({ root, env: { OPENMAESTRI_SECRETS_BACKEND: 'keyring' } });
  assert.equal(s.kind, 'keyring');
  s.set('claude', 'sk-ant-xyz');
  assert.equal(s.resolve('secret://claude'), 'sk-ant-xyz');
  assert.deepEqual(s.list(), ['claude']);
  assert.equal(fs.existsSync(path.join(root, 'secrets.json')), false, 'nothing lands in a file when the keyring is used');
  s.remove('claude');
  assert.equal(s.resolve('secret://claude'), undefined);
  // auto picks the keyring here, and file when the tool is broken
  assert.equal(new Secrets({ root, env: {} }).kind, 'keyring');
  assert.throws(() => new Secrets({ root, env: { OPENMAESTRI_SECRETS_BACKEND: 'bogus' } }), /auto, file or keyring/);
});

test('CLI: set from a pipe, list shows names only, refused inside a terminal, doctor never prints the value', (t) => {
  const root = mk(t);
  const env = { ...process.env, OPENMAESTRI_DATA_DIR: root, OPENMAESTRI_SECRETS_BACKEND: 'file' };
  delete env.OPENMAESTRI_SOCKET;
  const run = (args, input, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { env: { ...env, ...extra }, input, encoding: 'utf8' });
  const set = run(['secrets', 'set', 'deepseek'], 'sk-very-secret\n');
  assert.equal(set.status, 0, set.stderr);
  assert.doesNotMatch(set.stdout + set.stderr, /sk-very-secret/);
  const list = run(['secrets', 'list']);
  assert.match(list.stdout, /deepseek {2}\(secret:\/\/deepseek\)/);
  assert.doesNotMatch(list.stdout, /sk-very-secret/);
  assert.equal(run(['secrets', 'set', 'Bad Name'], 'x').status, 1);
  assert.equal(run(['secrets', 'bogus']).status, 2);
  const inside = run(['secrets', 'list'], '', { OPENMAESTRI_SOCKET: '/nonexistent.sock', OPENMAESTRI_TERMINAL_ID: 'x' });
  assert.equal(inside.status, 2);
  assert.match(inside.stderr, /not inside an agent terminal/);
  assert.equal(fs.statSync(path.join(root, 'secrets.json')).mode & 0o777, 0o600);
  assert.equal(run(['secrets', 'rm', 'deepseek']).status, 0);
  assert.equal(execFileSync(process.execPath, [CLI, 'version'], { env, encoding: 'utf8' }).trim().length > 0, true);
});

test('doctor sees a key kept as a secret and does not print it', async (t) => {
  const root = mk(t);
  fileStore(root).set('deepseek', 'sk-doctor-secret');
  fs.writeFileSync(path.join(root, 'env'), 'DEEPSEEK_API_KEY=secret://deepseek\n', { mode: 0o600 });
  const rows = await runDoctor({ env: { OPENMAESTRI_SECRETS_BACKEND: 'file', PATH: process.env.PATH }, root, socketPath: path.join(root, 'none.sock') });
  const text = formatDoctor(rows);
  assert.doesNotMatch(text, /sk-doctor-secret/);
  assert.equal(rows.find((r) => r.name === 'DeepSeek API key').level, 'ok');
  assert.match(rows.find((r) => r.name === 'Secret store').detail, /file \(1 stored\)/);
});
