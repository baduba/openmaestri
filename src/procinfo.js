// What a terminal is running: its process tree, memory and CPU, read from /proc (Linux).
// Read-only except for stopProcess, which only ever signals a descendant of the terminal's own
// shell, so it cannot be pointed at an unrelated program.
import fs from 'node:fs';

export class ProcError extends Error {}
const fail = (m) => { throw new ProcError(m); };

const CLK = 100; // clock ticks per second on Linux
const PAGE_KB = 4;

function stat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // the command name is in parentheses and may itself contain spaces or parentheses
    const open = raw.indexOf('(');
    const close = raw.lastIndexOf(')');
    const rest = raw.slice(close + 2).split(' ');
    return { pid, comm: raw.slice(open + 1, close), ppid: Number(rest[1]), cpu: (Number(rest[11]) + Number(rest[12])) / CLK, rssKb: Number(rest[21]) * PAGE_KB, state: rest[0] };
  } catch { return null; }
}

function cmdline(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 120); } catch { return ''; }
}

/** The process `root` and everything below it. [] when /proc is not available or the process is gone. */
export function tree(root) {
  if (!Number.isInteger(root) || root <= 1) return [];
  let pids;
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number); } catch { return []; }
  const all = new Map();
  for (const pid of pids) { const s = stat(pid); if (s) all.set(pid, s); }
  const out = [];
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const s = all.get(pid);
    if (!s) continue;
    out.push({ ...s, cmd: cmdline(pid) || s.comm });
    for (const c of all.values()) if (c.ppid === pid) queue.push(c.pid);
  }
  return out;
}

export function summarize(procs) {
  return { processes: procs.length, rssMb: Math.round(procs.reduce((a, p) => a + p.rssKb, 0) / 1024), cpuSeconds: Math.round(procs.reduce((a, p) => a + p.cpu, 0) * 10) / 10 };
}

/** Send SIGTERM (or SIGKILL with force) to one process under the terminal's shell; never the shell itself. */
export function stopProcess(rootPid, pid, { force = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) fail('give the process id from `openmaestri ps --all`');
  if (pid === rootPid) fail('that is the terminal itself; use dismiss to stop it');
  if (!tree(rootPid).some((p) => p.pid === pid)) fail(`process ${pid} is not running under this terminal`);
  try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (e) { fail(`could not signal ${pid}: ${e.code ?? e.message}`); }
}
