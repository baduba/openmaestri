// Floor snapshots: a safety net around agents that edit files.
//   snapshot   remembers the whole working tree of a floor (tracked files, new files, deletions;
//              not ignored files) as a git commit under refs/openmaestri/snapshots/<floor>/<id>.
//              The branch, the index and the working tree are not touched.
//   rollback   puts the working tree back as it was. First it takes a snapshot of the present
//              state, so a rollback can itself be rolled back.
// A snapshot restores FILES. It does not move the branch: commits made after it stay, and the
// staging area is not restored. Only the last 20 snapshots of a floor are kept.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, repoTop, FloorError } from './floors.js';

const fail = (m) => { throw new FloorError(m); };
const KEEP = 20;
const ID_RE = /^\d{17}-[0-9a-f]{4}$/;
const IDENTITY = { GIT_AUTHOR_NAME: 'openmaestri', GIT_AUTHOR_EMAIL: 'snapshots@openmaestri.invalid', GIT_COMMITTER_NAME: 'openmaestri', GIT_COMMITTER_EMAIL: 'snapshots@openmaestri.invalid' };

/** The folder name used under refs/: the floor slug, or "ground". */
export const keyOf = (floor) => (floor.id === null || floor.id === undefined ? 'ground' : floor.slug);
const refBase = (floor) => `refs/openmaestri/snapshots/${keyOf(floor)}`;

async function topOf(floor) {
  const top = await repoTop(floor.dir);
  if (!top) fail(`"${floor.name}" is not in a git repository, so it cannot be snapshotted`);
  if (fs.realpathSync(top) !== fs.realpathSync(floor.dir)) fail(`"${floor.name}" is a folder inside a repository; snapshots need the floor folder to be the top of one`);
  return top;
}

// year to millisecond, and never equal to or below the previous one: names sort in the order they were made
let lastStamp = 0;
const nulList = (text) => text.split('\0').filter(Boolean);

const stamp = () => {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return new Date(lastStamp).toISOString().replace(/\D/g, '').slice(0, 17);
};

async function hasHead(top) {
  try { await git(top, ['rev-parse', '--verify', '-q', 'HEAD']); return true; } catch { return false; }
}

const maxNewFiles = () => Math.max(1, Number(process.env.OPENMAESTRI_SNAPSHOT_MAX_FILES) || 20000);

/** A tree full of files that git does not ignore (an unignored node_modules, a build folder) would make every snapshot slow and heavy: say so instead. */
async function checkSize(top) {
  const out = await git(top, ['ls-files', '--others', '--exclude-standard', '-z'], { raw: true, timeout: 120000 });
  const count = nulList(out).length;
  if (count > maxNewFiles()) fail(`${count} new files are not ignored by git, which is too many to snapshot. Add the generated folders (node_modules, build, dist...) to .gitignore, or raise OPENMAESTRI_SNAPSHOT_MAX_FILES`);
}

/** @returns {{id: string, commit: string, label: string}} */
export async function takeSnapshot(floor, label = '') {
  const top = await topOf(floor);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'om-snap-'));
  const env = { ...IDENTITY, GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    const head = await hasHead(top);
    await checkSize(top);
    if (head) await git(top, ['read-tree', 'HEAD'], { env });
    await git(top, ['add', '-A', '--', '.'], { env, timeout: 180000 });
    const tree = await git(top, ['write-tree'], { env });
    const clean = String(label).replace(/\s+/g, ' ').trim().slice(0, 100);
    const message = `openmaestri snapshot${clean ? `: ${clean}` : ''}`;
    const commit = await git(top, ['commit-tree', tree, ...(head ? ['-p', 'HEAD'] : []), '-m', message], { env });
    const id = `${stamp()}-${crypto.randomBytes(2).toString('hex')}`;
    await git(top, ['update-ref', `${refBase(floor)}/${id}`, commit]);
    await prune(top, floor);
    return { id, commit, label: clean };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** Newest first. */
export async function listSnapshots(floor) {
  const top = await topOf(floor);
  const out = await git(top, ['for-each-ref', '--sort=-refname', '--format=%(refname)%09%(objectname)%09%(subject)', refBase(floor)]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [ref, commit, subject = ''] = line.split('\t');
    const id = ref.slice(ref.lastIndexOf('/') + 1);
    const t = id.slice(0, 17);
    return { id, commit, label: subject.replace(/^openmaestri snapshot:? ?/, ''), at: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)} UTC` };
  }).filter((s) => ID_RE.test(s.id));
}

async function prune(top, floor) {
  const all = await listSnapshots(floor);
  for (const old of all.slice(KEEP)) await git(top, ['update-ref', '-d', `${refBase(floor)}/${old.id}`]);
}

/** Forget every snapshot of a floor (used when the floor is deleted). Never throws. */
export async function dropSnapshots(repo, floor) {
  try {
    const out = await git(repo, ['for-each-ref', '--format=%(refname)', refBase(floor)]);
    for (const ref of out.split('\n').filter(Boolean)) await git(repo, ['update-ref', '-d', ref]);
  } catch { /* the repository is gone or has none */ }
}

/** Remove a file or link inside `top`; then its parent folders while they are empty. */
function removeInside(top, rel) {
  const full = path.join(top, rel);
  if (!full.startsWith(top + path.sep) || rel.split('/').includes('.git')) return;
  fs.rmSync(full, { force: true });
  for (let dir = path.dirname(full); dir.startsWith(top + path.sep); dir = path.dirname(dir)) {
    try { fs.rmdirSync(dir); } catch { break; }
  }
}

/**
 * @returns {{restored: number, removed: number, safety: {id: string}, headMoved: boolean}}
 */
export async function rollback(floor, id) {
  const top = await topOf(floor);
  const all = await listSnapshots(floor);
  const snap = id ? all.find((s) => s.id === String(id)) : all[0];
  if (!snap) fail(id ? `no snapshot "${String(id).slice(0, 30)}" on "${floor.name}" (see: floor snapshots)` : `"${floor.name}" has no snapshots yet`);
  const safety = await takeSnapshot(floor, `before rollback to ${snap.id}`);
  const wanted = new Set(nulList(await git(top, ['ls-tree', '-r', '-z', '--name-only', snap.commit], { raw: true })));
  const present = nulList(await git(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { raw: true }));
  let removed = 0;
  for (const rel of new Set(present)) {
    if (wanted.has(rel)) continue;
    removeInside(top, rel);
    removed += 1;
  }
  if (wanted.size) await git(top, ['restore', `--source=${snap.commit}`, '--worktree', '--', '.'], { timeout: 180000 });
  const headNow = await hasHead(top) ? await git(top, ['rev-parse', 'HEAD']) : '';
  const headThen = await hasHead(top) ? await git(top, ['rev-parse', `${snap.commit}^`]).catch(() => '') : '';
  return { restored: wanted.size, removed, safety, headMoved: !!headThen && headNow !== headThen };
}
