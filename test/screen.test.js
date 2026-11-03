import test from 'node:test';
import assert from 'node:assert/strict';
import { newScreenText, looksBusy } from '../src/screen.js';

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

test('looksBusy: the working hint at the bottom of the screen, not words in an answer', () => {
  assert.equal(looksBusy(['answer', '  ⬝⬝⬝⬝  esc interrupt   34.9K (3%)']), true);
  assert.equal(looksBusy(['  Working (12s • esc to interrupt)']), true);
  assert.equal(looksBusy(['  ⠋ Thinking... (esc to cancel)']), true);
  assert.equal(looksBusy(['press esc to interrupt is mentioned here', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'done']), false);
  assert.equal(looksBusy(['all done', '/work 6.9K (5%) · $0.00  ctrl+p commands']), false);
});

test('screen diff: the question shown back by the program is not part of the answer', () => {
  const q = 'Review this against data/rules.md. Reply with exactly APPROVED or REJECTED plus a reason.';
  const after = ['  ┃  Review this against data/rules.md. Reply with exactly', '  ┃  APPROVED or REJECTED plus a reason.', '', '  REJECTED: Norte is flagged by mistake.'];
  const out = newScreenText([], after, { echo: q });
  assert.equal(out, 'REJECTED: Norte is flagged by mistake.');
});

test('screen diff: a second answer that repeats the delimiter lines of the first one keeps them', () => {
  const first = ['  ┃  Review it.', '  <<<VERDICT', '  STATUS: REJECTED', '  REASON: Norte is flagged by mistake.', '  VERDICT>>>'];
  const second = [...first, '  ┃  Review it again.', '  <<<VERDICT', '  STATUS: REJECTED', '  REASON: Still the same mistake.', '  VERDICT>>>'];
  const out = newScreenText(first, second, { echo: 'Review it again.' });
  assert.match(out, /<<<VERDICT\n\s*STATUS: REJECTED\n\s*REASON: Still the same mistake\.\n\s*VERDICT>>>/);
  assert.doesNotMatch(out, /Norte is flagged/);
});

test('screen diff: a screen that scrolled keeps only the new rows, and a long screen does not break it', () => {
  const old = Array.from({ length: 900 }, (_, i) => `row ${i}`);
  const now = [...old.slice(50), 'the new answer line one', 'the new answer line two'];
  assert.equal(newScreenText(old, now), 'the new answer line one\nthe new answer line two');
});
