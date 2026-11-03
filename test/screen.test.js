import test from 'node:test';
import assert from 'node:assert/strict';
import { newScreenText } from '../src/screen.js';

const before = [
  '  ┃  Build · GPT OSS 120B',
  '',
  '  ┃',
  '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
  '   /work                           6.8K (5%) · $0.00  ctrl+p commands',
];

test('screen diff: keeps the answer that scrolled above the old cursor, drops frames and status bars', () => {
  const after = [
    '  ┃  Build · GPT OSS 120B',
    '  ┃  Rule 1: a region is flagged when revenue is over 100.',
    '  ┃  Rule 2: rows with 0 units are ignored.',
    '  ┃',
    '     ▣  Build · GPT OSS 120B · 4.6s',
    '  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
    '   /work                           7.1K (5%) · $0.01  ctrl+p commands',
  ];
  const out = newScreenText(before, after);
  assert.match(out, /Rule 1: a region is flagged/);
  assert.match(out, /Rule 2: rows with 0 units/);
  assert.doesNotMatch(out, /ctrl\+p|╹|┃/);
  assert.doesNotMatch(out, /\$0\.0/);
});

test('screen diff: a line that was already on the screen is not repeated, but a second copy is kept', () => {
  assert.equal(newScreenText(['ok'], ['ok', 'ok', 'next']), 'ok\nnext');
});

test('screen diff: nothing new gives an empty answer so the caller can fall back', () => {
  assert.equal(newScreenText(before, before), '');
});

test('screen diff: spinner rows and "esc interrupt" hints are not an answer', () => {
  assert.equal(newScreenText([], ['  ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt   34.9K (3%)  ctrl+p commands']), '');
});
