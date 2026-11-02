import test from 'node:test';
import assert from 'node:assert/strict';
import { tidyKimi, geminiHint, gooseModel, aiderFailure, stripAnsi, DRIVERS } from '../src/headless.js';

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
