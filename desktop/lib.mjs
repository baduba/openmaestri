// The parts of the desktop shell that do not need Electron, so they can be tested with plain Node.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

/** A node >= 22 to run the daemon: OPENMAESTRI_NODE, else the first `node` in PATH. */
export function findNode(env = process.env) {
  const candidates = [env.OPENMAESTRI_NODE, 'node'].filter(Boolean);
  for (const bin of candidates) {
    const r = spawnSync(bin, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 8000, env });
    const major = Number(String(r.stdout).split('.')[0]);
    if (r.status === 0 && major >= 22) return bin;
  }
  return null;
}

/** The UI address from what `openmaestri serve` prints; only a loopback address with a token is accepted. */
export function parseUiUrl(output) {
  for (const line of String(output).split('\n')) {
    const at = line.indexOf('UI:');
    if (at < 0) continue;
    const candidate = line.slice(at + 3).trim();
    try {
      const u = new URL(candidate);
      if (u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.searchParams.get('token')) return u.href;
    } catch { /* not a URL */ }
  }
  return null;
}

/** Only web pages may be opened outside the app. */
export const isExternalHttp = (url) => {
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
};

/** Whether `url` stays inside the daemon's own origin. */
export const sameOrigin = (url, base) => {
  try { return new URL(url).origin === new URL(base).origin; } catch { return false; }
};

/**
 * Start `openmaestri serve` (or find the one already running).
 * @returns {Promise<{url: string, child: import('node:child_process').ChildProcess|null}>}
 */
export function startDaemon({ node, root, env = process.env, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(root, 'bin', 'openmaestri.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('openmaestri did not start in time')); }, timeoutMs);
    const check = () => {
      const url = parseUiUrl(out);
      if (!url) return;
      clearTimeout(timer);
      // "already running": the process we started exits at once and the daemon belongs to someone else
      resolve({ url, child: out.includes('already running') ? null : child });
    };
    child.stdout.on('data', (c) => { out += c; check(); });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { if (!parseUiUrl(out)) { clearTimeout(timer); reject(new Error(`openmaestri exited with ${code}: ${out.trim().slice(-300)}`)); } });
  });
}
