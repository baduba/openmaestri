import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { detectProvider, normalizeProvider, plain, summarizeChecks, listChanges, formatChanges, ForgeError } from '../src/forge.js';

test('detectProvider reads the host, not the path', () => {
  assert.equal(detectProvider('git@github.com:a/b.git'), 'github');
  assert.equal(detectProvider('https://github.com/a/b'), 'github');
  assert.equal(detectProvider('ssh://git@gitlab.com:2222/a/b.git'), 'gitlab');
  assert.equal(detectProvider('https://user:pw@gitlab.example.org/a/b'), 'gitlab');
  assert.equal(detectProvider('https://evil.com/github.com/x'), null);
  assert.equal(detectProvider('/srv/git/repo.git'), null);
  assert.equal(normalizeProvider('GH'), 'github');
  assert.equal(normalizeProvider('glab'), 'gitlab');
  assert.throws(() => normalizeProvider('bitbucket'), /github or gitlab/);
});

test('plain strips control characters and escape sequences from text other people wrote', () => {
  const esc = String.fromCharCode(27); const bel = String.fromCharCode(7); const rlo = String.fromCharCode(0x202e);
  assert.equal(plain(`fix${esc}[31m red${bel} ${rlo}\ntitle`), 'fix [31m red title');
  assert.equal(plain(`a${String.fromCharCode(0)}b${String.fromCharCode(0x9b)}c`), 'a b c');
  assert.equal(plain('x'.repeat(200), 10), 'xxxxxxxxx…');
  assert.equal(plain(null), '');
});

test('summarizeChecks', () => {
  assert.equal(summarizeChecks([]), 'none');
  assert.equal(summarizeChecks(undefined), 'none');
  assert.equal(summarizeChecks([{ conclusion: 'SUCCESS', status: 'COMPLETED' }, { state: 'SUCCESS' }]), 'passing');
  assert.equal(summarizeChecks([{ conclusion: 'SUCCESS', status: 'COMPLETED' }, { conclusion: 'FAILURE', status: 'COMPLETED' }]), 'failing');
  assert.equal(summarizeChecks([{ status: 'IN_PROGRESS', conclusion: '' }]), 'pending');
  assert.equal(summarizeChecks([{ state: 'PENDING' }]), 'pending');
  assert.equal(summarizeChecks([{ conclusion: 'TIMED_OUT', status: 'COMPLETED' }, { status: 'QUEUED' }]), 'failing');
});

const ghJson = JSON.stringify([
  { number: 12, title: 'Add\u001b]0;pwned\u0007 thing', headRefName: 'feat/x', author: { login: 'ana' }, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }], url: 'https://github.com/a/b/pull/12' },
  { number: 9, title: 'WIP', headRefName: 'wip', author: { login: 'bo' }, isDraft: true, statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }], url: 'javascript:alert(1)' },
  { number: 'x', title: 'bad number' },
]);

test('listChanges: GitHub through gh, results cleaned and checked', async () => {
  let seen;
  const rows = await listChanges('/repo', { provider: 'github', resolveBin: (b) => `/usr/bin/${b}`, runner: async (bin, args, opts) => { seen = { bin, args, opts }; return { stdout: ghJson }; } });
  assert.equal(seen.bin, '/usr/bin/gh');
  assert.deepEqual(seen.args.slice(0, 4), ['pr', 'list', '--state', 'open']);
  assert.equal(seen.opts.cwd, '/repo');
  assert.equal(seen.opts.env.GH_PROMPT_DISABLED, '1');
  assert.ok(!Object.keys(seen.opts.env).some((k) => k.startsWith('OPENMAESTRI_')));
  assert.equal(rows.length, 2, 'a row without a numeric id is dropped');
  assert.equal(rows[0].title, 'Add ]0;pwned thing');
  assert.deepEqual([rows[0].checks, rows[1].checks, rows[1].draft], ['passing', 'failing', true]);
  assert.equal(rows[1].url, '', 'only https links are kept');
  const text = formatChanges(rows, 'github');
  assert.match(text, /#12\s+ok\s+feat\/x\s+ana\s+Add/);
  assert.match(text, /#9\s+FAIL draft wip/);
  assert.ok(!text.includes(String.fromCharCode(27)) && !text.includes(String.fromCharCode(7)));
  assert.equal(formatChanges([], 'gitlab'), 'No open merge requests.');
});

test('listChanges: GitLab through glab, and every failure has a plain message', async () => {
  const glab = JSON.stringify([{ iid: 4, title: 'MR four', source_branch: 'topic', author: { username: 'cy' }, draft: true, web_url: 'https://gitlab.com/a/b/-/merge_requests/4' }]);
  let args;
  const rows = await listChanges('/r', { provider: 'gitlab', resolveBin: () => '/usr/bin/glab', runner: async (_b, a) => { args = a; return { stdout: glab }; } });
  assert.deepEqual(args.slice(0, 2), ['mr', 'list']);
  assert.deepEqual(rows, [{ number: 4, title: 'MR four', branch: 'topic', author: 'cy', draft: true, checks: 'unknown', url: 'https://gitlab.com/a/b/-/merge_requests/4' }]);
  const base = { provider: 'github', resolveBin: () => '/usr/bin/gh' };
  await assert.rejects(listChanges('/r', { ...base, resolveBin: () => null }), /"gh" was not found.*gh auth login/);
  await assert.rejects(listChanges('/r', { ...base, runner: async () => ({ stdout: 'Welcome!' }) }), /did not return JSON.*gh auth status/);
  await assert.rejects(listChanges('/r', { ...base, runner: async () => ({ stdout: '{"a":1}' }) }), /unexpected/);
  await assert.rejects(listChanges('/r', { ...base, runner: async () => { throw Object.assign(new Error('x'), { stderr: '\nHTTP 401: Bad credentials\nmore' }); } }), /gh failed: HTTP 401: Bad credentials/);
  await assert.rejects(listChanges('/r', { ...base, provider: 'nope' }), ForgeError);
});

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: GIT_ENV, stdio: 'pipe', encoding: 'utf8' }).trim();

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-forge-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  const origin = path.join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const proj = path.join(dir, 'proj'); fs.mkdirSync(proj);
  git(proj, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(proj, 'a.txt'), 'a'); git(proj, 'add', '.'); git(proj, 'commit', '-qm', 'init');
  git(proj, 'remote', 'add', 'origin', origin); git(proj, 'push', '-q', 'origin', 'main');
  git(proj, 'checkout', '-q', '-b', 'topic'); fs.writeFileSync(path.join(proj, 'b.txt'), 'from the pull request'); git(proj, 'add', '.'); git(proj, 'commit', '-qm', 'pr work');
  git(proj, 'push', '-q', 'origin', 'topic:refs/pull/5/head', 'topic:refs/merge-requests/7/head'); git(proj, 'checkout', '-q', 'main');
  ws.dir = proj;
  const boss = core.store.createNode(ws, 'terminal', { name: 'Boss', maestro: true, command: '' });
  const worker = core.store.createNode(ws, 'terminal', { name: 'Worker', maestro: false, command: '' });
  const cmd = (me, name, args) => core.command({ terminalId: me.id }, name, args);
  return { dir, proj, core, ws, boss, worker, cmd };
}

test('floor create --pull-request: GitHub and GitLab refs, numbers or URLs, provider from origin or --provider', async (t) => {
  const { ws, boss, cmd } = await setup(t);
  await assert.rejects(cmd(boss, 'floor.create', { pullRequest: '5' }), /cannot tell if origin is GitHub or GitLab/);
  const gh = await cmd(boss, 'floor.create', { pullRequest: 'https://github.com/a/b/pull/5', provider: 'github' });
  assert.match(gh.text, /PR 5: worktree on pr-5/);
  assert.equal(fs.readFileSync(path.join(gh.data.dir, 'b.txt'), 'utf8'), 'from the pull request');
  const gl = await cmd(boss, 'floor.create', { pullRequest: '#7', provider: 'gitlab' });
  assert.match(gl.text, /MR 7: worktree on pr-7/);
  assert.equal(fs.readFileSync(path.join(gl.data.dir, 'b.txt'), 'utf8'), 'from the pull request');
  await assert.rejects(cmd(boss, 'floor.create', { pullRequest: 'https://github.com/a/b/merge_requests/5', provider: 'github' }), /takes a number or a pull request URL/);
  await assert.rejects(cmd(boss, 'floor.create', { pullRequest: 'abc', provider: 'github' }), /takes a number/);
  assert.equal(ws.floors.length, 2);
});

test('floor prs: Maestro only, needs a repo and the CLI; works with a gh on the PATH', async (t) => {
  const { dir, proj, core, ws, boss, worker, cmd } = await setup(t);
  await assert.rejects(cmd(worker, 'floor.prs', {}), /only available to Maestro/);
  git(proj, 'remote', 'set-url', 'origin', 'https://github.com/a/b.git');
  const bin = path.join(dir, 'fakebin'); fs.mkdirSync(bin);
  const old = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${old}`;
  t.after(() => { process.env.PATH = old; });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\nif [ "$1" = pr ] && [ "$2" = list ]; then cat <<'JSON'\n${ghJson}\nJSON\nelse exit 9; fi\n`, { mode: 0o755 });
  const out = await cmd(boss, 'floor.prs', {});
  assert.match(out.text, /#12 .*feat\/x.*ana/);
  assert.match(out.text, /floor create --pull-request N/);
  assert.equal(out.data.length, 2);
  const asJson = await cmd(boss, 'floor.prs', { json: true });
  assert.equal(JSON.parse(asJson.text)[0].number, 12);
  assert.ok(core.audit.read(5).some((e) => e.event === 'floor.prs'));
  fs.rmSync(path.join(bin, 'gh'));
  const real = await cmd(boss, 'floor.prs', {}).then(() => 'real gh answered', (e) => e.message);
  assert.ok(typeof real === 'string');
  ws.dir = dir;
  await assert.rejects(cmd(boss, 'floor.prs', {}), /not a git repository/);
});
