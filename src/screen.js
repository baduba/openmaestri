// What an agent answered, taken from a full-screen terminal program (opencode, claude, codex...).
// These programs redraw the screen in place, so "everything after the line where I asked" is only the footer:
// the answer scrolled above that line. Compare the screen before and after instead, and drop the decoration.

/** Rows that are only frame, spinner or block characters. */
const DECORATION = /^[\s─━│┃┆╹╻▀▄█▌▐▪▫■□▣⬝⬞⠀-⣿·•]*$/u;
/** Status-bar hints that change on every redraw, so a before/after comparison cannot remove them. */
const HINT = /(ctrl\+[a-z] (?:commands|to)|esc (?:to )?(?:interrupt|cancel)|\? for shortcuts|shift\+tab|tab (?:to )?(?:cycle|switch)|press enter to)/i;
const FRAME_EDGE = /^[\s┃│▌▐]+/u;
const squash = (s) => s.replace(/\s+/g, ' ');

/** How many times each non-blank row was on the screen. */
function countRows(lines) {
  const seen = new Map();
  for (const l of lines) {
    const k = l.trim();
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return seen;
}

/** A row that is the question shown back by the program (long enough not to match ordinary words). */
const isEcho = (row, sent) => {
  const k = squash(row.replace(FRAME_EDGE, ''));
  return sent !== '' && k.length >= 12 && sent.includes(k);
};

/** The rows of `after` that were not on the screen before, in order, without frames, status bars, the question shown back (`echo`) and blank runs. */
export function newScreenText(before, after, { echo = '' } = {}) {
  const sent = squash(String(echo));
  const seen = countRows(before);
  const out = [];
  for (const raw of after) {
    const k = raw.trim();
    if (!k) {
      if (out.length && out.at(-1) !== '') out.push('');
      continue;
    }
    const n = seen.get(k) ?? 0;
    if (n > 0) seen.set(k, n - 1);
    else if (!DECORATION.test(k) && !HINT.test(k) && !isEcho(raw, sent)) out.push(raw.replace(FRAME_EDGE, '').trimEnd());
  }
  while (out.at(-1) === '') out.pop();
  return out.join('\n').trim();
}

const BUSY_HINTS = ['esc to interrupt', 'esc interrupt', 'esc to cancel', 'esc cancel'];

/** True when the bottom of the screen says the program is still working (opencode, Claude Code and codex show "esc to interrupt", Gemini "esc to cancel"). */
export function looksBusy(lines, rows = 8) {
  const tail = lines.filter((l) => l.trim()).slice(-rows);
  return tail.some((l) => { const x = squash(l.toLowerCase()); return BUSY_HINTS.some((h) => x.includes(h)); });
}
