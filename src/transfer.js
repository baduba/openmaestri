// Moving structure around: partituras (saved layouts) and workspace export/import.
// Both copy a set of nodes with fresh ids, so nothing a file claims about ids is ever trusted.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { uid } from './store.js';

export const BUNDLE_FORMAT = 'openmaestri-workspace';
export const BUNDLE_VERSION = 1;
const LIMITS = { nodes: 2000, connections: 8000, noteBytes: 1 << 20, totalBytes: 20 << 20 };
const KINDS = ['terminal', 'note', 'portal', 'stack', 'band'];

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const fin = (v, d) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6 ? v : d);

/** Whitelisted, type-checked copy of one node description (from disk or from a file we do not trust). */
function cleanNode(raw) {
  if (!raw || typeof raw !== 'object' || !KINDS.includes(raw.kind)) return null;
  const n = {
    kind: raw.kind,
    name: str(raw.name, 80)?.trim() || raw.kind,
    x: fin(raw.x, 0), y: fin(raw.y, 0),
    w: Math.max(160, fin(raw.w, 320)), h: Math.max(100, fin(raw.h, 240)),
    color: str(raw.color, 32), icon: str(raw.icon, 64),
  };
  if (raw.kind === 'terminal') {
    Object.assign(n, { command: str(raw.command, 4096) ?? '', maestro: raw.maestro === true, role: str(raw.role, 128), preset: str(raw.preset, 128), cwd: str(raw.cwd, 4096) });
  } else if (raw.kind === 'portal') n.url = str(raw.url, 2048) ?? 'about:blank';
  return n;
}

// ---------------------------------------------------------------- partituras
/**
 * Snapshot `nodeIds` (and the cables among them) as a reusable layout.
 * Terminal commands and note text are optional because a layout may be shared around.
 */
export function capturePartitura(store, ws, nodeIds, { name, description = '', icon = null, color = null, commands = true, noteText = true, scope = 'current' }) {
  const set = new Set(nodeIds);
  const chosen = ws.nodes.filter((n) => set.has(n.id) && !n.stackId);
  // stacks bring their notes along
  for (const st of chosen.filter((n) => n.kind === 'stack')) for (const id of st.order) set.add(id);
  const nodes = ws.nodes.filter((n) => set.has(n.id));
  if (!nodes.length) throw new Error('nothing to save');
  const minX = Math.min(...nodes.filter((n) => !n.stackId).map((n) => n.x));
  const minY = Math.min(...nodes.filter((n) => !n.stackId).map((n) => n.y));
  const key = new Map(nodes.map((n, i) => [n.id, `n${i}`]));
  const items = nodes.map((n) => {
    const base = { key: key.get(n.id), kind: n.kind, name: n.name, x: n.x - minX, y: n.y - minY, w: n.w, h: n.h, color: n.color, icon: n.icon };
    if (n.kind === 'terminal') {
      const rel = n.cwd && n.cwd.startsWith(ws.dir + path.sep) ? path.relative(ws.dir, n.cwd) : null;
      Object.assign(base, { command: commands ? n.command : '', maestro: n.maestro, role: n.role, preset: n.preset, cwdRel: rel });
    } else if (n.kind === 'portal') base.url = n.url;
    else if (n.kind === 'note') { base.text = noteText ? store.readNote(ws.id, n.id) : ''; base.stackKey = n.stackId ? key.get(n.stackId) : null; }
    else if (n.kind === 'stack') { base.order = n.order.map((i) => key.get(i)).filter(Boolean); base.front = n.front ? key.get(n.front) : null; }
    else if (n.kind === 'band') base.members = n.members.map((i) => key.get(i)).filter(Boolean);
    return base;
  });
  const connections = ws.connections.filter((c) => set.has(c.from) && set.has(c.to)).map((c) => ({ from: key.get(c.from), to: key.get(c.to) }));
  return {
    id: uid(), name, description, icon, color, scope: scope === 'global' ? null : ws.id,
    options: { commands, noteText }, nodes: items, connections, savedAt: new Date().toISOString(),
  };
}

/** Instantiate a layout into `ws` at a free spot. Returns {created: node[], idMap}. */
export function instantiatePartitura(store, ws, part, { origin, floorId = null, baseDir = ws.dir } = {}) {
  const here = ws.nodes.filter((n) => (n.floorId ?? null) === floorId);
  const maxRight = here.length ? Math.max(...here.map((n) => n.x + n.w)) : -60;
  const at = origin ?? { x: maxRight + 80, y: here.length ? Math.min(...here.map((n) => n.y)) : 0 };
  const idMap = new Map();
  const created = [];
  const make = (it) => {
    const dir = it.cwdRel ? path.join(baseDir, it.cwdRel) : baseDir;
    const props = { floorId, name: it.name, x: at.x + it.x, y: at.y + it.y, w: it.w, h: it.h, color: it.color, icon: it.icon, command: it.command, maestro: it.maestro, role: it.role, preset: it.preset, cwd: dir, url: it.url, text: it.text };
    const node = store.createNode(ws, it.kind === 'band' ? 'band' : it.kind, props);
    idMap.set(it.key, node.id);
    created.push(node);
    return node;
  };
  const items = part.nodes;
  for (const it of items.filter((i) => i.kind !== 'band' && i.kind !== 'stack')) make(it);
  for (const it of items.filter((i) => i.kind === 'stack')) make(it);
  for (const it of items.filter((i) => i.kind === 'note' && i.stackKey)) {
    store.addToStack(ws, idMap.get(it.key), idMap.get(it.stackKey));
  }
  for (const it of items.filter((i) => i.kind === 'stack')) {
    const st = ws.nodes.find((n) => n.id === idMap.get(it.key));
    if (it.front && idMap.get(it.front)) st.front = idMap.get(it.front);
  }
  for (const it of items.filter((i) => i.kind === 'band')) {
    const members = (it.members ?? []).map((k) => idMap.get(k)).filter(Boolean);
    if (members.length) {
      const band = store.createBand(ws, it.name, members, { color: it.color, icon: it.icon });
      idMap.set(it.key, band.id);
      created.push(band);
    }
  }
  for (const c of part.connections) {
    const a = idMap.get(c.from), b = idMap.get(c.to);
    if (a && b) store.connect(ws, a, b);
  }
  return { created, idMap };
}

// --------------------------------------------------------- workspace bundles
export function exportWorkspace(store, ws) {
  // only the kinds the format defines: a Files browser is a view of a folder, not content to carry around
  const exported = ws.nodes.filter((n) => KINDS.includes(n.kind));
  const key = new Map(exported.map((n, i) => [n.id, `n${i}`]));
  const nodes = exported.map((n) => {
    const o = { key: key.get(n.id), kind: n.kind, name: n.name, x: n.x, y: n.y, w: n.w, h: n.h, color: n.color, icon: n.icon };
    if (n.kind === 'terminal') Object.assign(o, { command: n.command, maestro: n.maestro, role: n.role, preset: n.preset, cwdRel: n.cwd && n.cwd.startsWith(ws.dir + path.sep) ? path.relative(ws.dir, n.cwd) : null });
    if (n.kind === 'portal') o.url = n.url;
    if (n.kind === 'note') { o.text = store.readNote(ws.id, n.id); o.stackKey = n.stackId ? key.get(n.stackId) : null; }
    if (n.kind === 'stack') { o.order = n.order.map((i) => key.get(i)); o.front = n.front ? key.get(n.front) : null; }
    if (n.kind === 'band') o.members = n.members.map((i) => key.get(i));
    return o;
  });
  return {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: new Date().toISOString(),
    workspace: { name: ws.name, viewport: ws.viewport, floorStatus: null },
    nodes, connections: ws.connections.filter((c) => key.has(c.from) && key.has(c.to)).map((c) => ({ from: key.get(c.from), to: key.get(c.to) })),
    routines: ws.routines.map((r) => ({ name: r.name, command: r.command, schedule: r.schedule, terminalKey: key.get(r.terminalId) ?? null, enabled: false })),
  };
}

// ---------------------------------------------------------------- closed schema for bundle v1
const COMMON = ['key', 'kind', 'name', 'x', 'y', 'w', 'h', 'color', 'icon'];
const EXTRA = {
  terminal: ['command', 'maestro', 'role', 'preset', 'cwdRel'],
  note: ['text', 'stackKey'],
  portal: ['url'],
  stack: ['order', 'front'],
  band: ['members'],
};
const TOP = ['format', 'version', 'exportedAt', 'workspace', 'nodes', 'connections', 'routines'];
const ROUTINE = ['name', 'command', 'schedule', 'terminalKey', 'enabled'];
const MAX_ERRORS = 12;
const MAX_DEPTH = 12;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v) => v === null || v === undefined || typeof v === 'string';

function depthOf(v, d = 0) {
  if (d > MAX_DEPTH) return d;
  if (Array.isArray(v)) return v.reduce((m, x) => Math.max(m, depthOf(x, d + 1)), d);
  if (isObj(v)) return Object.values(v).reduce((m, x) => Math.max(m, depthOf(x, d + 1)), d);
  return d;
}

function checkNode(n, i, bad) {
  const at = `nodes[${i}]`;
  if (!isObj(n)) return bad(`${at} is not an object`);
  if (!Object.hasOwn(EXTRA, n.kind)) return bad(`${at} has an unknown kind`);
  const allowed = new Set([...COMMON, ...EXTRA[n.kind]]);
  for (const k of Object.keys(n)) if (!allowed.has(k)) bad(`${at} has a field that this format does not define: ${k.slice(0, 40)}`);
  if (typeof n.key !== 'string' || !n.key) bad(`${at}.key must be a text`);
  for (const k of ['x', 'y', 'w', 'h']) if (n[k] !== undefined && !isNum(n[k])) bad(`${at}.${k} must be a number`);
  for (const k of ['name', 'color', 'icon', 'role', 'preset', 'cwdRel', 'command', 'url', 'text', 'stackKey', 'front']) if (!strOrNull(n[k])) bad(`${at}.${k} must be a text`);
  if (n.maestro !== undefined && typeof n.maestro !== 'boolean') bad(`${at}.maestro must be true or false`);
  for (const k of ['order', 'members']) if (n[k] !== undefined && !(Array.isArray(n[k]) && n[k].every((x) => typeof x === 'string'))) bad(`${at}.${k} must be a list of texts`);
}

/**
 * Check a bundle against the closed format of version 1: a field the format does not define is
 * a refusal, not something ignored. Returns a list of problems (empty when the bundle is fine).
 */
export function validateBundle(bundle) {
  const errors = [];
  const bad = (m) => { if (errors.length < MAX_ERRORS) errors.push(m); };
  if (!isObj(bundle)) return ['the file is not a JSON object'];
  if (bundle.format !== BUNDLE_FORMAT) return ['not an openmaestri workspace file'];
  if (bundle.version !== BUNDLE_VERSION) return [`unsupported bundle version: ${String(bundle.version).slice(0, 20)} (this build reads version ${BUNDLE_VERSION})`];
  if (depthOf(bundle) > MAX_DEPTH) return ['the file is nested too deeply'];
  // size limits come first: there is no point listing type problems in a file that is simply too big
  if (Array.isArray(bundle.nodes) && bundle.nodes.length > LIMITS.nodes) return ['bundle has too many nodes'];
  if (Array.isArray(bundle.connections) && bundle.connections.length > LIMITS.connections) return ['bundle has too many connections'];
  if (Array.isArray(bundle.nodes)) {
    let bytes = 0;
    for (const n of bundle.nodes) {
      if (typeof n?.text !== 'string') continue;
      if (n.text.length > LIMITS.noteBytes) return ['a note is too large'];
      bytes += n.text.length;
    }
    if (bytes > LIMITS.totalBytes) return ['bundle is too large'];
  }
  for (const k of Object.keys(bundle)) if (!TOP.includes(k)) bad(`unknown top-level field: ${k.slice(0, 40)}`);
  if (!Array.isArray(bundle.nodes)) bad('nodes must be a list');
  else bundle.nodes.forEach((n, i) => { if (errors.length < MAX_ERRORS) checkNode(n, i, bad); });
  if (bundle.connections !== undefined) {
    if (!Array.isArray(bundle.connections)) bad('connections must be a list');
    else bundle.connections.forEach((c, i) => { if (!isObj(c) || typeof c.from !== 'string' || typeof c.to !== 'string' || Object.keys(c).length !== 2) bad(`connections[${i}] must be exactly {from, to}`); });
  }
  if (bundle.routines !== undefined) {
    if (!Array.isArray(bundle.routines)) bad('routines must be a list');
    else bundle.routines.forEach((r, i) => { if (!isObj(r) || Object.keys(r).some((k) => !ROUTINE.includes(k))) bad(`routines[${i}] has a field that this format does not define`); });
  }
  if (bundle.workspace !== undefined && !isObj(bundle.workspace)) bad('workspace must be an object');
  else if (isObj(bundle.workspace)) for (const k of Object.keys(bundle.workspace)) if (!['name', 'viewport', 'floorStatus'].includes(k)) bad(`unknown workspace field: ${k.slice(0, 40)}`);
  return errors;
}

/**
 * Create a new workspace from a bundle. The bundle is untrusted input: every field is
 * type-checked and re-created, ids are regenerated, and terminal commands do NOT run
 * until the user trusts them (node.untrusted).
 */
export function importWorkspace(store, bundle, { name, dir } = {}) {
  const problems = validateBundle(bundle);
  if (problems.length) throw new Error(`this file cannot be imported:\n- ${problems.join('\n- ')}`);
  if (!Array.isArray(bundle.nodes) || bundle.nodes.length > LIMITS.nodes) throw new Error('bundle has too many nodes');
  const conns = Array.isArray(bundle.connections) ? bundle.connections : [];
  if (conns.length > LIMITS.connections) throw new Error('bundle has too many connections');
  let bytes = 0;
  for (const n of bundle.nodes) {
    if (typeof n?.text === 'string') { bytes += n.text.length; if (n.text.length > LIMITS.noteBytes) throw new Error('a note is too large'); }
  }
  if (bytes > LIMITS.totalBytes) throw new Error('bundle is too large');

  const wsDir = dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? path.resolve(dir) : os.homedir();
  const ws = store.createWorkspace({ name: str(name, 80)?.trim() || str(bundle.workspace?.name, 80)?.trim() || 'Imported', dir: wsDir });
  const idMap = new Map();
  const items = bundle.nodes.map((n) => ({ raw: n, clean: cleanNode(n) })).filter((i) => i.clean && typeof i.raw.key === 'string');
  const plain = items.filter((i) => !['band', 'stack'].includes(i.clean.kind));
  for (const { raw: r, clean } of [...plain, ...items.filter((i) => i.clean.kind === 'stack')]) {
    const props = { ...clean, text: clean.kind === 'note' && typeof r.text === 'string' ? r.text : '' };
    props.cwd = clean.kind === 'terminal' ? (typeof r.cwdRel === 'string' && !path.isAbsolute(r.cwdRel) && !r.cwdRel.split(path.sep).includes('..') ? path.join(wsDir, r.cwdRel) : wsDir) : undefined;
    const node = store.createNode(ws, clean.kind, props);
    if (node.kind === 'terminal' && node.command) node.untrusted = true;
    idMap.set(r.key, node.id);
  }
  for (const { raw: r } of items.filter((i) => i.clean.kind === 'note')) {
    if (typeof r.stackKey === 'string' && idMap.get(r.stackKey)) store.addToStack(ws, idMap.get(r.key), idMap.get(r.stackKey));
  }
  for (const { raw: r } of items.filter((i) => i.clean.kind === 'stack')) {
    const st = ws.nodes.find((n) => n.id === idMap.get(r.key));
    if (st && typeof r.front === 'string' && idMap.get(r.front) && st.order.includes(idMap.get(r.front))) st.front = idMap.get(r.front);
  }
  for (const { raw: r, clean } of items.filter((i) => i.clean.kind === 'band')) {
    const members = (Array.isArray(r.members) ? r.members : []).map((k) => idMap.get(k)).filter(Boolean);
    try { if (members.length) store.createBand(ws, clean.name, members, { color: clean.color, icon: clean.icon }); } catch { /* member already banded */ }
  }
  for (const c of conns) {
    const a = idMap.get(c?.from), b = idMap.get(c?.to);
    if (a && b && a !== b) store.connect(ws, a, b);
  }
  store.saveWorkspace(ws.id, { now: true });
  return ws;
}
