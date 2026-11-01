// Floors: a workspace has a ground floor (its own directory) and extra floors, each with its
// own canvas and, when the project is a git repository, its own checkout:
//   worktree  `git worktree add` under <repo>/.openmaestri/floors/<slug>   (cheap, shares objects)
//   clone     an independent `git clone --local` of the repo               (fully isolated)
//   dir       a folder the user already has (nothing is checked out)
//   plain     no repository: the floor shares the workspace directory
// Every git call goes through execFile with an argument array (no shell), with `--` or a
// validated ref before anything user-supplied, and a 60 s timeout.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { uid } from './store.js';

const run = promisify(execFile);
// read at call time so an identity exported later (or in tests) is honoured
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });

export class FloorError extends Error {}
const fail = (m) => { throw new FloorError(m); };

export async function git(cwd, args, { timeout = 60000 } = {}) {
  try {
    const { stdout } = await run('git', args, { cwd, env: gitEnv(), timeout, maxBuffer: 8 << 20 });
    return stdout.trim();
  } catch (e) {
    const text = String(e.stderr || e.stdout || e.message).trim().split('\n').slice(0, 6).join('\n');
    throw new FloorError(text || 'git failed');
  }
}

export const slugify = (name) => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function validName(name) {
  const n = String(name ?? '').trim();
  if (!n || n.length > 60) fail('a floor name is 1 to 60 characters');
  if (/^ground$/i.test(n)) fail('"Ground" is the workspace itself and cannot be used as a floor name');
  if (!slugify(n)) fail('a floor name needs letters or digits');
  return n;
}

async function checkBranchName(branch) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-') || branch.length > 200) fail(`invalid branch name: ${branch}`);
  try { await git(process.cwd(), ['check-ref-format', '--branch', branch]); } catch { fail(`invalid branch name: ${branch}`); }
  return branch;
}

export async function repoTop(dir) {
  try { return await git(dir, ['rev-parse', '--show-toplevel']); } catch { return null; }
}

export const floorsDir = (top) => path.join(top, '.openmaestri', 'floors');
const inside = (parent, child) => { const rel = path.relative(parent, child); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

async function ensureExcluded(top) {
  // keep floors out of `git status` in the main checkout
  const common = await git(top, ['rev-parse', '--git-common-dir']);
  const file = path.join(path.resolve(top, common), 'info', 'exclude');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* no exclude file yet */ }
  if (!text.split('\n').includes('/.openmaestri/')) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}/.openmaestri/\n`);
  }
}

export const groundOf = (ws) => ({ id: null, name: 'Ground', dir: ws.dir, kind: 'ground', status: ws.floorStatus ?? null });
export const floorById = (ws, id) => (id ? ws.floors.find((f) => f.id === id) ?? null : null);
export function findFloor(ws, name) {
  if (name == null || /^ground$/i.test(String(name))) return groundOf(ws);
  const lc = String(name).toLowerCase();
  return ws.floors.find((f) => f.name.toLowerCase() === lc) || fail(`no floor named "${name}"`);
}

/** Serialise git work per workspace so two floor operations never race on the same repo. */
const locks = new Map();
export function withLock(wsId, fn) {
  const prev = locks.get(wsId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(wsId, next);
  return next.finally(() => { if (locks.get(wsId) === next) locks.delete(wsId); });
}

/**
 * Create a floor record (and its checkout). Does not touch nodes: the caller seeds the canvas.
 */
export async function createFloor(ws, opts) {
  const name = validName(opts.name);
  if (ws.floors.some((f) => f.name.toLowerCase() === name.toLowerCase())) fail(`a floor named "${name}" already exists`);
  const slug = slugify(name);
  const floor = { id: uid(), name, slug, dir: ws.dir, kind: 'plain', branch: null, repo: null, createdAt: new Date().toISOString(), status: null };

  if (opts.dir) {
    const d = path.resolve(opts.dir);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) fail(`directory does not exist: ${d}`);
    Object.assign(floor, { kind: 'dir', dir: d });
  } else {
    const base = opts.from ? path.resolve(ws.dir, opts.from) : ws.dir;
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) fail(`directory does not exist: ${base}`);
    const top = opts.noGit ? null : await repoTop(base);
    if (!top) {
      if (opts.copy) fail('--copy needs a git repository');
      Object.assign(floor, { kind: 'plain', dir: base });
    } else {
      await git(top, ['rev-parse', '--verify', 'HEAD']).catch(() => fail('the repository has no commits yet; commit once before creating a floor'));
      const branch = await checkBranchName(opts.branch ?? `floor/${slug}`);
      const target = path.join(floorsDir(top), slug);
      if (fs.existsSync(target)) fail(`${target} already exists`);
      fs.mkdirSync(floorsDir(top), { recursive: true });
      await ensureExcluded(top);
      if (opts.copy) {
        await git(top, ['clone', '--local', '--', top, target], { timeout: 300000 });
        if (opts.existingBranch) await git(target, ['checkout', branch]);
        else await git(target, ['checkout', '-b', branch]);
        floor.kind = 'clone';
      } else {
        const args = opts.existingBranch ? ['worktree', 'add', '--', target, branch] : ['worktree', 'add', '-b', branch, '--', target, ...(opts.startPoint ? [opts.startPoint] : [])];
        await git(top, args);
        floor.kind = 'worktree';
      }
      Object.assign(floor, { dir: target, branch, repo: top });
    }
  }
  ws.floors.push(floor);
  return floor;
}

export async function floorStateOf(floor) {
  if (!floor.branch) return { dirty: false, ahead: 0, branch: null };
  const dirty = (await git(floor.dir, ['status', '--porcelain'])).length > 0;
  let ahead = 0;
  try {
    const base = await git(floor.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    ahead = Number(await git(floor.dir, ['rev-list', '--count', `${base}..HEAD`]));
  } catch { /* detached or unrelated */ }
  return { dirty, ahead, branch: floor.branch };
}

/** Merge a floor's branch into the project. Returns a summary; throws FloorError with a reason otherwise. */
export async function landFloor(ws, floor, { into } = {}) {
  if (!floor.branch || !floor.repo) fail(`"${floor.name}" has no branch of its own, so there is nothing to land`);
  const { dirty } = await floorStateOf(floor);
  if (dirty) fail(`"${floor.name}" has uncommitted changes. Commit or stash them on that floor first`);
  const repo = floor.repo;
  // a merge commit needs an identity; say so plainly instead of surfacing git's wall of text
  await git(repo, ['var', 'GIT_COMMITTER_IDENT']).catch(() => fail('git has no name and email configured. Run: git config --global user.name "Your Name" && git config --global user.email you@example.com'));
  if ((await git(repo, ['status', '--porcelain'])).length > 0) fail('the ground floor has uncommitted changes. Commit or stash them before landing');
  const current = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const target = into ? await checkBranchName(into) : current;
  if (target === floor.branch) fail('a floor cannot land into its own branch');
  let ref = floor.branch;
  if (floor.kind === 'clone') {
    ref = `refs/openmaestri/land/${floor.slug}`;
    await git(repo, ['fetch', '--no-tags', '--', floor.dir, `+refs/heads/${floor.branch}:${ref}`]);
  }
  if (target !== current) await git(repo, ['checkout', target]);
  try {
    const out = await git(repo, ['merge', '--no-edit', '--', ref]);
    return { into: target, summary: out.split('\n')[0] };
  } catch (e) {
    const conflicts = await git(repo, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
    await git(repo, ['merge', '--abort']).catch(() => {});
    if (target !== current) await git(repo, ['checkout', current]).catch(() => {});
    fail(conflicts ? `merge conflicts in:\n${conflicts}\nNothing was changed. Merge ${current} into the floor first and resolve them there.` : e.message);
  }
}

/** Remove a floor's checkout and, unless asked otherwise, its branch. The caller removes its nodes. */
export async function removeFloor(ws, floor, { keepBranch = false, keepFolder = false, force = false } = {}) {
  if (floor.branch && !force) {
    const { dirty } = await floorStateOf(floor);
    if (dirty) fail(`"${floor.name}" has uncommitted changes. Use --force to discard them`);
  }
  if (floor.kind === 'worktree' && !keepFolder) {
    await git(floor.repo, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', floor.dir]);
  } else if (floor.kind === 'clone' && !keepFolder) {
    if (!inside(floorsDir(floor.repo), floor.dir)) fail('refusing to delete a folder outside the floors directory');
    fs.rmSync(floor.dir, { recursive: true, force: true });
  }
  const warnings = [];
  ws.floors = ws.floors.filter((f) => f.id !== floor.id);
  if (floor.branch && floor.kind === 'worktree' && !keepBranch) {
    try { await git(floor.repo, ['branch', force ? '-D' : '-d', '--', floor.branch]); } catch (e) {
      warnings.push(/not fully merged/.test(e.message) ? `branch "${floor.branch}" was kept because it has commits that are not merged (land it first, or use --force)` : `could not delete branch "${floor.branch}": ${e.message}`);
    }
  }
  return { warnings };
}
