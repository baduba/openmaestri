// Chat: the conversation between the human and the Maestro. Seven fixed threads per workspace,
// each an append-only JSONL file, plus a vault for attachments. Nothing here lives in
// workspace.json, so a long conversation never slows down dragging a node.
//
//   <workspace dir>/chat/threads.json            titles, counters, unread
//   <workspace dir>/chat/threads/thread-N.jsonl  one message per line
//   <workspace dir>/chat/vault/<sha256>/<name>   attachments (0600, content addressed)
//   <workspace dir>/chat/vault.json              attachment id -> metadata
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { atomicWrite, safeId } from './store.js';

export class ChatError extends Error {}
const fail = (m) => { throw new ChatError(m); };

export const THREAD_COUNT = 7;
export const THREAD_IDS = Array.from({ length: THREAD_COUNT }, (_, i) => `thread-${i + 1}`);
const MAX_TEXT = 20000;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const KEEP_LINES = 3000;
const SECRET_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.kdbx']);
const SECRET_FILES = new Set(['credentials', 'credentials.json', '.netrc', '.npmrc', '.pgpass']);
/** Names that usually hold secrets: .env*, ssh keys, key stores, credentials, anything called secret. */
export function looksSecret(file) {
  const n = path.basename(String(file)).toLowerCase();
  return n.startsWith('.env') || n.startsWith('id_') || SECRET_EXT.has(path.extname(n)) || SECRET_FILES.has(n) || n.includes('secret');
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain', '.csv': 'text/csv' };

/** Drop control characters (ESC, NUL, ...) but keep tab, newline and carriage return. */
export function cleanText(s, max = MAX_TEXT) {
  let out = '';
  for (const ch of String(s ?? '').slice(0, max * 2)) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) out += ch;
    if (out.length >= max) break;
  }
  return out;
}
export const cleanName = (s) => (path.basename(String(s)).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file');

/** Open once, then stat and read through the same descriptor, so the file cannot change in between. */
function readRegularFile(file, maxBytes, tooBig) {
  // O_NONBLOCK: opening a FIFO must not hang the daemon; it is then refused as not a regular file
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) fail('an attachment must be a regular file');
    if (st.size > maxBytes) fail(tooBig);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function isThreadId(id) { return THREAD_IDS.includes(id); }
export function threadId(input) {
  if (input === undefined || input === null || input === '') return null;
  const s = String(input).trim().toLowerCase();
  if (isThreadId(s)) return s;
  if (/^[1-7]$/.test(s)) return `thread-${s}`;
  return fail(`threads are numbered 1 to ${THREAD_COUNT}`);
}

export class Chat extends EventEmitter {
  /** @param {{store: import('./store.js').Store, allowedRoots: (wsId: string) => string[]}} deps */
  constructor({ store, allowedRoots, vaultLimit = 100 * 1024 * 1024 }) {
    super();
    this.store = store;
    this.allowedRoots = allowedRoots;
    this.vaultLimit = vaultLimit;
    this.progress = new Map(); // `${wsId}/${thread}/${sender}` -> latest progress message (never persisted)
  }

  dir(wsId) { return path.join(this.store.wsDir(safeId(wsId)), 'chat'); }
  threadFile(wsId, tid) { return path.join(this.dir(wsId), 'threads', `${tid}.jsonl`); }

  // ------------------------------------------------------------------ metadata
  meta(wsId) {
    const file = path.join(this.dir(wsId), 'threads.json');
    let m = null;
    try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first use or damaged: rebuilt below */ }
    const byId = new Map((m?.threads ?? []).map((t) => [t.id, t]));
    const threads = THREAD_IDS.map((id, i) => ({ id, title: `Thread ${i + 1}`, turnCount: 0, unread: 0, updatedAt: null, preview: '', ...byId.get(id) }));
    const active = isThreadId(m?.active) ? m.active : THREAD_IDS[0];
    return { threads, active };
  }

  saveMeta(wsId, m) {
    fs.mkdirSync(this.dir(wsId), { recursive: true, mode: 0o700 });
    atomicWrite(path.join(this.dir(wsId), 'threads.json'), JSON.stringify(m, null, 2));
  }

  list(wsId) {
    const m = this.meta(wsId);
    return m.threads.map((t) => ({ ...t, empty: t.turnCount === 0, active: t.id === m.active }));
  }

  active(wsId) { return this.meta(wsId).active; }

  setActive(wsId, tid) {
    const m = this.meta(wsId);
    m.active = threadId(tid) ?? m.active;
    this.saveMeta(wsId, m);
    this.emit('state', wsId);
    return m.active;
  }

  rename(wsId, tid, title) {
    const m = this.meta(wsId);
    const t = m.threads.find((x) => x.id === threadId(tid));
    if (!t) fail('unknown thread');
    t.title = cleanText(title, 40).trim() || t.title;
    this.saveMeta(wsId, m);
    this.emit('state', wsId);
    return t.title;
  }

  markRead(wsId, tid) {
    const m = this.meta(wsId);
    const t = m.threads.find((x) => x.id === threadId(tid));
    if (t && t.unread) { t.unread = 0; this.saveMeta(wsId, m); }
    this.emit('state', wsId);
  }

  // ------------------------------------------------------------------ messages
  /**
   * @param {{role: 'human'|'agent'|'system', sender: string, senderId?: string, text: string, attachments?: object[], progress?: boolean}} msg
   */
  append(wsId, tid, msg) {
    const thread = threadId(tid) ?? this.active(wsId);
    const text = cleanText(msg.text);
    const attachments = (msg.attachments ?? []).slice(0, 10);
    if (!text.trim() && !attachments.length) fail('a message needs text or an attachment');
    const full = {
      id: crypto.randomUUID(), threadId: thread, role: msg.role, sender: cleanText(msg.sender, 60), senderId: msg.senderId ?? null,
      text, attachments, progress: !!msg.progress, ts: Date.now(),
    };
    const key = `${wsId}/${thread}/${full.sender}`;
    if (full.progress) {
      this.progress.set(key, full);
      this.emit('progress', wsId, full);
      return full;
    }
    this.progress.delete(key);
    fs.mkdirSync(path.dirname(this.threadFile(wsId, thread)), { recursive: true, mode: 0o700 });
    // fsync so an answer the human has seen is not lost if the machine dies a second later
    const fd = fs.openSync(this.threadFile(wsId, thread), 'a', 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(full)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.trimIfLarge(wsId, thread);
    const m = this.meta(wsId);
    const t = m.threads.find((x) => x.id === thread);
    t.turnCount += 1;
    t.updatedAt = full.ts;
    t.preview = text.replace(/\s+/g, ' ').slice(0, 80);
    if (full.role !== 'human' && thread !== m.active) t.unread += 1;
    this.saveMeta(wsId, m);
    this.emit('message', wsId, full);
    return full;
  }

  /** Keep the file bounded: past 8 MB only the newest lines stay. */
  trimIfLarge(wsId, tid) {
    const file = this.threadFile(wsId, tid);
    const fd = fs.openSync(file, fs.constants.O_RDONLY);
    let raw = null;
    try { if (fs.fstatSync(fd).size >= MAX_FILE_BYTES) raw = fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
    if (raw === null) return;
    const lines = raw.split('\n').filter(Boolean);
    atomicWrite(file, `${lines.slice(-KEEP_LINES).join('\n')}\n`);
  }

  readAll(wsId, tid) {
    let raw;
    try { raw = fs.readFileSync(this.threadFile(wsId, tid), 'utf8'); } catch { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn or damaged line is skipped, never fatal */ }
    }
    return out;
  }

  /**
   * @param {{turns?: number, since?: number, until?: number, before?: number}} q  newest `turns` messages inside the window, oldest first
   */
  history(wsId, tid, q = {}) {
    const thread = threadId(tid) ?? this.active(wsId);
    let rows = this.readAll(wsId, thread);
    if (q.since !== undefined) rows = rows.filter((m) => m.ts >= q.since);
    if (q.until !== undefined) rows = rows.filter((m) => m.ts <= q.until);
    if (q.before !== undefined) rows = rows.filter((m) => m.ts < q.before);
    const turns = Math.max(1, Math.min(Number(q.turns) || 50, 1000));
    return rows.slice(-turns);
  }

  pendingProgress(wsId, tid) {
    const prefix = `${wsId}/${tid}/`;
    return [...this.progress].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  }

  clear(wsId, tid) {
    const thread = threadId(tid);
    if (!thread) fail('which thread?');
    fs.rmSync(this.threadFile(wsId, thread), { force: true });
    for (const k of [...this.progress.keys()]) if (k.startsWith(`${wsId}/${thread}/`)) this.progress.delete(k);
    const m = this.meta(wsId);
    const t = m.threads.find((x) => x.id === thread);
    Object.assign(t, { turnCount: 0, unread: 0, updatedAt: null, preview: '' });
    this.saveMeta(wsId, m);
    this.emit('state', wsId);
  }

  /** Substring search across threads. `isCancelled` lets a long search stop when the user types again. */
  search(wsId, query, { limit = 50, isCancelled = () => false } = {}) {
    const q = String(query ?? '').toLowerCase().trim();
    if (q.length < 2) return [];
    const hits = [];
    for (const tid of THREAD_IDS) {
      if (isCancelled()) break;
      for (const m of this.readAll(wsId, tid)) {
        if (m.text.toLowerCase().includes(q)) hits.push({ threadId: tid, id: m.id, sender: m.sender, ts: m.ts, snippet: m.text.slice(0, 160) });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  // ------------------------------------------------------------------ attachments
  vaultIndexFile(wsId) { return path.join(this.dir(wsId), 'vault.json'); }
  readVault(wsId) { try { return JSON.parse(fs.readFileSync(this.vaultIndexFile(wsId), 'utf8')); } catch { return {}; } }

  /**
   * Copy a file into the vault. The source must be a regular file inside the workspace or one of
   * its floors (resolved through symlinks), small, and not something that looks like a secret.
   */
  attach(wsId, sourcePath, originalName) {
    let real;
    try { real = fs.realpathSync(path.resolve(String(sourcePath))); } catch { return fail(`no such file: ${sourcePath}`); }
    const roots = this.allowedRoots(wsId);
    if (!roots.some((r) => real === r || real.startsWith(r + path.sep))) fail('attachments must come from inside the workspace or one of its floors');
    const name = cleanName(originalName ?? path.basename(real));
    if (looksSecret(name) || looksSecret(real)) fail('that file looks like it holds secrets and cannot be attached');
    let data;
    try { data = readRegularFile(real, MAX_ATTACHMENT, `attachments are limited to ${MAX_ATTACHMENT / 1024 / 1024} MB`); } catch (e) {
      if (e instanceof ChatError) throw e;
      return fail(`cannot read ${sourcePath}`);
    }
    const sha = crypto.createHash('sha256').update(data).digest('hex');
    const id = `att_${sha.slice(0, 16)}`;
    const dest = path.join(this.dir(wsId), 'vault', sha, name);
    const index = this.readVault(wsId);
    const used = new Map(Object.values(index).map((r) => [r.sha, r.size]));
    if (!used.has(sha) && [...used.values()].reduce((a, b) => a + b, 0) + data.length > this.vaultLimit) fail(`this workspace's attachment vault is full (${Math.round(this.vaultLimit / 1024 / 1024)} MB). Clear a thread to free space`);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(dest, data, { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const mime = MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
    index[id] = { id, sha, name, size: data.length, mime };
    atomicWrite(this.vaultIndexFile(wsId), JSON.stringify(index));
    return { id, name, size: data.length, mime };
  }

  /** Absolute path of a stored attachment, only ever inside the vault. */
  attachmentPath(wsId, id) {
    const rec = this.readVault(wsId)[String(id)];
    if (!rec) return fail(`no attachment "${id}"`);
    const p = path.join(this.dir(wsId), 'vault', rec.sha, cleanName(rec.name));
    if (!fs.existsSync(p)) fail(`attachment "${id}" is missing from the vault`);
    return p;
  }
}
