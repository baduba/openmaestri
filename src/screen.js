// What an agent answered, taken from a full-screen terminal program (opencode, claude, codex...).
// These programs redraw the screen in place, so "everything after the line where I asked" is only the footer:
// the answer scrolled above that line. Compare the screen before and after instead, and drop the decoration.

/** Rows that are only frame, spinner or block characters. */
const DECORATION = /^[\s─━│┃┆╹╻▀▄█▌▐▪▫■□▣⬝⬞⠀-⣿·•]*$/u;
/** Status-bar hints that change on every redraw, so a before/after comparison cannot remove them. */
const HINT = /(ctrl\+[a-z] (?:commands|to)|esc (?:to )?(?:interrupt|cancel)|\? for shortcuts|shift\+tab|tab (?:to )?(?:cycle|switch)|press enter to)/i;
const FRAME_EDGE = /^[\s┃│▌▐]+/u;

/** The rows of `after` that were not on the screen before, in order, without frames, status bars and blank runs. */
export function newScreenText(before, after) {
  const seen = new Map();
  for (const l of before) { const k = l.trim(); if (k) seen.set(k, (seen.get(k) ?? 0) + 1); }
  const out = [];
  for (const raw of after) {
    const k = raw.trim();
    if (!k) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    const n = seen.get(k) ?? 0;
    if (n > 0) { seen.set(k, n - 1); continue; }
    if (DECORATION.test(k) || HINT.test(k)) continue;
    out.push(raw.replace(FRAME_EDGE, '').trimEnd());
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n').trim();
}

const BUSY_HINTS = ['esc to interrupt', 'esc interrupt', 'esc to cancel', 'esc cancel'];

/** True when the bottom of the screen says the program is still working (opencode, Claude Code and codex show "esc to interrupt", Gemini "esc to cancel"). */
export function looksBusy(lines, rows = 8) {
  const tail = lines.filter((l) => l.trim()).slice(-rows);
  return tail.some((l) => { const x = l.toLowerCase().replace(/\s+/g, ' '); return BUSY_HINTS.some((h) => x.includes(h)); });
}
