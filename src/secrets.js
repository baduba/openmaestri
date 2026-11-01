// Named secrets for agent keys. The env file keeps a reference instead of the key:
//     ANTHROPIC_API_KEY=secret://anthropic        resolved when a terminal starts
// Where the value lives:
//   keyring   the desktop keyring through `secret-tool` (libsecret), when it works on this machine
//   file      <data dir>/secrets.json, mode 0600, same trust level as the env file it replaces
// OPENMAESTRI_SECRETS_BACKEND=file|keyring|auto (default auto). Values are never printed, logged
// or exported; only names are listed. There is no home-made encryption: a key stored beside the
// file it protects would add nothing.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './store.js';

export class SecretError extends Error {}
const fail = (m) => { throw new SecretError(m); };

export const REF_PREFIX = 'secret://';
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_VALUE = 16 * 1024;

export function validName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) fail('a secret name is 1 to 64 characters: lowercase letters, digits, dot, dash, underscore, starting with a letter or digit');
  return name;
}

/** "secret://anthropic" gives "anthropic"; anything else gives null. */
export function refName(value) {
  if (typeof value !== 'string' || !value.startsWith(REF_PREFIX)) return null;
  const n = value.slice(REF_PREFIX.length);
  return NAME_RE.test(n) ? n : null;
}

function tool(args, input) {
  return spawnSync('secret-tool', args, { input, encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 20 });
}

class KeyringBackend {
  kind = 'keyring';
  /** Works only when secret-tool exists and talks to a running keyring (a missing entry is a clean exit 1 with no message). */
  static usable() {
    const r = tool(['lookup', 'service', 'openmaestri', 'name', '.probe']);
    return !r.error && r.status === 1 && !String(r.stderr).trim();
  }
  get(name) {
    const r = tool(['lookup', 'service', 'openmaestri', 'name', name]);
    return r.status === 0 && r.stdout ? r.stdout : null;
  }
  set(name, value) {
    const r = tool(['store', '--label', `openmaestri: ${name}`, 'service', 'openmaestri', 'name', name], value);
    if (r.error || r.status !== 0) fail('the keyring refused the secret (is it unlocked?)');
  }
  remove(name) { return tool(['clear', 'service', 'openmaestri', 'name', name]).status === 0; }
  list() {
    const r = tool(['search', '--all', 'service', 'openmaestri']);
    const names = new Set();
    for (const m of String(r.stdout).matchAll(/^attribute\.name = (.+)$/gm)) if (NAME_RE.test(m[1])) names.add(m[1]);
    return [...names].sort();
  }
}

class FileBackend {
  kind = 'file';
  constructor(file) { this.file = file; }
  read() {
    let fd;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      return fail('secrets.json cannot be read; fix or remove it (nothing was overwritten)');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  get(name) { const v = this.read()[name]; return typeof v === 'string' ? v : null; }
  set(name, value) {
    const data = this.read();
    data[name] = value;
    atomicWrite(this.file, JSON.stringify(data, null, 2));
    fs.chmodSync(this.file, 0o600);
  }
  remove(name) {
    const data = this.read();
    if (!(name in data)) return false;
    delete data[name];
    atomicWrite(this.file, JSON.stringify(data, null, 2));
    fs.chmodSync(this.file, 0o600);
    return true;
  }
  list() { return Object.keys(this.read()).filter((n) => NAME_RE.test(n)).sort(); }
}

export class Secrets {
  /** @param {{root: string, env?: object}} deps */
  constructor({ root, env = process.env }) {
    const want = (env.OPENMAESTRI_SECRETS_BACKEND || 'auto').toLowerCase();
    if (!['auto', 'file', 'keyring'].includes(want)) fail('OPENMAESTRI_SECRETS_BACKEND is auto, file or keyring');
    if (want === 'keyring' && !KeyringBackend.usable()) fail('the keyring backend was asked for but secret-tool is not usable here (install libsecret-tools and unlock your keyring)');
    this.backend = want === 'file' || (want === 'auto' && !KeyringBackend.usable()) ? new FileBackend(path.join(root, 'secrets.json')) : new KeyringBackend();
  }

  get kind() { return this.backend.kind; }
  list() { return this.backend.list(); }
  has(name) { return this.backend.get(validName(name)) !== null; }

  set(name, value) {
    validName(name);
    if (typeof value !== 'string' || !value.trim()) fail('a secret needs a value');
    if (/[\r\n\0]/.test(value.replace(/\n$/, ''))) fail('a secret is one line without control characters');
    if (value.length > MAX_VALUE) fail('that secret is too long');
    this.backend.set(name, value.replace(/\n$/, ''));
  }

  remove(name) { return this.backend.remove(validName(name)); }

  /** The value for "secret://name", or undefined when it is not a reference or is not stored. */
  resolve(ref) {
    const name = refName(ref);
    if (!name) return undefined;
    return this.backend.get(name) ?? undefined;
  }
}
