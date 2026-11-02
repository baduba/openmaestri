// MCP servers shared by a workspace (for example Context7, which gives agents current library documentation),
// written into the project config of the agents that understand them. Secrets never go into the files:
// a value is either plain text or a ${VAR} placeholder that the agent resolves from its own environment.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './store.js';
import { redact } from './memory.js';

export class McpError extends Error {}
const fail = (m) => { throw new McpError(m); };

export const PRESETS = {
  context7: {
    about: 'current documentation and code examples for libraries, so agents stop inventing APIs',
    server: { type: 'remote', url: 'https://mcp.context7.com/mcp' },
  },
};

const NAME = /^[a-z][a-z0-9_-]{0,30}$/;
const VAR = /^\$\{[A-Z_][A-Z0-9_]*\}$/;
const UNSAFE_WORD = /["'`;|&$<>\\]/;

/** "npx -y @upstash/context7-mcp" to ["npx","-y","@upstash/context7-mcp"]; no shell, so no quotes or operators. */
export function parseCommand(line) {
  const argv = String(line ?? '').trim().split(/\s+/).filter(Boolean);
  if (!argv.length) fail('give a command: --command "npx -y package"');
  if (argv.length > 20) fail('the command has too many arguments');
  if (argv.some((w) => UNSAFE_WORD.test(w))) fail('keep the command plain: words separated by spaces, no quotes, pipes or $ (there is no shell). Put anything complicated in a script and run that');
  return argv;
}

/** A value may be plain text, or exactly ${VAR}. Anything that looks like a credential is refused. */
function checkValue(what, v) {
  const s = String(v);
  if (VAR.test(s) || /^Bearer \$\{[A-Z_][A-Z0-9_]*\}$/.test(s)) return s;
  if (redact(s) !== s || /^Bearer\s+\S{8,}/.test(s)) fail(`${what} looks like a credential. Put the key in ~/.openmaestri/env (for example CONTEXT7_API_KEY=...) and write \${CONTEXT7_API_KEY} here`);
  return s;
}

function pairs(what, list) {
  const out = {};
  for (const item of list ?? []) {
    const i = String(item).indexOf('=');
    if (i < 1) fail(`${what} is NAME=value, got "${item}"`);
    const k = String(item).slice(0, i);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,60}$/.test(k)) fail(`bad ${what} name "${k}"`);
    out[k] = checkValue(`${what} ${k}`, String(item).slice(i + 1));
  }
  return out;
}

/** Build one validated server from the command line. */
export function buildServer({ name, command, url, env, header, key }) {
  if (!NAME.test(String(name ?? ''))) fail('a server name is lowercase letters, digits, - or _ (for example context7)');
  const preset = Object.hasOwn(PRESETS, name) && !command && !url ? PRESETS[name].server : null;
  if (preset) {
    const headers = key ? { Authorization: checkValue('key', `Bearer \${${key}}`) } : undefined;
    if (key && !/^[A-Z_][A-Z0-9_]*$/.test(key)) fail('--key is the NAME of an environment variable, for example CONTEXT7_API_KEY');
    return { ...preset, ...(headers ? { headers } : {}) };
  }
  if (command && url) fail('a server is either local (--command) or remote (--url)');
  if (command) return { type: 'local', command: parseCommand(command), ...(env?.length ? { env: pairs('env', env) } : {}) };
  if (url) {
    let u;
    try { u = new URL(String(url)); } catch { fail('the url is not valid'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) fail('a remote server must use https (http only for localhost)');
    if (u.username || u.password || u.search) fail('no credentials or query strings in the url; use --header "Authorization=Bearer ${VAR}"');
    return { type: 'remote', url: u.toString(), ...(header?.length ? { headers: pairs('header', header) } : {}) };
  }
  return fail(`give --command or --url, or use a preset: ${Object.keys(PRESETS).join(', ')}`);
}

export class Mcp {
  constructor({ dir }) { this.dir = dir; }
  file(wsId) { return path.join(this.dir(wsId), 'mcp.json'); }
  list(wsId) {
    try {
      const o = JSON.parse(fs.readFileSync(this.file(wsId), 'utf8'));
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch { return {}; }
  }
  set(wsId, name, server) {
    const all = this.list(wsId);
    if (!Object.hasOwn(all, name) && Object.keys(all).length >= 20) fail('at most 20 servers per workspace');
    fs.mkdirSync(this.dir(wsId), { recursive: true });
    atomicWrite(this.file(wsId), JSON.stringify({ ...all, [name]: server }, null, 2));
  }
  remove(wsId, name) {
    const all = this.list(wsId);
    if (!Object.hasOwn(all, name)) fail(`no server named "${name}" (see: openmaestri mcp list)`);
    delete all[name];
    atomicWrite(this.file(wsId), JSON.stringify(all, null, 2));
  }
}

export const mcpText = (all) => {
  const rows = Object.entries(all).map(([n, s]) => (s.type === 'remote' ? `${n}  remote  ${s.url}${s.headers ? `  (headers: ${Object.keys(s.headers).join(', ')})` : ''}` : `${n}  local   ${s.command.join(' ')}${s.env ? `  (env: ${Object.keys(s.env).join(', ')})` : ''}`));
  return rows.length ? rows.join('\n') : `no MCP servers. Start with a preset: openmaestri mcp add context7  (${PRESETS.context7.about})`;
};

// ---- what each agent reads ----
const toOpencodeVars = (v) => String(v).replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, '{env:$1}');
const mapValues = (o, f) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)])) : undefined);
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export const TARGETS = {
  claude: {
    file: '.mcp.json', key: 'mcpServers',
    render: (s) => (s.type === 'remote' ? drop({ type: 'http', url: s.url, headers: s.headers }) : drop({ command: s.command[0], args: s.command.slice(1), env: s.env })),
    note: 'Claude Code asks you to approve each project server the first time it starts.',
  },
  opencode: {
    file: 'opencode.json', key: 'mcp',
    render: (s) => (s.type === 'remote'
      ? drop({ type: 'remote', url: s.url, enabled: true, headers: mapValues(s.headers, toOpencodeVars) })
      : drop({ type: 'local', command: s.command, enabled: true, environment: mapValues(s.env, toOpencodeVars) })),
    note: 'Restart opencode so it reads the file.',
  },
};

/**
 * Plan (and optionally do) writing the servers into one agent's project config. Other entries of the file are kept.
 * `cwd` must already be checked to be inside the workspace.
 * @returns {{file: string, existed: boolean, before: string, after: string, changed: boolean, backup?: string}}
 */
export function planInstall({ cwd, kind, servers, remove = false, apply = false, now = Date.now() }) {
  const t = Object.hasOwn(TARGETS, kind) ? TARGETS[kind] : null;
  if (!t) fail(`MCP servers can be installed for ${Object.keys(TARGETS).join(' and ')} (the others keep theirs in a global file); "${kind}" is not one of them`);
  const file = path.join(cwd, t.file);
  if (kind === 'opencode' && fs.existsSync(path.join(cwd, 'opencode.jsonc'))) fail('this project has opencode.jsonc (with comments); edit that file by hand, openmaestri only rewrites opencode.json');
  let before = '';
  let existed = false;
  let mode = 0o644;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) fail(`${t.file} is not a regular file`);
    if (st.size > 1024 * 1024) fail(`${t.file} is larger than 1 MB; refusing to rewrite it`);
    before = fs.readFileSync(fd, 'utf8');
    existed = true;
    mode = st.mode & 0o777;
  } catch (e) {
    if (e instanceof McpError) throw e;
    if (e.code === 'ELOOP') fail(`${t.file} is a symbolic link; refusing to write through it`);
    if (e.code !== 'ENOENT') throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let doc = {};
  if (before.trim()) {
    try { doc = JSON.parse(before); } catch { fail(`${t.file} is not valid JSON; fix it by hand first`); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail(`${t.file} must hold a JSON object`);
  }
  const current = doc[t.key] && typeof doc[t.key] === 'object' ? { ...doc[t.key] } : {};
  for (const [name, s] of Object.entries(servers)) {
    if (remove) delete current[name]; else current[name] = t.render(s);
  }
  const next = { ...doc };
  if (Object.keys(current).length) next[t.key] = current; else delete next[t.key];
  if (kind === 'opencode' && !next.$schema && !existed) next.$schema = 'https://opencode.ai/config.json';
  const after = Object.keys(next).length || existed ? `${JSON.stringify(next, null, 2)}\n` : '';
  const changed = after !== before;
  const result = { file, existed, before, after, changed, note: t.note, mode };
  if (!apply || !changed) return result;
  if (existed) {
    result.backup = `${file}.bak-${now}`;
    fs.writeFileSync(result.backup, before, { mode, flag: 'wx' });
  }
  const tmp = `${file}.om-${process.pid}.tmp`;
  fs.writeFileSync(tmp, after, { mode, flag: 'wx' });
  fs.renameSync(tmp, file);
  return result;
}
