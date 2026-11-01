// Unix-socket RPC used by the `openmaestri` CLI running inside terminals.
// Wire format: one JSON object per line.
//   request  {id, ctx:{terminalId}, cmd, args}
//   response {id, ok:true, text, data} | {id, ok:false, error}
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CommandError } from './core.js';

export function defaultSocketPath() {
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(base, `openmaestri-${process.getuid?.() ?? 'u'}`, 'ipc.sock');
}

const MAX_LINE = 4 * 1024 * 1024;

/** True when something is already accepting connections on the socket (another daemon). */
export function ipcAlive(socketPath) {
  return new Promise((resolve) => {
    const c = net.createConnection(socketPath);
    const done = (v) => { c.destroy(); resolve(v); };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    setTimeout(() => done(false), 500).unref();
  });
}

export function startIpc(core, socketPath) {
  // sun_path is ~108 bytes on Linux; fail with a readable message instead of EINVAL
  if (Buffer.byteLength(socketPath) > 100) {
    return Promise.reject(new Error(`socket path is too long (${Buffer.byteLength(socketPath)} bytes): ${socketPath}. Set OPENMAESTRI_SOCKET_PATH to a shorter path.`));
  }
  // only tighten a directory we create; the socket file itself is chmod 0600 below
  const dir = path.dirname(socketPath);
  const fresh = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fresh) fs.chmodSync(dir, 0o700);
  try { fs.unlinkSync(socketPath); } catch {}

  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE) return sock.destroy();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) handle(line, sock);
      }
    });
  });

  async function handle(line, sock) {
    let req;
    try { req = JSON.parse(line); } catch { return reply(sock, { ok: false, error: 'malformed request' }); }
    const { id, ctx, cmd, args } = req;
    try {
      if (!ctx || typeof ctx.terminalId !== 'string') throw new CommandError('missing terminal context');
      const r = await core.command(ctx, String(cmd), args && typeof args === 'object' ? args : {});
      reply(sock, { id, ok: true, text: r.text ?? '', data: r.data });
    } catch (e) {
      if (!(e instanceof CommandError)) console.error('[ipc] command failed:', JSON.stringify(String(cmd).slice(0, 64)), e);
      reply(sock, { id, ok: false, error: e instanceof CommandError ? e.message : 'internal error (see the daemon log)' });
    }
  }

  const reply = (sock, obj) => { if (!sock.destroyed) sock.write(JSON.stringify(obj) + '\n'); };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      resolve(server);
    });
  });
}
