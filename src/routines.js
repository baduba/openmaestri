// Routines: a command (prompt) typed into a terminal on a schedule.
// Schedules: {kind:'every', ms} | {kind:'daily', time:'HH:MM'} |
//            {kind:'weekly', days:[0-6], time:'HH:MM'} | {kind:'once', at: ISO}
import { exec } from 'node:child_process';
import { uid } from './store.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const MAX_EVERY_MS = 366 * 86400000;

export function parseDuration(s) {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(String(s).trim());
  if (!m) throw new Error(`bad duration "${s}" (use 30s, 15m, 2h, 1d)`);
  return Number(m[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
}

function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`bad time "${t}" (use HH:MM)`);
  return [+m[1], +m[2]];
}

/** How many times a routine may fire: a whole number from 1, or none. A word or a decimal used to be kept as NaN, and a count that is NaN never ends. */
export function parseCount(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1e6) throw new Error(`bad --count "${v}" (a whole number from 1)`);
  return n;
}

/** The moment after which a routine stops, as an ISO date. A date that does not parse used to be kept, and then the routine never stopped. */
export function parseUntil(v) {
  if (v == null || v === '') return null;
  const t = Date.parse(String(v).replace(' ', 'T'));
  if (Number.isNaN(t)) throw new Error(`bad --until "${v}" (YYYY-MM-DD HH:MM)`);
  return new Date(t).toISOString();
}

export function parseSchedule(opts) {
  if (opts.every) {
    const ms = parseDuration(opts.every);
    if (ms < 10000) throw new Error('--every must be at least 10s');
    // a year is the longest period that means anything; beyond it the next run is past the last date a Date can hold and shows as Invalid Date
    if (ms > MAX_EVERY_MS) throw new Error('--every must be at most 366d');
    return { kind: 'every', ms };
  }
  if (opts.daily) { parseTime(opts.daily); return { kind: 'daily', time: opts.daily }; }
  if (opts.weekly) {
    const [days, time] = String(opts.weekly).split('@');
    parseTime(time || '');
    const set = days.split(',').map((d) => DAYS.indexOf(d.trim().toLowerCase().slice(0, 3)));
    if (set.some((d) => d < 0)) throw new Error(`bad weekday list "${days}" (mon,fri)`);
    return { kind: 'weekly', days: [...new Set(set)], time };
  }
  if (opts.once) {
    const at = new Date(String(opts.once).replace(' ', 'T'));
    if (Number.isNaN(at.getTime())) throw new Error(`bad date "${opts.once}" (YYYY-MM-DD HH:MM)`);
    return { kind: 'once', at: at.toISOString() };
  }
  throw new Error('a schedule is required: --every, --daily, --weekly or --once');
}

export function nextRun(schedule, from = Date.now()) {
  switch (schedule.kind) {
    case 'every': return from + schedule.ms;
    case 'once': { const t = Date.parse(schedule.at); return t > from ? t : null; }
    case 'daily':
    case 'weekly': {
      const [h, m] = parseTime(schedule.time);
      for (let add = 0; add < 8; add++) {
        const d = new Date(from);
        d.setDate(d.getDate() + add);
        d.setHours(h, m, 0, 0);
        const okDay = schedule.kind === 'daily' || schedule.days.includes(d.getDay());
        if (okDay && d.getTime() > from) return d.getTime();
      }
      return null;
    }
    default: return null;
  }
}

export function describeSchedule(s) {
  switch (s.kind) {
    case 'every': return `every ${s.ms >= 3600000 ? s.ms / 3600000 + 'h' : s.ms >= 60000 ? s.ms / 60000 + 'm' : s.ms / 1000 + 's'}`;
    case 'daily': return `daily ${s.time}`;
    case 'weekly': return `weekly ${s.days.map((d) => DAYS[d]).join(',')}@${s.time}`;
    case 'once': return `once ${new Date(s.at).toLocaleString()}`;
    default: return s.kind;
  }
}

export class Scheduler {
  /**
   * @param {object} deps
   * @param {() => Iterable<object>} deps.workspaces
   * @param {(ws, routine, text) => void} deps.fire   types `text` into the routine's target
   * @param {() => void} deps.changed                 persist + broadcast
   */
  constructor(deps) {
    this.deps = deps;
    this.timer = null;
  }

  start() { this.timer = setInterval(() => this.tick(), 1000); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); }

  create(ws, { name, terminalId, command, schedule, reminder, count, until, preRun, notify = true, enabled = true }) {
    if (ws.routines.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new Error(`routine "${name}" already exists`);
    const r = {
      id: uid(), name, terminalId, command, schedule,
      reminder: !!reminder, count: count ?? null, until: until ?? null, preRun: preRun ?? null,
      notify, enabled, fireCount: 0, lastFiredAt: null,
      nextRunAt: nextRun(schedule),
    };
    ws.routines.push(r);
    this.deps.changed(ws);
    return r;
  }

  /** Keep the last 20 outcomes of a routine: when, how it started, whether it worked. */
  record(r, entry) {
    r.history ??= [];
    r.history.push({ at: new Date().toISOString(), ...entry });
    if (r.history.length > 20) r.history.splice(0, r.history.length - 20);
  }

  async runNow(ws, r, trigger = 'manual') {
    const started = Date.now();
    let preRun;
    try {
      let text = r.command;
      if (r.preRun) {
        // Intentional: --pre-run is a user-authored shell command (same privileges as the terminals, bounded by timeout and output size).
        const { out, failed } = await new Promise((res) =>
          // eslint-disable-next-line security/detect-child-process
          exec(r.preRun, { cwd: ws.dir, timeout: 60000, maxBuffer: 1 << 20 }, (e, stdout) => res({ out: String(stdout || '').trim(), failed: !!e })),
        );
        preRun = failed ? 'failed' : 'ok';
        text = text.includes('{{output}}') ? text.replaceAll('{{output}}', out) : text;
      }
      this.deps.fire(ws, r, text);
      r.fireCount += 1;
      r.lastFiredAt = new Date().toISOString();
      this.record(r, { trigger, ok: true, ms: Date.now() - started, ...(preRun ? { preRun } : {}) });
    } catch (e) {
      this.record(r, { trigger, ok: false, ms: Date.now() - started, error: String(e?.message ?? e).slice(0, 200), ...(preRun ? { preRun } : {}) });
      throw e;
    }
  }

  async tick() {
    const now = Date.now();
    for (const ws of this.deps.workspaces()) {
      let dirty = false;
      for (const r of ws.routines) {
        if (!r.enabled || r.nextRunAt == null || r.nextRunAt > now) continue;
        try { await this.runNow(ws, r, 'schedule'); } catch (e) { console.error("[routine] failed:", r.name, String(e)); }
        const done = (r.count != null && r.fireCount >= r.count) || (r.until && Date.parse(r.until) <= now);
        r.nextRunAt = done ? null : nextRun(r.schedule, now);
        if (r.nextRunAt == null) r.enabled = false;
        dirty = true;
      }
      if (dirty) this.deps.changed(ws);
    }
  }
}
