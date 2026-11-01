// File browser and editor backend. Every path a client sends is a path RELATIVE to a root (the
// workspace folder or a floor's folder) and is confined to it: no "..", no absolute paths, no NUL,
// no .git or .openmaestri, and symbolic links are followed only when they stay inside the root
// (and are never written through). Edits are atomic, keep the previous versions, and refuse to
// overwrite a file that changed on disk since it was opened.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export class FilesError extends Error {}
const fail = (m) => { throw new FilesError(m); };

export const MAX_EDIT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;
const KEEP_VERSIONS = 10;
const HIDDEN = new Set(['.git', '.openmaestri']);

const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Split a client path into safe segments; throws on anything that could leave the root. */
export function segments(rel) {
  if (typeof rel !== 'string') fail('a path is required');
  if (rel.includes('\0') || rel.includes('\\')) fail('that path is not allowed');
  if (rel.startsWith('/')) fail('paths are relative to the folder, never absolute');
  const parts = rel.split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..') fail('".." is not allowed in a path');
    if (HIDDEN.has(p)) fail(`${p} is not available here`);
    if (p.length > 255) fail('a name in that path is too long');
  }
  return parts;
}

export class Files {
  /** @param {{backupDir: (wsId: string) => string}} deps */
  constructor({ backupDir }) {
    this.backupDir = backupDir;
  }

  rootReal(root) {
    try { return fs.realpathSync(root); } catch { return fail('that folder does not exist any more'); }
  }

  /** Absolute path of `rel` under `root`, checked through symbolic links. */
  confine(root, rel, { existing = true } = {}) {
    const base = this.rootReal(root);
    const parts = segments(rel);
    const abs = path.join(base, ...parts);
    const check = existing ? abs : path.dirname(abs);
    let real;
    try { real = fs.realpathSync(check); } catch { return fail(existing ? 'no such file or folder' : 'the folder for that file does not exist'); }
    if (real !== base && !real.startsWith(base + path.sep)) fail('that path leaves the folder');
    return { base, abs, parts, real: existing ? real : path.join(real, path.basename(abs)) };
  }

  list(root, rel = '') {
    const { real } = this.confine(root, rel);
    const entries = [];
    let names;
    try { names = fs.readdirSync(real, { withFileTypes: true }); } catch { return fail('cannot read that folder'); }
    for (const ent of names) {
      if (HIDDEN.has(ent.name)) continue;
      if (entries.length >= MAX_ENTRIES) break;
      let type = ent.isDirectory() ? 'dir' : ent.isFile() ? 'file' : null;
      if (ent.isSymbolicLink()) {
        // a link is shown only when it points to something inside the root
        try {
          const target = fs.realpathSync(path.join(real, ent.name));
          const base = this.rootReal(root);
          if (target !== base && !target.startsWith(base + path.sep)) continue;
          type = fs.statSync(target).isDirectory() ? 'dir' : 'file';
        } catch { continue; }
      }
      if (!type) continue;
      let size = 0;
      if (type === 'file') { try { size = fs.statSync(path.join(real, ent.name)).size; } catch { /* vanished */ } }
      entries.push({ name: ent.name, type, size });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { path: segments(rel).join('/'), entries, truncated: names.length > MAX_ENTRIES };
  }

  openRead(abs) {
    return fs.openSync(abs, fs.constants.O_RDONLY | NONBLOCK);
  }

  read(root, rel) {
    const { real } = this.confine(root, rel);
    const fd = this.openRead(real);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) fail('that is not a file');
      if (st.size > MAX_EDIT_BYTES) return { size: st.size, mtimeMs: st.mtimeMs, tooLarge: true, text: '' };
      const buf = Buffer.alloc(st.size);
      let got = 0;
      while (got < st.size) { const n = fs.readSync(fd, buf, got, st.size - got, got); if (n === 0) break; got += n; }
      const data = buf.subarray(0, got);
      if (data.subarray(0, 8192).includes(0)) return { size: got, mtimeMs: st.mtimeMs, binary: true, text: '' };
      return { size: got, mtimeMs: st.mtimeMs, text: data.toString('utf8') };
    } finally { fs.closeSync(fd); }
  }

  versionsDir(wsId, base, parts) {
    const key = crypto.createHash('sha256').update(`${base}\0${parts.join('/')}`).digest('hex').slice(0, 24);
    return path.join(this.backupDir(wsId), key);
  }

  keepVersion(wsId, base, parts, content) {
    const dir = this.versionsDir(wsId, base, parts);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ids = fs.readdirSync(dir).map((n) => Number(n.slice(0, -4))).filter(Number.isFinite).sort((a, b) => a - b);
    // two saves in the same millisecond must not collide: ids only ever grow
    const id = Math.max(Date.now(), (ids.at(-1) ?? 0) + 1);
    fs.writeFileSync(path.join(dir, `${id}.txt`), content, { mode: 0o600, flag: 'wx' });
    for (const old of [...ids, id].slice(0, -KEEP_VERSIONS)) fs.rmSync(path.join(dir, `${old}.txt`), { force: true });
  }

  /** Save `text`. `expectedMtime` is what the editor saw when it opened the file. */
  write(root, rel, text, { wsId, expectedMtime } = {}) {
    if (typeof text !== 'string') fail('nothing to save');
    if (Buffer.byteLength(text) > MAX_EDIT_BYTES) fail('files over 1 MB are not edited here');
    const { abs, base, parts } = this.confine(root, rel);
    // one descriptor for the checks and the backup; O_NOFOLLOW refuses a symlink leaf, O_NONBLOCK keeps a FIFO from hanging us
    let fd;
    try { fd = fs.openSync(abs, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK); } catch (e) { return fail(e.code === 'ELOOP' ? 'that file is a symbolic link; it is not written through' : 'cannot open that file'); }
    let mode;
    try {
      const st0 = fs.fstatSync(fd);
      if (!st0.isFile()) fail('that is not a file');
      if (expectedMtime !== undefined && Math.abs(st0.mtimeMs - expectedMtime) > 1) fail('the file changed on disk since you opened it. Reload it, or copy your text first');
      mode = st0.mode & 0o777;
      this.keepVersion(wsId, base, parts, fs.readFileSync(fd));
    } finally { fs.closeSync(fd); }
    const tmp = `${abs}.om-${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode, flag: 'wx' });
    fs.renameSync(tmp, abs);
    const st = fs.statSync(abs);
    return { mtimeMs: st.mtimeMs, size: st.size };
  }

  versions(wsId, root, rel) {
    const { base, parts } = this.confine(root, rel);
    const dir = this.versionsDir(wsId, base, parts);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* none */ }
    return names.sort((a, b) => Number(b.slice(0, -4)) - Number(a.slice(0, -4))).map((n) => ({ id: n.slice(0, -4), at: Number(n.slice(0, -4)) }));
  }

  version(wsId, root, rel, id) {
    const { base, parts } = this.confine(root, rel);
    if (!/^\d{10,16}$/.test(String(id))) fail('unknown version');
    const file = path.join(this.versionsDir(wsId, base, parts), `${id}.txt`);
    try { return fs.readFileSync(file, 'utf8'); } catch { return fail('that version is gone'); }
  }

  create(root, rel, kind) {
    if (segments(rel).length === 0) fail('give it a name');
    const { abs } = this.confine(root, rel, { existing: false });
    if (kind === 'dir') {
      try { fs.mkdirSync(abs, { mode: 0o755 }); } catch (e) { fail(e.code === 'EEXIST' ? 'something with that name already exists' : 'cannot create that folder'); }
    } else {
      try { fs.writeFileSync(abs, '', { mode: 0o644, flag: 'wx' }); } catch (e) { fail(e.code === 'EEXIST' ? 'something with that name already exists' : 'cannot create that file'); }
    }
  }

  rename(root, from, to) {
    const src = this.confine(root, from);
    const dst = this.confine(root, to, { existing: false });
    if (fs.lstatSync(src.abs).isSymbolicLink()) fail('symbolic links are not renamed here');
    if (fs.existsSync(dst.abs)) fail('something with that name already exists');
    if (dst.abs === src.abs || dst.abs.startsWith(src.abs + path.sep)) fail('cannot move a folder into itself');
    fs.renameSync(src.abs, dst.abs);
  }

  /** Deleting moves the item to a trash folder next to the backups; it is never unlinked outright. */
  remove(root, rel, wsId) {
    const { abs, base, parts } = this.confine(root, rel);
    if (parts.length === 0) fail('the folder itself cannot be deleted');
    if (fs.lstatSync(abs).isSymbolicLink()) { fs.unlinkSync(abs); return { trashed: null }; }
    const trash = path.join(this.backupDir(wsId), 'trash');
    fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
    const dest = path.join(trash, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${path.basename(abs)}`);
    try { fs.renameSync(abs, dest); } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.cpSync(abs, dest, { recursive: true, errorOnExist: true });
      fs.rmSync(abs, { recursive: true });
    }
    void base;
    return { trashed: dest };
  }

  /** Git status per path (M, A, D, ?) when the folder is in a repository; {} otherwise. */
  async status(root) {
    const base = this.rootReal(root);
    try {
      const { stdout } = await run('git', ['-c', 'core.hooksPath=/dev/null', '-C', base, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], { timeout: 8000, maxBuffer: 4 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } });
      const out = {};
      const items = stdout.split('\0').filter(Boolean);
      for (let i = 0; i < items.length; i++) {
        const code = items[i].slice(0, 2);
        const file = items[i].slice(3);
        if (code[0] === 'R' || code[0] === 'C') i += 1;
        const c = code === '??' ? '?' : code.includes('D') ? 'D' : code.includes('A') ? 'A' : 'M';
        if (!HIDDEN.has(file.split('/')[0])) out[file] = c;
      }
      return out;
    } catch { return {}; }
  }
}
