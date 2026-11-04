// The acceptance gate of `ask`: what turns "the teammate answered" into "the teammate's work is accepted".
// A weak model should not be the one that decides whether another model's answer is good. The checks here are
// done by the program: a command that must exit 0, and a verdict line that must have an exact shape. When one
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
  'End your reply with exactly one line, and put nothing else on it:',
  'VERDICT: <APPROVED or REJECTED> - <what you checked and found, in one sentence>',
  'For example: VERDICT: REJECTED - Norte is listed but its revenue is under the limit.',
].join('\n');

/** Drop the spaces and the separator (: , ; - and the long dashes) between the status word and the reason. */
const trimLeadSeparators = (text) => {
  let i = 0;
  while (i < text.length && ' \t:,;-\u2013\u2014'.includes(text[i])) i++;
  return text.slice(i).trim();
};

const STATUS = new Set(['APPROVED', 'REJECTED']);
const PLACEHOLDER = /^[<[{]/;

/** "VERDICT: APPROVED - reason" on one line (markdown marks around it are ignored); null when the status is not exactly one of the two words or the reason is missing. */
function verdictLine(line) {
  const t = line.trim().replace(/^[\s>*_`#-]+/, '').replace(/[*_`]+/g, '');
  if (!t.startsWith('VERDICT:')) return null;
  const rest = t.slice('VERDICT:'.length).trim();
  const space = rest.search(/[\s:,;-]/);
  const status = space < 0 ? rest : rest.slice(0, space);
  const reason = trimLeadSeparators(space < 0 ? '' : rest.slice(space));
  return STATUS.has(status) && reason.length >= 3 && !PLACEHOLDER.test(reason) ? { status, reason } : null;
}

/** The old three-line block, still accepted: <<<VERDICT / STATUS: X / REASON: y / VERDICT>>>. */
function verdictBlock(src) {
  const open = src.lastIndexOf('<<<VERDICT');
  if (open < 0) return null;
  const close = src.indexOf('VERDICT>>>', open);
  if (close < 0) return null;
  const body = src.slice(open + '<<<VERDICT'.length, close).split('\n').map((l) => l.trim()).filter(Boolean);
  const status = body.find((l) => l.startsWith('STATUS:'))?.slice('STATUS:'.length).trim();
  const reasonAt = body.findIndex((l) => l.startsWith('REASON:'));
  if (!STATUS.has(status) || reasonAt < 0) return null;
  const reason = [body[reasonAt].slice('REASON:'.length), ...body.slice(reasonAt + 1)].join(' ').replace(/\s+/g, ' ').trim();
  return reason ? { status, reason } : null;
}

/** The last verdict in the text, or null. Anything else (a loose "APPROVED", "NOT APPROVED", a missing reason) is not a verdict. */
export function parseVerdict(text) {
  const src = String(text ?? '');
  const lines = src.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = verdictLine(lines[i]);
    if (v) return v;
  }
  return verdictBlock(src);
}

/** The message that goes back to the teammate when its work was not accepted. */
export function correction({ kind, command, exitCode, timedOut, output, verdict }) {
  if (kind === 'format') return `Your last reply was not accepted: it has no verdict line in the required shape.\n${VERDICT_FORMAT}\nLook at the data again and answer with that line.`;
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
    `${count('nudge')} reminders to the Maestro`,
    `${count('budget')} spending notices`,
  ];
  return `${rows.join('\n')}\n\nTotals: ${totals.join(', ')}.`;
}

/** Checks whose last result, per teammate, was a failure: work that was never accepted. */
export function unresolvedChecks(events) {
  const last = new Map();
  for (const e of events) if (e.kind === 'check') last.set(e.to, e);
  return [...last.values()].filter((e) => e.ok === false);
}

/** What is appended to the Maestro's answer to the human when it answers with work that never passed its check. */
export function unverifiedNotice(open) {
  const what = open.map((e) => `${e.to}: ${e.note}`).join('; ');
  return `\n\n[openmaestri] Not verified: a check on the work of ${what} failed and was not fixed afterwards. This answer was given anyway; do not trust it until that check passes.`;
}

/** What a Maestro that starts late (a crash, a restart, a replacement) is told about the work so far: the last events and what is still open. */
export function resumeText(events, open, spend) {
  if (!events.length) return 'Nothing has happened in this workspace yet: no ask, check, verdict or correction was recorded. Start from the goal.';
  const recent = events.slice(-15).map((e) => `${e.at.slice(0, 19).replace('T', ' ')}  ${e.kind}${e.to ? ` -> ${e.to}` : ''}${e.ok === false ? ' FAILED' : ''}${e.note ? `  ${e.note}` : ''}`);
  const pending = open.length
    ? `Still open (the last check on this work failed and was not fixed):\n${open.map((e) => `  ${e.to}: ${e.note}`).join('\n')}`
    : 'Nothing is open: the last check on every teammate\'s work passed, or none was made.';
  return `The work so far in this workspace (${events.length} recorded events, newest last):\n${recent.join('\n')}\n\n${pending}\n${spend}\nContinue from here; do not redo what already passed.`;
}
