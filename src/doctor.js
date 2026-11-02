// `openmaestri doctor`: what is installed, what is missing, and the command that fixes it.
// It never prints a secret; for API keys it only says whether one is set.
import { Secrets } from './secrets.js';
import { Persist } from './persist.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from './store.js';
import { defaultSocketPath, ipcAlive } from './ipc.js';
import { findChrome } from './portals.js';
import { commandAvailable, readUserEnv } from './terminals.js';

const AGENTS = [
  ['opencode', 'OpenCode (works with DeepSeek)', 'see https://opencode.ai for the installer'],
  ['aider', 'Aider (works with DeepSeek)', 'pip install aider-chat   (https://aider.chat)'],
  ['claude', 'Claude Code', 'https://claude.com/claude-code'],
  ['codex', 'Codex CLI', 'https://github.com/openai/codex'],
  ['gemini', 'Gemini CLI', 'https://github.com/google-gemini/gemini-cli'],
];

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

/** @returns {Promise<Array<{name: string, level: 'ok'|'warn'|'fail', detail: string, fix?: string}>>} */
export async function runDoctor({ env = process.env, root = dataDir(), socketPath = env.OPENMAESTRI_SOCKET_PATH || defaultSocketPath() } = {}) {
  const out = [];
  const add = (name, level, detail, fix) => out.push({ name, level, detail, ...(fix ? { fix } : {}) });

  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js', major >= 22 ? 'ok' : 'fail', `v${process.versions.node}`, major >= 22 ? undefined : 'install Node.js 22 or newer (https://nodejs.org)');

  const git = sh('git', ['--version']);
  add('git', git ? 'ok' : 'warn', git ?? 'not found', git ? undefined : 'install git; floors need it (apt install git)');
  if (git) {
    const ident = sh('git', ['var', 'GIT_COMMITTER_IDENT']);
    add('git identity', ident ? 'ok' : 'warn', ident ? 'configured' : 'no name and email', ident ? undefined : 'git config --global user.name "Your Name" && git config --global user.email you@example.com   (landing a floor needs it)');
  }

  const chrome = findChrome(env);
  add('Browser for portals', chrome ? 'ok' : 'warn', chrome ?? 'no Chrome or Chromium found', chrome ? undefined : 'apt install chromium, or set OPENMAESTRI_CHROME; without it portals fall back to a plain frame agents cannot drive');

  for (const [cmd, label, fix] of AGENTS) {
    const r = commandAvailable(cmd);
    add(`Agent: ${label}`, r.ok ? 'ok' : 'warn', r.ok ? `${cmd} found` : `${cmd} not found`, r.ok ? undefined : fix);
  }

  const envFile = path.join(root, 'env');
  let mode = null;
  try { mode = fs.statSync(envFile).mode & 0o777; } catch { /* no file */ }
  let secrets = null;
  try { secrets = new Secrets({ root, env }); } catch { /* reported below */ }
  const fileKeys = readUserEnv(envFile, (ref) => secrets?.resolve(ref));
  const hasKey = !!(fileKeys.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY);
  add('DeepSeek API key', hasKey ? 'ok' : 'warn', hasKey ? `set (${fileKeys.DEEPSEEK_API_KEY ? envFile : 'environment'})` : 'not set', hasKey ? undefined : `put DEEPSEEK_API_KEY=... in ${envFile} (chmod 600); never in a workspace or a repository`);
  const tmux = Persist.detect(env);
  const wantsPersist = env.OPENMAESTRI_PERSIST === 'tmux';
  add('tmux (persistent terminals)', tmux ? 'ok' : wantsPersist ? 'warn' : 'ok', tmux ? `${tmux.bin}${wantsPersist ? ', persistence is on' : ', not enabled (OPENMAESTRI_PERSIST=tmux turns it on)'}` : 'not installed', tmux ? undefined : wantsPersist ? 'sudo apt install tmux' : 'optional: sudo apt install tmux, then set OPENMAESTRI_PERSIST=tmux');
  add('Secret store', secrets ? 'ok' : 'warn', secrets ? `${secrets.kind} (${secrets.list().length} stored)` : 'unavailable', secrets ? undefined : 'unset OPENMAESTRI_SECRETS_BACKEND or install libsecret-tools and unlock the keyring');
  if (mode !== null) add('Keys file permissions', (mode & 0o077) === 0 ? 'ok' : 'warn', `${envFile} is ${mode.toString(8)}`, (mode & 0o077) === 0 ? undefined : `chmod 600 ${envFile}`);
  if (hasKey) add('DeepSeek model', 'ok', fileKeys.OPENMAESTRI_DEEPSEEK_MODEL || env.OPENMAESTRI_DEEPSEEK_MODEL || 'deepseek-flash (default)');

  let dmode = null;
  try { dmode = fs.statSync(root).mode & 0o777; } catch { /* first run */ }
  add('Data folder', dmode === null ? 'ok' : (dmode & 0o077) === 0 ? 'ok' : 'warn', dmode === null ? `${root} (created on first run)` : `${root} is ${dmode.toString(8)}`, dmode !== null && (dmode & 0o077) !== 0 ? `chmod 700 ${root}` : undefined);

  const userns = sh('unshare', ['--user', 'true']);
  add('Browser sandbox', userns !== null ? 'ok' : 'warn', userns !== null ? 'user namespaces available' : 'user namespaces blocked', userns !== null ? undefined : 'Chrome may refuse to start; on Ubuntu 24.04 allow it for Chrome via AppArmor, or set OPENMAESTRI_CHROME_NO_SANDBOX=1 (weaker isolation)');

  const alive = await ipcAlive(socketPath);
  add('openmaestri daemon', alive ? 'ok' : 'warn', alive ? 'running' : 'not running', alive ? undefined : 'start it with: openmaestri serve --open');
  add('Host', 'ok', `${os.platform()} ${os.release()}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, limit ${process.env.OPENMAESTRI_MAX_TERMINALS || 40} terminals`);
  return out;
}

export function formatDoctor(rows) {
  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  const lines = rows.flatMap((r) => [`[${mark[r.level]}] ${r.name}: ${r.detail}`, ...(r.fix ? [`       fix: ${r.fix}`] : [])]);
  const fails = rows.filter((r) => r.level === 'fail').length;
  const warns = rows.filter((r) => r.level === 'warn').length;
  lines.push('', fails ? `${fails} problem(s) must be fixed.` : warns ? `Ready to use. ${warns} optional item(s) above would improve it.` : 'Everything looks good.');
  return lines.join('\n');
}
