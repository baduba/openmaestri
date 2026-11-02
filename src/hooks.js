// Floor hooks: a check that runs after an agent has worked on a floor, or before the floor is
// landed. The command is written by the person (or the Maestro they trust) for this project,
// e.g. `npm test`; it runs in the floor folder with the same privileges as a terminal, but with a
// short allow-listed environment (no keys), no input, a time limit, and the whole process group
// stopped on timeout.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { checkSandbox, dockerArgs } from './headless.js';

const KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TZ|TMPDIR|LC_[A-Z]+|XDG_[A-Z_]+|NVM_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy)$/;
const MAX_TAIL = 4096;
export const MAX_COMMAND = 500;
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class HookError extends Error {}

export function checkCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim() || cmd.length > MAX_COMMAND || cmd.includes('\0')) throw new HookError(`a hook is a command of at most ${MAX_COMMAND} characters`);
  return cmd.trim();
}

const timeoutMs = () => Math.min(Math.max(Number(process.env.OPENMAESTRI_HOOK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, 1000), 30 * 60 * 1000);

/** @returns {Promise<{ok: boolean, exitCode: number|null, timedOut: boolean, output: string, ms: number}>} */
export function runHook(command, { cwd, base = process.env, sandbox = null, docker = 'docker' }) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (KEEP.test(k) && typeof v === 'string') env[k] = v;
  Object.assign(env, { TERM: 'dumb', NO_COLOR: '1', CI: '1', OPENMAESTRI_HOOK: '1' });
  const started = Date.now();
  return new Promise((resolve) => {
    // Intentional: the hook is a shell command the user configured for their own project.
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
    // inside a sandbox the command runs in the container (same folder rule as the agents); otherwise on this machine
    const cmd = checkCommand(command);
    let file = '/bin/sh';
    let argv = ['-c', cmd];
    let containerName = null;
    if (sandbox) {
      containerName = `om-hook-${crypto.randomBytes(6).toString('hex')}`;
      file = docker;
      argv = dockerArgs(checkSandbox(sandbox), { name: containerName, cwd, bin: 'sh', args: ['-c', cmd], envNames: Object.keys(env) });
    }
    const child = spawn(file, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let timedOut = false;
    let done = false;
    const kill = (sig) => {
      if (containerName && sig === 'SIGKILL') spawnSync(docker, ['kill', containerName], { stdio: 'ignore', timeout: 10000 });
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 3000).unref(); }, timeoutMs());
    const take = (c) => { output = (output + c).slice(-MAX_TAIL); };
    child.stdout.setEncoding('utf8').on('data', take);
    child.stderr.setEncoding('utf8').on('data', take);
    const finish = (exitCode, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      kill('SIGKILL');
      resolve({ ok: !timedOut && exitCode === 0, exitCode, timedOut, output: `${output}${extra}`.trim(), ms: Date.now() - started });
    };
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
  });
}

/** A hook result as one short paragraph for a report or an error. */
export function describeHook(name, r) {
  const state = r.ok ? 'passed' : r.timedOut ? 'timed out' : `FAILED (exit ${r.exitCode ?? '?'})`;
  const tail = !r.ok && r.output ? `\n${r.output.split('\n').slice(-12).join('\n')}` : '';
  return `${name} hook ${state} in ${(r.ms / 1000).toFixed(1)}s${tail}`;
}
