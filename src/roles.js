// Roles: reusable instructions for an agent ("you are the reviewer..."). They are found in four
// places and can be installed into the instruction file the agent already reads (AGENTS.md,
// CLAUDE.md, GEMINI.md) as a clearly marked block, with a dry run first and a backup before
// anything is changed. Roles that came from a repository are untrusted until the user says so.
import fs from 'node:fs';
import path from 'node:path';

export class RoleError extends Error {}
const fail = (m) => { throw new RoleError(m); };

const MAX_ROLE_BYTES = 16 * 1024;
const MAX_FILES = 50;

/** Written for openmaestri; short on purpose, so a cheap model can follow them. */
export const BUILTIN_ROLES = [
  { id: 'reviewer', name: 'Reviewer', description: 'Reads changes critically and reports what is wrong', prompt: 'You review code, you do not write it. Read the change, run the tests, and report problems in order of severity: bugs, security, missing tests, then style. For each problem give the file and line, why it matters, and a concrete fix. If something is fine, say so in one line. Do not edit files unless asked.' },
  { id: 'tester', name: 'Tester', description: 'Writes and runs tests, reports failures plainly', prompt: 'Your job is to prove whether the code works. Write tests for the behavior you were told about, including empty input, large input and hostile input. Run them and report exactly what failed with the command and the output. Do not change the code under test; describe the bug instead.' },
  { id: 'explorer', name: 'Explorer', description: 'Maps unfamiliar code and answers questions, read-only', prompt: 'You only read. Explore the repository to answer the question you were given: find the relevant files, follow the calls, and answer with file paths and line numbers. Say what you are unsure about. Never modify, create or delete files.' },
  { id: 'implementer', name: 'Implementer', description: 'Makes one scoped change and proves it works', prompt: 'You make the change you were asked for and nothing else. Keep the diff small, match the surrounding style, add or update tests, run them, and report what you changed and the test result. If the task is unclear or larger than described, stop and ask the Maestro instead of guessing.' },
  { id: 'writer', name: 'Writer', description: 'Writes and fixes documentation', prompt: 'You write documentation for people who have not seen the code. Check every command and path you mention by running it. Prefer short sentences, concrete examples and exact flag names. Do not describe features that do not exist.' },
];

export const AGENT_FILES = { opencode: 'AGENTS.md', codex: 'AGENTS.md', goose: 'AGENTS.md', claude: 'CLAUDE.md', gemini: 'GEMINI.md' };

export function validRoleId(id) {
  const s = String(id ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(s)) fail('a role id is lowercase letters, digits and dashes (up to 40)');
  return s;
}

export const idFromName = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'role';

function readCapped(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, MAX_ROLE_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.includes(0) ? null : buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function roleFiles(dir, source, trusted) {
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).slice(0, MAX_FILES); } catch { return []; }
  const out = [];
  for (const f of names) {
    const id = idFromName(f.slice(0, -3));
    let text = null;
    try { text = readCapped(path.join(dir, f)); } catch { /* unreadable or a symlink: skipped */ }
    if (!text?.trim()) continue;
    const first = text.split('\n').find((l) => l.trim()) ?? '';
    out.push({ id, name: f.slice(0, -3), description: first.replace(/^#+\s*/, '').slice(0, 100), prompt: text.trim(), source, trusted });
  }
  return out;
}

/**
 * Every role the user could install, with where it came from.
 * Files inside the repository (<project>/.openmaestri/roles/*.md, AGENTS.md, CLAUDE.md) are listed as
 * untrusted: anyone who can commit to the repository could have written them.
 */
export function discover({ userRoles = [], dataRoles, wsRoles, repoDir }) {
  const found = BUILTIN_ROLES.map((r) => ({ ...r, source: 'built-in', trusted: true }));
  for (const r of userRoles) found.push({ id: idFromName(r.name), name: r.name, description: r.prompt.slice(0, 100), prompt: r.prompt, source: r.workspaceId ? 'workspace' : 'user', trusted: true });
  found.push(...roleFiles(dataRoles, 'user file', true));
  found.push(...roleFiles(wsRoles, 'repository', false));
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    let text = null;
    try { text = readCapped(path.join(repoDir, f)); } catch { /* absent */ }
    if (text?.trim()) found.push({ id: `${idFromName(f)}-file`, name: `${f} (as found)`, description: `The instructions already in ${f}`, prompt: text.trim(), source: 'repository', trusted: false });
  }
  return found;
}

const open = (id) => `<!-- openmaestri:role:${id} -->`;
const close = (id) => `<!-- /openmaestri:role:${id} -->`;
export const blockFor = (role) => `${open(role.id)}\n## ${role.heading ?? `Role: ${role.name}`}\n\n${role.prompt.trim()}\n${close(role.id)}`;

/** Text of `file` with this role's block added or replaced (idempotent), or removed. */
export function withBlock(existing, role, { remove = false } = {}) {
  const a = existing.indexOf(open(role.id));
  const b = existing.indexOf(close(role.id));
  const has = a >= 0 && b > a;
  if (remove) {
    if (!has) return null;
    const end = b + close(role.id).length;
    return `${existing.slice(0, a).replace(/\n+$/, '\n')}${existing.slice(end).replace(/^\n+/, '')}`.replace(/^\n+$/, '');
  }
  if (has) return existing.slice(0, a) + blockFor(role) + existing.slice(b + close(role.id).length);
  return `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${existing ? '\n' : ''}${blockFor(role)}\n`;
}

export function agentKind(node) {
  const words = `${node.preset ?? ''} ${node.command ?? ''}`.toLowerCase().split(/[\s/"'=-]+/).filter(Boolean);
  return Object.keys(AGENT_FILES).find((k) => words.includes(k)) ?? null;
}

/**
 * Plan (and optionally do) an install or uninstall. `cwd` must already be checked to be inside the workspace.
 * @returns {{file: string, existed: boolean, before: string, after: string, changed: boolean, backup?: string}}
 */
export function plan({ cwd, kind, role, remove = false, apply = false, now = Date.now() }) {
  const result = {};
  const name = AGENT_FILES[kind];
  if (!name) fail(`no instruction file is known for "${kind}". Supported: ${Object.keys(AGENT_FILES).join(', ')}`);
  const file = path.join(cwd, name);
  let before = '';
  let existed = false;
  let fd;
  try {
    // one descriptor for checking and reading; O_NOFOLLOW makes a symlink fail instead of being followed
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) fail(`${name} is not a regular file`);
    if (st.size > 1024 * 1024) fail(`${name} is larger than 1 MB; refusing to rewrite it`);
    before = fs.readFileSync(fd, 'utf8');
    existed = true;
    result.mode = st.mode & 0o777;
  } catch (e) {
    if (e instanceof RoleError) throw e;
    if (e.code === 'ELOOP') fail(`${name} is a symbolic link; refusing to write through it`);
    if (e.code !== 'ENOENT') throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const after = withBlock(before, role, { remove });
  if (after === null) fail(`the role "${role.id}" is not installed in ${name}`);
  const changed = after !== before;
  Object.assign(result, { file, existed, before, after, changed });
  if (!apply || !changed) return result;
  if (existed) {
    result.backup = `${file}.bak-${now}`;
    fs.writeFileSync(result.backup, before, { mode: result.mode, flag: 'wx' }); // the bytes we read, not a second look at the file
  }
  const tmp = `${file}.om-${process.pid}.tmp`;
  fs.writeFileSync(tmp, after, { mode: existed ? result.mode : 0o644, flag: 'wx' });
  fs.renameSync(tmp, file);
  return result;
}

/** A short unified-style view of what an install would change. */
export function diffText(file, before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const lines = [`--- ${file}`, `+++ ${file} (after)`];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let ea = a.length;
  let eb = b.length;
  while (ea > i && eb > i && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  for (const l of a.slice(i, ea)) lines.push(`- ${l}`);
  for (const l of b.slice(i, eb)) lines.push(`+ ${l}`);
  return lines.join('\n');
}
