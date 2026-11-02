// The note a retiring agent leaves for the one that takes over. It is built from facts (the screen, the git state,
// the notes cabled to it) and, when asked, from what the agent writes about itself; nothing else is invented.
import { redact } from './memory.js';

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const SELF_REPORT_PROMPT =
  'You are about to be replaced by another agent that knows nothing of this session. Write a handoff in at most 200 words, exactly these four parts, no commands to run:\n' +
  'GOAL: what you were asked to do.\nDONE: what is finished and where (files).\nNEXT: what remains, in order.\nGOTCHAS: traps, failed attempts, decisions the next agent must not undo.';

/** @param {{name: string, at?: Date, folder?: string, floor?: string, branch?: string, command?: string, status?: string, diffstat?: string, notes?: string[], screen?: string, selfReport?: string}} h */
export function handoffText(h) {
  const out = [`# Handoff from ${h.name}`, ''];
  out.push(`Written ${(h.at ?? new Date()).toISOString().slice(0, 16).replace('T', ' ')} UTC. Read this before touching anything: you are taking over, the previous agent is gone.`, '');
  const where = [h.folder && `folder ${h.folder}`, h.floor && `floor ${h.floor}${h.branch ? ` (branch ${h.branch})` : ''}`, h.command && `ran \`${clip(h.command, 80)}\``].filter(Boolean);
  if (where.length) out.push(`Where it worked: ${where.join(', ')}.`, '');
  if (h.selfReport?.trim()) out.push('## In its own words', clip(redact(h.selfReport.trim()), 3000), '');
  out.push('## Files', h.status?.trim() ? `\`\`\`\n${clip(h.status.trim(), 1500)}\n\`\`\`` : 'No uncommitted changes (or not a git folder).');
  if (h.diffstat?.trim()) out.push('', `\`\`\`\n${clip(h.diffstat.trim(), 1500)}\n\`\`\``);
  if (h.notes?.length) out.push('', '## Notes it could see', h.notes.map((n) => `- ${n}`).join('\n'));
  const screen = redact((h.screen ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-60).join('\n'));
  out.push('', '## Last thing on its screen (credentials masked)', screen ? `\`\`\`\n${clip(screen, 4000)}\n\`\`\`` : '(nothing)');
  out.push('', 'Check the files above against reality before you rely on them: this note is a snapshot, not a promise.');
  return out.join('\n');
}

/** The line typed into the new agent so it reads the note first. */
export const takeoverLine = (note, old) =>
  `You are taking over from ${old}, who is gone. Before anything else read the note "${note}" (openmaestri note read "${note}"), then continue its work. Do not redo what it says is done.`;
