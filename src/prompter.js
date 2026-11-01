// Prompter: the composer behind the chat box. A message can mention things with typed tokens:
//   @agent:Name   @note:Name   @file:relative/path     (quote names with spaces: @note:"Release plan")
// Before a message is typed into the Maestro's terminal, mentions are materialised: a note becomes
// its text and a file becomes its content (at most 32 KB, read through one descriptor, inside the
// workspace only, never anything that looks like a secret). The thread keeps the raw text.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cleanText, looksSecret } from './chat.js';

export const MAX_FILE_BYTES = 32 * 1024;
const MAX_NOTE_CHARS = 32 * 1024;
const MAX_MENTIONS = 12;
const INDEX_LIMIT = 20000;
const INDEX_DEPTH = 8;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.openmaestri', '.next', '.cache', '.venv', '__pycache__', 'target']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.xz', '.7z', '.so', '.o', '.a', '.exe', '.dll', '.dylib', '.bin', '.deb', '.woff', '.woff2', '.ttf', '.mp3', '.mp4', '.mov', '.wasm', '.class', '.jar']);
const KINDS = new Set(['agent', 'note', 'file']);

/** "..." with \" and \\ as escapes. Returns null when it never closes or is absurdly long. */
function readQuoted(src, open) {
  let value = '';
  for (let k = open + 1; k < src.length && k - open <= 400; k++) {
    const c = src[k];
    if (c === '\\' && (src[k + 1] === '"' || src[k + 1] === '\\')) { value += src[k + 1]; k += 1; continue; }
    if (c === '"') return { value, end: k + 1 };
    value += c;
  }
  return null;
}

const isSpace = (ch) => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';

/**
 * Split text into plain pieces and mentions. A mention starts with "@kind:" at the start of the
 * text or after whitespace, so an e-mail address or `@decorator` in code stays plain text.
 * @returns {Array<{type:'text', text:string} | {type:'mention', kind:string, ref:string, raw:string}>}
 */
export function parse(text) {
  const src = String(text ?? '');
  const out = [];
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
  while (i < src.length) {
    const ch = src[i];
    const startsToken = ch === '@' && (i === 0 || isSpace(src[i - 1]));
    const colon = startsToken ? src.indexOf(':', i) : -1;
    const kind = colon > i ? src.slice(i + 1, colon) : '';
    if (!startsToken || !KINDS.has(kind)) { buf += ch; i += 1; continue; }
    let j = colon + 1;
    let ref;
    if (src[j] === '"') {
      const q = readQuoted(src, j);
      if (!q) { buf += ch; i += 1; continue; }
      ref = q.value;
      j = q.end;
    } else {
      const start = j;
      while (j < src.length && !isSpace(src[j])) j += 1;
      ref = src.slice(start, j).replace(/[.,;:!?)\]]+$/, '');
      j = start + ref.length;
    }
    if (!ref) { buf += ch; i += 1; continue; }
    flush();
    out.push({ type: 'mention', kind, ref, raw: src.slice(i, j) });
    i = j;
  }
  flush();
  return out;
}

/** The inverse of parse: blocks back to the raw text the composer shows. */
export function serialize(blocks) {
  return blocks.map((b) => (b.type === 'text' ? b.text : mentionToken(b.kind, b.ref))).join('');
}

export function mentionToken(kind, ref) {
  if (!KINDS.has(kind)) throw new Error(`unknown mention kind: ${kind}`);
  const r = String(ref);
  return /^[^\s"\\]+$/.test(r) ? `@${kind}:${r}` : `@${kind}:"${r.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** Read a workspace file for a mention: inside the roots, regular, small, text, not secret-looking. */
export function readMentionedFile(roots, relPath) {
  const rel = String(relPath);
  if (!rel || rel.includes('\0')) return { ok: false, reason: 'empty path' };
  let real = null;
  for (const root of roots) {
    try {
      const candidate = fs.realpathSync(path.resolve(root, rel));
      if (candidate === root || candidate.startsWith(root + path.sep)) { real = candidate; break; }
    } catch { /* not under this root */ }
  }
  if (!real) return { ok: false, reason: 'not found inside the workspace' };
  if (looksSecret(real)) return { ok: false, reason: 'looks like a secret, not included' };
  let fd;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
    if (st.size > MAX_FILE_BYTES) return { ok: false, reason: `${Math.ceil(st.size / 1024)} KB is over the ${MAX_FILE_BYTES / 1024} KB limit` };
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = fs.readSync(fd, buf, got, st.size - got, got);
      if (n === 0) break;
      got += n;
    }
    const data = buf.subarray(0, got);
    if (data.includes(0)) return { ok: false, reason: 'binary file, not included' };
    return { ok: true, text: cleanText(data.toString('utf8'), MAX_FILE_BYTES), bytes: got, path: real };
  } catch (e) {
    return { ok: false, reason: `cannot read it (${e.code ?? 'error'})` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Expand mentions. `ctx` supplies what a mention can resolve to:
 *   roots: string[]                    real paths of the workspace and its floors
 *   notes: () => [{name, text}]        every note
 *   agents: () => [{name, status}]     every agent
 * Nothing here throws on a bad mention: the placeholder tells the reader why it is empty.
 */
export function materialize(text, ctx) {
  const blocks = parse(text);
  const boundary = crypto.randomBytes(4).toString('hex');
  const mentions = [];
  let used = 0;
  const parts = blocks.map((b) => {
    if (b.type === 'text') return b.text;
    used += 1;
    if (used > MAX_MENTIONS) { mentions.push({ ...b, ok: false, reason: 'too many mentions' }); return `[${b.raw}: too many mentions in one message]`; }
    if (b.kind === 'agent') {
      const a = ctx.agents().find((x) => x.name.toLowerCase() === b.ref.toLowerCase());
      mentions.push({ kind: 'agent', ref: b.ref, ok: !!a, reason: a ? undefined : 'no such agent' });
      return a ? `${a.name}` : `[${b.raw}: no agent with that name]`;
    }
    if (b.kind === 'note') {
      const n = ctx.notes().find((x) => x.name.toLowerCase() === b.ref.toLowerCase());
      if (!n) { mentions.push({ kind: 'note', ref: b.ref, ok: false, reason: 'no such note' }); return `[${b.raw}: no note with that name]`; }
      const body = cleanText(n.text, MAX_NOTE_CHARS);
      mentions.push({ kind: 'note', ref: n.name, ok: true, bytes: body.length });
      return `\n<<<note "${n.name}" ${boundary}>>>\n${body}\n<<<end ${boundary}>>>\n`;
    }
    const f = readMentionedFile(ctx.roots, b.ref);
    mentions.push({ kind: 'file', ref: b.ref, ok: f.ok, reason: f.reason, bytes: f.bytes });
    return f.ok ? `\n<<<file "${b.ref}" ${boundary}>>>\n${f.text}\n<<<end ${boundary}>>>\n` : `[${b.raw}: ${f.reason}]`;
  });
  return { text: parts.join(''), mentions, blocks };
}

/**
 * List workspace files for the @file picker. Streams directories, never follows symlinks, skips
 * build output and secrets, and stops as soon as `signal` aborts (partial results are returned).
 */
export async function fileIndex(root, { signal, limit = INDEX_LIMIT, maxDepth = INDEX_DEPTH } = {}) {
  const files = [];
  let aborted = false;
  const walk = async (dir, depth) => {
    if (depth > maxDepth || aborted || files.length >= limit) return;
    let handle;
    try { handle = await fs.promises.opendir(dir); } catch { return; }
    try {
      for await (const ent of handle) {
        if (signal?.aborted) { aborted = true; return; }
        if (files.length >= limit) return;
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) {
          if (!SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) await walk(path.join(dir, ent.name), depth + 1);
        } else if (ent.isFile() && !BINARY_EXT.has(path.extname(ent.name).toLowerCase()) && !looksSecret(ent.name)) {
          files.push(path.relative(root, path.join(dir, ent.name)));
        }
      }
    } finally {
      await handle.close().catch(() => {});
    }
  };
  await walk(root, 0);
  files.sort();
  return { files, aborted, truncated: files.length >= limit };
}

/** Ranked substring match: prefix first, then word/segment starts, then anywhere. */
export function rank(items, query, key = (x) => x, max = 30) {
  const q = String(query ?? '').toLowerCase();
  const scored = [];
  for (const it of items) {
    const k = key(it).toLowerCase();
    if (!q) { scored.push([1, it]); continue; }
    const at = k.indexOf(q);
    if (at < 0) continue;
    scored.push([at === 0 ? 3 : /[\\/\s._-]/.test(k[at - 1] ?? '') ? 2 : 1, it]);
  }
  scored.sort((a, b) => b[0] - a[0] || key(a[1]).length - key(b[1]).length);
  return scored.slice(0, max).map((s) => s[1]);
}
