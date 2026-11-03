// The acceptance gate of `ask`: what turns "the teammate answered" into "the teammate's work is accepted".
// A weak model should not be the one that decides whether another model's answer is good. The checks here are
// done by the program: a command that must exit 0, and a verdict block that must have an exact shape. When one
// fails, the failure goes back to the teammate in a short, fixed wording, a limited number of times.

/** More than two corrections in a row rarely help; a model that cannot fix it in two tries usually circles. */
export const MAX_RETRIES = 2;
export const DEFAULT_RETRIES = 1;

/** A message nearly the same as one sent to the same teammate this many times is a loop. */
export const REPEAT_WARN = 3;
export const REPEAT_STOP = 5;
const REPEAT_WINDOW_MS = 15 * 60 * 1000;
const REPEAT_SIMILARITY = 0.85;

/** Keep the start and the end of a long log: the first lines say what ran, the last ones say why it failed. */
export function clipLog(text, head = 20, tail = 40) {
  const lines = String(text ?? '').split('\n');
  if (lines.length <= head + tail) return lines.join('\n');
  return [...lines.slice(0, head), `[... ${lines.length - head - tail} lines left out ...]`, ...lines.slice(-tail)].join('\n');
}

export const VERDICT_FORMAT = [
  'End your reply with a block in exactly this shape, each line on its own line.',
  'STATUS must be the single word APPROVED or REJECTED. REASON is one or two sentences about what you checked.',
  '<<<VERDICT',
  'STATUS: <APPROVED or REJECTED>',
  'REASON: <what you checked and found>',
  'VERDICT>>>',
].join('\n');

/** The last well-formed verdict block in the text, or null. Anything else (a loose "APPROVED", a missing reason) is not a verdict. */
export function parseVerdict(text) {
  const src = String(text ?? '');
  const open = src.lastIndexOf('<<<VERDICT');
  if (open < 0) return null;
  const close = src.indexOf('VERDICT>>>', open);
  if (close < 0) return null;
  const body = src.slice(open + '<<<VERDICT'.length, close).split('\n').map((l) => l.trim()).filter(Boolean);
  const statusLine = body.find((l) => l.startsWith('STATUS:'));
  const reasonAt = body.findIndex((l) => l.startsWith('REASON:'));
  const status = statusLine?.slice('STATUS:'.length).trim();
  if (status !== 'APPROVED' && status !== 'REJECTED') return null;
  if (reasonAt < 0) return null;
  const reason = [body[reasonAt].slice('REASON:'.length), ...body.slice(reasonAt + 1)].join(' ').replace(/\s+/g, ' ').trim();
  return reason ? { status, reason } : null;
}

/** The message that goes back to the teammate when its work was not accepted. */
export function correction({ kind, command, exitCode, timedOut, output, verdict }) {
  if (kind === 'format') return `Your last reply was not accepted: it has no verdict block in the required shape.\n${VERDICT_FORMAT}\nLook at the data again and answer with the block.`;
  const how = timedOut ? 'timed out' : `exited with code ${exitCode ?? '?'}`;
  const tail = verdict ? `\n${VERDICT_FORMAT}` : '';
  return `An automatic check of your work failed, so it is not accepted yet.\nCommand: ${command}\nResult: ${how}\nOutput (shortened):\n${clipLog(output)}\nFix the cause, then say what you changed.${tail}`;
}

const words = (s) => new Set((String(s).toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? []).map((w) => w.replace(/[./-]+$/, '')));

/** 0 to 1: how much of the wording two messages share. */
export function similarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** Remembers the recent messages to each teammate so a Maestro that asks the same thing again and again is told. */
export class AskLog {
  constructor() { this.recent = new Map(); }

  /** Record a message and say how many nearly identical ones this teammate got lately (not counting this one). */
  note(workspaceId, targetId, prompt, now = Date.now()) {
    const key = `${workspaceId}/${targetId}`;
    const list = (this.recent.get(key) ?? []).filter((x) => now - x.at < REPEAT_WINDOW_MS);
    const repeats = list.filter((x) => similarity(x.prompt, prompt) >= REPEAT_SIMILARITY).length;
    list.push({ at: now, prompt: String(prompt).slice(0, 2000) });
    this.recent.set(key, list.slice(-30));
    return repeats;
  }
}

/** What the Maestro is told about a loop: the count and what to do instead. */
export function repeatNotice(repeats, name) {
  return `[loop] "${name}" has now been sent almost the same message ${repeats + 1} times. Asking again will not change the answer. Read the reply you already have, say it differently with the exact error, or give the task to another teammate (ask ... --then "Other").`;
}

/** One line per thing that happened, in order, and the totals: written by the program from what it saw, not by the Maestro. */
export function reportText(events) {
  if (!events.length) return 'Nothing to report yet: no ask has been made in this workspace.';
  const rows = events.map((e) => `${e.at.slice(11, 19)}  ${e.kind.padEnd(8)} ${e.to ? `-> ${e.to}` : ''}${e.ok === false ? '  FAILED' : e.ok === true ? '  ok' : ''}${e.secs != null ? `  ${e.secs}s` : ''}${e.note ? `  ${e.note}` : ''}`);
  const count = (k, ok) => events.filter((e) => e.kind === k && (ok === undefined || e.ok === ok)).length;
  const totals = [
    `${count('ask')} asks`,
    `${count('check')} checks (${count('check', false)} failed)`,
    `${count('verdict')} verdicts (${events.filter((e) => e.kind === 'verdict' && e.note?.startsWith('REJECTED')).length} rejected)`,
    `${count('retry')} corrections sent`,
    `${count('forward')} handed to another teammate`,
    `${count('loop')} loop warnings`,
  ];
  return `${rows.join('\n')}\n\nTotals: ${totals.join(', ')}.`;
}
