// Persistent workspace store. Everything lives under the data dir:
//   settings.json                         presets, roles, last active workspace
//   workspaces/<id>/workspace.json        nodes, connections, routines, viewport
//   workspaces/<id>/notes/<node id>.md    note bodies (plain markdown files)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const SCHEMA_VERSION = 1;

export function dataDir() {
  return process.env.OPENMAESTRI_DATA_DIR || path.join(os.homedir(), '.openmaestri');
}

export const uid = () => crypto.randomUUID();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids end up in file paths (workspace dir, note file), so only canonical UUIDs are accepted. */
export function safeId(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('invalid id');
  return id;
}

export function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export const PRESETS_VERSION = 2;
export const DEFAULT_PRESETS = [
  { name: 'Shell', command: '', maestro: false },
  { name: 'Claude', command: 'claude', maestro: false },
  { name: 'Codex', command: 'codex', maestro: false },
  { name: 'Gemini', command: 'gemini', maestro: false },
  { name: 'OpenCode', command: 'opencode', maestro: false },
  // The model comes from OPENMAESTRI_DEEPSEEK_MODEL (see docs/deepseek.md); `opencode models deepseek` lists valid ids.
  { name: 'OpenCode (DeepSeek)', command: 'opencode -m "deepseek/${OPENMAESTRI_DEEPSEEK_MODEL:-deepseek-chat}"', maestro: false },
  { name: 'Aider (DeepSeek)', command: 'aider --model "deepseek/${OPENMAESTRI_DEEPSEEK_MODEL:-deepseek-chat}"', maestro: false },
  { name: 'Aider', command: 'aider', maestro: false },
  { name: 'Goose', command: 'goose', maestro: false },
  { name: 'Maestro (OpenCode + DeepSeek)', command: 'opencode -m "deepseek/${OPENMAESTRI_DEEPSEEK_MODEL:-deepseek-chat}"', maestro: true },
  { name: 'Maestro (Claude)', command: 'claude', maestro: true },
];

const NODE_DEFAULTS = {
  terminal: { w: 640, h: 400 },
  note: { w: 320, h: 260 },
  portal: { w: 520, h: 380 },
};

export class Store {
  constructor(root = dataDir()) {
    this.root = root;
    this.workspaces = new Map();
    this.settings = { presets: DEFAULT_PRESETS.map((p) => ({ ...p })), presetsVersion: PRESETS_VERSION, roles: [], activeWorkspaceId: null };
    this.saveTimers = new Map();
  }

  // ---------- load / save ----------
  load() {
    fs.mkdirSync(path.join(this.root, 'workspaces'), { recursive: true, mode: 0o700 });
    fs.chmodSync(this.root, 0o700);
    try {
      const s = JSON.parse(fs.readFileSync(path.join(this.root, 'settings.json'), 'utf8'));
      this.settings = { ...this.settings, ...s };
    } catch {}
    // add newly shipped presets once per schema bump, never resurrecting ones the user deleted later
    if ((this.settings.presetsVersion ?? 1) < PRESETS_VERSION) {
      const have = new Set(this.settings.presets.map((p) => p.name.toLowerCase()));
      for (const p of DEFAULT_PRESETS) if (!have.has(p.name.toLowerCase())) this.settings.presets.push({ ...p });
      this.settings.presetsVersion = PRESETS_VERSION;
      this.saveSettings();
    }
    for (const id of fs.readdirSync(path.join(this.root, 'workspaces'))) {
      const file = path.join(this.root, 'workspaces', id, 'workspace.json');
      try {
        const ws = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (ws && ws.id === id && UUID_RE.test(id)) this.workspaces.set(id, this.normalize(ws));
      } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[store] skipping ${id}: ${e.message}`);
      }
    }
    if (this.workspaces.size === 0) {
      this.createWorkspace({ name: 'Home', dir: os.homedir() });
    }
    if (!this.workspaces.has(this.settings.activeWorkspaceId)) {
      this.settings.activeWorkspaceId = [...this.workspaces.keys()][0];
    }
  }

  normalize(ws) {
    ws.version = SCHEMA_VERSION;
    ws.nodes ||= [];
    ws.connections ||= [];
    ws.routines ||= [];
    ws.viewport ||= { x: 0, y: 0, z: 1 };
    ws.floorStatus ||= null;
    return ws;
  }

  saveSettings() {
    atomicWrite(path.join(this.root, 'settings.json'), JSON.stringify(this.settings, null, 2));
  }

  /** Debounced write so drags (many patches per second) do not hammer the disk. */
  saveWorkspace(id, { now = false } = {}) {
    const run = () => {
      this.saveTimers.delete(id);
      const ws = this.workspaces.get(id);
      if (!ws) return;
      atomicWrite(this.wsFile(id), JSON.stringify(ws, null, 2));
    };
    clearTimeout(this.saveTimers.get(id));
    if (now) return run();
    this.saveTimers.set(id, setTimeout(run, 250));
  }

  flush() {
    for (const id of [...this.saveTimers.keys()]) this.saveWorkspace(id, { now: true });
    this.saveSettings();
  }

  wsDir(id) { return path.join(this.root, 'workspaces', safeId(id)); }
  wsFile(id) { return path.join(this.wsDir(id), 'workspace.json'); }
  noteFile(wsId, nodeId) { return path.join(this.wsDir(wsId), 'notes', `${safeId(nodeId)}.md`); }

  // ---------- workspaces ----------
  createWorkspace({ name, dir, from }) {
    const id = uid();
    const ws = this.normalize({
      id,
      name: this.uniqueWorkspaceName(name || 'Workspace'),
      dir: path.resolve(dir || os.homedir()),
      createdAt: new Date().toISOString(),
    });
    this.workspaces.set(id, ws);
    if (from) this.cloneInto(ws, this.workspaces.get(from));
    this.saveWorkspace(id, { now: true });
    return ws;
  }

  cloneInto(ws, src) {
    if (!src) return;
    const idMap = new Map();
    for (const n of src.nodes) {
      const copy = { ...n, id: uid() };
      idMap.set(n.id, copy.id);
      ws.nodes.push(copy);
      if (n.kind === 'note') this.writeNote(ws.id, copy.id, this.readNote(src.id, n.id));
    }
    for (const c of src.connections) {
      ws.connections.push({ id: uid(), from: idMap.get(c.from), to: idMap.get(c.to) });
    }
  }

  uniqueWorkspaceName(base) {
    const taken = new Set([...this.workspaces.values()].map((w) => w.name.toLowerCase()));
    let name = base, i = 2;
    while (taken.has(name.toLowerCase())) name = `${base} ${i++}`;
    return name;
  }

  deleteWorkspace(id) {
    if (!this.workspaces.has(id)) return false;
    if (this.workspaces.size === 1) throw new Error('cannot delete the last workspace');
    this.workspaces.delete(id);
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    fs.rmSync(this.wsDir(id), { recursive: true, force: true });
    if (this.settings.activeWorkspaceId === id) {
      this.settings.activeWorkspaceId = [...this.workspaces.keys()][0];
      this.saveSettings();
    }
    return true;
  }

  workspaceOfNode(nodeId) {
    for (const ws of this.workspaces.values()) {
      if (ws.nodes.some((n) => n.id === nodeId)) return ws;
    }
    return null;
  }

  // ---------- nodes ----------
  uniqueNodeName(ws, base, exceptId = null) {
    const taken = new Set(ws.nodes.filter((n) => n.id !== exceptId).map((n) => n.name.toLowerCase()));
    let name = base, i = 2;
    while (taken.has(name.toLowerCase())) name = `${base} ${i++}`;
    return name;
  }

  createNode(ws, kind, props = {}) {
    if (!Object.hasOwn(NODE_DEFAULTS, kind)) throw new Error(`unknown node kind: ${kind}`);
    const d = NODE_DEFAULTS[kind];
    const fin = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6 ? v : fallback);
    const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
    const base = text(props.name, 80)?.trim() || { terminal: 'Terminal', note: 'Note', portal: 'Portal' }[kind];
    const spot = fin(props.x) === undefined || fin(props.y) === undefined ? this.freeSpot(ws, d) : null;
    const node = {
      id: uid(),
      kind,
      name: this.uniqueNodeName(ws, base),
      x: fin(props.x, spot?.x ?? 0),
      y: fin(props.y, spot?.y ?? 0),
      w: Math.max(160, fin(props.w, d.w)),
      h: Math.max(100, fin(props.h, d.h)),
      color: text(props.color, 32),
      icon: text(props.icon, 64),
    };
    if (kind === 'terminal') {
      node.command = text(props.command, 4096) ?? '';
      node.cwd = text(props.cwd, 4096) ?? ws.dir;
      node.maestro = !!props.maestro;
      node.role = text(props.role, 128);
      node.preset = text(props.preset, 128);
    } else if (kind === 'portal') {
      node.url = text(props.url, 2048) ?? 'about:blank';
    }
    ws.nodes.push(node);
    if (kind === 'note') this.writeNote(ws.id, node.id, typeof props.text === 'string' ? props.text : '');
    this.saveWorkspace(ws.id);
    return node;
  }

  /** First spot on a coarse grid that does not overlap an existing node. */
  freeSpot(ws, size) {
    const gap = 40;
    const hits = (x, y) =>
      ws.nodes.some((n) => x < n.x + n.w + gap && x + size.w + gap > n.x && y < n.y + n.h + gap && y + size.h + gap > n.y);
    for (let row = 0; row < 40; row++) {
      for (let col = 0; col < 6; col++) {
        const x = col * (size.w + gap), y = row * (size.h + gap);
        if (!hits(x, y)) return { x, y };
      }
    }
    return { x: 0, y: 0 };
  }

  patchNode(ws, id, patch) {
    const n = ws.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`no such node: ${id}`);
    const num = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6;
    const str = (v, max) => typeof v === 'string' && v.length <= max;
    const rules = {
      x: num, y: num, w: num, h: num,
      color: (v) => v === null || str(v, 32), icon: (v) => v === null || str(v, 64),
      url: (v) => str(v, 2048), command: (v) => str(v, 4096), cwd: (v) => str(v, 4096),
      maestro: (v) => typeof v === 'boolean', role: (v) => v === null || str(v, 128),
    };
    for (const [k, ok] of Object.entries(rules)) {
      if (!Object.hasOwn(patch, k)) continue;
      if (!ok(patch[k])) throw new Error(`invalid value for ${k}`);
      n[k] = patch[k];
    }
    if (typeof patch.name === 'string' && patch.name.trim()) {
      n.name = this.uniqueNodeName(ws, patch.name.trim().slice(0, 80), n.id);
    }
    if ('w' in patch) n.w = Math.max(160, n.w);
    if ('h' in patch) n.h = Math.max(100, n.h);
    this.saveWorkspace(ws.id);
    return n;
  }

  deleteNode(ws, id) {
    const i = ws.nodes.findIndex((n) => n.id === id);
    if (i < 0) return false;
    const [n] = ws.nodes.splice(i, 1);
    ws.connections = ws.connections.filter((c) => c.from !== id && c.to !== id);
    ws.routines = ws.routines.filter((r) => r.terminalId !== id);
    if (n.kind === 'note') fs.rmSync(this.noteFile(ws.id, id), { force: true });
    this.saveWorkspace(ws.id);
    return true;
  }

  // ---------- connections ----------
  connect(ws, a, b) {
    if (a === b) throw new Error('cannot connect a node to itself');
    if (!ws.nodes.some((n) => n.id === a) || !ws.nodes.some((n) => n.id === b)) throw new Error('unknown node');
    const existing = ws.connections.find((c) => (c.from === a && c.to === b) || (c.from === b && c.to === a));
    if (existing) return existing;
    const c = { id: uid(), from: a, to: b };
    ws.connections.push(c);
    this.saveWorkspace(ws.id);
    return c;
  }

  disconnect(ws, idOrPair) {
    const before = ws.connections.length;
    ws.connections = ws.connections.filter((c) =>
      typeof idOrPair === 'string'
        ? c.id !== idOrPair
        : !((c.from === idOrPair[0] && c.to === idOrPair[1]) || (c.from === idOrPair[1] && c.to === idOrPair[0])),
    );
    if (ws.connections.length !== before) this.saveWorkspace(ws.id);
    return before !== ws.connections.length;
  }

  neighbors(ws, id) {
    const ids = new Set();
    for (const c of ws.connections) {
      if (c.from === id) ids.add(c.to);
      if (c.to === id) ids.add(c.from);
    }
    return ws.nodes.filter((n) => ids.has(n.id));
  }

  // ---------- notes ----------
  readNote(wsId, nodeId) {
    try { return fs.readFileSync(this.noteFile(wsId, nodeId), 'utf8'); } catch { return ''; }
  }
  writeNote(wsId, nodeId, text) {
    atomicWrite(this.noteFile(wsId, nodeId), String(text));
  }
}
