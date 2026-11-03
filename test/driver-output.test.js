import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tidyKimi, geminiHint, gooseModel, aiderFailure, opencodeFatal, runHeadless, stripAnsi, DRIVERS, codexBase } from '../src/headless.js';

test('kimi: the bullet and the version and resume lines are not part of the answer', () => {
  const r = tidyKimi({ text: '• OK\n• keep this bullet', stderr: 'kimi version 2.4.0\n• User wants just OK.\n\nTo resume this session: kimi -r session_abc' });
  assert.equal(r.text, 'OK\n• keep this bullet');
  assert.equal(r.stderr, '• User wants just OK.');
});

test('kimi: a real error stays on stderr and plain text is untouched', () => {
  const r = tidyKimi({ text: 'plain', stderr: 'kimi version 2.4.0\nError: quota exceeded' });
  assert.equal(r.text, 'plain');
  assert.equal(r.stderr, 'Error: quota exceeded');
});

test('gemini: the unsupported-account error points to agy', () => {
  assert.match(geminiHint('Error authenticating: IneligibleTierError: no longer supported'), /agy driver/);
  assert.equal(geminiHint('some other failure'), '');
  assert.equal(typeof DRIVERS.gemini.hint, 'function');
});

test('goose: provider/model gives both flags, a bare model only the model, and the output is quiet', () => {
  assert.deepEqual(gooseModel('openai/gpt-5'), ['--provider', 'openai', '--model', 'gpt-5']);
  assert.deepEqual(gooseModel('gpt-5'), ['--model', 'gpt-5']);
  assert.deepEqual(gooseModel(undefined), []);
  assert.deepEqual(DRIVERS.goose.args('hi', { model: 'openai/gpt-5' }), ['run', '--no-session', '-q', '--provider', 'openai', '--model', 'gpt-5', '-t', 'hi']);
});

test('codex: runs outside a git repository too', () => {
  assert.ok(DRIVERS.codex.args('hi', {}).includes('--skip-git-repo-check'));
});

test('aider: nothing is written into your folder, and a refused call counts as a failure', () => {
  const a = DRIVERS.aider.args('hi', { model: 'm' });
  for (const flag of ['--no-gitignore', '--no-analytics', '--no-check-update', '--chat-history-file', '--input-history-file']) assert.ok(a.includes(flag), flag);
  assert.equal(a[a.indexOf('--chat-history-file') + 1], '/dev/null');
  assert.match(aiderFailure('Repo-map: using 4096 tokens\n\nlitellm.BadRequestError: DeepseekException - {"error":{"message":"Authentication\nFails"}}\n'), /^litellm\.BadRequestError: DeepseekException/);
  assert.equal(aiderFailure('Applied edit to a.txt\nDone'), '');
  assert.equal(DRIVERS['aider-deepseek'].failure, aiderFailure);
});

test('colour codes are removed from what a tool prints', () => {
  assert.equal(stripAnsi('\u001b[91m\u001b[1mError: \u001b[0m{ "a": 1 }'), 'Error: { "a": 1 }');
  assert.equal(stripAnsi('plain [91m text and a lone \u001b'), 'plain [91m text and a lone \u001b');
  assert.equal(stripAnsi('\u001b[38;5;12mblue\u001b[0m'), 'blue');
});

const REFUSED = 'timestamp=2026-11-02T22:11:27.029Z level=ERROR run=fc8ef597 message="stream error" providerID=opencode modelID=big-pickle session.id=ses_x small=false agent=build mode=primary error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"';
const TITLE_ONLY = 'timestamp=2026-11-02T22:11:32.649Z level=ERROR run=fc8ef597 message="stream error" providerID=opencode modelID=big-pickle session.id=ses_x small=true agent=title mode=primary error.error="AI_RetryError: Failed after 3 attempts."';

test('opencode: a refused call is recognised from its error log, the title helper alone is not', () => {
  assert.match(opencodeFatal(REFUSED), /^opencode stopped: Free usage limit reached\./);
  assert.doesNotMatch(opencodeFatal(REFUSED), /AI_APICallError/);
  assert.equal(opencodeFatal(TITLE_ONLY), '');
  assert.equal(opencodeFatal('level=INFO message="all LSPs are disabled"'), '');
  assert.deepEqual(DRIVERS.opencode.args('hi', {}).slice(0, 4), ['run', '--print-logs', '--log-level', 'ERROR']);
  assert.equal(DRIVERS.opencode.fatal, opencodeFatal);
  assert.equal(DRIVERS['opencode-deepseek'].fatal, opencodeFatal);
});

test('opencode: a run that never exits after a refusal is stopped at once and reported', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-oc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'opencode');
  fs.writeFileSync(bin, `#!/usr/bin/env bash\necho '${REFUSED}' >&2\nsleep 60\n`, { mode: 0o755 });
  const r = await runHeadless({ driver: 'opencode', prompt: 'hi', cwd: dir, env: { PATH: process.env.PATH }, timeoutMs: 30000, resolveBin: () => bin });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, false);
  assert.equal(r.reportedError, true);
  assert.ok(r.ms < 10000, `stopped in ${r.ms} ms`);
  assert.match(r.stderr, /opencode stopped: Free usage limit reached/);
});

test('codex: the endpoint goes as a config override and the key is also given as CODEX_API_KEY', () => {
  assert.deepEqual(codexBase('https://openrouter.ai/api/v1'), ['-c', 'openai_base_url="https://openrouter.ai/api/v1"']);
  assert.deepEqual(codexBase('file:///etc/passwd'), []);
  assert.deepEqual(codexBase('not a url'), []);
  assert.deepEqual(codexBase(undefined), []);
  assert.ok(DRIVERS.codex.args('hi', { env: { OPENAI_BASE_URL: 'https://x.example/v1' } }).includes('-c'));
  assert.ok(DRIVERS.codex.keys.includes('CODEX_API_KEY'));
  assert.equal(DRIVERS.codex.alias.CODEX_API_KEY, 'OPENAI_API_KEY');
});
