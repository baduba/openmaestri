// Entry point: starts the core, the CLI socket and the local web UI.
//   OPENMAESTRI_PORT   (default 7777, 0 = random)
//   OPENMAESTRI_DATA_DIR
// The UI gives shell access, so it is bound to loopback only and every request
// needs the per-install token (cookie or ?token=) plus a same-origin Host/Origin.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Core, CommandError } from './core.js';
import { dataDir, atomicWrite, safeId } from './store.js';
import { startIpc, defaultSocketPath, ipcAlive } from './ipc.js';
import { MAESTRO_BOOTSTRAP } from './prompts.js';
import { exportWorkspace, importWorkspace, capturePartitura } from './transfer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src http: https:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cache-control': 'no-store',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function loadToken(dir) {
  const file = path.join(dir, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  atomicWrite(file, t);
  return t;
}

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function cookieToken(req) {
  const m = /(?:^|;\s*)om_token=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

export async function main({ port = Number(process.env.OPENMAESTRI_PORT ?? 7777), dataRoot = dataDir(), socketPath = process.env.OPENMAESTRI_SOCKET_PATH || defaultSocketPath(), quiet = false } = {}) {
  if (await ipcAlive(socketPath)) {
    throw Object.assign(new Error('openmaestri is already running'), { code: 'ALREADY_RUNNING' });
  }
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataRoot, 0o700);
  const token = loadToken(dataRoot);
  const cliBin = path.join(root, 'bin', 'openmaestri.js');
  const core = new Core({ dataRoot, socketPath, cliDir: path.join(root, 'bin', 'shims'), cliBin });
  core.start();
  const ipc = await startIpc(core, socketPath);

  const allowedHost = (h) => {
    const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(h || '');
    return !!m && Number(m[2]) === actualPort;
  };
  const authed = (req, url) => {
    if (!allowedHost(req.headers.host)) return false;
    const origin = req.headers.origin;
    if (origin && !allowedHost(new URL(origin).host)) return false;
    const t = url.searchParams.get('token') || cookieToken(req);
    return !!t && safeEq(t, token);
  };

  const server = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://x');
    if (!authed(req, url)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('forbidden: open the URL printed by openmaestri (it carries the token)');
    }
    if (url.searchParams.get('token')) {
      res.setHeader('set-cookie', `om_token=${token}; HttpOnly; SameSite=Strict; Path=/`);
      if (url.pathname === '/') { res.writeHead(302, { location: '/', 'set-cookie': res.getHeader('set-cookie') }); return res.end(); }
    }
    if (url.pathname.startsWith('/export/')) return serveExport(url.pathname, res);
    serveStatic(url.pathname, res);
  });

  function serveExport(pathname, res) {
    let ws;
    try { ws = core.store.workspaces.get(safeId(pathname.slice('/export/'.length).replace(/\.json$/, ''))); } catch { ws = null; }
    if (!ws) { res.writeHead(404); return res.end('not found'); }
    const safeName = ws.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'workspace';
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${safeName}.openmaestri.json"` });
    res.end(JSON.stringify(exportWorkspace(core.store, ws), null, 2));
  }

  function serveStatic(pathname, res) {
    const vendor = {
      '/vendor/xterm.mjs': 'node_modules/@xterm/xterm/lib/xterm.mjs',
      '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
      '/vendor/addon-fit.mjs': 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs',
    };
    let file;
    if (Object.hasOwn(vendor, pathname)) file = path.join(root, vendor[pathname]);
    else {
      const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      file = path.join(root, 'web', rel);
      if (!file.startsWith(path.join(root, 'web') + path.sep)) { res.writeHead(400); return res.end(); }
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': (Object.hasOwn(MIME, path.extname(file)) && MIME[path.extname(file)]) || 'application/octet-stream' });
      res.end(buf);
    });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (!authed(req, url)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const broadcast = (msg, filter = () => true) => {
    const s = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1 && filter(c)) c.send(s);
  };

  core.on('workspace', (id) => {
    const ws = core.store.workspaces.get(id);
    if (ws) broadcast({ t: 'workspace', ws: core.payload(ws) });
  });
  core.on('workspace-list', () => broadcast({ t: 'summary', ...core.summary() }));
  core.on('notify', (n) => broadcast({ t: 'notify', ...n }));
  core.on('term-data', (id, data) => broadcast({ t: 'term.out', id, data }, (c) => c.attached?.has(id)));
  core.on('term-status', (id, status, code) => broadcast({ t: 'term.status', id, status, code }));

  wss.on('connection', (ws) => {
    ws.attached = new Set();
    send(ws, { t: 'summary', ...core.summary() });
    const active = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
    if (active) send(ws, { t: 'workspace', ws: core.payload(active) });

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      try { handleUi(ws, m); } catch (e) {
        send(ws, { t: 'error', message: e.message, reqId: m.reqId });
      }
    });
    ws.on('close', () => ws.attached.clear());
  });

  function handleUi(ws, m) {
    const s = core.store;
    const wsOf = () => core.wsOrFail(m.workspaceId);
    switch (m.t) {
      case 'workspace.select': {
        const w = core.wsOrFail(m.id);
        s.settings.activeWorkspaceId = w.id;
        s.saveSettings();
        send(ws, { t: 'workspace', ws: core.payload(w), select: true });
        break;
      }
      case 'workspace.create': {
        const w = s.createWorkspace({ name: String(m.name || 'Workspace'), dir: m.dir, from: m.from });
        s.settings.activeWorkspaceId = w.id;
        s.saveSettings();
        broadcast({ t: 'summary', ...core.summary() });
        send(ws, { t: 'workspace', ws: core.payload(w), select: true });
        break;
      }
      case 'workspace.rename': {
        const w = core.wsOrFail(m.id);
        w.name = s.uniqueWorkspaceName(String(m.name || w.name));
        s.saveWorkspace(w.id);
        broadcast({ t: 'summary', ...core.summary() });
        break;
      }
      case 'workspace.delete': {
        const w = core.wsOrFail(m.id);
        for (const n of w.nodes) core.terminals.dispose(n.id);
        s.deleteWorkspace(m.id);
        broadcast({ t: 'summary', ...core.summary() });
        const next = s.workspaces.get(s.settings.activeWorkspaceId);
        send(ws, { t: 'workspace', ws: core.payload(next), select: true });
        break;
      }
      case 'viewport.set': {
        const w = wsOf();
        w.viewport = { x: +m.x || 0, y: +m.y || 0, z: Math.min(4, Math.max(0.1, +m.z || 1)) };
        s.saveWorkspace(w.id);
        break;
      }
      case 'node.create': {
        const w = wsOf();
        const props = { ...m.props };
        if (m.preset) {
          const p = s.settings.presets.find((x) => x.name === m.preset);
          if (p) { props.command = p.command; props.maestro = !!(props.maestro || p.maestro); props.preset = p.name; props.name ||= p.name; }
        }
        if (props.cwd) props.cwd = path.resolve(w.dir, props.cwd);
        const node = s.createNode(w, m.kind, props);
        if (node.kind === 'terminal') {
          core.startTerminal(w, node);
          // a Maestro running a real agent gets told what it is once the agent has booted
          if (node.maestro && node.command) setTimeout(() => { try { core.terminals.deliver(node.id, MAESTRO_BOOTSTRAP); } catch {} }, 5000).unref?.();
        }
        core.touch(w);
        break;
      }
      case 'node.patch': {
        const w = wsOf();
        s.patchNode(w, m.id, m.patch || {});
        core.touch(w);
        break;
      }
      case 'node.delete': {
        const w = wsOf();
        core.terminals.dispose(m.id);
        s.deleteNode(w, m.id, { keepStackNotes: m.keepNotes !== false });
        core.touch(w);
        break;
      }
      case 'note.write': {
        const w = wsOf();
        core.nodeOrFail(w, m.id);
        s.writeNote(w.id, m.id, String(m.text ?? ''));
        // not broadcast back to the sender, who already has the text; other tabs get it
        const msg = JSON.stringify({ t: 'note', workspaceId: w.id, id: m.id, text: String(m.text ?? '') });
        for (const c of wss.clients) if (c !== ws && c.readyState === 1) c.send(msg);
        break;
      }
      case 'conn.create': {
        const w = wsOf();
        s.connect(w, m.from, m.to);
        core.touch(w);
        break;
      }
      case 'conn.delete': {
        const w = wsOf();
        s.disconnect(w, m.id);
        core.touch(w);
        break;
      }
      case 'term.attach': {
        const w = wsOf();
        const node = core.nodeOrFail(w, m.id);
        if (node.kind !== 'terminal') break;
        core.startTerminal(w, node);
        ws.attached.add(node.id);
        send(ws, { t: 'term.snapshot', id: node.id, data: core.terminals.snapshot(node.id) });
        break;
      }
      case 'term.detach': ws.attached.delete(m.id); break;
      case 'term.in': core.terminals.write(m.id, String(m.data)); break;
      case 'term.resize': core.terminals.resize(m.id, m.cols, m.rows); break;
      case 'term.restart': {
        const w = wsOf();
        const node = core.nodeOrFail(w, m.id);
        core.terminals.dispose(node.id);
        core.startTerminal(w, node);
        send(ws, { t: 'term.snapshot', id: node.id, data: '' });
        core.touch(w);
        break;
      }
      case 'term.kill': core.terminals.kill(m.id); break;
      case 'term.trust': {
        const w = wsOf();
        const node = core.nodeOrFail(w, m.id);
        node.untrusted = false;
        core.terminals.dispose(node.id);
        core.startTerminal(w, node);
        send(ws, { t: 'term.snapshot', id: node.id, data: '' });
        core.touch(w);
        break;
      }
      case 'undo': { const w = wsOf(); if (!core.undo(w)) send(ws, { t: 'error', message: 'nothing to undo' }); break; }
      case 'redo': { const w = wsOf(); if (!core.redo(w)) send(ws, { t: 'error', message: 'nothing to redo' }); break; }
      case 'tidy': core.tidy(wsOf()); break;
      case 'stack.addNote': {
        const w = wsOf();
        const st = core.nodeOrFail(w, m.stackId);
        if (st.kind !== 'stack') throw new CommandError('not a stack');
        const note = s.createNode(w, 'note', { name: 'Note', x: st.x, y: st.y });
        s.addToStack(w, note.id, st.id);
        st.front = note.id;
        core.touch(w);
        break;
      }
      case 'note.stack': { const w = wsOf(); s.addToStack(w, m.noteId, m.stackId); core.touch(w); break; }
      case 'note.unstack': { const w = wsOf(); s.removeFromStack(w, m.noteId); core.touch(w); break; }
      case 'stack.front': {
        const w = wsOf();
        const st = core.nodeOrFail(w, m.id);
        if (st.kind === 'stack' && st.order.includes(m.noteId)) { st.front = m.noteId; core.touch(w); }
        break;
      }
      case 'band.create': {
        const w = wsOf();
        s.createBand(w, String(m.name || 'Band').slice(0, 80), Array.isArray(m.members) ? m.members : []);
        core.touch(w);
        break;
      }
      case 'band.add': { const w = wsOf(); s.addToBand(w, core.nodeOrFail(w, m.id), m.terminalId); core.touch(w); break; }
      case 'band.remove': { const w = wsOf(); s.removeFromBand(w, core.nodeOrFail(w, m.id), m.terminalId); core.touch(w); break; }
      case 'band.dissolve': { const w = wsOf(); s.deleteNode(w, m.id); core.touch(w); break; }
      case 'band.move': {
        const w = wsOf();
        const band = core.nodeOrFail(w, m.id);
        const dx = Number(m.dx), dy = Number(m.dy);
        if (band.kind !== 'band' || !Number.isFinite(dx) || !Number.isFinite(dy)) throw new CommandError('invalid band move');
        for (const id of band.members) { const n = core.nodeOrFail(w, id); s.patchNode(w, id, { x: n.x + dx, y: n.y + dy }); }
        core.touch(w);
        break;
      }
      case 'partitura.save': {
        const w = wsOf();
        const ids = Array.isArray(m.nodeIds) && m.nodeIds.length ? m.nodeIds : w.nodes.map((n) => n.id);
        const list = s.settings.partituras ??= [];
        const name = String(m.name || 'Layout').trim().slice(0, 80);
        if (list.some((p) => p.name.toLowerCase() === name.toLowerCase() && (p.scope === null || p.scope === w.id))) throw new CommandError(`partitura "${name}" already exists`);
        list.push(capturePartitura(s, w, ids, { name, commands: m.commands !== false, noteText: m.noteText !== false, scope: m.global ? 'global' : 'current' }));
        s.saveSettings();
        broadcast({ t: 'summary', ...core.summary() });
        break;
      }
      case 'partitura.insert': {
        const w = wsOf();
        const part = core.partiturasFor(w).find((p) => p.id === m.id) || (() => { throw new CommandError('unknown partitura'); })();
        core.insertPartitura(w, part, null);
        core.touch(w);
        break;
      }
      case 'partitura.delete': {
        const list = s.settings.partituras ?? [];
        s.settings.partituras = list.filter((p) => p.id !== m.id);
        s.saveSettings();
        broadcast({ t: 'summary', ...core.summary() });
        break;
      }
      case 'workspace.import': {
        const w = importWorkspace(s, m.bundle, { name: m.name, dir: m.dir });
        s.settings.activeWorkspaceId = w.id;
        s.saveSettings();
        broadcast({ t: 'summary', ...core.summary() });
        send(ws, { t: 'workspace', ws: core.payload(w), select: true });
        break;
      }
      default: throw new CommandError(`unknown message: ${m.t}`);
    }
  }

  // idle/working badge: push status changes of live terminals once a second
  const lastStatus = new Map();
  const statusTimer = setInterval(() => {
    for (const [id] of core.terminals.rt) {
      const st = core.terminals.status(id);
      if (lastStatus.get(id) !== st) { lastStatus.set(id, st); broadcast({ t: 'term.status', id, status: st }); }
    }
  }, 1000);
  statusTimer.unref();

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}/?token=${token}`;
  if (!quiet) {
    console.log(`openmaestri running\n  UI:     ${url}\n  socket: ${socketPath}\n  data:   ${dataRoot}`);
  }

  const close = async () => {
    clearInterval(statusTimer);
    core.stop();
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => server.close(r));
    await new Promise((r) => ipc.close(r));
    try { fs.unlinkSync(socketPath); } catch {}
  };
  return { core, server, url, port: actualPort, token, close, socketPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await main();
  const bye = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
