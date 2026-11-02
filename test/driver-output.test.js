import test from 'node:test';
import assert from 'node:assert/strict';
import { tidyKimi, geminiHint, DRIVERS } from '../src/headless.js';

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
