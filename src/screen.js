// What an agent answered, taken from a full-screen terminal program (opencode, claude, codex...).
// These programs redraw the screen in place, so "everything after the line where I asked" is only the footer:
// the answer scrolled above that line. Compare the screen before and after instead, and drop the decoration.

/** Rows that are only frame, spinner or block characters. */
const DECORATION = /^[\s─━│┃┆╹╻▀▄█▌▐▪▫■□▣⬝⬞⠀-⣿·•]*$/u;
/** Status-bar hints that change on every redraw, so a before/after comparison cannot remove them. */
const HINT = /(ctrl\+[a-z] (?:commands|to)|esc (?:to )?(?:interrupt|cancel)|\? for shortcuts|shift\+tab|tab (?:to )?(?:cycle|switch)|press enter to)/i;
const FRAME_EDGE = /^[\s┃│▌▐]+/u;
const squash = (s) => s.replace(/\s+/g, ' ');

/** At most this many non-blank rows of each screen are compared (the newest ones); the table is rows x rows. */
const MAX_ROWS = 700;

/**
 * Which rows of `after` were already there in `before`: the longest common run of rows in the same order (what scrolled up
 * and stayed the same). A row that only looks like an old one, such as the `<<<VERDICT` line of a second answer, is new text.
 * @returns {Set<number>} indexes into `after`
 */
function unchangedRows(before, after) {
  const a = before.map((l) => l.trim()).filter(Boolean).slice(-MAX_ROWS);
  const index = [];
  const b = [];
  after.forEach((l, i) => { const k = l.trim(); if (k) { b.push(k); index.push(i); } });
  const keep = b.length > MAX_ROWS ? b.length - MAX_ROWS : 0;
  const n = a.length;
  const m = b.length - keep;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a[i] === b[keep + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  }
  // rows older than the window are far above the new text: they were there before
  const same = new Set(index.slice(0, keep));
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[keep + j]) { same.add(index[keep + j]); i++; j++; } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++; else j++;
  }
  return same;
}

/** A row that is the question shown back by the program (long enough not to match ordinary words). */
const isEcho = (row, sent) => {
  const k = squash(row.replace(FRAME_EDGE, ''));
  return sent !== '' && k.length >= 12 && sent.includes(k);
};

/** The rows of `after` that were not on the screen before, in order, without frames, status bars, the question shown back (`echo`) and blank runs. */
export function newScreenText(before, after, { echo = '' } = {}) {
  const sent = squash(String(echo));
  const old = unchangedRows(before, after);
  const out = [];
  after.forEach((raw, i) => {
    const k = raw.trim();
    if (!k) {
      if (out.length && out.at(-1) !== '') out.push('');
    } else if (!old.has(i) && !DECORATION.test(k) && !HINT.test(k) && !isEcho(raw, sent)) {
      out.push(raw.replace(FRAME_EDGE, '').trimEnd());
    }
  });
  while (out.at(-1) === '') out.pop();
  return out.join('\n').trim();
}

const BUSY_HINTS = ['esc to interrupt', 'esc interrupt', 'esc to cancel', 'esc cancel'];

/** True when the bottom of the screen says the program is still working (opencode, Claude Code and codex show "esc to interrupt", Gemini "esc to cancel"). */
export function looksBusy(lines, rows = 8) {
  const tail = lines.filter((l) => l.trim()).slice(-rows);
  return tail.some((l) => { const x = squash(l.toLowerCase()); return BUSY_HINTS.some((h) => x.includes(h)); });
}
