import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';

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
};

// ---------- socket ----------
let socket;
let retry = 500;
const pendingTerm = new Map(); // id -> {snapshot, out[]} until the view exists

function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onopen = () => { retry = 500; setConn(true); for (const v of state.views.values()) v.attach?.(); };
  socket.onclose = () => { setConn(false); setTimeout(connect, retry = Math.min(retry * 2, 8000)); };
  socket.onmessage = (ev) => onMessage(JSON.parse(ev.data));
}
const send = (m) => socket?.readyState === 1 && socket.send(JSON.stringify(m));
const wsId = () => state.ws?.id;
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
      state.ws.notes[m.id] = m.text;
      state.views.get(m.id)?.setNote?.(m.text);
      break;
    }
    case 'term.snapshot': state.views.get(m.id)?.snapshot?.(m.data); break;
    case 'term.out': state.views.get(m.id)?.write?.(m.data); break;
    case 'term.status': {
      if (state.ws && m.status) state.ws.status[m.id] = m.status;
      state.views.get(m.id)?.setStatus?.(m.status);
      break;
    }
    case 'notify': toast(m.message, m.from); maybeSystemNotify(m); break;
    case 'error': toast(m.message, 'error', true); break;
  }
}

// ---------- workspace ----------
function applyWorkspace(ws, switching) {
  state.ws = ws;
  if (switching) {
    for (const v of state.views.values()) v.destroy();
    state.views.clear();
    state.vp = { ...ws.viewport };
    state.selected = null;
    state.linkFrom = null;
    applyViewport();
  }
  const seen = new Set();
  for (const n of ws.nodes) {
    seen.add(n.id);
    let v = state.views.get(n.id);
    if (!v) { v = makeView(n); state.views.set(n.id, v); $('#world').append(v.root); }
    v.update(n);
  }
  for (const [id, v] of [...state.views]) if (!seen.has(id)) { v.destroy(); state.views.delete(id); }
  renderLinks();
  renderSidebar();
  const fs = $('#floor-status');
  if (ws.floorStatus) { fs.textContent = `${ws.floorStatus.state}${ws.floorStatus.progress ? ` ${ws.floorStatus.progress}` : ''}: ${ws.floorStatus.text}`; fs.title = `by ${ws.floorStatus.by}`; fs.classList.add('on'); }
  else fs.classList.remove('on');
}

function renderSidebar() {
  const ul = $('#ws-list');
  ul.replaceChildren();
  for (const w of state.summary.workspaces) {
    const li = el('li', w.id === (state.ws?.id) ? 'active' : '');
    li.append(el('span', 'name', w.name), el('span', 'count', String(w.nodes)));
    const x = el('button', 'x', '×');
    x.title = 'Delete workspace';
    x.onclick = (e) => { e.stopPropagation(); if (confirm(`Delete workspace "${w.name}" and everything in it?`)) send({ t: 'workspace.delete', id: w.id }); };
    li.append(x);
    li.title = w.dir;
    li.onclick = () => send({ t: 'workspace.select', id: w.id });
    li.ondblclick = () => { const name = prompt('Rename workspace', w.name); if (name) send({ t: 'workspace.rename', id: w.id, name }); };
    ul.append(li);
  }
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
  const inScrollable = e.target.closest('.term, textarea, iframe');
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
  if (e.target.closest('.node, #toolbar')) return;
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
  const ns = state.ws?.nodes || [];
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
    if (!a || !b) continue;
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
  head.append(dot, title, kind, link, close);
  const body = el('div', 'body');
  const rz = el('div', 'resize');
  root.append(head, body, rz);

  const view = { root, node: n, destroy() { root.remove(); }, update() {} };
  let node = n;

  const patch = (p, local = true) => {
    if (local) Object.assign(node, p);
    send({ t: 'node.patch', workspaceId: wsId(), id: node.id, patch: p });
  };
  const layout = () => {
    root.style.left = `${node.x}px`; root.style.top = `${node.y}px`;
    root.style.width = `${node.w}px`; root.style.height = `${node.h}px`;
    root.style.setProperty('--nodecolor', cssColor(node.color));
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
      node.x = Math.round(s.nx + (ev.clientX - s.x) / state.vp.z); node.y = Math.round(s.ny + (ev.clientY - s.y) / state.vp.z);
      layout(); renderLinks();
      if (Date.now() - last > 100) { last = Date.now(); patch({ x: node.x, y: node.y }, false); }
    };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); patch({ x: node.x, y: node.y }, false); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
  // clicking the body while linking, or to select
  root.addEventListener('pointerdown', (e) => {
    if (state.linkFrom && state.linkFrom !== node.id) { e.preventDefault(); e.stopPropagation(); send({ t: 'conn.create', workspaceId: wsId(), from: state.linkFrom, to: node.id }); setLinkFrom(null); return; }
    select(node.id);
  }, true);
  // resize
  rz.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    const s = { x: e.clientX, y: e.clientY, w: node.w, h: node.h };
    rz.setPointerCapture(e.pointerId);
    const move = (ev) => {
      node.w = Math.max(200, Math.round(s.w + (ev.clientX - s.x) / state.vp.z)); node.h = Math.max(120, Math.round(s.h + (ev.clientY - s.y) / state.vp.z));
      layout(); renderLinks(); view.resized?.();
    };
    const up = () => { rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); patch({ w: node.w, h: node.h }, false); };
    rz.addEventListener('pointermove', move);
    rz.addEventListener('pointerup', up);
  });
  link.onclick = () => setLinkFrom(state.linkFrom === node.id ? null : node.id);
  close.onclick = () => {
    if (node.kind === 'terminal' && !confirm(`Stop and remove "${node.name}"?`)) return;
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
  view.update = (next) => {
    baseUpdate(next);
    view.setStatus(state.ws.status[next.id] || 'idle');
  };
  // first update must run before attach so getNode().id is set
  view.attach();
}

function buildNote(view, body, dot, getNode, baseUpdate, patch) {
  dot.style.background = 'var(--accent)';
  const ta = el('textarea', 'note-text');
  ta.spellcheck = false;
  ta.placeholder = 'Markdown note…';
  body.append(ta);
  let timer;
  ta.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => send({ t: 'note.write', workspaceId: wsId(), id: getNode().id, text: ta.value }), 300);
  });
  ta.addEventListener('blur', () => { clearTimeout(timer); send({ t: 'note.write', workspaceId: wsId(), id: getNode().id, text: ta.value }); });
  view.setNote = (text) => { if (document.activeElement !== ta && ta.value !== text) ta.value = text; };
  view.update = (next) => { baseUpdate(next); view.setNote(state.ws.notes[next.id] ?? ''); };
  view.cleanup = () => clearTimeout(timer);
  void patch;
}

function buildPortal(view, body, dot, getNode, baseUpdate, patch) {
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
  dlgTerm.showModal();
};
$('#form-term').onsubmit = (e) => {
  const f = new FormData(e.target);
  const props = { name: f.get('name') || undefined, maestro: f.get('maestro') === 'on' };
  if (f.get('cwd')) props.cwd = f.get('cwd');
  const preset = f.get('preset');
  send({ t: 'node.create', workspaceId: wsId(), kind: 'terminal', preset, props: nudge(props, 640, 400) });
  const p = state.summary.presets.find((x) => x.name === preset);
  if (props.maestro && p) { /* maestro flag from the dialog wins over the preset */ }
};
$('#add-note').onclick = () => send({ t: 'node.create', workspaceId: wsId(), kind: 'note', props: nudge({}, 320, 260) });
$('#add-portal').onclick = () => {
  const url = prompt('URL for the portal', 'https://');
  if (url) send({ t: 'node.create', workspaceId: wsId(), kind: 'portal', props: nudge({ url }, 520, 380) });
};
/** Spawn new nodes near the middle of the view, in the first spot that overlaps nothing. */
function nudge(props, w, h) {
  const cx = Math.round((canvas.clientWidth / 2 - state.vp.x) / state.vp.z - w / 2);
  const cy = Math.round((canvas.clientHeight / 2 - state.vp.y) / state.vp.z - h / 2);
  const gap = 30;
  const nodes = state.ws?.nodes || [];
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
  if (best) return { ...props, x: best.x, y: best.y };
  return { ...props, x: cx, y: cy };
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

// test hook (read-only view of state)
window.__om = { state };
connect();
