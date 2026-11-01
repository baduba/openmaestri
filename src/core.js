// Core: owns the store, the terminal runtime and the scheduler, and implements
// every command that either the CLI (inside a terminal) or the UI can issue.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Store, dataDir } from './store.js';
import { GUIDE } from './prompts.js';
import { Terminals } from './terminals.js';
import { History } from './history.js';
import { tidy as tidyLayout } from './layout.js';
import { capturePartitura, instantiatePartitura } from './transfer.js';
import { Scheduler, parseSchedule, describeSchedule, nextRun } from './routines.js';

export class CommandError extends Error {}
const fail = (msg) => { throw new CommandError(msg); };

/** Escapes accepted by `ask --raw`: \n \t \e \r \\ and \xNN. */
export function unescapeRaw(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|[ntre\\])/g, (_m, g) => {
    if (g[0] === 'x') return String.fromCharCode(parseInt(g.slice(1), 16));
    return { n: '\r', t: '\t', r: '\r', e: '\x1b', '\\': '\\' }[g];
  });
}

export class Core extends EventEmitter {
  constructor({ dataRoot = dataDir(), socketPath, cliDir, cliBin }) {
    super();
    this.store = new Store(dataRoot);
    this.terminals = new Terminals({ socketPath, cliDir, cliBin, envFile: path.join(dataRoot, 'env') });
    this.socketPath = socketPath;
    this.startedAt = Date.now();
    this.notifyLog = new Map();
    this.history = new History();
    this.scheduler = new Scheduler({
      workspaces: () => this.store.workspaces.values(),
      changed: (ws) => this.touch(ws),
      fire: (ws, r, text) => {
        const node = ws.nodes.find((n) => n.id === r.terminalId);
        if (!node) return;
        this.terminals.ensure(node, ws);
        this.terminals.deliver(node.id, text);
        if (r.notify) this.emit('notify', { workspaceId: ws.id, from: `routine ${r.name}`, message: `Fired: ${r.name}` });
      },
    });
  }

  start() {
    // the undo baseline of a workspace is its state when it appeared, so even its first change can be undone
    this.store.onCreate = (ws) => this.history.entry(ws);
    this.store.load();
    for (const ws of this.store.workspaces.values()) this.history.entry(ws);
    this.scheduler.start();
    this.terminals.on('data', (id, data) => this.emit('term-data', id, data));
    this.terminals.on('exit', (id, code) => this.emit('term-status', id, 'exited', code));
    this.terminals.on('status', (id, st) => this.emit('term-status', id, st));
  }

  stop() {
    this.scheduler.stop();
    this.store.flush();
    this.terminals.disposeAll();
  }

  // ---------- state helpers ----------
  payload(ws) {
    const notes = {};
    for (const n of ws.nodes) if (n.kind === 'note') notes[n.id] = this.store.readNote(ws.id, n.id);
    const status = {};
    for (const n of ws.nodes) if (n.kind === 'terminal') status[n.id] = this.terminals.status(n.id);
    return { ...ws, notes, status, history: this.history.state(ws) };
  }

  summary() {
    return {
      active: this.store.settings.activeWorkspaceId,
      workspaces: [...this.store.workspaces.values()].map((w) => ({ id: w.id, name: w.name, dir: w.dir, nodes: w.nodes.length })),
      presets: this.store.settings.presets,
      partituras: (this.store.settings.partituras ?? []).map((p) => ({ id: p.id, name: p.name, description: p.description, icon: p.icon, color: p.color, scope: p.scope, nodes: p.nodes.length })),
    };
  }

  /** Mark a workspace changed: persist (debounced) and tell every listener. */
  touch(ws) {
    this.history.record(ws);
    this.store.saveWorkspace(ws.id);
    this.emit('workspace', ws.id);
  }

  /** Replace the structure with a snapshot from history; terminals of removed nodes stop, trashed notes return. */
  applySnapshot(ws, snap) {
    const before = new Set(ws.nodes.map((n) => n.id));
    ws.nodes = snap.nodes;
    ws.connections = snap.connections;
    const after = new Set(ws.nodes.map((n) => n.id));
    for (const id of before) if (!after.has(id)) this.terminals.dispose(id);
    for (const n of ws.nodes) if (n.kind === 'note' && !before.has(n.id)) this.store.untrashNote(ws.id, n.id);
    ws.routines = ws.routines.filter((r) => after.has(r.terminalId));
    this.store.saveWorkspace(ws.id);
    this.emit('workspace', ws.id);
  }

  undo(ws) {
    const snap = this.history.undo(ws);
    if (!snap) return false;
    this.applySnapshot(ws, snap);
    return true;
  }

  redo(ws) {
    const snap = this.history.redo(ws);
    if (!snap) return false;
    this.applySnapshot(ws, snap);
    return true;
  }

  tidy(ws) {
    const pos = tidyLayout(ws);
    for (const [id, p] of pos) this.store.patchNode(ws, id, p);
    this.touch(ws);
  }

  partiturasFor(ws) {
    return (this.store.settings.partituras ?? []).filter((p) => p.scope === null || p.scope === ws.id);
  }

  wsOrFail(id) {
    return this.store.workspaces.get(id) || fail(`unknown workspace: ${id}`);
  }
  nodeOrFail(ws, id) {
    return ws.nodes.find((n) => n.id === id) || fail(`unknown node: ${id}`);
  }

  // ---------- name resolution ----------
  reachable(ws, me) {
    return me.maestro ? ws.nodes.filter((n) => n.id !== me.id) : this.store.neighbors(ws, me.id);
  }

  resolve(ws, me, name, kinds = null) {
    if (!name) fail('a name is required');
    const pool = this.reachable(ws, me).filter((n) => !kinds || kinds.includes(n.kind));
    const lc = String(name).toLowerCase();
    const exact = pool.filter((n) => n.name.toLowerCase() === lc);
    if (exact.length === 1) return exact[0];
    const prefix = pool.filter((n) => n.name.toLowerCase().startsWith(lc));
    if (prefix.length === 1) return prefix[0];
    if (prefix.length > 1) fail(`"${name}" is ambiguous: ${prefix.map((n) => n.name).join(', ')}`);
    fail(`no ${kinds ? kinds.join('/') : 'node'} named "${name}" is connected to you. Connected: ${pool.map((n) => n.name).join(', ') || '(none)'}`);
  }

  resolveAny(ws, name, kinds = null) {
    const lc = String(name).toLowerCase();
    const pool = ws.nodes.filter((n) => !kinds || kinds.includes(n.kind));
    const hit = pool.find((n) => n.name.toLowerCase() === lc) || pool.filter((n) => n.name.toLowerCase().startsWith(lc));
    if (Array.isArray(hit)) {
      if (hit.length === 1) return hit[0];
      fail(hit.length ? `"${name}" is ambiguous: ${hit.map((n) => n.name).join(', ')}` : `no node named "${name}"`);
    }
    return hit || fail(`no node named "${name}"`);
  }

  requireMaestro(me) {
    if (!me.maestro) fail('this command is only available to Maestro terminals');
  }

  // ---------- spawning ----------
  startTerminal(ws, node) {
    return this.terminals.ensure(node, ws);
  }

  placeBeside(ws, anchor, size) {
    const gap = 60;
    const x = anchor.x + anchor.w + gap;
    let y = anchor.y;
    const overlaps = (yy) => ws.nodes.some((n) => x < n.x + n.w + 20 && x + size.w + 20 > n.x && yy < n.y + n.h + 20 && yy + size.h + 20 > n.y);
    while (overlaps(y)) y += 40;
    return { x, y };
  }

  // ---------- CLI commands ----------
  /**
   * @param {{terminalId: string}} ctx  caller identity (from the env the pty was spawned with)
   */
  async command(ctx, cmd, a = {}) {
    const ws = this.store.workspaceOfNode(ctx.terminalId) || fail('unknown terminal (was it removed?)');
    const me = this.nodeOrFail(ws, ctx.terminalId);
    const h = Object.hasOwn(HANDLERS, cmd) ? HANDLERS[cmd] : null;
    if (!h) fail(`unknown command: ${cmd}`);
    return h.call(this, ws, me, a);
  }

  get handlers() {
    return HANDLERS;
  }
}

const textOf = (rows) => rows.join('\n');
const kindLabel = { terminal: 'agent', note: 'note', portal: 'portal', stack: 'stack', band: 'band' };
const KIND_FLAGS = { agent: 'terminal', note: 'note', portal: 'portal', fichario: 'stack', stack: 'stack', band: 'band' };

const HANDLERS = {
  guide() {
    return { text: GUIDE };
  },

  list(ws, me) {
    const nodes = this.reachable(ws, me);
    const rows = nodes.map((n) => {
      const extra = n.kind === 'terminal' ? ` [${this.terminals.status(n.id)}]${n.maestro ? ' (maestro)' : ''}` : n.kind === 'portal' ? ` ${n.url}` : '';
      return `${kindLabel[n.kind].padEnd(7)} ${n.name}${extra}`;
    });
    const myBands = ws.nodes.filter((n) => n.kind === 'band' && n.members.includes(me.id));
    for (const b of myBands) rows.push(`band    ${b.name} (${b.members.map((m) => ws.nodes.find((n) => n.id === m)?.name).join(', ')})`);
    return {
      text: rows.length ? textOf(rows) : '(nothing is connected to this terminal)',
      data: { self: me.name, workspace: ws.name, nodes: nodes.map((n) => ({ name: n.name, kind: n.kind, status: n.kind === 'terminal' ? this.terminals.status(n.id) : undefined, maestro: n.maestro || undefined, url: n.url })) },
    };
  },

  notify(ws, me, { message }) {
    if (!message) fail('usage: notify "message"');
    // a looping agent must not be able to flood the human with notifications
    const now = Date.now();
    const recent = (this.notifyLog.get(me.id) ?? []).filter((t) => now - t < 60000);
    if (recent.length >= 20) fail('notification rate limit reached (20 per minute)');
    this.notifyLog.set(me.id, [...recent, now]);
    this.emit('notify', { workspaceId: ws.id, from: me.name, message: String(message).slice(0, 500) });
    return { text: 'sent' };
  },

  async ask(ws, me, { name, prompt, raw, timeoutMs = 120000, quietMs }) {
    const target = this.resolve(ws, me, name, ['terminal']);
    if (target.id === me.id) fail('an agent cannot ask itself');
    this.startTerminal(ws, target);
    const since = Date.now();
    const fromLine = this.terminals.cursorLine(target.id);
    if (raw != null) {
      this.terminals.write(target.id, unescapeRaw(String(raw)));
    } else {
      if (!prompt) fail('usage: ask "Agent" "prompt"');
      this.terminals.deliver(target.id, String(prompt));
    }
    const state = await this.terminals.waitIdle(target.id, { since, timeoutMs, quietMs: quietMs ?? (raw != null ? 800 : 2500) });
    const output = this.terminals.text(target.id, { fromLine });
    return { text: output || '(no output)', data: { name: target.name, state, output } };
  },

  async 'ask.batch'(ws, me, { items, timeoutMs }) {
    const entries = Object.entries(items || {});
    if (!entries.length) fail('usage: ask --batch \'{"A": "prompt"}\'');
    const results = await Promise.all(entries.map(async ([name, prompt]) => {
      try {
        const r = await HANDLERS.ask.call(this, ws, me, { name, prompt, timeoutMs });
        return { agent: r.data.name, state: r.data.state, output: r.data.output };
      } catch (e) {
        return { agent: name, error: e.message };
      }
    }));
    return { text: JSON.stringify(results, null, 2), data: results };
  },

  check(ws, me, { name, lines = 200 }) {
    const target = this.resolve(ws, me, name, ['terminal']);
    this.startTerminal(ws, target);
    return { text: this.terminals.text(target.id, { lastLines: lines }) || '(empty)' };
  },

  // ----- notes -----
  'note.create'(ws, me, { content = '', name, color, stack }) {
    const pos = this.placeBeside(ws, me, { w: 320, h: 260 });
    const note = this.store.createNode(ws, 'note', { name: name || (String(content).split('\n')[0].slice(0, 40).trim() || 'Note'), text: content, color, ...pos });
    if (stack) this.fileIntoStack(ws, me, note, stack === true ? 'Stack' : String(stack));
    else this.store.connect(ws, me.id, note.id);
    this.touch(ws);
    return { text: note.name, data: { name: note.name } };
  },
  'note.stack'(ws, me, { name, stack }) {
    const note = this.resolve(ws, me, name, ['note']);
    const st = this.fileIntoStack(ws, me, note, stack ? String(stack) : 'Stack');
    this.touch(ws);
    return { text: `${note.name} -> ${st.name}` };
  },
  'note.unstack'(ws, me, { name }) {
    const note = this.resolve(ws, me, name, ['note']);
    if (!note.stackId) fail(`"${note.name}" is not in a stack`);
    const st = this.store.removeFromStack(ws, note.id);
    this.store.connect(ws, me.id, note.id);
    this.touch(ws);
    return { text: `${note.name} freed from ${st.name}` };
  },
  'note.read'(ws, me, { name, offset, limit }) {
    const note = this.resolve(ws, me, name, ['note']);
    let lines = this.store.readNote(ws.id, note.id).split('\n');
    if (offset != null || limit != null) lines = lines.slice(Math.max(0, (offset ?? 1) - 1), limit != null ? Math.max(0, (offset ?? 1) - 1) + limit : undefined);
    return { text: lines.join('\n') };
  },
  'note.write'(ws, me, { name, content }) {
    const note = this.resolve(ws, me, name, ['note']);
    this.store.writeNote(ws.id, note.id, content ?? '');
    this.touch(ws);
    return { text: `wrote ${note.name}` };
  },
  'note.edit'(ws, me, { name, old, new: next }) {
    const note = this.resolve(ws, me, name, ['note']);
    const body = this.store.readNote(ws.id, note.id);
    if (!old) fail('usage: note edit "Note" "old text" "new text"');
    const first = body.indexOf(old);
    if (first < 0) fail('the text to replace was not found in the note');
    if (body.indexOf(old, first + 1) >= 0) fail('the text to replace appears more than once; include more context');
    this.store.writeNote(ws.id, note.id, body.slice(0, first) + (next ?? '') + body.slice(first + old.length));
    this.touch(ws);
    return { text: `edited ${note.name}` };
  },
  'note.delete'(ws, me, { name, stack }) {
    if (stack) {
      const st = this.resolve(ws, me, stack === true ? name : stack, ['stack']);
      const count = st.order.length;
      this.store.deleteNode(ws, st.id, { keepStackNotes: false });
      this.touch(ws);
      return { text: `deleted stack ${st.name} and ${count} note(s)` };
    }
    const note = this.resolve(ws, me, name, ['note']);
    this.store.deleteNode(ws, note.id);
    this.touch(ws);
    return { text: `deleted ${note.name}` };
  },

  // ----- portals (URL panes; page automation is not implemented) -----
  'portal.create'(ws, me, { url, name, size }) {
    if (!url) fail('usage: portal create URL ["Name"]');
    let u;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `http://${url}`); } catch { fail(`invalid URL: ${url}`); }
    if (!['http:', 'https:', 'about:'].includes(u.protocol)) fail('only http(s) URLs are allowed');
    const dims = size && /^(\d+)x(\d+)$/.exec(size);
    const pos = this.placeBeside(ws, me, { w: 520, h: 380 });
    const node = this.store.createNode(ws, 'portal', { name: name || u.hostname || 'Portal', url: u.href, w: dims ? +dims[1] : undefined, h: dims ? +dims[2] : undefined, ...pos });
    this.store.connect(ws, me.id, node.id);
    this.touch(ws);
    return { text: node.name };
  },
  'portal.edit'(ws, me, { name, url }) {
    const p = this.resolve(ws, me, name, ['portal']);
    let u;
    try { u = new URL(url); } catch { fail(`invalid URL: ${url}`); }
    if (!['http:', 'https:'].includes(u.protocol)) fail('only http(s) URLs are allowed');
    this.store.patchNode(ws, p.id, { url: u.href });
    this.touch(ws);
    return { text: `${p.name} -> ${u.href}` };
  },
  'portal.close'(ws, me, { name }) {
    const p = this.resolve(ws, me, name, ['portal']);
    this.store.deleteNode(ws, p.id);
    this.touch(ws);
    return { text: `closed ${p.name}` };
  },
  'portal.info'(ws, me, { name }) {
    const p = this.resolve(ws, me, name, ['portal']);
    return { text: `url: ${p.url}\nviewport: ${p.w}x${p.h}` };
  },

  // ----- orchestration (maestro only) -----
  recruit(ws, me, { name, preset, role, dir, command, color, icon, replace }) {
    this.requireMaestro(me);
    const presetObj = preset ? this.store.settings.presets.find((p) => p.name.toLowerCase() === String(preset).toLowerCase()) : null;
    if (preset && !presetObj) fail(`no preset named "${preset}" (see: preset list)`);
    const cmd = command ?? presetObj?.command ?? '';
    if (replace) {
      const old = this.resolveAny(ws, replace, ['terminal']);
      this.terminals.dispose(old.id);
      this.store.patchNode(ws, old.id, { command: cmd, ...(name ? { name } : {}) });
      this.startTerminal(ws, old);
      this.touch(ws);
      return { text: old.name };
    }
    if (!name) fail('usage: recruit "Name" [--preset P] [--role R] [--dir PATH] [--command C]');
    const cwd = dir ? path.resolve(ws.dir, dir) : ws.dir;
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) fail(`directory does not exist: ${cwd}`);
    let rolePrompt = null;
    if (role) {
      const r = this.findRole(ws, role);
      rolePrompt = r.prompt;
    }
    const pos = this.placeBeside(ws, me, { w: 640, h: 400 });
    const node = this.store.createNode(ws, 'terminal', { name, command: cmd, cwd, color, icon, role: role || null, preset: presetObj?.name ?? null, maestro: !!presetObj?.maestro, ...pos });
    this.store.connect(ws, me.id, node.id);
    this.startTerminal(ws, node);
    if (rolePrompt) setTimeout(() => { try { this.terminals.deliver(node.id, rolePrompt); } catch {} }, 3000);
    this.touch(ws);
    return { text: node.name, data: { name: node.name } };
  },

  dismiss(ws, me, { name }) {
    this.requireMaestro(me);
    const n = this.resolve(ws, me, name, ['terminal']);
    this.terminals.dispose(n.id);
    this.store.deleteNode(ws, n.id);
    this.touch(ws);
    return { text: `dismissed ${n.name}` };
  },

  connect(ws, me, { from, to, kind }) {
    this.requireMaestro(me);
    const kinds = kind ? [KIND_FLAGS[kind]].filter(Boolean) : null;
    if (kind && !kinds.length) fail(`unknown kind "${kind}" (agent, band, note, fichario, portal)`);
    const a = this.resolveAny(ws, from);
    const b = this.resolveAny(ws, to, kinds);
    this.store.connect(ws, a.id, b.id);
    this.touch(ws);
    return { text: `${a.name} <-> ${b.name}` };
  },

  disconnect(ws, me, { from, to }) {
    this.requireMaestro(me);
    const a = this.resolveAny(ws, from);
    const b = this.resolveAny(ws, to);
    const removed = this.store.disconnect(ws, [a.id, b.id]);
    if (!removed) fail(`${a.name} and ${b.name} are not connected`);
    this.touch(ws);
    return { text: `${a.name} -/- ${b.name}` };
  },

  arrange(ws, me, { name, newName, color, icon, kind }) {
    if (!name) {
      const rows = [me, ...this.reachable(ws, me)].map((n) => `${kindLabel[n.kind].padEnd(7)} ${n.name}  color=${n.color ?? '-'} icon=${n.icon ?? '-'}`);
      return { text: textOf(rows) };
    }
    const kinds = kind ? [KIND_FLAGS[kind]].filter(Boolean) : null;
    let target;
    if (name.toLowerCase() === me.name.toLowerCase() && !kinds) target = me;
    else if (kinds?.includes('band')) {
      // a band is reachable by its members (and any Maestro)
      target = ws.nodes.find((n) => n.kind === 'band' && n.name.toLowerCase() === name.toLowerCase() && (me.maestro || n.members.includes(me.id))) || fail(`no band named "${name}" that you belong to`);
    } else target = this.resolve(ws, me, name, kinds);
    const patch = {};
    if (newName) patch.name = newName;
    if (color) patch.color = color;
    if (icon) patch.icon = icon;
    if (!Object.keys(patch).length) fail('nothing to change: pass --name, --color or --icon');
    this.store.patchNode(ws, target.id, patch);
    this.touch(ws);
    return { text: target.name };
  },

  // ----- bands (Maestro) -----
  'band.create'(ws, me, { name, agents = [], withoutMe, color, icon }) {
    this.requireMaestro(me);
    if (!name) fail('usage: band create "Name" ["Agent" ...] [--without-me]');
    const named = agents.map((a) => this.resolve(ws, me, a, ['terminal']).id);
    const team = named.length ? named : this.reachable(ws, me).filter((n) => n.kind === 'terminal').map((n) => n.id);
    const ids = [...(withoutMe ? [] : [me.id]), ...team];
    let band;
    try { band = this.store.createBand(ws, name, ids, { color, icon }); } catch (e) { fail(e.message); }
    this.touch(ws);
    return { text: `${band.name}: ${band.members.length} member(s)` };
  },
  'band.add'(ws, me, { band, agent }) {
    this.requireMaestro(me);
    const b = this.findBand(ws, band);
    const t = this.resolve(ws, me, agent, ['terminal']);
    try { this.store.addToBand(ws, b, t.id); } catch (e) { fail(e.message); }
    this.touch(ws);
    return { text: `${t.name} joined ${b.name}` };
  },
  'band.remove'(ws, me, { band, agent }) {
    this.requireMaestro(me);
    const b = this.findBand(ws, band);
    const t = ws.nodes.find((n) => n.kind === 'terminal' && n.name.toLowerCase() === String(agent).toLowerCase()) || fail(`no agent named "${agent}"`);
    try { this.store.removeFromBand(ws, b, t.id); } catch (e) { fail(e.message); }
    this.touch(ws);
    return { text: `${t.name} left ${b.name}` };
  },
  'band.dissolve'(ws, me, { band }) {
    this.requireMaestro(me);
    const b = this.findBand(ws, band);
    this.store.deleteNode(ws, b.id);
    this.touch(ws);
    return { text: `dissolved ${b.name}` };
  },

  // ----- partituras: saved layouts (Maestro) -----
  'partitura.list'(ws, me) {
    this.requireMaestro(me);
    const rows = this.partiturasFor(ws).map((p) => `${p.name}  (${p.scope === null ? 'global' : 'workspace'}, ${p.nodes.length} items)${p.description ? '  ' + p.description : ''}`);
    return { text: rows.length ? textOf(rows) : '(no partituras)' };
  },
  'partitura.create'(ws, me, { name, agents = [], withoutMe, commands = true, noteText = true, description, icon, color, scope = 'current' }) {
    this.requireMaestro(me);
    if (!name) fail('usage: partitura create "Name" ["Agent" ...]');
    const list = this.store.settings.partituras ??= [];
    if (list.some((p) => p.name.toLowerCase() === name.toLowerCase() && (p.scope === null || p.scope === ws.id))) fail(`partitura "${name}" already exists (use partitura update)`);
    const part = this.capture(ws, me, { name, agents, withoutMe, commands, noteText, description, icon, color, scope });
    list.push(part);
    this.store.saveSettings();
    this.emit('workspace-list');
    return { text: `saved ${part.name}: ${part.nodes.length} items` };
  },
  'partitura.update'(ws, me, { name, agents = [], withoutMe, commands, noteText, newName, description, icon, color, scope }) {
    this.requireMaestro(me);
    const old = this.findPartitura(ws, name);
    const resave = agents.length || withoutMe || commands !== undefined || noteText !== undefined;
    if (resave) {
      const fresh = this.capture(ws, me, { name: newName ?? old.name, agents, withoutMe, commands: commands ?? old.options.commands, noteText: noteText ?? old.options.noteText, description: description ?? old.description, icon: icon ?? old.icon, color: color ?? old.color, scope: scope ?? (old.scope === null ? 'global' : 'current') });
      Object.assign(old, { ...fresh, id: old.id });
    } else {
      if (newName) old.name = newName;
      if (description !== undefined) old.description = description;
      if (icon !== undefined) old.icon = icon;
      if (color !== undefined) old.color = color;
      if (scope) old.scope = scope === 'global' ? null : ws.id;
    }
    this.store.saveSettings();
    this.emit('workspace-list');
    return { text: `updated ${old.name}` };
  },
  'partitura.insert'(ws, me, { name }) {
    this.requireMaestro(me);
    const part = this.findPartitura(ws, name);
    const { created } = this.insertPartitura(ws, part, me);
    this.touch(ws);
    return { text: `inserted ${part.name}: ${created.map((n) => n.name).join(', ')}` };
  },
  'partitura.delete'(ws, me, { name }) {
    this.requireMaestro(me);
    const part = this.findPartitura(ws, name);
    this.store.settings.partituras = this.store.settings.partituras.filter((p) => p !== part);
    this.store.saveSettings();
    this.emit('workspace-list');
    return { text: `deleted ${part.name}` };
  },

  // ----- presets & roles -----
  'preset.list'(ws, me) {
    this.requireMaestro(me);
    const rows = this.store.settings.presets.map((p) => `${p.name}${p.maestro ? ' (maestro)' : ''}  ${p.command || '(plain shell)'}`);
    return { text: textOf(rows) };
  },
  'preset.show'(ws, me, { name }) {
    this.requireMaestro(me);
    const p = this.findPreset(name);
    return { text: JSON.stringify(p, null, 2) };
  },
  'preset.create'(ws, me, { name, command = '', maestro = false }) {
    this.requireMaestro(me);
    if (!name) fail('usage: preset create "Name" [--command C] [--maestro on|off]');
    if (this.store.settings.presets.some((p) => p.name.toLowerCase() === name.toLowerCase())) fail(`preset "${name}" already exists`);
    this.store.settings.presets.push({ name, command, maestro: !!maestro });
    this.store.saveSettings();
    return { text: `created preset ${name}` };
  },
  'preset.set'(ws, me, { name, newName, command, maestro }) {
    this.requireMaestro(me);
    const p = this.findPreset(name);
    if (newName) p.name = newName;
    if (command != null) p.command = command;
    if (maestro != null) p.maestro = !!maestro;
    this.store.saveSettings();
    return { text: `updated preset ${p.name}` };
  },
  'preset.delete'(ws, me, { name }) {
    this.requireMaestro(me);
    const p = this.findPreset(name);
    this.store.settings.presets = this.store.settings.presets.filter((x) => x !== p);
    this.store.saveSettings();
    return { text: `deleted preset ${p.name}` };
  },

  'role.list'(ws, me) {
    this.requireMaestro(me);
    const roles = this.store.settings.roles;
    const rows = roles.map((r) => `${r.name}  (${r.workspaceId ? 'workspace' : 'global'})`);
    return { text: rows.length ? textOf(rows) : '(no roles)' };
  },
  'role.show'(ws, me, { name }) {
    this.requireMaestro(me);
    return { text: this.findRole(ws, name).prompt };
  },
  'role.create'(ws, me, { name, prompt, scope = 'current' }) {
    this.requireMaestro(me);
    if (!name || !prompt) fail('usage: role create "Name" "Prompt" [--scope current|global]');
    if (this.store.settings.roles.some((r) => r.name.toLowerCase() === name.toLowerCase() && (!r.workspaceId || r.workspaceId === ws.id))) fail(`role "${name}" already exists`);
    this.store.settings.roles.push({ name, prompt, workspaceId: scope === 'global' ? null : ws.id });
    this.store.saveSettings();
    return { text: `created role ${name}` };
  },
  'role.write'(ws, me, { name, prompt }) {
    this.requireMaestro(me);
    this.findRole(ws, name).prompt = prompt;
    this.store.saveSettings();
    return { text: `updated role ${name}` };
  },
  'role.edit'(ws, me, { name, old, new: next, scope }) {
    this.requireMaestro(me);
    const r = this.findRole(ws, name);
    if (old != null) {
      if (!r.prompt.includes(old)) fail('the text to replace was not found in the role');
      r.prompt = r.prompt.replace(old, () => next ?? '');
    }
    if (scope) r.workspaceId = scope === 'global' ? null : ws.id;
    this.store.saveSettings();
    return { text: `edited role ${name}` };
  },
  'role.assign'(ws, me, { recruit, role, none }) {
    this.requireMaestro(me);
    const t = this.resolve(ws, me, recruit, ['terminal']);
    if (none) { this.store.patchNode(ws, t.id, { role: null }); this.touch(ws); return { text: `cleared role on ${t.name}` }; }
    const r = this.findRole(ws, role);
    this.store.patchNode(ws, t.id, { role: r.name });
    this.touch(ws);
    this.startTerminal(ws, t);
    this.terminals.deliver(t.id, r.prompt);
    return { text: `${t.name} -> ${r.name}` };
  },
  'role.delete'(ws, me, { name, force }) {
    this.requireMaestro(me);
    const r = this.findRole(ws, name);
    const users = ws.nodes.filter((n) => n.role === r.name);
    if (users.length && !force) fail(`role "${r.name}" is still used by ${users.map((n) => n.name).join(', ')} (use --force)`);
    for (const n of users) n.role = null;
    this.store.settings.roles = this.store.settings.roles.filter((x) => x !== r);
    this.store.saveSettings();
    this.touch(ws);
    return { text: `deleted role ${r.name}` };
  },

  // ----- routines -----
  'routine.list'(ws, me) {
    this.requireMaestro(me);
    const rows = ws.routines.map((r) => `${r.enabled ? 'on ' : 'off'} ${r.name}  ${describeSchedule(r.schedule)}  -> ${ws.nodes.find((n) => n.id === r.terminalId)?.name ?? '?'}`);
    return { text: rows.length ? textOf(rows) : '(no routines)' };
  },
  'routine.show'(ws, me, { name }) {
    this.requireMaestro(me);
    return { text: JSON.stringify(this.findRoutine(ws, name), null, 2) };
  },
  'routine.create'(ws, me, { name, command, terminal, every, daily, weekly, once, count, until, preRun, noNotify, disabled, reminder }) {
    this.requireMaestro(me);
    if (!name || !command) fail('usage: routine create "Name" --command "..." <schedule>');
    const target = terminal ? this.resolve(ws, me, terminal, ['terminal']) : me;
    const r = this.scheduler.create(ws, {
      name, command, terminalId: target.id, schedule: parseSchedule({ every, daily, weekly, once }),
      count: count != null ? Number(count) : null, until, preRun, reminder, notify: !noNotify, enabled: !disabled,
    });
    return { text: `${r.name}: ${describeSchedule(r.schedule)}` };
  },
  'routine.edit'(ws, me, { name, newName, command, every, daily, weekly, once, terminal }) {
    this.requireMaestro(me);
    const r = this.findRoutine(ws, name);
    if (newName) r.name = newName;
    if (command != null) r.command = command;
    if (terminal) r.terminalId = this.resolve(ws, me, terminal, ['terminal']).id;
    if (every || daily || weekly || once) {
      r.schedule = parseSchedule({ every, daily, weekly, once });
      r.nextRunAt = this.scheduleNext(r);
    }
    this.touch(ws);
    return { text: `edited ${r.name}` };
  },
  'routine.enable'(ws, me, { name }) {
    this.requireMaestro(me);
    const r = this.findRoutine(ws, name);
    r.enabled = true;
    r.nextRunAt = this.scheduleNext(r);
    this.touch(ws);
    return { text: `enabled ${r.name}` };
  },
  'routine.disable'(ws, me, { name }) {
    this.requireMaestro(me);
    const r = this.findRoutine(ws, name);
    r.enabled = false;
    this.touch(ws);
    return { text: `disabled ${r.name}` };
  },
  async 'routine.run'(ws, me, { name }) {
    this.requireMaestro(me);
    const r = this.findRoutine(ws, name);
    await this.scheduler.runNow(ws, r);
    this.touch(ws);
    return { text: `fired ${r.name}` };
  },
  'routine.delete'(ws, me, { name }) {
    this.requireMaestro(me);
    const r = this.findRoutine(ws, name);
    ws.routines = ws.routines.filter((x) => x !== r);
    this.touch(ws);
    return { text: `deleted ${r.name}` };
  },

  // ----- workspaces & floors -----
  'workspace.list'(ws, me) {
    this.requireMaestro(me);
    const rows = [...this.store.workspaces.values()].map((w) => `${w.id === ws.id ? '*' : ' '} ${w.name}  ${w.dir}`);
    return { text: textOf(rows) };
  },
  'workspace.create'(ws, me, { name, dir, from }) {
    this.requireMaestro(me);
    if (!name || !dir) fail('usage: workspace create "Name" --dir PATH');
    const abs = path.resolve(ws.dir, dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) fail(`directory does not exist: ${abs}`);
    const src = from ? [...this.store.workspaces.values()].find((w) => w.name.toLowerCase() === from.toLowerCase()) || fail(`no workspace named "${from}"`) : null;
    const created = this.store.createWorkspace({ name, dir: abs, from: src?.id });
    this.emit('workspace-list');
    return { text: created.name };
  },
  'workspace.rename'(ws, me, { name, newName }) {
    this.requireMaestro(me);
    const w = [...this.store.workspaces.values()].find((x) => x.name.toLowerCase() === String(name).toLowerCase()) || fail(`no workspace named "${name}"`);
    w.name = this.store.uniqueWorkspaceName(newName);
    this.store.saveWorkspace(w.id);
    this.emit('workspace-list');
    return { text: w.name };
  },
  'floor.status'(ws, me, { text, state, progress, clear }) {
    if (clear) { ws.floorStatus = null; this.touch(ws); return { text: 'cleared' }; }
    if (text == null) return { text: ws.floorStatus ? `${ws.floorStatus.state ?? 'working'}${ws.floorStatus.progress ? ` (${ws.floorStatus.progress})` : ''}: ${ws.floorStatus.text}` : '(no status)' };
    if (state && !['working', 'blocked', 'review', 'done'].includes(state)) fail('state must be working, blocked, review or done');
    ws.floorStatus = { text, state: state ?? 'working', progress: progress ?? null, by: me.name, at: new Date().toISOString() };
    this.touch(ws);
    return { text: 'status posted' };
  },

  debug(ws, me) {
    const rt = this.terminals.get(me.id);
    return {
      text: [
        `openmaestri daemon: up ${Math.round((Date.now() - this.startedAt) / 1000)}s`,
        `socket: ${this.socketPath}`,
        `workspace: ${ws.name} (${ws.id})`,
        `terminal: ${me.name} (${me.id}) ${rt ? rt.status : 'no runtime'}`,
        `maestro: ${me.maestro ? 'yes' : 'no'}`,
        `connected: ${this.reachable(ws, me).map((n) => n.name).join(', ') || '(none)'}`,
      ].join('\n'),
    };
  },
};

// helpers hung on the prototype so HANDLERS can use `this`
Core.prototype.findPreset = function (name) {
  return this.store.settings.presets.find((p) => p.name.toLowerCase() === String(name).toLowerCase()) || fail(`no preset named "${name}"`);
};
Core.prototype.findRole = function (ws, name) {
  const lc = String(name).toLowerCase();
  const scoped = this.store.settings.roles.filter((r) => r.name.toLowerCase() === lc);
  return scoped.find((r) => r.workspaceId === ws.id) || scoped.find((r) => !r.workspaceId) || fail(`no role named "${name}"`);
};
Core.prototype.findRoutine = function (ws, name) {
  const lc = String(name).toLowerCase();
  return ws.routines.find((r) => r.name.toLowerCase() === lc) || fail(`no routine named "${name}"`);
};
Core.prototype.scheduleNext = function (r) {
  return nextRun(r.schedule);
};

Core.prototype.findBand = function (ws, name) {
  const lc = String(name).toLowerCase();
  return ws.nodes.find((n) => n.kind === 'band' && n.name.toLowerCase() === lc) || fail(`no band named "${name}"`);
};
Core.prototype.findPartitura = function (ws, name) {
  const lc = String(name).toLowerCase();
  const all = this.partiturasFor(ws).filter((p) => p.name.toLowerCase() === lc);
  return all.find((p) => p.scope === ws.id) || all[0] || fail(`no partitura named "${name}"`);
};
/** File a note into the stack called `stackName`, reachable from `me`; create (and wire) the stack if there is none. */
Core.prototype.fileIntoStack = function (ws, me, note, stackName) {
  let st = this.reachable(ws, me).find((n) => n.kind === 'stack' && n.name.toLowerCase() === stackName.toLowerCase());
  if (!st) {
    const pos = this.placeBeside(ws, me, { w: 360, h: 300 });
    st = this.store.createNode(ws, 'stack', { name: stackName, ...pos });
    this.store.connect(ws, me.id, st.id);
  }
  if (note.stackId && note.stackId !== st.id) this.store.removeFromStack(ws, note.id);
  this.store.addToStack(ws, note.id, st.id);
  // a stacked note is only reachable through its stack, so drop a now-redundant direct cable
  this.store.disconnect(ws, [me.id, note.id]);
  return st;
};
/** Everything a partitura should carry: the chosen agents plus what is wired to them. */
Core.prototype.capture = function (ws, me, { name, agents, withoutMe, commands, noteText, description, icon, color, scope }) {
  const named = agents.map((a) => this.resolve(ws, me, a, ['terminal']));
  const team = named.length ? named : this.reachable(ws, me).filter((n) => n.kind === 'terminal');
  const core = [...(withoutMe ? [] : [me]), ...team];
  if (!core.length) fail('nothing to save: no agents selected');
  const ids = new Set(core.map((n) => n.id));
  for (const t of core) for (const n of this.store.neighbors(ws, t.id)) if (n.kind !== 'terminal') ids.add(n.kind === 'note' && n.stackId ? n.stackId : n.id);
  for (const b of ws.nodes.filter((n) => n.kind === 'band' && n.members.every((m) => ids.has(m)))) ids.add(b.id);
  try {
    return capturePartitura(this.store, ws, [...ids], { name, description: description ?? '', icon: icon ?? null, color: color ?? null, commands: commands !== false, noteText: noteText !== false, scope });
  } catch (e) { return fail(e.message); }
};
Core.prototype.insertPartitura = function (ws, part, me) {
  const out = instantiatePartitura(this.store, ws, part);
  for (const n of out.created) {
    if (n.kind === 'terminal') {
      if (me) this.store.connect(ws, me.id, n.id);
      this.startTerminal(ws, n);
    }
  }
  return out;
};
