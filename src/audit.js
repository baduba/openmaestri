// An append-only record of what changed the machine's state through openmaestri: keys stored or
// removed, agents run, workspaces imported and exported. One JSON line per event, each line
// carrying the hash of the line before it, so an edited, removed or reordered line in the middle
// shows up in `openmaestri audit --verify`.
// Honest limits: it is a tamper-EVIDENT log, not a tamper-proof one. A program running as you can
// rewrite the whole file and the .head file together. It never stores a secret or a prompt: only
// names, sizes and a SHA-256 of the prompt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './store.js';

const GENESIS = '0'.repeat(64);
const MAX_VALUE = 200;
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;

/** JSON with sorted keys, so the same event always hashes the same way. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** Detail values are short strings, numbers or booleans; anything else is dropped or clipped. */
function cleanDetail(d) {
  const out = {};
  for (const [k, v] of Object.entries(d ?? {})) {
    if (typeof v === 'string') out[k] = v.length > MAX_VALUE ? `${v.slice(0, MAX_VALUE)}...` : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v.slice(0, 20).map((x) => x.slice(0, 60));
  }
  return out;
}

export const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const hashOf = (e) => sha256(`${e.prev}\n${e.seq}\n${e.at}\n${e.event}\n${e.actor}\n${canonical(e.detail)}`);

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class Audit {
  constructor(file) {
    this.file = file;
    this.headFile = `${file}.head`;
    this.lockDir = `${file}.lock`;
  }

  withLock(fn) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const end = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try { fs.mkdirSync(this.lockDir, { mode: 0o700 }); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(this.lockDir).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(this.lockDir); } catch { /* released meanwhile */ }
        if (Date.now() > end) throw new Error('the audit log is busy', { cause: e });
        sleepMs(15);
      }
    }
    try { return fn(); } finally { try { fs.rmdirSync(this.lockDir); } catch { /* already gone */ } }
  }

  lines() {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return text.split('\n').filter(Boolean);
  }

  /** Never throws: an audit problem must not stop the operation it describes. Returns the entry, or null. */
  record(event, detail = {}, actor = 'system') {
    try { return this.append(event, detail, actor); } catch (e) { console.warn(`[audit] could not record ${event}: ${e.message}`); return null; }
  }

  append(event, detail = {}, actor = 'system') {
    return this.withLock(() => {
      const lines = this.lines();
      let prev = GENESIS;
      let seq = 1;
      if (lines.length) {
        let last;
        try { last = JSON.parse(lines.at(-1)); } catch { last = null; }
        if (last && typeof last.hash === 'string' && Number.isInteger(last.seq)) { prev = last.hash; seq = last.seq + 1; }
        else { prev = 'unreadable'; seq = lines.length + 1; }
      }
      const entry = { seq, at: new Date().toISOString(), event: String(event).slice(0, 60), actor: String(actor).slice(0, 80), detail: cleanDetail(detail), prev };
      entry.hash = hashOf(entry);
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      fs.chmodSync(this.file, 0o600);
      atomicWrite(this.headFile, JSON.stringify({ seq: entry.seq, hash: entry.hash }));
      return entry;
    });
  }

  read(limit = 50) {
    const out = [];
    for (const l of this.lines().slice(-Math.max(1, limit))) { try { out.push(JSON.parse(l)); } catch { out.push({ event: '(unreadable line)' }); } }
    return out;
  }

  /** @returns {{ok: boolean, count: number, head: string|null, problem?: string, at?: number}} */
  verify() {
    const lines = this.lines();
    let prev = GENESIS;
    for (let i = 0; i < lines.length; i += 1) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { return { ok: false, count: lines.length, head: null, problem: 'a line is not valid JSON', at: i + 1 }; }
      if (e.seq !== i + 1) return { ok: false, count: lines.length, head: null, problem: 'a line is missing, repeated or out of order', at: i + 1 };
      if (e.prev !== prev && !(e.prev === 'unreadable')) return { ok: false, count: lines.length, head: null, problem: 'a line does not follow the one before it (removed or reordered)', at: i + 1 };
      if (hashOf(e) !== e.hash) return { ok: false, count: lines.length, head: null, problem: 'a line was edited', at: i + 1 };
      prev = e.hash;
    }
    let head = null;
    try { head = JSON.parse(fs.readFileSync(this.headFile, 'utf8')); } catch { /* no head file yet */ }
    if (head && (head.seq !== lines.length || (lines.length && head.hash !== prev))) {
      return { ok: false, count: lines.length, head: prev, problem: `the log ends at line ${lines.length} but the head file says ${head.seq} (lines were cut off the end)`, at: lines.length };
    }
    return { ok: true, count: lines.length, head: lines.length ? prev : null };
  }
}
