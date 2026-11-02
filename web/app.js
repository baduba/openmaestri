import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { createChat } from '/chat.js';
import { buildFiles, renderMarkdown } from '/files.js';
import { createWelcome } from '/welcome.js';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const COLORS = { red: '#ef5b5b', orange: '#f59f4a', yellow: '#f0b429', green: '#4cc38a', teal: '#2dbdb6', blue: '#6ea8fe', purple: '#a78bfa', pink: '#f472b6', gray: '#8b93a1' };
const cssColor = (c) => (c && (COLORS[c.toLowerCase()] || (/^#[0-9a-f]{3,8}$/i.test(c) ? c : null))) || '';

const state = {
  summary: { workspaces: [], presets: [], active: null },
  ws: null, // active workspace payload
  views: new Map(), // node id -> NodeView
  vp: { x: 0, y: 0, z: 1 },
  selected: null,
  linkFrom: null,
  stackNote: null,
  floorId: null,
  snap: (() => { try { return localStorage.getItem('om.snap') === '1'; } catch { return false; } })(),
};

// ---------- socket ----------
let socket;
let retry = 500;

function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onopen = () => { retry = 500; setConn(true); for (const v of state.views.values()) v.attach?.(); };
  socket.onclose = () => { setConn(false); setTimeout(connect, retry = Math.min(retry * 2, 8000)); };
  socket.onmessage = (ev) => onMessage(JSON.parse(ev.data));
}
const send = (m) => socket?.readyState === 1 && socket.send(JSON.stringify(m));
const wsId = () => state.ws?.id;
const welcome = createWelcome({ send, wsId });
function setConn(ok) {
  const c = $('#conn');
  c.classList.toggle('off', !ok);
  c.textContent = ok ? 'connected' : 'reconnecting…';
}

function onMessage(m) {
  switch (m.t) {
    case 'summary': state.summary = { ...state.summary, ...m }; renderSidebar(); break;
    case 'workspace':
      if (!state.ws || m.ws.id === state.ws.id || m.select) applyWorkspace(m.ws, !!m.select || !state.ws || m.ws.id !== state.ws.id);
      break;
    case 'note': {
      if (m.workspaceId !== wsId()) break;
      state.ws.notes.set(m.id, m.text);
      state.views.get(m.id)?.setNote?.(m.text, m.id);
      const owner = state.ws.nodes.find((x) => x.id === m.id)?.stackId;
      if (owner) state.views.get(owner)?.setNote?.(m.text, m.id);
      break;
    }
    case 'term.snapshot': state.views.get(m.id)?.snapshot?.(m.data); break;
    case 'term.out': state.views.get(m.id)?.write?.(m.data); break;
    case 'term.status': {
      if (state.ws && m.status) state.ws.status.set(m.id, m.status);
      state.views.get(m.id)?.setStatus?.(m.status);
      break;
    }
    case 'notify': toast(m.message, m.from); maybeSystemNotify(m); break;
    case 'error': toast(m.message, 'error', true); break;
    case 'toast': toast(m.message, m.from); break;
    case 'usage.state':
      if (state.ws && m.workspaceId === state.ws.id) { state.ws.usage = new Map(Object.entries(m.usage || {})); for (const [id, v] of state.views) v.setUsage?.(state.ws.usage.get(id)); }
      break;
    case 'chat.history': case 'chat.message': case 'chat.progress': case 'chat.state': case 'chat.search': case 'prompter.mentions': case 'prompter.preview': case 'prompts.list': case 'prompts.changed': case 'prompts.item': case 'prompts.deleted': chatUi.handle(m); break;
    case 'welcome.info': welcome.handle(m); break;
    case 'note.image': state.views.get(m.id)?.imageAdded?.(m.markdown); break;
    case 'files.result': state.views.get(m.id)?.filesResult?.(m); break;
    case 'portal.frame': state.views.get(m.id)?.frame?.(m); break;
    case 'portal.nav': state.views.get(m.id)?.nav?.(m); break;
    case 'portal.error': state.views.get(m.id)?.portalError?.(m.message); break;
    case 'floor.focus': setFloor(m.id); break;
  }
}

// ---------- workspace ----------
const floorKey = (id) => `om.floor.${id}`;
const nodeFloor = (n) => n.floorId ?? null;
const isVisible = (n) => nodeFloor(n) === state.floorId;

function applyWorkspace(ws, switching) {
  queueMicrotask(() => welcome.check());
  // keyed by ids that arrive over the wire, so Maps (no prototype keys to poison)
  ws.notes = ws.notes instanceof Map ? ws.notes : new Map(Object.entries(ws.notes || {}));
  ws.status = ws.status instanceof Map ? ws.status : new Map(Object.entries(ws.status || {}));
  ws.usage = ws.usage instanceof Map ? ws.usage : new Map(Object.entries(ws.usage || {}));
  state.ws = ws;
  if (switching) {
    for (const v of state.views.values()) v.destroy();
    state.views.clear();
    // a never-moved canvas starts clear of the toolbar, so a node at the origin is not hidden under it
    const fresh = ws.viewport.x === 0 && ws.viewport.y === 0 && ws.viewport.z === 1;
    state.vp = fresh ? { x: 40, y: 64, z: 1 } : { ...ws.viewport };
    state.selected = null;
    state.linkFrom = null;
    let saved = null;
    try { saved = localStorage.getItem(floorKey(ws.id)); } catch { /* storage unavailable */ }
    state.floorId = saved && ws.floors?.some((f) => f.id === saved) ? saved : null;
    applyViewport();
  }
  if (state.floorId && !ws.floors?.some((f) => f.id === state.floorId)) { state.floorId = null; for (const v of state.views.values()) v.destroy(); state.views.clear(); }
  syncViews();
}

/** Create, update and remove node views so that exactly the current floor's nodes are on the canvas. */
function syncViews() {
  const ws = state.ws;
  const seen = new Set();
  for (const n of ws.nodes.filter(isVisible)) {
    seen.add(n.id);
    let v = state.views.get(n.id);
    if (!v) { v = n.kind === 'band' ? makeBandView(n) : makeView(n); state.views.set(n.id, v); $('#world').append(v.root); }
    v.update(n);
  }
  for (const [id, v] of [...state.views]) if (!seen.has(id)) { v.destroy(); state.views.delete(id); }
  renderLinks();
  renderSidebar();
  renderFloors();
  syncHistoryButtons();
  chatUi.sync();
  markAttention();
  const cur = state.floorId ? ws.floors.find((f) => f.id === state.floorId) : null;
  const status = cur ? cur.status : ws.floorStatus;
  const fs = $('#floor-status');
  if (status) { fs.textContent = `${status.state}${status.progress ? ` ${status.progress}` : ''}: ${status.text}`; fs.title = `${cur ? cur.name : 'Ground'} · by ${status.by}`; fs.classList.add('on'); }
  else { fs.textContent = ''; fs.classList.remove('on'); }
}

function setFloor(id) {
  if (id === state.floorId) return;
  state.floorId = id;
  try { localStorage.setItem(floorKey(wsId()), id ?? ''); } catch { /* storage unavailable */ }
  setLinkFrom(null); setStackNote(null);
  for (const v of state.views.values()) v.destroy();
  state.views.clear();
  syncViews();
  $('#fit').click();
}

function renderFloors() {
  const bar = $('#floors');
  bar.replaceChildren();
  const tab = (id, name, title, status) => {
    const b = el('button', `floor-tab${id === state.floorId ? ' on' : ''}`);
    if (status) { const d = el('span', `fdot ${status.state}`); b.append(d); }
    b.append(document.createTextNode(name));
    b.title = title;
    b.onclick = () => setFloor(id);
    bar.append(b);
  };
  tab(null, 'Ground', state.ws.dir, state.ws.floorStatus);
  for (const f of state.ws.floors ?? []) tab(f.id, f.name, `${f.kind}${f.branch ? ` · ${f.branch}` : ''}\n${f.dir}`, f.status);
  const add = el('button', 'floor-tab add', '+ Floor');
  add.title = 'Add a floor: its own canvas and, in a git project, its own branch';
  add.onclick = () => openFloorDialog();
  bar.append(add);
}

function renderSidebar() {
  const ul = $('#ws-list');
  ul.replaceChildren();
  const collapsed = readCollapsed();
  const groups = new Map();
  for (const w of state.summary.workspaces) {
    const key = w.group ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  const names = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  for (const g of names) {
    if (g !== '') {
      const head = el('li', 'ws-group', `${collapsed.has(g) ? '▸' : '▾'} ${g}`);
      head.onclick = () => { if (collapsed.has(g)) collapsed.delete(g); else collapsed.add(g); saveCollapsed(collapsed); renderSidebar(); };
      ul.append(head);
      if (collapsed.has(g)) continue;
    }
    for (const w of groups.get(g)) ul.append(workspaceRow(w));
  }
}

function readCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem('om.collapsedGroups') || '[]')); } catch { return new Set(); }
}
function saveCollapsed(set) {
  try { localStorage.setItem('om.collapsedGroups', JSON.stringify([...set])); } catch { /* storage may be off */ }
}

function workspaceRow(w) {
  const li = el('li', w.id === (state.ws?.id) ? 'active' : '');
  li.append(el('span', 'name', `${w.icon ? `${w.icon} ` : ''}${w.name}`), el('span', 'count', `${w.running ? '● ' : ''}${w.nodes}`));
  const x = el('button', 'x', '×');
  x.title = 'Delete workspace';
  x.onclick = (e) => { e.stopPropagation(); if (confirm(`Delete workspace "${w.name}" and everything in it?`)) send({ t: 'workspace.delete', id: w.id }); };
  const exp = el('button', 'x', '⭳');
  exp.title = 'Export this workspace to a file';
  exp.onclick = (e) => { e.stopPropagation(); location.href = `/export/${w.id}.json`; };
  li.append(exp, x);
  li.title = w.dir;
  li.onclick = () => send({ t: 'workspace.select', id: w.id });
  li.ondblclick = () => { const name = prompt('Rename workspace', w.name); if (name) send({ t: 'workspace.rename', id: w.id, name }); };
  return li;
}

// ---------- viewport ----------
function applyViewport() {
  const { x, y, z } = state.vp;
  $('#world').style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  $('#zoom-label').textContent = `${Math.round(z * 100)}%`;
  const grid = 24 * z;
  const c = $('#canvas');
  c.style.backgroundSize = `${grid}px ${grid}px`;
  c.style.backgroundPosition = `${x}px ${y}px`;
}
let vpTimer;
function saveViewport() {
  clearTimeout(vpTimer);
  vpTimer = setTimeout(() => send({ t: 'viewport.set', workspaceId: wsId(), ...state.vp }), 400);
}
function zoomAt(factor, cx, cy) {
  const z0 = state.vp.z;
  const z1 = Math.min(2.5, Math.max(0.15, z0 * factor));
  state.vp.x = cx - ((cx - state.vp.x) * z1) / z0;
  state.vp.y = cy - ((cy - state.vp.y) * z1) / z0;
  state.vp.z = z1;
  applyViewport();
  saveViewport();
}
const canvas = $('#canvas');
const canvasPoint = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

canvas.addEventListener('wheel', (e) => {
  const inScrollable = e.target.closest('.term, textarea, iframe, canvas.pv');
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const p = canvasPoint(e);
    zoomAt(Math.exp(-e.deltaY * 0.01), p.x, p.y);
  } else if (!inScrollable) {
    e.preventDefault();
    state.vp.x -= e.deltaX;
    state.vp.y -= e.deltaY;
    applyViewport();
    saveViewport();
  }
}, { passive: false });

canvas.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.node, #toolbar, #floors, .band-label')) return;
  select(null);
  if (state.linkFrom) setLinkFrom(null);
  const start = { x: e.clientX, y: e.clientY, vx: state.vp.x, vy: state.vp.y };
  canvas.classList.add('panning');
  canvas.setPointerCapture(e.pointerId);
  const move = (ev) => { state.vp.x = start.vx + ev.clientX - start.x; state.vp.y = start.vy + ev.clientY - start.y; applyViewport(); };
  const up = () => { canvas.classList.remove('panning'); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); saveViewport(); };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
});

$('#zoom-in').onclick = () => zoomAt(1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
$('#zoom-out').onclick = () => zoomAt(1 / 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
$('#zoom-label').onclick = () => { state.vp = { x: 40, y: 60, z: 1 }; applyViewport(); saveViewport(); };
$('#fit').onclick = () => {
  const ns = (state.ws?.nodes || []).filter((n) => isVisible(n) && !n.stackId);
  if (!ns.length) return;
  const minX = Math.min(...ns.map((n) => n.x)), minY = Math.min(...ns.map((n) => n.y));
  const maxX = Math.max(...ns.map((n) => n.x + n.w)), maxY = Math.max(...ns.map((n) => n.y + n.h));
  const pad = 60;
  const z = Math.min(1, Math.max(0.15, Math.min((canvas.clientWidth - pad * 2) / (maxX - minX), (canvas.clientHeight - pad * 2 - 40) / (maxY - minY))));
  state.vp = { z, x: pad - minX * z + (canvas.clientWidth - pad * 2 - (maxX - minX) * z) / 2, y: pad + 40 - minY * z };
  applyViewport();
  saveViewport();
};

// ---------- links ----------
function renderLinks() {
  const svg = $('#links');
  svg.replaceChildren();
  const ns = new Map(state.ws.nodes.map((n) => [n.id, n]));
  for (const c of state.ws.connections) {
    const a = ns.get(c.from), b = ns.get(c.to);
    if (!a || !b || a.stackId || b.stackId || !isVisible(a) || !isVisible(b)) continue;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', linkPath(a, b));
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    t.textContent = `${a.name} ↔ ${b.name} (click to disconnect)`;
    path.append(t);
    path.onclick = () => { if (confirm(`Disconnect ${a.name} and ${b.name}?`)) send({ t: 'conn.delete', workspaceId: wsId(), id: c.id }); };
    svg.append(path);
  }
}
function linkPath(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const horiz = Math.abs(ac.x - bc.x) * (a.h + b.h) > Math.abs(ac.y - bc.y) * (a.w + b.w);
  let p1, p2, c1, c2;
  if (horiz) {
    const left = ac.x < bc.x ? a : b, right = left === a ? b : a;
    p1 = { x: left.x + left.w, y: left.y + left.h / 2 }; p2 = { x: right.x, y: right.y + right.h / 2 };
    const dx = Math.max(40, Math.abs(p2.x - p1.x) / 2);
    c1 = { x: p1.x + dx, y: p1.y }; c2 = { x: p2.x - dx, y: p2.y };
  } else {
    const top = ac.y < bc.y ? a : b, bot = top === a ? b : a;
    p1 = { x: top.x + top.w / 2, y: top.y + top.h }; p2 = { x: bot.x + bot.w / 2, y: bot.y };
    const dy = Math.max(40, Math.abs(p2.y - p1.y) / 2);
    c1 = { x: p1.x, y: p1.y + dy }; c2 = { x: p2.x, y: p2.y - dy };
  }
  return `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`;
}

function select(id) {
  if (id && state.ws?.chat?.attention?.includes(id)) send({ t: 'chat.ack', workspaceId: wsId(), terminalId: id });
  state.selected = id;
  for (const [nid, v] of state.views) v.root.classList.toggle('sel', nid === id);
}
function setLinkFrom(id) {
  state.linkFrom = id;
  for (const [nid, v] of state.views) {
    v.root.classList.toggle('linkfrom', nid === id);
    v.root.classList.toggle('linkable', !!id && nid !== id);
  }
  const h = $('#hint');
  h.classList.toggle('on', !!id);
  h.textContent = id ? 'Click another node to connect — Esc to cancel' : '';
}
addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.linkFrom) setLinkFrom(null); });

// ---------- node views ----------
function makeView(n) {
  const root = el('div', 'node');
  root.dataset.id = n.id;
  const head = el('div', 'head');
  const dot = el('span', 'dot');
  const title = el('span', 'title');
  const kind = el('span', 'kind', n.kind);
  const link = el('button', 'ibtn', '⚭');
  link.title = 'Connect to another node';
  const close = el('button', 'ibtn', '×');
  close.title = 'Remove';
  const fileBtn = n.kind === 'note' ? el('button', 'ibtn', '▤') : null;
  if (fileBtn) fileBtn.title = 'File this note into a stack';
  const usageEl = n.kind === 'terminal' ? el('span', 'usage') : null;
  head.append(dot, title, ...(usageEl ? [usageEl] : []), kind, ...(fileBtn ? [fileBtn] : []), link, close);
  const body = el('div', 'body');
  const rz = el('div', 'resize');
  root.append(head, body, rz);

  const view = {
    root, node: n, destroy() { root.remove(); }, update() {},
    setUsage(u) {
      if (!usageEl) return;
      const k = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}m` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v));
      const tok = u?.tokens ? `${k(u.tokens.input + u.tokens.output)} tok` : '';
      const cost = u?.costUsd != null ? `$${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)}` : '';
      usageEl.textContent = [tok, cost].filter(Boolean).join(' · ') || (u?.turns ? `${u.turns} turns` : '');
      usageEl.title = u?.tokens ? `${u.tokens.input} in, ${u.tokens.output} out (${u.source}${u.model ? `, ${u.model}` : ''})\n${u.turns} turns, ${Math.round(u.activeSeconds / 60)} min active${u.costUsd == null ? '\nno price known for this model' : ''}` : (u?.turns ? `${u.turns} turns; no token numbers reported yet` : '');
    },
  };
  let node = n;

  const patch = (p, local = true) => {
    if (local) Object.assign(node, p);
    send({ t: 'node.patch', workspaceId: wsId(), id: node.id, patch: p });
  };
  const layout = () => {
    root.style.left = `${node.x}px`; root.style.top = `${node.y}px`;
    root.style.width = `${node.w}px`; root.style.height = `${node.h}px`;
    root.style.setProperty('--nodecolor', cssColor(node.color));
    root.style.display = node.stackId ? 'none' : '';
  };

  // drag by header
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input')) return;
    e.stopPropagation();
    select(node.id);
    if (state.linkFrom && state.linkFrom !== node.id) { send({ t: 'conn.create', workspaceId: wsId(), from: state.linkFrom, to: node.id }); setLinkFrom(null); return; }
    const s = { x: e.clientX, y: e.clientY, nx: node.x, ny: node.y };
    head.setPointerCapture(e.pointerId);
    let last = 0;
    const move = (ev) => {
      node.x = snapV(Math.round(s.nx + (ev.clientX - s.x) / state.vp.z)); node.y = snapV(Math.round(s.ny + (ev.clientY - s.y) / state.vp.z));
      layout(); refreshBandsLocal(); renderLinks();
      if (Date.now() - last > 100) { last = Date.now(); patch({ x: node.x, y: node.y }, false); }
    };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); patch({ x: node.x, y: node.y }, false); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
  // clicking the body while linking, or to select
  root.addEventListener('pointerdown', (e) => {
    if (state.stackNote && node.kind === 'stack') { e.preventDefault(); e.stopPropagation(); send({ t: 'note.stack', workspaceId: wsId(), noteId: state.stackNote, stackId: node.id }); setStackNote(null); return; }
    if (state.linkFrom && state.linkFrom !== node.id) { e.preventDefault(); e.stopPropagation(); send({ t: 'conn.create', workspaceId: wsId(), from: state.linkFrom, to: node.id }); setLinkFrom(null); return; }
    select(node.id);
  }, true);
  // resize
  rz.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    const s = { x: e.clientX, y: e.clientY, w: node.w, h: node.h };
    rz.setPointerCapture(e.pointerId);
    const move = (ev) => {
      node.w = Math.max(200, snapV(Math.round(s.w + (ev.clientX - s.x) / state.vp.z))); node.h = Math.max(120, snapV(Math.round(s.h + (ev.clientY - s.y) / state.vp.z)));
      layout(); refreshBandsLocal(); renderLinks(); view.resized?.();
    };
    const up = () => { rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); patch({ w: node.w, h: node.h }, false); };
    rz.addEventListener('pointermove', move);
    rz.addEventListener('pointerup', up);
  });
  link.onclick = () => setLinkFrom(state.linkFrom === node.id ? null : node.id);
  if (fileBtn) fileBtn.onclick = () => setStackNote(state.stackNote === node.id ? null : node.id);
  close.onclick = () => {
    if (node.kind === 'terminal' && !confirm(`Stop and remove "${node.name}"?`)) return;
    if (node.kind === 'stack' && node.order.length) {
      const del = confirm(`Delete stack "${node.name}" AND its ${node.order.length} note(s)?\n\nOK = delete the notes too. Cancel = keep the notes and remove only the stack.`);
      send({ t: 'node.delete', workspaceId: wsId(), id: node.id, keepNotes: !del });
      return;
    }
    send({ t: 'node.delete', workspaceId: wsId(), id: node.id });
  };
  title.ondblclick = () => {
    const input = el('input');
    input.value = node.name;
    title.replaceChildren(input);
    input.focus(); input.select();
    const done = (ok) => { if (ok && input.value.trim() && input.value !== node.name) patch({ name: input.value.trim() }, false); title.textContent = node.name; };
    input.onblur = () => done(true);
    input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.onblur = null; done(false); } };
  };

  const baseUpdate = (next) => {
    node = Object.assign(node, next);
    view.node = node;
    if (!title.firstChild || title.firstChild.nodeType === 3) title.textContent = node.name;
    layout();
  };

  if (n.kind === 'terminal') buildTerminal(view, body, dot, () => node, baseUpdate);
  else if (n.kind === 'note') buildNote(view, body, dot, () => node, baseUpdate, (p) => patch(p, false));
  else if (n.kind === 'stack') buildStack(view, body, dot, () => node, baseUpdate);
  else if (n.kind === 'files') buildFiles(view, body, dot, { send, wsId, nodeId: () => node.id, confirm: (t) => confirm(t) });
  else buildPortal(view, body, dot, () => node, baseUpdate, (p) => patch(p, false));
  const origDestroy = view.destroy;
  view.destroy = () => { view.cleanup?.(); origDestroy(); };
  return view;
}

function buildTerminal(view, body, dot, getNode, baseUpdate) {
  const holder = el('div', 'term');
  const exited = el('div', 'exited');
  const restart = el('button', 'primary', 'Restart');
  exited.append(el('div', null, 'Process exited'), restart);
  body.append(holder, exited);
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, scrollback: 5000, allowProposedApi: true,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    theme: { background: '#101216', foreground: '#e6e8ec', cursor: '#6ea8fe' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(holder);
  let snapped = false;
  const buffered = [];
  view.attach = () => { snapped = false; buffered.length = 0; send({ t: 'term.attach', workspaceId: wsId(), id: getNode().id }); };
  view.snapshot = (data) => { term.reset(); if (data) term.write(data); snapped = true; for (const b of buffered.splice(0)) term.write(b); doFit(); };
  view.write = (data) => (snapped ? term.write(data) : buffered.push(data));
  term.onData((d) => send({ t: 'term.in', id: getNode().id, data: d }));
  let fitTimer;
  const doFit = () => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      try { fit.fit(); } catch { return; }
      send({ t: 'term.resize', id: getNode().id, cols: term.cols, rows: term.rows });
    }, 60);
  };
  view.resized = doFit;
  const ro = new ResizeObserver(doFit);
  ro.observe(holder);
  view.setStatus = (s) => {
    dot.className = `dot ${s}`;
    dot.title = s;
    exited.classList.toggle('on', s === 'exited');
  };
  restart.onclick = () => send({ t: 'term.restart', workspaceId: wsId(), id: getNode().id });
  view.cleanup = () => { ro.disconnect(); send({ t: 'term.detach', id: getNode().id }); term.dispose(); };
  const held = el('div', 'exited');
  const heldText = el('div');
  heldText.style.cssText = 'padding:0 16px;text-align:center;max-width:100%;overflow-wrap:anywhere';
  const runIt = el('button', 'primary', 'Trust and run it');
  held.append(heldText, runIt);
  body.append(held);
  runIt.onclick = () => send({ t: 'term.trust', workspaceId: wsId(), id: getNode().id });
  view.update = (next) => {
    baseUpdate(next);
    view.setStatus(state.ws.status.get(next.id) || 'idle');
    view.setUsage(state.ws.usage.get(next.id));
    held.classList.toggle('on', !!next.untrusted);
    if (next.untrusted) heldText.textContent = `This terminal came from an imported file. Its command was NOT run: ${next.command}`;
  };
  // first update must run before attach so getNode().id is set
  view.attach();
}

function buildNote(view, body, dot, getNode, baseUpdate, patch) {
  dot.style.background = 'var(--accent)';
  const bar = el('div', 'notebar');
  const previewBtn = el('button', null, 'Preview');
  previewBtn.title = 'Show the note as formatted Markdown';
  bar.append(previewBtn, el('span', 'muted', 'drop or paste a picture to add it'));
  const ta = el('textarea', 'note-text with-bar');
  ta.spellcheck = false;
  ta.placeholder = 'Markdown note…';
  const preview = el('div', 'note-preview');
  preview.hidden = true;
  body.append(bar, ta, preview);
  let timer;
  const save = () => { clearTimeout(timer); send({ t: 'note.write', workspaceId: wsId(), id: getNode().id, text: ta.value }); };
  ta.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => send({ t: 'note.write', workspaceId: wsId(), id: getNode().id, text: ta.value }), 300);
  });
  ta.addEventListener('blur', save);
  previewBtn.onclick = () => {
    preview.hidden = !preview.hidden;
    ta.hidden = !preview.hidden;
    previewBtn.textContent = preview.hidden ? 'Preview' : 'Edit';
    if (!preview.hidden) renderMarkdown(ta.value, preview);
  };
  // pictures: dropped or pasted raster images go to the workspace vault and come back as Markdown
  const sendImage = (file) => {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return false;
    if (file.size > 5 * 1024 * 1024) { toast(`${file.name || 'picture'} is over 5 MB`, 'note', true); return true; }
    const reader = new FileReader();
    reader.onload = () => send({ t: 'note.image', workspaceId: wsId(), id: getNode().id, name: file.name || 'picture.png', data: String(reader.result).split(',')[1] ?? '' });
    reader.readAsDataURL(file);
    return true;
  };
  ta.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault(); });
  ta.addEventListener('drop', (e) => { const files = [...(e.dataTransfer?.files ?? [])]; if (files.some(sendImage)) e.preventDefault(); });
  ta.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files ?? [])]; if (files.some(sendImage)) e.preventDefault(); });
  view.imageAdded = (markdown) => {
    const at = ta.selectionStart ?? ta.value.length;
    ta.value = `${ta.value.slice(0, at)}\n${markdown}\n${ta.value.slice(at)}`;
    save();
    if (!preview.hidden) renderMarkdown(ta.value, preview);
  };
  view.setNote = (text) => { if (document.activeElement !== ta && ta.value !== text) { ta.value = text; if (!preview.hidden) renderMarkdown(text, preview); } };
  view.update = (next) => { baseUpdate(next); view.setNote(state.ws.notes.get(next.id) ?? ''); };
  view.cleanup = () => clearTimeout(timer);
  void patch;
}

function buildPortal(view, body, dot, getNode, baseUpdate, patch) {
  if (state.summary.portalsAvailable) buildPortalBrowser(view, body, dot, getNode, baseUpdate);
  else buildPortalIframe(view, body, dot, getNode, baseUpdate, patch);
}

/** A real Chromium on the server, shown as a stream of frames; mouse and keys go back to it. */
function buildPortalBrowser(view, body, dot, getNode, baseUpdate) {
  dot.style.background = 'var(--ok)';
  const bar = el('div', 'urlbar');
  const back = el('button', null, '‹'); back.title = 'Back';
  const fwd = el('button', null, '›'); fwd.title = 'Forward';
  const reload = el('button', null, '↻'); reload.title = 'Reload';
  const input = el('input');
  input.setAttribute('aria-label', 'Address');
  bar.append(back, fwd, reload, input);
  const stage = el('div', 'pv-stage');
  const cv = el('canvas', 'pv');
  cv.tabIndex = 0;
  const note = el('div', 'portal-msg');
  note.textContent = 'Starting the browser…';
  stage.append(cv, note);
  body.append(bar, stage);
  const ctx = cv.getContext('2d');
  let frame = null, drawing = false, size = { w: 0, h: 0 };
  const go = (action, url) => send({ t: 'portal.go', workspaceId: wsId(), id: getNode().id, action, url });
  back.onclick = () => go('back'); fwd.onclick = () => go('forward'); reload.onclick = () => go('reload');
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { const v = input.value.trim(); if (v) go('navigate', /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`); } };

  const paint = () => {
    drawing = false;
    if (!frame) return;
    const img = new Image();
    img.onload = () => {
      if (cv.width !== img.width || cv.height !== img.height) { cv.width = img.width; cv.height = img.height; }
      size = { w: img.width, h: img.height };
      ctx.drawImage(img, 0, 0);
      note.style.display = 'none';
    };
    img.src = `data:image/jpeg;base64,${frame}`;
  };
  view.frame = (f) => { frame = f.data; if (!drawing) { drawing = true; requestAnimationFrame(paint); } };
  view.nav = (n) => {
    if (document.activeElement !== input) input.value = n.url === 'about:blank' ? '' : n.url;
    back.disabled = !n.canBack; fwd.disabled = !n.canForward;
  };
  view.portalError = (m) => { note.style.display = ''; note.textContent = m; };

  // pointer position in page pixels (the canvas letterboxes the frame)
  const toPage = (e) => {
    const r = cv.getBoundingClientRect();
    const k = Math.min(r.width / size.w, r.height / size.h) || 1;
    const ox = (r.width - size.w * k) / 2, oy = (r.height - size.h * k) / 2;
    return { x: Math.round((e.clientX - r.left - ox) / k), y: Math.round((e.clientY - r.top - oy) / k) };
  };
  const ev = (event) => send({ t: 'portal.input', workspaceId: wsId(), id: getNode().id, event });
  const btn = (e) => ['left', 'middle', 'right'][e.button] ?? 'left';
  let lastMove = 0;
  cv.addEventListener('pointerdown', (e) => { cv.focus(); cv.setPointerCapture(e.pointerId); ev({ kind: 'mouse', type: 'down', ...toPage(e), button: btn(e), clickCount: e.detail || 1 }); });
  cv.addEventListener('pointerup', (e) => ev({ kind: 'mouse', type: 'up', ...toPage(e), button: btn(e), clickCount: e.detail || 1 }));
  cv.addEventListener('pointermove', (e) => { const now = Date.now(); if (now - lastMove > 30) { lastMove = now; ev({ kind: 'mouse', type: 'move', ...toPage(e), buttons: e.buttons }); } });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); ev({ kind: 'mouse', type: 'wheel', ...toPage(e), deltaX: e.deltaX, deltaY: e.deltaY }); }, { passive: false });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  const modsOf = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const keyEv = (type, e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') return; // the palette
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return; // delivered by the paste event
    e.preventDefault(); e.stopPropagation();
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    ev({ kind: 'key', type, key: e.key, code: e.code, modifiers: modsOf(e), text: type === 'down' ? (printable ? e.key : e.key === 'Enter' ? '\r' : undefined) : undefined });
  };
  cv.addEventListener('keydown', (e) => keyEv('down', e));
  cv.addEventListener('keyup', (e) => keyEv('up', e));
  cv.addEventListener('paste', (e) => { e.preventDefault(); const text = e.clipboardData?.getData('text/plain'); if (text) ev({ kind: 'paste', text }); });

  view.attach = () => send({ t: 'portal.attach', workspaceId: wsId(), id: getNode().id });
  view.update = (next) => { baseUpdate(next); if (document.activeElement !== input && next.url && !input.value) input.value = next.url === 'about:blank' ? '' : next.url; };
  view.cleanup = () => send({ t: 'portal.detach', id: getNode().id });
  view.attach();
}

function buildPortalIframe(view, body, dot, getNode, baseUpdate, patch) {
  dot.style.background = 'var(--ok)';
  const bar = el('div', 'urlbar');
  const input = el('input');
  const go = el('button', null, 'Go');
  bar.append(input, go);
  const holder = el('div', null);
  holder.style.height = 'calc(100% - 28px)';
  body.append(bar, holder);
  let current = null;
  const load = (url) => {
    holder.replaceChildren();
    let u;
    try { u = new URL(url); } catch { holder.append(el('div', 'portal-msg', 'Invalid URL')); return; }
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
    if (u.protocol === 'about:') return;
    if (!['http:', 'https:'].includes(u.protocol) || u.host === location.host) { holder.append(el('div', 'portal-msg', 'This URL cannot be shown in a portal.')); return; }
    const f = el('iframe');
    // loopback pages must not share an origin with anything of ours
    f.setAttribute('sandbox', `allow-scripts allow-forms allow-popups${loopback ? '' : ' allow-same-origin'}`);
    f.referrerPolicy = 'no-referrer';
    f.src = u.href;
    holder.append(f);
  };
  const commit = () => {
    let v = input.value.trim();
    if (!v) return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = `https://${v}`;
    patch({ url: v });
  };
  go.onclick = commit;
  input.onkeydown = (e) => { if (e.key === 'Enter') commit(); };
  view.update = (next) => {
    baseUpdate(next);
    if (document.activeElement !== input) input.value = next.url === 'about:blank' ? '' : next.url;
    if (next.url !== current) { current = next.url; load(next.url); }
  };
}

// ---------- toolbar & dialogs ----------
const dlgTerm = $('#dlg-term'), dlgWs = $('#dlg-ws');
for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => b.closest('dialog').close();

$('#add-term').onclick = () => {
  const sel = $('select[name=preset]', dlgTerm);
  sel.replaceChildren(...state.summary.presets.map((p) => { const o = el('option', null, p.name + (p.command ? ` (${p.command})` : '')); o.value = p.name; return o; }));
  $('input[name=name]', dlgTerm).value = '';
  $('input[name=cwd]', dlgTerm).value = '';
  $('input[name=cwd]', dlgTerm).placeholder = state.ws?.dir || '';
  $('input[name=maestro]', dlgTerm).checked = false;
  const accounts = state.summary.accounts ?? [];
  const accSel = $('select[name=account]', dlgTerm);
  accSel.replaceChildren(el('option', null, '(none)'), ...accounts.map((a) => { const o = el('option', null, a); o.value = a; return o; }));
  accSel.firstChild.value = '';
  $('#term-account').hidden = !accounts.length;
  dlgTerm.showModal();
};
$('#form-term').onsubmit = (e) => {
  const f = new FormData(e.target);
  const props = { name: f.get('name') || undefined, maestro: f.get('maestro') === 'on' };
  if (f.get('cwd')) props.cwd = f.get('cwd');
  if (f.get('account')) props.account = f.get('account');
  const preset = f.get('preset');
  send({ t: 'node.create', workspaceId: wsId(), kind: 'terminal', preset, props: nudge(props, 640, 400) });
  const p = state.summary.presets.find((x) => x.name === preset);
  if (props.maestro && p) { /* maestro flag from the dialog wins over the preset */ }
};
$('#add-note').onclick = () => send({ t: 'node.create', workspaceId: wsId(), kind: 'note', props: nudge({}, 320, 260) });
$('#add-files').onclick = () => send({ t: 'node.create', workspaceId: wsId(), kind: 'files', props: nudge({}, 780, 520) });
$('#add-portal').onclick = () => {
  const url = prompt('URL for the portal', 'https://');
  if (url) send({ t: 'node.create', workspaceId: wsId(), kind: 'portal', props: nudge({ url }, 520, 380) });
};
/** Spawn new nodes near the middle of the view, in the first spot that overlaps nothing. */
function nudge(props, w, h) {
  const cx = Math.round((canvas.clientWidth / 2 - state.vp.x) / state.vp.z - w / 2);
  const cy = Math.round((canvas.clientHeight / 2 - state.vp.y) / state.vp.z - h / 2);
  const gap = 30;
  const nodes = (state.ws?.nodes || []).filter(isVisible);
  const free = (x, y) => !nodes.some((n) => x < n.x + n.w + gap && x + w + gap > n.x && y < n.y + n.h + gap && y + h + gap > n.y);
  // closest free spot to the centre, leaning right/down so new nodes stay in view
  const step = 40, span = 40;
  let best = null;
  for (let i = -span; i <= span; i++) {
    for (let j = -span; j <= span; j++) {
      const dx = i * step, dy = j * step;
      const cost = Math.hypot(dx, dy) + (dx < 0 ? 200 : 0) + (dy < 0 ? 200 : 0);
      if ((!best || cost < best.cost) && free(cx + dx, cy + dy)) best = { cost, x: cx + dx, y: cy + dy };
    }
  }
  if (best) return { ...props, floorId: state.floorId ?? undefined, x: best.x, y: best.y };
  return { ...props, floorId: state.floorId ?? undefined, x: cx, y: cy };
}
$('#ws-add').onclick = () => { $('input[name=name]', dlgWs).value = ''; $('input[name=dir]', dlgWs).value = ''; dlgWs.showModal(); };
$('#form-ws').onsubmit = (e) => {
  const f = new FormData(e.target);
  send({ t: 'workspace.create', name: f.get('name'), dir: f.get('dir') || undefined });
};

// ---------- toasts ----------
function toast(message, from, isErr = false) {
  const t = el('div', `toast${isErr ? ' err' : ''}`);
  if (from) t.append(el('b', null, from));
  t.append(document.createTextNode(message));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 7000);
}
function maybeSystemNotify(m) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') new Notification(m.from, { body: m.message });
  else if (Notification.permission === 'default') Notification.requestPermission();
}


// ---------- stacks, bands ----------
const snapV = (v) => (state.snap ? Math.round(v / 20) * 20 : v);
const BAND_PAD = 28;

/** Same rule as the server: a band's frame hugs its members. */
function refreshBandsLocal() {
  if (!state.ws) return;
  for (const b of state.ws.nodes.filter((n) => n.kind === 'band')) {
    const ms = state.ws.nodes.filter((n) => b.members.includes(n.id));
    if (!ms.length) continue;
    const x0 = Math.min(...ms.map((m) => m.x)), y0 = Math.min(...ms.map((m) => m.y));
    const x1 = Math.max(...ms.map((m) => m.x + m.w)), y1 = Math.max(...ms.map((m) => m.y + m.h));
    Object.assign(b, { x: x0 - BAND_PAD, y: y0 - BAND_PAD - 22, w: x1 - x0 + BAND_PAD * 2, h: y1 - y0 + BAND_PAD * 2 + 22 });
    state.views.get(b.id)?.update(b);
  }
}

function setStackNote(id) {
  state.stackNote = id;
  for (const [nid, v] of state.views) v.root.classList.toggle('linkable', !!id && v.node.kind === 'stack' && nid !== id);
  const h = $('#hint');
  h.classList.toggle('on', !!id);
  h.textContent = id ? 'Click a stack to file this note in it — Esc to cancel' : '';
}
addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.stackNote) setStackNote(null); });

function makeBandView(n) {
  const root = el('div', 'band');
  const label = el('div', 'band-label');
  const title = el('span', 'title');
  const link = el('button', 'ibtn', '⚭');
  link.title = 'Connect this band: every member gets the connection';
  const add = el('button', 'ibtn', '+');
  add.title = 'Add an agent to this band';
  const close = el('button', 'ibtn', '×');
  close.title = 'Dissolve band (agents keep running)';
  label.append(title, link, add, close);
  root.append(label);
  let node = n;
  const view = {
    root, node,
    update(next) {
      node = Object.assign(node, next);
      view.node = node;
      if (!title.firstChild || title.firstChild.nodeType === 3) title.textContent = node.name;
      root.style.left = `${node.x}px`; root.style.top = `${node.y}px`;
      root.style.width = `${node.w}px`; root.style.height = `${node.h}px`;
      root.style.setProperty('--nodecolor', cssColor(node.color) || 'var(--accent)');
    },
    destroy() { root.remove(); },
  };
  link.onclick = () => setLinkFrom(state.linkFrom === node.id ? null : node.id);
  close.onclick = () => { if (confirm(`Dissolve band "${node.name}"? Its agents keep running.`)) send({ t: 'band.dissolve', workspaceId: wsId(), id: node.id }); };
  add.onclick = () => {
    const free = state.ws.nodes.filter((x) => x.kind === 'terminal' && !state.ws.nodes.some((b) => b.kind === 'band' && b.members.includes(x.id)));
    if (!free.length) { toast('Every agent is already in a band', 'band', true); return; }
    const pick = prompt(`Add which agent?\n${free.map((x) => `- ${x.name}`).join('\n')}`);
    const t = free.find((x) => x.name.toLowerCase() === String(pick).trim().toLowerCase());
    if (t) send({ t: 'band.add', workspaceId: wsId(), id: node.id, terminalId: t.id });
  };
  title.ondblclick = () => {
    const name = prompt('Rename band', node.name);
    if (name && name.trim()) send({ t: 'node.patch', workspaceId: wsId(), id: node.id, patch: { name: name.trim() } });
  };
  label.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.stopPropagation();
    if (state.linkFrom && state.linkFrom !== node.id) { send({ t: 'conn.create', workspaceId: wsId(), from: state.linkFrom, to: node.id }); setLinkFrom(null); return; }
    const members = state.ws.nodes.filter((x) => node.members.includes(x.id));
    const start = { x: e.clientX, y: e.clientY, pos: members.map((m) => [m, m.x, m.y]) };
    let dx = 0, dy = 0;
    label.setPointerCapture(e.pointerId);
    const move = (ev) => {
      dx = Math.round((ev.clientX - start.x) / state.vp.z); dy = Math.round((ev.clientY - start.y) / state.vp.z);
      for (const [m, x, y] of start.pos) { m.x = x + dx; m.y = y + dy; state.views.get(m.id)?.update(m); }
      refreshBandsLocal(); renderLinks();
    };
    const up = () => {
      label.removeEventListener('pointermove', move); label.removeEventListener('pointerup', up);
      if (dx || dy) send({ t: 'band.move', workspaceId: wsId(), id: node.id, dx, dy });
    };
    label.addEventListener('pointermove', move);
    label.addEventListener('pointerup', up);
  });
  view.update(n);
  return view;
}

function buildStack(view, body, dot, getNode, baseUpdate) {
  dot.style.background = 'var(--warn)';
  const tabs = el('div', 'tabs');
  const ta = el('textarea', 'note-text');
  ta.spellcheck = false;
  ta.placeholder = 'Empty stack: press + to add a note';
  body.append(tabs, ta);
  let shown = null;
  let timer;
  const flush = () => { clearTimeout(timer); if (shown) send({ t: 'note.write', workspaceId: wsId(), id: shown, text: ta.value }); };
  const render = () => {
    const n = getNode();
    tabs.replaceChildren();
    for (const id of n.order) {
      const note = state.ws.nodes.find((x) => x.id === id);
      if (!note) continue;
      const tab = el('span', `tab${id === n.front ? ' on' : ''}`);
      const label = el('button', 'tab-label', note.name);
      label.title = 'Click to open, double-click to rename';
      label.onclick = () => { flush(); send({ t: 'stack.front', workspaceId: wsId(), id: n.id, noteId: id }); };
      label.ondblclick = () => { const name = prompt('Rename note', note.name); if (name && name.trim()) send({ t: 'node.patch', workspaceId: wsId(), id, patch: { name: name.trim() } }); };
      const out = el('button', 'tabx', '↗');
      out.title = 'Take this note out of the stack';
      out.onclick = () => { flush(); send({ t: 'note.unstack', workspaceId: wsId(), noteId: id }); };
      tab.append(label, out);
      tabs.append(tab);
    }
    const plus = el('button', 'tab add', '+');
    plus.title = 'New note in this stack';
    plus.onclick = () => send({ t: 'stack.addNote', workspaceId: wsId(), stackId: n.id });
    tabs.append(plus);
    ta.disabled = !n.front;
    if (shown !== n.front) { flush(); shown = n.front; ta.value = n.front ? (state.ws.notes.get(n.front) ?? '') : ''; }
  };
  ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(flush, 300); });
  ta.addEventListener('blur', flush);
  view.setNote = (text, id) => { if (id === shown && document.activeElement !== ta && ta.value !== text) ta.value = text; };
  view.update = (next) => { baseUpdate(next); render(); };
  view.cleanup = () => clearTimeout(timer);
}

// ---------- undo, redo, tidy, snap ----------
function syncHistoryButtons() {
  $('#undo').disabled = !state.ws?.history?.canUndo;
  $('#redo').disabled = !state.ws?.history?.canRedo;
  $('#snap').classList.toggle('on', state.snap);
}
$('#undo').onclick = () => send({ t: 'undo', workspaceId: wsId() });
$('#redo').onclick = () => send({ t: 'redo', workspaceId: wsId() });
$('#tidy').onclick = () => { send({ t: 'tidy', workspaceId: wsId(), floorId: state.floorId }); setTimeout(() => $('#fit').click(), 250); };
$('#snap').onclick = () => { state.snap = !state.snap; try { localStorage.setItem('om.snap', state.snap ? '1' : '0'); } catch { /* storage unavailable */ } syncHistoryButtons(); toast(state.snap ? 'Snap to grid on' : 'Snap to grid off', 'canvas'); };
addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select, .xterm');
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (typing || !(e.ctrlKey || e.metaKey)) return;
  if (e.key.toLowerCase() === 'z') { e.preventDefault(); send({ t: e.shiftKey ? 'redo' : 'undo', workspaceId: wsId() }); }
  else if (e.key.toLowerCase() === 'y') { e.preventDefault(); send({ t: 'redo', workspaceId: wsId() }); }
});

// ---------- bands and stacks from the toolbar ----------
$('#add-stack').onclick = () => send({ t: 'node.create', workspaceId: wsId(), kind: 'stack', props: nudge({ name: 'Stack' }, 360, 300) });
const dlgBand = $('#dlg-band');
$('#add-band').onclick = () => {
  const free = state.ws.nodes.filter((x) => x.kind === 'terminal' && !state.ws.nodes.some((b) => b.kind === 'band' && b.members.includes(x.id)));
  if (!free.length) { toast('There are no agents free to group', 'band', true); return; }
  const list = $('#band-members');
  list.replaceChildren(...free.map((x) => { const l = el('label', 'chk'); const c = el('input'); c.type = 'checkbox'; c.value = x.id; l.append(c, document.createTextNode(` ${x.name}`)); return l; }));
  $('input[name=name]', dlgBand).value = '';
  dlgBand.showModal();
};
$('#form-band').onsubmit = (e) => {
  const f = new FormData(e.target);
  const members = [...$('#band-members').querySelectorAll('input:checked')].map((c) => c.value);
  if (!members.length) { e.preventDefault(); toast('Pick at least one agent', 'band', true); return; }
  send({ t: 'band.create', workspaceId: wsId(), name: f.get('name') || 'Band', members });
};

// ---------- export / import ----------
const fileInput = $('#import-file');
$('#ws-import').onclick = () => fileInput.click();
fileInput.onchange = async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { toast('That file is too large to be a workspace', 'import', true); return; }
  let bundle;
  try { bundle = JSON.parse(await file.text()); } catch { toast('That is not valid JSON', 'import', true); return; }
  const cmds = (Array.isArray(bundle?.nodes) ? bundle.nodes : []).filter((n) => n?.kind === 'terminal' && n.command);
  const msg = `Import "${String(bundle?.workspace?.name ?? file.name).slice(0, 60)}"?\n\n${Array.isArray(bundle?.nodes) ? bundle.nodes.length : 0} nodes.` + (cmds.length ? `\n\n${cmds.length} terminal(s) carry a startup command. They will NOT run until you trust each one.` : '');
  if (confirm(msg)) send({ t: 'workspace.import', bundle, dir: state.ws?.dir });
};

// ---------- layouts (partituras) ----------
function saveLayout() {
  const name = prompt('Name for this layout (saves everything on this canvas, with wiring)');
  if (name && name.trim()) send({ t: 'partitura.save', workspaceId: wsId(), name: name.trim() });
}
$('#layouts').onclick = () => openPalette('layout');

// ---------- command palette ----------
const dlgPal = $('#palette');
const palInput = $('#pal-input');
const palList = $('#pal-list');
let palItems = [];
let palSel = 0;

function fuzzy(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase(), t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return 1000 - at;
  let qi = 0, score = 0, last = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) { score += i === last + 1 ? 8 : 2; last = i; qi++; }
  }
  return qi === q.length ? score : 0;
}

function focusNode(n) {
  if (nodeFloor(n) !== state.floorId) setFloor(nodeFloor(n));
  const z = state.vp.z;
  state.vp.x = canvas.clientWidth / 2 - (n.x + n.w / 2) * z;
  state.vp.y = canvas.clientHeight / 2 - (n.y + n.h / 2) * z;
  applyViewport(); saveViewport(); select(n.id);
}

function buildPaletteItems() {
  const items = [];
  const add = (label, hint, run) => items.push({ label, hint, run });
  add('New terminal', 'canvas', () => $('#add-term').click());
  add('New note', 'canvas', () => $('#add-note').click());
  add('New portal', 'canvas', () => $('#add-portal').click());
  add('Workspace: set icon and group', 'workspace', () => {
    if (!state.ws) return;
    const cur = state.summary.workspaces.find((w) => w.id === state.ws.id);
    const icon = prompt('Icon (a letter or emoji, empty to clear)', cur?.icon ?? '');
    if (icon === null) return;
    const group = prompt('Group in the sidebar (empty for none)', cur?.group ?? '');
    if (group === null) return;
    send({ t: 'workspace.set', id: state.ws.id, icon, group });
  });
  for (const w of state.summary.workspaces) if (w.id !== wsId() && w.running) add(`Workspace: stop everything running in ${w.name}`, 'workspace', () => send({ t: 'workspace.unload', id: w.id }));
  add('Duplicate this workspace', 'workspace', () => state.ws && send({ t: 'workspace.create', name: `${state.ws.name} copy`, dir: state.ws.dir, from: state.ws.id }));
  add('New stack', 'canvas', () => $('#add-stack').click());
  add('New band (group agents)', 'canvas', () => $('#add-band').click());
  add('Undo', 'edit', () => $('#undo').click());
  add('Redo', 'edit', () => $('#redo').click());
  add('Tidy: auto-arrange the canvas', 'layout', () => $('#tidy').click());
  add('Fit everything in view', 'view', () => $('#fit').click());
  add('New floor', 'floor', () => openFloorDialog());
  add('Floor status: set a message', 'floor', () => { const text = prompt('What is happening on this floor?'); if (text !== null) send({ t: 'floor.status', workspaceId: wsId(), floorId: state.floorId, text, state: 'working' }); });
  for (const f of [{ id: null, name: 'Ground' }, ...(state.ws?.floors ?? [])]) if (f.id !== state.floorId) add(`Go to floor: ${f.name}`, 'floor', () => setFloor(f.id));
  for (const f of state.ws?.floors ?? []) {
    add(`Land floor: ${f.name}`, 'floor · merge into the project', () => { if (confirm(`Merge floor "${f.name}" into the project's current branch and remove the floor?`)) send({ t: 'floor.land', workspaceId: wsId(), name: f.name }); });
    add(`Delete floor: ${f.name}`, 'floor', () => { if (confirm(`Delete floor "${f.name}", its canvas and its checkout?`)) send({ t: 'floor.delete', workspaceId: wsId(), name: f.name }); });
  }
  add(`Snap to grid: ${state.snap ? 'turn off' : 'turn on'}`, 'view', () => $('#snap').click());
  add('Save this canvas as a layout', 'layout', saveLayout);
  add('Export this workspace to a file', 'workspace', () => { location.href = `/export/${wsId()}.json`; });
  add('Import a workspace from a file', 'workspace', () => $('#ws-import').click());
  add('New workspace', 'workspace', () => $('#ws-add').click());
  for (const w of state.summary.workspaces) if (w.id !== wsId()) add(`Switch to workspace: ${w.name}`, 'workspace', () => send({ t: 'workspace.select', id: w.id }));
  for (const p of state.summary.partituras ?? []) {
    if (p.scope !== null && p.scope !== wsId()) continue;
    add(`Insert layout: ${p.name}`, `layout · ${p.nodes} items`, () => send({ t: 'partitura.insert', workspaceId: wsId(), id: p.id, floorId: state.floorId }));
    add(`Delete layout: ${p.name}`, 'layout', () => { if (confirm(`Delete layout "${p.name}"?`)) send({ t: 'partitura.delete', id: p.id }); });
  }
  for (const n of state.ws?.nodes ?? []) {
    if (n.kind === 'band' || n.stackId) continue;
    add(`Go to: ${n.name}`, nodeFloor(n) === null ? n.kind : `${n.kind} · ${state.ws.floors.find((f) => f.id === n.floorId)?.name ?? 'floor'}`, () => focusNode(n));
  }
  for (const b of (state.ws?.nodes ?? []).filter((x) => x.kind === 'band')) {
    for (const mid of b.members) {
      const m = state.ws.nodes.find((x) => x.id === mid);
      if (m) add(`Remove ${m.name} from band ${b.name}`, 'band', () => send({ t: 'band.remove', workspaceId: wsId(), id: b.id, terminalId: mid }));
    }
  }
  return items;
}

function renderPalette() {
  const q = palInput.value.trim();
  const ranked = palItems.map((i) => ({ i, s: fuzzy(q, i.label) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 12);
  palList.replaceChildren();
  palSel = Math.min(palSel, Math.max(0, ranked.length - 1));
  ranked.forEach(({ i }, idx) => {
    const li = el('li', idx === palSel ? 'on' : '');
    li.append(el('span', 'pl', i.label), el('span', 'ph', i.hint));
    li.onclick = () => { dlgPal.close(); i.run(); };
    li.onmousemove = () => { if (palSel !== idx) { palSel = idx; renderPalette(); } };
    palList.append(li);
  });
  palList.dataset.count = String(ranked.length);
  palList._ranked = ranked;
}
function openPalette(prefill = '') {
  if (!state.ws) return;
  palItems = buildPaletteItems();
  palInput.value = prefill;
  palSel = 0;
  renderPalette();
  if (!dlgPal.open) dlgPal.showModal();
  palInput.focus();
}
palInput.addEventListener('input', () => { palSel = 0; renderPalette(); });
palInput.addEventListener('keydown', (e) => {
  const n = palList._ranked?.length ?? 0;
  if (e.key === 'ArrowDown') { e.preventDefault(); palSel = (palSel + 1) % Math.max(1, n); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = (palSel - 1 + n) % Math.max(1, n); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); const pick = palList._ranked?.[palSel]; if (pick) { dlgPal.close(); pick.i.run(); } }
});
$('#palette-btn').onclick = () => openPalette();

// ---------- floor dialog ----------
const dlgFloor = $('#dlg-floor');
function openFloorDialog() {
  $('input[name=name]', dlgFloor).value = '';
  $('input[name=branch]', dlgFloor).value = '';
  $('input[name=dir]', dlgFloor).value = '';
  $('select[name=mode]', dlgFloor).value = 'worktree';
  $('input[name=copyGround]', dlgFloor).checked = false;
  syncFloorMode();
  dlgFloor.showModal();
}
function syncFloorMode() {
  const mode = $('select[name=mode]', dlgFloor).value;
  $('#floor-branch', dlgFloor).hidden = !(mode === 'worktree' || mode === 'copy');
  $('#floor-dir', dlgFloor).hidden = mode !== 'dir';
}
$('select[name=mode]', dlgFloor).onchange = syncFloorMode;
$('#form-floor').onsubmit = (e) => {
  const f = new FormData(e.target);
  const mode = f.get('mode');
  const name = String(f.get('name') || '').trim();
  if (!name) { e.preventDefault(); toast('A floor needs a name', 'floor', true); return; }
  send({ t: 'floor.create', workspaceId: wsId(), name, mode, branch: f.get('branch') || undefined, dir: mode === 'dir' ? f.get('dir') : undefined, copyGround: f.get('copyGround') === 'on' });
};
$('#floor-status').onclick = () => { const text = prompt('What is happening on this floor? (empty clears it)'); if (text !== null) send({ t: 'floor.status', workspaceId: wsId(), floorId: state.floorId, text, state: 'working' }); };

// ---------- chat ----------
const chatUi = createChat({ state, send, wsId, toast, $, el });
function markAttention() {
  const att = new Set(state.ws?.chat?.attention ?? []);
  for (const [id, v] of state.views) v.root.classList.toggle('attn', att.has(id));
}
window.addEventListener('om-chat-state', markAttention);

// test hook (read-only view of state)
window.__om = { state };
connect();
