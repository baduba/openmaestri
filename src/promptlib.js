// Saved prompts: a small library of reusable messages, one Markdown file each.
//   global      <data dir>/prompts/<name>.md                    shared by every workspace
//   workspace   <data dir>/workspaces/<id>/prompts/<name>.md    only this workspace (wins over a global one of the same name)
// A deleted prompt moves to .trash/ for 30 days and can be restored. Files can also be edited
// with any editor; a watcher tells connected UIs when something changed on disk.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './store.js';

export class PromptError extends Error {}
const fail = (m) => { throw new PromptError(m); };

export const MAX_PROMPT_BYTES = 64 * 1024;
const TRASH_DAYS = 30;
const NAME_MAX = 60;

/** Letters, digits, space, dot, dash, underscore; starts with a letter or digit; no traversal possible. */
export function validName(raw) {
  const name = String(raw ?? '').trim();
  if (!name || name.length > NAME_MAX) fail(`a prompt name is 1 to ${NAME_MAX} characters`);
  if (!/^[\p{L}\p{N}]/u.test(name)) fail('a prompt name starts with a letter or digit');
  for (const ch of name) {
    const ok = /[\p{L}\p{N}]/u.test(ch) || ch === ' ' || ch === '.' || ch === '-' || ch === '_';
    if (!ok) fail('a prompt name may only use letters, digits, spaces, dots, dashes and underscores');
  }
  if (name.includes('..')) fail('a prompt name cannot contain ".."');
  return name;
}

const fileOf = (dir, name) => path.join(dir, `${name}.md`);

export class PromptLib extends EventEmitter {
  /** @param {{globalDir: string, localDir: (wsId: string) => string}} deps */
  constructor({ globalDir, localDir }) {
    super();
    this.globalDir = globalDir;
    this.localDir = localDir;
    this.watchers = new Map();
    this.timers = new Map();
    this.lastDeleted = [];
  }

  dir(wsId, scope) {
    if (scope === 'global') return this.globalDir;
    if (scope === 'workspace') return this.localDir(wsId);
    return fail('scope is "workspace" or "global"');
  }

  ensure(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  readFile(file) {
    // one descriptor for the checks and the read; O_NOFOLLOW refuses a symlink, O_NONBLOCK a FIFO cannot hang us
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) fail('not a regular file');
      if (st.size > MAX_PROMPT_BYTES) fail(`over the ${MAX_PROMPT_BYTES / 1024} KB limit`);
      return { text: fs.readFileSync(fd, 'utf8'), size: st.size, updatedAt: st.mtimeMs };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Prompts for one workspace: its own plus the global ones; a workspace prompt hides a global one with the same name. */
  list(wsId) {
    this.watch(wsId);
    const out = new Map();
    for (const scope of ['global', 'workspace']) {
      const dir = this.dir(wsId, scope);
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const f of names) {
        if (!f.endsWith('.md')) continue;
        const name = f.slice(0, -3);
        try { validName(name); } catch { continue; }
        try {
          const r = this.readFile(path.join(dir, f));
          out.set(name.toLowerCase(), { name, scope, size: r.size, updatedAt: r.updatedAt, preview: r.text.replace(/\s+/g, ' ').trim().slice(0, 100), shadows: scope === 'workspace' && out.has(name.toLowerCase()) });
        } catch { /* unreadable or oversized files are simply not listed */ }
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(wsId, name, scope) {
    const n = validName(name);
    const scopes = scope ? [scope] : ['workspace', 'global'];
    for (const s of scopes) {
      try { return { name: n, scope: s, ...this.readFile(fileOf(this.dir(wsId, s), n)) }; } catch (e) { if (e instanceof PromptError) throw e; }
    }
    return fail(`no saved prompt named "${n}"`);
  }

  save(wsId, name, text, { scope = 'workspace', overwrite = false } = {}) {
    const n = validName(name);
    const body = String(text ?? '');
    if (!body.trim()) fail('a prompt needs some text');
    if (Buffer.byteLength(body) > MAX_PROMPT_BYTES) fail(`a prompt is limited to ${MAX_PROMPT_BYTES / 1024} KB`);
    const dir = this.ensure(this.dir(wsId, scope));
    const dest = fileOf(dir, n);
    if (overwrite) atomicWrite(dest, body);
    else {
      // write beside, then link: link() fails with EEXIST instead of replacing, so two writers cannot clobber each other
      const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
      atomicWrite(tmp, body);
      try { fs.linkSync(tmp, dest); } catch (e) {
        if (e.code === 'EEXIST') fail(`a prompt named "${n}" already exists (use another name, or overwrite)`);
        throw e;
      } finally { fs.rmSync(tmp, { force: true }); }
    }
    this.emit('changed', wsId);
    return { name: n, scope };
  }

  /** Next free name: "Review", "Review 2", "Review 3"... */
  availableName(wsId, base, scope = 'workspace') {
    const root = validName(base);
    const dir = this.dir(wsId, scope);
    let name = root;
    for (let i = 2; fs.existsSync(fileOf(dir, name)) && i < 1000; i++) name = `${root} ${i}`.slice(0, NAME_MAX);
    return name;
  }

  remove(wsId, name, scope) {
    const n = validName(name);
    const found = this.get(wsId, n, scope);
    const dir = this.dir(wsId, found.scope);
    const trash = this.ensure(path.join(dir, '.trash'));
    const to = path.join(trash, `${n}.${Date.now()}.md`);
    fs.renameSync(fileOf(dir, n), to);
    this.lastDeleted.push({ wsId, name: n, scope: found.scope, trashed: to });
    if (this.lastDeleted.length > 20) this.lastDeleted.shift();
    this.emit('changed', wsId);
    return { name: n, scope: found.scope };
  }

  /** Bring back the most recently deleted prompt of this workspace. */
  undo(wsId) {
    const i = this.lastDeleted.map((d) => d.wsId).lastIndexOf(wsId);
    if (i < 0) return fail('nothing to restore');
    const d = this.lastDeleted[i];
    const dest = fileOf(this.dir(wsId, d.scope), d.name);
    try { fs.linkSync(d.trashed, dest); } catch (e) {
      if (e.code === 'EEXIST') return fail(`a prompt named "${d.name}" exists again; rename or delete it first`);
      if (e.code === 'ENOENT') return fail('the deleted prompt is no longer in the trash');
      throw e;
    }
    fs.rmSync(d.trashed, { force: true });
    this.lastDeleted.splice(i, 1);
    this.emit('changed', wsId);
    return { name: d.name, scope: d.scope };
  }

  purgeTrash(wsId, maxAgeMs = TRASH_DAYS * 86400000) {
    for (const scope of ['global', 'workspace']) {
      const trash = path.join(this.dir(wsId, scope), '.trash');
      let names;
      try { names = fs.readdirSync(trash); } catch { continue; }
      for (const f of names) {
        const full = path.join(trash, f);
        try { if (Date.now() - fs.lstatSync(full).mtimeMs > maxAgeMs) fs.rmSync(full, { force: true }); } catch { /* raced */ }
      }
    }
  }

  /** Tell listeners when a prompt file changes on disk, whoever changed it. */
  watch(wsId) {
    for (const scope of ['global', 'workspace']) {
      const dir = this.dir(wsId, scope);
      if (this.watchers.has(dir)) continue;
      try {
        this.ensure(dir);
        // the global folder is shared, so its changes concern every workspace (wsId null)
        const target = scope === 'global' ? null : wsId;
        const w = fs.watch(dir, { persistent: false }, (_ev, file) => {
          if (file && !String(file).endsWith('.md')) return;
          clearTimeout(this.timers.get(dir));
          const t = setTimeout(() => this.emit('changed', target), 150);
          t.unref();
          this.timers.set(dir, t);
        });
        w.on('error', () => { this.watchers.delete(dir); });
        this.watchers.set(dir, w);
      } catch { /* watching is a nicety: no inotify, no live updates */ }
    }
  }

  close() {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
