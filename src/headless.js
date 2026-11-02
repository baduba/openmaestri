// One-shot agent runs: give a prompt to any agent CLI in its non-interactive mode and get the
// answer back as text. No terminal, no screen scraping. Works with Claude Code, Codex, Gemini CLI,
// Antigravity (agy), Kimi, OpenCode, Aider and Goose out of the box; any other tool can be added in settings.json under
// "drivers" (see docs/agents.md). The flags below are what each tool documents at the time of
// writing; a tool that changes them is fixed by overriding its driver, not by editing code.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { commandPath, readUserEnv } from './terminals.js';

export class HeadlessError extends Error {}
const fail = (m) => { throw new HeadlessError(m); };

const DEEPSEEK = (env) => env.OPENMAESTRI_DEEPSEEK_MODEL || 'deepseek-flash';
const withModel = (flag, model) => (model ? [flag, model] : []);

// multi-provider tools may need any of these; single-provider drivers list only their own
const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY'];

/** name -> { bin, keys, args(prompt, {model, env}) }. `keys` are the secret variables the tool is given. The prompt is always its own argv entry: no shell is involved. */
/** kimi marks its answer with a bullet and prints its version and a resume hint on stderr; neither is part of the answer. */
export function tidyKimi({ text, stderr }) {
  const noise = (l) => /^kimi version \S+$/.test(l.trim()) || l.trim().startsWith('To resume this session:');
  return {
    text: text.startsWith('• ') ? text.slice(2) : text,
    stderr: stderr.split('\n').filter((l) => !noise(l)).join('\n').trim(),
  };
}

/** Google ended the Gemini CLI for individual accounts; say so instead of leaving a bare authentication error. */
export function geminiHint(stderr) {
  return stderr.includes('IneligibleTierError') ? 'Google no longer supports the Gemini CLI for individual accounts. Use the agy driver (Antigravity) instead.' : '';
}

export const DRIVERS = {
  claude: { bin: 'claude', keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'], args: (p, o) => ['-p', p, ...withModel('--model', o.model)] },
  codex: { bin: 'codex', keys: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'], args: (p, o) => ['exec', ...withModel('--model', o.model), p] },
  gemini: { bin: 'gemini', keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], args: (p, o) => [...withModel('--model', o.model), '-p', p], hint: geminiHint },
  opencode: { bin: 'opencode', keys: PROVIDER_KEYS, args: (p, o) => ['run', ...withModel('-m', o.model), p] },
  aider: { bin: 'aider', keys: PROVIDER_KEYS, args: (p, o) => ['--message', p, '--yes-always', '--no-auto-commits', '--no-pretty', ...withModel('--model', o.model)] },
  agy: { bin: 'agy', keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], args: (p, o) => ['-p', p, ...withModel('--model', o.model)] },
  kimi: { bin: 'kimi', keys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'], args: (p, o) => ['-p', p, ...withModel('--model', o.model)], tidy: tidyKimi },
  goose: { bin: 'goose', keys: PROVIDER_KEYS, args: (p) => ['run', '-t', p] },
  'opencode-deepseek': { bin: 'opencode', keys: ['DEEPSEEK_API_KEY'], args: (p, o) => ['run', '-m', `deepseek/${o.model || DEEPSEEK(o.env)}`, p] },
  'aider-deepseek': { bin: 'aider', keys: ['DEEPSEEK_API_KEY'], args: (p, o) => ['--message', p, '--yes-always', '--no-auto-commits', '--no-pretty', '--model', `deepseek/${o.model || DEEPSEEK(o.env)}`] },
};

/** Drivers from settings.json: { "name": { "bin": "tool", "args": ["--ask", "{prompt}"] } }, {prompt} and {model} are filled in. */
export function customDrivers(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [name, d] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(name) || !d || typeof d.bin !== 'string' || !Array.isArray(d.args) || !d.args.every((a) => typeof a === 'string')) continue;
    if (!d.args.some((a) => a.includes('{prompt}'))) continue;
    let sandbox;
    if (d.sandbox !== undefined) { try { sandbox = checkSandbox(d.sandbox); } catch { continue; } }
    // a custom driver without "keys" gets every key from the env file (it is your own driver); list "keys" to give it less
    const keys = Array.isArray(d.keys) && d.keys.every((k) => typeof k === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(k)) ? d.keys : undefined;
    out[name] = { bin: d.bin, ...(keys ? { keys } : {}), ...(sandbox ? { sandbox } : {}), args: (p, o) => d.args.map((a) => a.replaceAll('{prompt}', p).replaceAll('{model}', o.model ?? '')) };
  }
  return out;
}

export function driverNames(custom = {}) { return Object.keys({ ...DRIVERS, ...customDrivers(custom) }); }

// no DBUS_SESSION_BUS_ADDRESS (it would let the tool ask the keyring), no SSH_AUTH_SOCK, no display
const KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TZ|TMPDIR|TERM|COLORTERM|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|https?_proxy|no_proxy|all_proxy|LC_[A-Z]+|XDG_[A-Z_]+|NVM_[A-Z_]+|SDKMAN_DIR)$/;
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/** The environment of a one-shot agent: a short allow-list of the daemon's own, plus the keys from the env file. Never OPENMAESTRI_* (the worker cannot drive the canvas) and never the daemon's other variables. */
export function workerEnv(base, envFile, resolveSecret, driver) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (KEEP.test(k) && typeof v === 'string') env[k] = v;
  // keys are per driver: Claude never receives the DeepSeek key, and the other way round
  for (const [k, v] of Object.entries(readUserEnv(envFile, resolveSecret))) {
    if (!SECRETISH.test(k) || !driver?.keys || driver.keys.includes(k)) env[k] = v;
  }
  env.TERM = 'dumb';
  env.NO_COLOR = '1';
  env.CI = '1';
  return env;
}

const MAX_OUT = 400 * 1024;
const MAX_ERR = 4 * 1024;
export const MAX_PROMPT = 100 * 1024;
export const MAX_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * @returns {Promise<{ok: boolean, text: string, exitCode: number|null, signal: string|null, timedOut: boolean, cancelled: boolean, truncated: boolean, stderr: string, ms: number}>}
 */
export async function runHeadless({ driver, drivers = DRIVERS, prompt, cwd, env, model, timeoutMs = 10 * 60 * 1000, signal, resolveBin = commandPath, sandbox = null }) {
  const d = drivers[driver];
  if (!d) fail(`no driver named "${driver}". Available: ${Object.keys(drivers).join(', ')}`);
  const text = String(prompt ?? '');
  if (!text.trim()) fail('give it a prompt');
  if (text.length > MAX_PROMPT) fail(`the prompt is over ${MAX_PROMPT / 1024} KB`);
  if (model !== undefined && (!/^[\w./:@-]{1,80}$/.test(String(model)) || String(model).includes('..'))) fail('model names use letters, digits and . _ / : @ -');
  const box = sandbox ?? d.sandbox ?? null;
  let bin;
  let argv = d.args(text, { model, env });
  let containerName = null;
  if (box) {
    // the agent runs inside a container: the program only has to exist in the image, and docker is what runs on the host
    bin = resolveBin('docker');
    if (!bin) fail('"docker" was not found in your shell, so the sandbox cannot start');
    containerName = `om-${crypto.randomBytes(6).toString('hex')}`;
    argv = dockerArgs(box, { name: containerName, cwd, bin: d.bin, args: argv, envNames: Object.keys(env) });
  } else {
    bin = resolveBin(d.bin);
    if (!bin) fail(`"${d.bin}" was not found in your shell. Install it (run: openmaestri doctor)`);
  }
  const limit = Math.min(Math.max(Number(timeoutMs) || 0, 1000), MAX_TIMEOUT_MS);
  const started = Date.now();
  return new Promise((resolve) => {
    // its own process group, so a timeout ends the agent and every tool it started
    const child = spawn(bin, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let err = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let done = false;
    const kill = (sig) => {
      // killing the docker client does not stop the container, so the container is removed by name too (rm -f also clears one that never started)
      if (containerName && sig === 'SIGKILL') spawnSync(bin, ['rm', '-f', containerName], { stdio: 'ignore', timeout: 10000 });
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
    };
    const stop = () => { kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 3000).unref(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, limit);
    const onAbort = () => { cancelled = true; stop(); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { if (out.length < MAX_OUT) out += c.slice(0, MAX_OUT - out.length); else truncated = true; });
    child.stderr.on('data', (c) => { err = (err + c).slice(-MAX_ERR); });
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      kill('SIGKILL');
      const ok = !timedOut && !cancelled && r.exitCode === 0;
      const raw = { text: out.trim(), stderr: containerName ? explainDocker(err.trim(), box) : err.trim() };
      const tidy = d.tidy ? d.tidy(raw) : raw;
      const hint = !ok && d.hint ? d.hint(raw.stderr) : '';
      resolve({ truncated, timedOut, cancelled, ms: Date.now() - started, ...r, text: tidy.text, stderr: hint ? `${hint}\n${tidy.stderr}`.trim() : tidy.stderr, ok });
    };
    child.on('error', (e) => finish({ exitCode: null, signal: null, stderr: `${err}${e.message}`.trim() }));
    child.on('close', (code, sig) => finish({ exitCode: code, signal: sig }));
  });
}

/** Docker's own errors are long and cryptic; say what to do about the common ones. */
export function explainDocker(stderr, box) {
  const low = stderr.toLowerCase();
  const has = (...needles) => needles.some((n) => low.includes(n));
  if (has('cannot connect to the docker daemon', 'is the docker daemon running')) return 'Docker is installed but its service is not running. Start it (sudo systemctl start docker) and try again.';
  if (has('permission denied while trying to connect to the docker')) return 'Your user is not allowed to use Docker. Add it to the docker group (sudo usermod -aG docker $USER), log in again, and retry.';
  if (has('unable to find image', 'pull access denied', 'manifest unknown', 'repository does not exist')) {
    const image = typeof box === 'string' ? box : box?.image ?? 'the image';
    return `The image ${image} was not found. Pull or build it first: docker pull ${image}`;
  }
  return stderr;
}

const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]{0,200}$/;
const MEMORY_RE = /^[1-9]\d{0,4}[mg]$/;

/** Settings of a sandbox: an image, and optionally { network: 'bridge' | 'none', memory: '2g' }. A bare string is the image. */
export function checkSandbox(raw) {
  const box = typeof raw === 'string' ? { image: raw } : raw;
  if (!box || typeof box !== 'object' || typeof box.image !== 'string' || !IMAGE_RE.test(box.image) || box.image.includes('..')) fail('a sandbox needs an image name such as node:22 or my-agents:latest');
  const network = box.network ?? 'bridge';
  if (!['bridge', 'none'].includes(network)) fail('a sandbox network is "bridge" (normal access) or "none" (no network)');
  const memory = box.memory ?? '2g';
  if (!MEMORY_RE.test(memory)) fail('sandbox memory looks like 512m or 2g');
  return { image: box.image, network, memory };
}

/**
 * The `docker run` command for one agent. The folder is the only thing shared with the host;
 * variables are passed by name (the values travel in docker's own environment, not on a command
 * line), the user is yourself rather than root, and the container cannot gain privileges.
 */
export function dockerArgs(box, { name, cwd, bin, args, envNames }) {
  const { image, network, memory } = checkSandbox(box);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const names = envNames.filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !['PATH', 'HOME', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME', 'PWD'].includes(n));
  return ['run', '--rm', '--init', '--name', name, '--network', network, '--memory', memory, '--pids-limit', '256', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${uid}:${gid}`, '-v', `${cwd}:/work`, '-w', '/work', '-e', 'HOME=/tmp', ...names.flatMap((n) => ['-e', n]), image, bin, ...args];
}

export const cwdLabel = (cwd) => path.basename(cwd || '');
