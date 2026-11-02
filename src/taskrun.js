// `openmaestri run`: one task, several agents. This file only builds text, so the same inputs
// always give the same report: no model summarises anything, every answer is quoted as it came.

export const MAX_AGENTS = 6;
const ANSWER_CHARS = 6000;

/** "claude, codex" or ["claude","codex"] to a unique, lowercase list. */
export function parseAgents(raw) {
  const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\s]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  return [...new Set(list)];
}

const secs = (ms) => (ms / 1000).toFixed(1);
const clip = (t) => (t.length > ANSWER_CHARS ? `${t.slice(0, ANSWER_CHARS)}\n[cut: ${t.length - ANSWER_CHARS} more characters]` : t);

export function planText({ task, agents, floors, model }) {
  const lines = [`Run: ${task.length > 120 ? `${task.slice(0, 120)}...` : task}`, `Agents (${agents.length}): ${agents.join(', ')}`];
  lines.push(floors ? 'Each agent works on its own floor (a separate git branch and folder); nothing is landed for you.' : 'All agents work in the same folder. If they may edit files, use --floors.');
  if (model) lines.push(`Model: ${model}`);
  return lines.join('\n');
}

function statusOf(r) {
  if (r.problem) return 'not run';
  if (r.timedOut) return 'timed out';
  if (r.cancelled) return 'stopped';
  return r.ok ? 'ok' : `failed (exit ${r.exitCode ?? r.signal ?? '?'})`;
}

/** @param results [{driver, ok, text, stderr, ms, truncated, timedOut, cancelled, exitCode, signal, problem?, floor?: {name, dir, branch}}] */
export function reportText({ task, results, floors }) {
  const okCount = results.filter((r) => r.ok).length;
  const out = [`# Run: ${task.length > 80 ? `${task.slice(0, 80)}...` : task}`, '', `${okCount} of ${results.length} agents finished${floors ? ', each on its own floor' : ''}.`, ''];
  for (const r of results) {
    out.push(`## ${r.driver}: ${statusOf(r)}${r.ms ? ` (${secs(r.ms)}s)` : ''}`);
    if (r.floor) out.push(`Floor: ${r.floor.name}${r.floor.branch ? `, branch ${r.floor.branch}` : ''}, ${r.floor.dir}`);
    if (r.problem) out.push(r.problem);
    else if (r.text) out.push('', clip(r.text), r.truncated ? '[output was cut at 400 KB]' : '');
    if (!r.ok && !r.problem && r.stderr) out.push('', `stderr: ${r.stderr}`);
    out.push('');
  }
  if (floors && results.some((r) => r.floor)) out.push('Review each floor, then land the ones you want: `openmaestri floor land NAME`. Remove the rest: `openmaestri floor delete NAME`.');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
