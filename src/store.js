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
  stack: { w: 360, h: 300 },
  band: { w: 300, h: 200 },
};
const DEFAULT_NAMES = { terminal: 'Terminal', note: 'Note', portal: 'Portal', stack: 'Stack', band: 'Band' };
const BAND_PAD = 28;

export class Store {
  constructor(root = dataDir()) {
    this.root = root;
    this.workspaces = new Map();
    this.settings = { presets: DEFAULT_PRESETS.map((p) => ({ ...p })), presetsVersion: PRESETS_VERSION, roles: [], partituras: [], activeWorkspaceId: null };
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
    this.purgeTrash();
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
    ws.floors ||= [];
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
    this.onCreate?.(ws);
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
    const base = text(props.name, 80)?.trim() || DEFAULT_NAMES[kind];
    const floorId = typeof props.floorId === 'string' && ws.floors.some((f) => f.id === props.floorId) ? props.floorId : null;
    const spot = fin(props.x) === undefined || fin(props.y) === undefined ? this.freeSpot(ws, d, floorId) : null;
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
    if (floorId) node.floorId = floorId;
    if (kind === 'terminal') {
      node.command = text(props.command, 4096) ?? '';
      node.cwd = text(props.cwd, 4096) ?? (floorId ? ws.floors.find((f) => f.id === floorId).dir : ws.dir);
      node.maestro = !!props.maestro;
      node.role = text(props.role, 128);
      node.preset = text(props.preset, 128);
    } else if (kind === 'portal') {
      node.url = text(props.url, 2048) ?? 'about:blank';
    } else if (kind === 'stack') {
      node.order = [];
      node.front = null;
    } else if (kind === 'band') {
      node.members = [];
    }
    ws.nodes.push(node);
    if (kind === 'note') this.writeNote(ws.id, node.id, typeof props.text === 'string' ? props.text : '');
    this.saveWorkspace(ws.id);
    return node;
  }

  /** First spot on a coarse grid that does not overlap an existing node. */
  freeSpot(ws, size, floorId = null) {
    const gap = 40;
    const here = ws.nodes.filter((n) => (n.floorId ?? null) === floorId);
    const hits = (x, y) =>
      here.some((n) => x < n.x + n.w + gap && x + size.w + gap > n.x && y < n.y + n.h + gap && y + size.h + gap > n.y);
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
    if (n.kind === 'band') this.refreshBands(ws); // a band always hugs its members
    else this.refreshBands(ws, n.id);
    this.saveWorkspace(ws.id);
    return n;
  }

  deleteNode(ws, id, { keepStackNotes = true } = {}) {
    const i = ws.nodes.findIndex((n) => n.id === id);
    if (i < 0) return false;
    const [n] = ws.nodes.splice(i, 1);
    ws.connections = ws.connections.filter((c) => c.from !== id && c.to !== id);
    ws.routines = ws.routines.filter((r) => r.terminalId !== id);
    if (n.kind === 'note') {
      this.trashNote(ws.id, id);
      const stack = ws.nodes.find((x) => x.kind === 'stack' && x.order.includes(id));
      if (stack) this.removeFromStack(ws, id);
    } else if (n.kind === 'stack') {
      for (const nid of [...n.order]) {
        if (keepStackNotes) {
          const note = ws.nodes.find((x) => x.id === nid);
          if (note) { delete note.stackId; note.x = n.x + 20; note.y = n.y + 20; }
        } else this.deleteNode(ws, nid);
      }
    } else if (n.kind === 'terminal') {
      for (const band of ws.nodes.filter((x) => x.kind === 'band' && x.members.includes(id))) {
        band.members = band.members.filter((m) => m !== id);
        if (band.members.length === 0) this.deleteNode(ws, band.id);
      }
      this.refreshBands(ws);
    }
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

  /**
   * What a node can reach. Direct cables, plus the two group rules:
   * a cable to a band reaches every member, and a member reaches what its band reaches
   * (and its fellow members). A cable to a stack reaches the notes inside it.
   * Bands themselves are containers, never addressable.
   */
  neighbors(ws, id) {
    const byId = new Map(ws.nodes.map((n) => [n.id, n]));
    const direct = (nid) => {
      const out = new Set();
      for (const c of ws.connections) {
        if (c.from === nid) out.add(c.to);
        if (c.to === nid) out.add(c.from);
      }
      return out;
    };
    const reach = new Set();
    const addNode = (nid) => {
      const n = byId.get(nid);
      if (!n || nid === id) return;
      if (n.kind === 'band') { for (const m of n.members) addNode(m); return; }
      reach.add(nid);
      if (n.kind === 'stack') for (const m of n.order) addNode(m);
    };
    for (const nid of direct(id)) addNode(nid);
    for (const band of ws.nodes.filter((n) => n.kind === 'band' && n.members.includes(id))) {
      for (const m of band.members) addNode(m);
      for (const nid of direct(band.id)) addNode(nid);
    }
    return ws.nodes.filter((n) => reach.has(n.id));
  }

  // ---------- stacks (fichários): notes filed together, one visible at a time ----------
  addToStack(ws, noteId, stackId) {
    const note = ws.nodes.find((n) => n.id === noteId && n.kind === 'note');
    const stack = ws.nodes.find((n) => n.id === stackId && n.kind === 'stack');
    if (!note || !stack) throw new Error('unknown note or stack');
    if (note.stackId === stackId) return stack;
    if (note.stackId) this.removeFromStack(ws, noteId);
    note.stackId = stackId;
    stack.order.push(noteId);
    stack.front ??= noteId;
    this.saveWorkspace(ws.id);
    return stack;
  }

  removeFromStack(ws, noteId) {
    const note = ws.nodes.find((n) => n.id === noteId);
    const stack = ws.nodes.find((n) => n.kind === 'stack' && n.order.includes(noteId));
    if (!stack) return null;
    stack.order = stack.order.filter((x) => x !== noteId);
    if (stack.front === noteId) stack.front = stack.order[0] ?? null;
    if (note) {
      delete note.stackId;
      note.x = stack.x + stack.w + 30;
      note.y = stack.y;
    }
    this.saveWorkspace(ws.id);
    return stack;
  }

  // ---------- bands: a named group of agents that share connections ----------
  createBand(ws, name, memberIds, props = {}) {
    const members = [...new Set(memberIds)].filter((m) => ws.nodes.some((n) => n.id === m && n.kind === 'terminal'));
    if (members.length === 0) throw new Error('a band needs at least one agent');
    for (const m of members) {
      const other = ws.nodes.find((n) => n.kind === 'band' && n.members.includes(m));
      if (other) throw new Error(`${ws.nodes.find((n) => n.id === m).name} is already in band "${other.name}"`);
    }
    const band = this.createNode(ws, 'band', { name, color: props.color, icon: props.icon, x: 0, y: 0 });
    band.members = members;
    this.refreshBands(ws);
    this.saveWorkspace(ws.id);
    return band;
  }

  addToBand(ws, band, terminalId) {
    const t = ws.nodes.find((n) => n.id === terminalId && n.kind === 'terminal');
    if (!t) throw new Error('only agents can join a band');
    const other = ws.nodes.find((n) => n.kind === 'band' && n.members.includes(terminalId));
    if (other && other.id !== band.id) throw new Error(`${t.name} is already in band "${other.name}"`);
    if (!band.members.includes(terminalId)) band.members.push(terminalId);
    this.refreshBands(ws);
    this.saveWorkspace(ws.id);
  }

  removeFromBand(ws, band, terminalId) {
    if (!band.members.includes(terminalId)) throw new Error('that agent is not in this band');
    band.members = band.members.filter((m) => m !== terminalId);
    if (band.members.length === 0) this.deleteNode(ws, band.id);
    else this.refreshBands(ws);
    this.saveWorkspace(ws.id);
  }

  /** A band's frame is the padded bounding box of its members; recomputed whenever one moves. */
  refreshBands(ws, movedId = null) {
    for (const band of ws.nodes.filter((n) => n.kind === 'band')) {
      if (movedId && !band.members.includes(movedId)) continue;
      const ms = ws.nodes.filter((n) => band.members.includes(n.id));
      if (!ms.length) continue;
      const x0 = Math.min(...ms.map((m) => m.x)), y0 = Math.min(...ms.map((m) => m.y));
      const x1 = Math.max(...ms.map((m) => m.x + m.w)), y1 = Math.max(...ms.map((m) => m.y + m.h));
      band.x = x0 - BAND_PAD; band.y = y0 - BAND_PAD - 22;
      band.w = x1 - x0 + BAND_PAD * 2; band.h = y1 - y0 + BAND_PAD * 2 + 22;
    }
  }

  // ---------- notes ----------
  readNote(wsId, nodeId) {
    try { return fs.readFileSync(this.noteFile(wsId, nodeId), 'utf8'); } catch { return ''; }
  }
  /** Deleted notes go to a trash folder so undo can bring their text back. */
  trashNote(wsId, nodeId) {
    const file = this.noteFile(wsId, nodeId);
    const trash = path.join(this.wsDir(wsId), 'notes', '.trash');
    try {
      fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
      fs.renameSync(file, path.join(trash, `${safeId(nodeId)}.md`));
    } catch { /* note had no file yet */ }
  }

  untrashNote(wsId, nodeId) {
    const file = this.noteFile(wsId, nodeId);
    const trashed = path.join(this.wsDir(wsId), 'notes', '.trash', `${safeId(nodeId)}.md`);
    if (!fs.existsSync(file) && fs.existsSync(trashed)) fs.renameSync(trashed, file);
  }

  purgeTrash(maxAgeMs = 7 * 24 * 3600 * 1000) {
    for (const ws of this.workspaces.values()) {
      const dir = path.join(this.wsDir(ws.id), 'notes', '.trash');
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const f of names) {
        const full = path.join(dir, f);
        try { if (Date.now() - fs.statSync(full).mtimeMs > maxAgeMs) fs.rmSync(full, { force: true }); } catch { /* raced */ }
      }
    }
  }

  writeNote(wsId, nodeId, text) {
    atomicWrite(this.noteFile(wsId, nodeId), String(text));
  }
}
