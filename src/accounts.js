// Accounts: named sets of environment variables, so the same agent can run as "work" or
// "personal" (different keys, base URLs, organisations).
//   openmaestri accounts set work ANTHROPIC_API_KEY=secret://work-anthropic ANTHROPIC_BASE_URL=https://...
//   openmaestri recruit "Dev" --preset Claude --account work
// A variable whose name looks like a key, token or password must be a secret:// reference (store
// it with `openmaestri secrets set`); only harmless settings may be written out literally. Names
// that change how programs start (PATH, LD_PRELOAD, NODE_OPTIONS...) are refused, because an
// account is an environment the agent runs in.
import fs from 'node:fs';
import { atomicWrite } from './store.js';
import { refName } from './secrets.js';

export class AccountError extends Error {}
const fail = (m) => { throw new AccountError(m); };

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const DENY_NAMES = new Set(['PATH', 'HOME', 'SHELL', 'IFS', 'PS1', 'PS2', 'PS3', 'PS4', 'PROMPT_COMMAND', 'BASH_ENV', 'ENV', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'TERM', 'USER', 'LOGNAME']);
const DENY_PREFIXES = ['LD_', 'DYLD_', 'PYTHON', 'PERL', 'RUBY', 'GIT_', 'SSH_', 'OPENMAESTRI_', 'ELECTRON_'];
const isDenied = (name) => DENY_NAMES.has(name) || DENY_PREFIXES.some((p) => name.startsWith(p));

/** Capital letters, digits and underscore, not starting with a digit, up to 64 characters (checked character by character). */
function isVarName(name) {
  if (typeof name !== 'string' || !name || name.length > 64) return false;
  for (let i = 0; i < name.length; i += 1) {
    const c = name.charCodeAt(i);
    const upper = (c >= 65 && c <= 90) || c === 95;
    if (!upper && !(i > 0 && c >= 48 && c <= 57)) return false;
  }
  return true;
}
const SECRET_WORDS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL'];
const looksSecret = (name) => SECRET_WORDS.some((w) => name.toUpperCase().includes(w));
const MAX_ACCOUNTS = 50;
const MAX_VARS = 30;

export const validAccountName = (n) => (typeof n === 'string' && NAME_RE.test(n) ? n : fail('an account name is 1 to 40 characters: lowercase letters, digits, dot, dash, underscore'));

export function checkVar(name, value) {
  if (!isVarName(name)) fail(`"${String(name).slice(0, 40)}" is not a valid variable name (capital letters, digits, underscore)`);
  if (isDenied(name)) fail(`${name} changes how programs start and cannot be part of an account`);
  if (typeof value !== 'string' || !value || value.length > 500 || /[\0\r\n]/.test(value)) fail(`${name}: a value is one line of at most 500 characters`);
  if (refName(value)) return;
  if (value.startsWith('secret://')) fail(`${name}: "${value.slice(0, 40)}" is not a valid secret reference (names are lowercase letters, digits, dot, dash, underscore)`);
  if (looksSecret(name)) fail(`${name} looks like a key, so it must be a secret reference: run "openmaestri secrets set NAME" and use ${name}=secret://NAME`);
}

export class Accounts {
  constructor(file) { this.file = file; }

  read() {
    let fd;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      return fail('accounts.json cannot be read; fix or remove it (nothing was overwritten)');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  save(data) {
    atomicWrite(this.file, JSON.stringify(data, null, 2));
    fs.chmodSync(this.file, 0o600);
  }

  /** Names and variable names only: never a value. */
  list() {
    const data = this.read();
    return Object.keys(data).filter((n) => NAME_RE.test(n)).sort((a, b) => a.localeCompare(b)).map((name) => ({ name, vars: Object.keys(data[name]?.env ?? {}).sort((a, b) => a.localeCompare(b)) }));
  }

  has(name) { return Object.hasOwn(this.read(), name) && NAME_RE.test(name); }

  set(name, pairs) {
    validAccountName(name);
    const entries = Object.entries(pairs ?? {});
    if (!entries.length) fail('usage: accounts set NAME VAR=value ...');
    for (const [k, v] of entries) checkVar(k, v);
    const data = this.read();
    if (!Object.hasOwn(data, name) && Object.keys(data).length >= MAX_ACCOUNTS) fail(`at most ${MAX_ACCOUNTS} accounts`);
    const env = { ...(Object.hasOwn(data, name) ? data[name].env : {}), ...Object.fromEntries(entries) };
    if (Object.keys(env).length > MAX_VARS) fail(`at most ${MAX_VARS} variables per account`);
    data[name] = { env };
    this.save(data);
  }

  unset(name, vars) {
    const data = this.read();
    if (!Object.hasOwn(data, name)) return false;
    for (const v of vars) delete data[name].env[v];
    this.save(data);
    return true;
  }

  remove(name) {
    const data = this.read();
    if (!Object.hasOwn(data, name)) return false;
    delete data[name];
    this.save(data);
    return true;
  }

  /**
   * The environment of an account with secret references resolved. A reference that cannot be
   * resolved is left out with a warning; a variable that no longer passes the checks is skipped.
   */
  env(name, resolve) {
    if (!name) return {};
    const data = this.read();
    if (!Object.hasOwn(data, name)) return fail(`no account named "${String(name).slice(0, 40)}" (see: openmaestri accounts list)`);
    const out = {};
    for (const [k, v] of Object.entries(data[name].env ?? {})) {
      try { checkVar(k, v); } catch { continue; }
      if (refName(v)) {
        const secret = resolve?.(v);
        if (typeof secret !== 'string') { console.warn(`[accounts] ${name}: ${k} points to ${v}, which is not stored`); continue; }
        out[k] = secret;
      } else out[k] = v;
    }
    return out;
  }
}
