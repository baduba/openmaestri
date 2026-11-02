// Pull requests and merge requests of the repository's host, read through the user's own `gh`
// (GitHub) or `glab` (GitLab). Read-only: listing never changes the repository, and the CLI is
// the user's, already signed in, so openmaestri never sees or stores a token.
// Everything these tools print comes from other people (titles, branch names, author names), so
// it is cleaned of control characters before it reaches a terminal or the UI.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class ForgeError extends Error {}
const fail = (m) => { throw new ForgeError(m); };

const PROVIDERS = {
  github: { bin: 'gh', env: 'OPENMAESTRI_GH', install: 'https://cli.github.com (then: gh auth login)', word: 'pull request', refspec: (n) => `pull/${n}/head`, urlPart: 'pull' },
  gitlab: { bin: 'glab', env: 'OPENMAESTRI_GLAB', install: 'https://gitlab.com/gitlab-org/cli (then: glab auth login)', word: 'merge request', refspec: (n) => `merge-requests/${n}/head`, urlPart: 'merge_requests' },
};
export const providerInfo = (p) => PROVIDERS[p] ?? fail(`unknown provider "${p}". Use github or gitlab`);

/** "github", "gitlab" or null from a remote URL (ssh or https). */
export function detectProvider(remoteUrl) {
  let rest = String(remoteUrl).trim();
  const scheme = rest.indexOf('://');
  if (scheme > 0) rest = rest.slice(scheme + 3);
  const slash = rest.search(/[/]/);
  let authority = slash < 0 ? rest : rest.slice(0, slash);
  if (!authority.includes('@') && authority.includes(':') && scheme < 0) authority = authority.slice(0, authority.indexOf(':'));
  const host = authority.slice(authority.lastIndexOf('@') + 1).split(':')[0].toLowerCase();
  if (host === 'github.com' || host.startsWith('github.')) return 'github';
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) return 'gitlab';
  return null;
}

export function normalizeProvider(raw) {
  const v = String(raw ?? '').toLowerCase();
  if (v === 'gh' || v === 'github') return 'github';
  if (v === 'glab' || v === 'gitlab') return 'gitlab';
  return fail('--provider is github or gitlab');
}

/** Line separators and the bidirectional controls used in "trojan source" tricks (they make text read differently from how it is stored). */
const isInvisibleFormat = (c) => c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f || c === 0x061c;

/** Visible text only: control characters and escape sequences become spaces, length is capped. */
export function plain(v, max = 80) {
  let out = '';
  for (const ch of String(v ?? '')) {
    const c = ch.codePointAt(0);
    out += c < 32 || (c >= 127 && c < 160) || isInvisibleFormat(c) ? ' ' : ch;
  }
  out = out.replace(/ {2,}/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** passing | failing | pending | none, from GitHub's statusCheckRollup. */
export function summarizeChecks(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return 'none';
  const bad = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
  let pending = false;
  for (const c of rollup) {
    const verdict = String(c?.conclusion || c?.state || '').toUpperCase();
    if (bad.has(verdict)) return 'failing';
    if (c?.status && String(c.status).toUpperCase() !== 'COMPLETED') pending = true;
    if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(verdict) || !verdict) pending = true;
  }
  return pending ? 'pending' : 'passing';
}

function parseJson(text, who) {
  let data;
  try { data = JSON.parse(text); } catch { return fail(`${who} did not return JSON (is it signed in? run: ${who} auth status)`); }
  return Array.isArray(data) ? data : fail(`${who} returned something unexpected`);
}

const intOf = (v) => (Number.isInteger(v) && v > 0 ? v : null);

/**
 * @param {string} cwd  the repository
 * @param {{provider: string, resolveBin: (word: string) => string|null, limit?: number, runner?: Function}} deps
 * @returns {Promise<Array<{number: number, title: string, branch: string, author: string, draft: boolean, checks: string, url: string}>>}
 */
export async function listChanges(cwd, { provider, resolveBin, limit = 30, runner = run }) {
  const info = providerInfo(provider);
  const bin = resolveBin(info.bin);
  if (!bin) fail(`"${info.bin}" was not found in your shell. Install it: ${info.install}`);
  const args = provider === 'github'
    ? ['pr', 'list', '--state', 'open', '--limit', String(limit), '--json', 'number,title,headRefName,author,isDraft,statusCheckRollup,url']
    : ['mr', 'list', '--per-page', String(limit), '-F', 'json'];
  let out;
  try {
    ({ stdout: out } = await runner(bin, args, { cwd, timeout: 30000, maxBuffer: 4 << 20, env: forgeEnv() }));
  } catch (e) {
    const why = plain(String(e.stderr || e.message).split('\n').find((l) => l.trim()) ?? 'failed', 160);
    return fail(`${info.bin} failed: ${why}`);
  }
  const rows = parseJson(out, info.bin);
  return rows.slice(0, limit).map((r) => ({
    number: intOf(provider === 'github' ? r.number : r.iid),
    title: plain(r.title, 100),
    branch: plain(provider === 'github' ? r.headRefName : r.source_branch, 60),
    author: plain(provider === 'github' ? r.author?.login : r.author?.username, 40),
    draft: provider === 'github' ? r.isDraft === true : (r.draft === true || r.work_in_progress === true),
    checks: provider === 'github' ? summarizeChecks(r.statusCheckRollup) : 'unknown',
    url: /^https:\/\//.test(String(provider === 'github' ? r.url : r.web_url)) ? String(provider === 'github' ? r.url : r.web_url).slice(0, 300) : '',
  })).filter((r) => r.number !== null);
}

/** The daemon's own variables minus anything openmaestri-specific: gh and glab find their login in the user's files. */
function forgeEnv() {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GLAB_NO_PROMPT: '1', NO_COLOR: '1', GH_PAGER: 'cat', GLAB_PAGER: 'cat' };
  for (const k of Object.keys(env)) if (k.startsWith('OPENMAESTRI_') || k.startsWith('ELECTRON_')) delete env[k];
  return env;
}

export function formatChanges(rows, provider) {
  if (!rows.length) return `No open ${providerInfo(provider).word}s.`;
  const mark = { passing: 'ok  ', failing: 'FAIL', pending: '... ', none: '-   ', unknown: '?   ' };
  return rows.map((r) => `#${String(r.number).padEnd(5)} ${mark[r.checks] ?? '?   '} ${r.draft ? 'draft ' : '      '}${r.branch.padEnd(28).slice(0, 28)} ${r.author.padEnd(14).slice(0, 14)} ${r.title}`).join('\n');
}
