// Long-term memory for a chat thread. When a thread grows long, its older messages are
//   1. appended to <thread>.archive.jsonl (kept for good, never deleted),
//   2. condensed into a short digest saved under chat/memory/<thread>.json,
//   3. removed from the active file, which keeps only the most recent messages.
// The digest is built by fixed rules, with no model and no network: it quotes pieces of the
// thread (decisions, questions, files, attachments), so it cannot contain anything that was not
// said, and it is the same every time for the same messages. Obvious secrets are masked in it.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './store.js';

const MAX_CHAPTERS = 8;
const DECISION_WORDS = ['decided', 'decision', "let's use", 'we will use', 'we will', 'agreed', 'going with', 'instead of', 'must not', 'never ', 'decidimos', 'vamos usar', 'ficou definido', 'combinado'];
const FILE_EXT = new Set(['js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'rb', 'php', 'c', 'h', 'cpp', 'cs', 'swift', 'kt', 'md', 'json', 'yaml', 'yml', 'toml', 'html', 'css', 'sh', 'sql', 'txt', 'lock']);

const FIVE_DASHES = '-'.repeat(5);

/** Drop PEM private key blocks (BEGIN ... PRIVATE KEY up to the matching END, or to the end of the text). */
function stripPrivateKeys(text) {
  const begin = `${FIVE_DASHES}BEGIN `;
  const end = `${FIVE_DASHES}END `;
  let out = '';
  let i = 0;
  for (;;) {
    const a = text.indexOf(begin, i);
    if (a < 0 || !text.slice(a, a + 60).includes('PRIVATE KEY')) { out += text.slice(i); return out; }
    out += `${text.slice(i, a)}[private key removed]`;
    const e = text.indexOf(end, a + begin.length);
    if (e < 0) return out;
    const close = text.indexOf(FIVE_DASHES, e + end.length);
    i = close < 0 ? text.length : close + 5;
  }
}

/** Mask what looks like a credential before it is copied into a digest. */
export function redact(text) {
  // These are patterns that MATCH credentials in order to mask them; there is no credential in this file.
  // nosemgrep: node_secret
  return stripPrivateKeys(String(text))
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[key removed]')
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[key removed]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[token removed]')
    .replace(/\b(password|passwd|secret|token|api[_-]?key|authorization)\b(\s*[:=]\s*|\s+is\s+)\S{4,}/gi, '$1$2[removed]');
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

function fileLike(word) {
  const w = word.replace(/^[("'`]+|[)"'`,.;:!?]+$/g, '');
  if (w.length < 3 || w.length > 120 || w.startsWith('http') || w.includes('@')) return null;
  const dot = w.lastIndexOf('.');
  const ext = dot > 0 ? w.slice(dot + 1).toLowerCase() : '';
  return FILE_EXT.has(ext) || (w.includes('/') && !w.startsWith('/') && /^[\w./-]+$/.test(w)) ? w : null;
}

/** The digest of one batch of messages (a "chapter"). Pure and deterministic. */
export function digest(messages) {
  const first = messages[0];
  const last = messages[messages.length - 1];
  const senders = new Map();
  const files = new Map();
  const decisions = [];
  const questions = [];
  const attachments = [];
  for (const m of messages) {
    senders.set(m.sender, (senders.get(m.sender) ?? 0) + 1);
    for (const a of m.attachments ?? []) attachments.push(`${a.name} (${a.id})`);
    for (const word of m.text.split(/\s+/)) { const f = fileLike(word); if (f) files.set(f, (files.get(f) ?? 0) + 1); }
    for (const raw of m.text.split('\n')) {
      const line = oneLine(raw);
      const lc = line.toLowerCase();
      if (line.length > 8 && decisions.length < 12 && DECISION_WORDS.some((w) => lc.includes(w))) decisions.push(`${m.sender}: ${clip(redact(line), 200)}`);
    }
    if (m.role === 'human' && m.text.includes('?')) questions.push(clip(redact(oneLine(m.text)), 160));
  }
  const topFiles = [...files].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 15).map(([f]) => f);
  const topics = messages.filter((m) => m.role === 'human').slice(-6).map((m) => clip(redact(oneLine(m.text)), 120));
  return {
    from: first.ts, to: last.ts, count: messages.length,
    speakers: [...senders].map(([n, c]) => `${n} (${c})`),
    decisions, questions: questions.slice(-5), topics, files: topFiles, attachments: [...new Set(attachments)].slice(0, 15),
  };
}

export function renderChapter(c, n) {
  const day = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  const lines = [`Earlier, part ${n}: ${c.count} messages, ${day(c.from)} to ${day(c.to)}; ${c.speakers.join(', ')}`];
  if (c.topics.length) lines.push(`  The human asked about: ${c.topics.map((t) => `"${t}"`).join(' | ')}`);
  if (c.decisions.length) lines.push(`  Decisions and rules mentioned:\n${c.decisions.map((d) => `    - ${d}`).join('\n')}`);
  if (c.questions.length) lines.push(`  Questions from the human (may still be open):\n${c.questions.map((q) => `    - ${q}`).join('\n')}`);
  if (c.files.length) lines.push(`  Files mentioned: ${c.files.join(', ')}`);
  if (c.attachments.length) lines.push(`  Attachments: ${c.attachments.join(', ')}`);
  return lines.join('\n');
}

export class Memory {
  /** @param {import('./chat.js').Chat} chat */
  constructor(chat, { compressAt = 200, keep = 40 } = {}) {
    this.chat = chat;
    this.compressAt = compressAt;
    this.keep = keep;
  }

  file(wsId, tid) { return path.join(this.chat.dir(wsId), 'memory', `${tid}.json`); }
  archiveFile(wsId, tid) { return path.join(this.chat.dir(wsId), 'threads', `${tid}.archive.jsonl`); }

  load(wsId, tid) {
    try {
      const m = JSON.parse(fs.readFileSync(this.file(wsId, tid), 'utf8'));
      return Array.isArray(m?.chapters) ? m : { chapters: [] };
    } catch { return { chapters: [] }; }
  }

  /** The text agents see in `recall` before the recent messages, or '' when nothing was summarised. */
  summary(wsId, tid) {
    const m = this.load(wsId, tid);
    if (!m.chapters.length) return '';
    const dropped = m.droppedChapters ? `(${m.droppedChapters} older parts are only in the archive)\n` : '';
    return `${dropped}${m.chapters.map((c, i) => renderChapter(c, (m.droppedChapters ?? 0) + i + 1)).join('\n')}`;
  }

  status(wsId, tid) {
    const active = this.chat.readAll(wsId, tid).length;
    let archived = 0;
    try { archived = fs.readFileSync(this.archiveFile(wsId, tid), 'utf8').split('\n').filter(Boolean).length; } catch { /* none yet */ }
    const m = this.load(wsId, tid);
    return { thread: tid, active, archived, chapters: m.chapters.length + (m.droppedChapters ?? 0), due: active >= this.compressAt };
  }

  /** Condense everything but the newest `keep` messages. Returns null when there is nothing to do. */
  compress(wsId, tid, { keep = this.keep } = {}) {
    const rows = this.chat.readAll(wsId, tid);
    if (rows.length <= keep + 5) return null;
    const old = rows.slice(0, rows.length - keep);
    const recent = rows.slice(rows.length - keep);
    // 1) the archive first: if anything fails after this, no message is lost (at worst it exists twice)
    fs.mkdirSync(path.dirname(this.archiveFile(wsId, tid)), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(this.archiveFile(wsId, tid), 'a', 0o600);
    try { fs.writeSync(fd, old.map((m) => JSON.stringify(m)).join('\n') + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // 2) the digest
    const mem = this.load(wsId, tid);
    mem.chapters.push(digest(old));
    while (mem.chapters.length > MAX_CHAPTERS) { mem.chapters.shift(); mem.droppedChapters = (mem.droppedChapters ?? 0) + 1; }
    fs.mkdirSync(path.dirname(this.file(wsId, tid)), { recursive: true, mode: 0o700 });
    atomicWrite(this.file(wsId, tid), JSON.stringify(mem));
    // 3) the active file keeps only the tail
    atomicWrite(this.chat.threadFile(wsId, tid), `${recent.map((m) => JSON.stringify(m)).join('\n')}\n`);
    return { archived: old.length, kept: recent.length, chapters: mem.chapters.length };
  }

  /** Archived messages (oldest first), for `recall --archive` and date ranges that reach back. */
  readArchive(wsId, tid) {
    let raw;
    try { raw = fs.readFileSync(this.archiveFile(wsId, tid), 'utf8'); } catch { return []; }
    const out = [];
    const seen = new Set();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { const m = JSON.parse(line); if (!seen.has(m.id)) { seen.add(m.id); out.push(m); } } catch { /* damaged line */ }
    }
    return out;
  }

  /** Called after every stored message: compress by itself once a thread is long. */
  maybeCompress(wsId, tid) {
    try {
      if (this.chat.readAll(wsId, tid).length >= this.compressAt) return this.compress(wsId, tid);
    } catch { /* memory is a convenience: a failure here must never lose or block a message */ }
    return null;
  }
}
