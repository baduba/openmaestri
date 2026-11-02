// The Files node: a tree of the workspace (or floor) folder and a plain text editor beside it.
// Everything that comes from a file or a file name goes in through textContent / createElement,
// never innerHTML: this page can drive shells, and a file is untrusted text.

import { renderMarkdown } from './markdown.js';
import { highlightInto, languageOf } from './highlight.js';
export { renderMarkdown };

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/**
 * @param view     the node view (gets .filesResult and .cleanup)
 * @param body     the node body element
 * @param ctx      { send(msg), nodeId(), wsId(), confirm(text) }
 */
/** Why a file is shown empty and read-only, or ''. */
function unreadableNote(r) {
  if (r.binary) return 'Binary file: not shown.';
  if (r.tooLarge) return 'Over 1 MB: not opened here.';
  return '';
}

export function buildFiles(view, body, dot, ctx) {
  dot.style.background = 'var(--accent)';
  const pane = el('div', 'files');
  const left = el('div', 'fleft');
  const search = el('input', 'fsearch');
  search.placeholder = 'Search in files…';
  search.setAttribute('aria-label', 'Search in files');
  search.autocomplete = 'off';
  const results = el('div', 'fresults');
  results.hidden = true;
  const tree = el('div', 'ftree');
  tree.setAttribute('role', 'tree');
  left.append(search, results, tree);
  const side = el('div', 'fmain');
  const tabs = el('div', 'ftabs');
  const bar = el('div', 'fbar');
  const pathEl = el('span', 'fpath', 'Pick a file');
  const dirtyEl = el('span', 'fdirty', '');
  const saveBtn = el('button', null, 'Save');
  const prevBtn = el('button', null, 'Preview');
  const verSel = el('select');
  verSel.title = 'Earlier versions';
  verSel.setAttribute('aria-label', 'Earlier versions');
  const newBtn = el('button', null, '+');
  newBtn.title = 'New file in the open folder';
  const dirBtn = el('button', null, '▸+');
  dirBtn.title = 'New folder in the open folder';
  const refBtn = el('button', null, '↻');
  refBtn.title = 'Refresh';
  bar.append(newBtn, dirBtn, refBtn, pathEl, dirtyEl, verSel, prevBtn, saveBtn);
  const wrap = el('div', 'fedwrap');
  const hl = el('pre', 'fhl');
  hl.setAttribute('aria-hidden', 'true');
  const ta = el('textarea', 'feditor');
  ta.spellcheck = false;
  ta.disabled = true;
  wrap.append(hl, ta);
  const preview = el('div', 'fpreview');
  preview.hidden = true;
  const msg = el('div', 'fmsg');
  side.append(tabs, bar, msg, wrap, preview);
  pane.append(left, side);
  body.append(pane);

  // open files: each tab keeps its own text, so switching never loses an edit
  const open = new Map();
  const st = { current: null, git: {}, cwd: '' };
  const pending = new Map();
  let seq = 0;
  const ask = (op, extra = {}) => new Promise((resolve) => {
    const reqId = `${Date.now()}-${++seq}`;
    pending.set(reqId, resolve);
    setTimeout(() => { if (pending.delete(reqId)) resolve(null); }, 15000);
    ctx.send({ t: 'files.op', workspaceId: ctx.wsId(), id: ctx.nodeId(), op, reqId, ...extra });
  });
  view.filesResult = (m) => { const r = pending.get(m.reqId); if (r) { pending.delete(m.reqId); r(m); } };

  const say = (text) => { msg.textContent = text || ''; };
  const join = (a, b) => (a ? `${a}/${b}` : b);
  const cur = () => (st.current ? open.get(st.current) : null);
  const colour = () => { const f = cur(); highlightInto(hl, f ? `${ta.value}\n` : '', f ? f.lang : null); };

  function paintChrome() {
    const f = cur();
    pathEl.textContent = f ? f.path : 'Pick a file';
    dirtyEl.textContent = f?.dirty ? '●' : '';
    dirtyEl.title = f?.dirty ? 'Unsaved changes' : '';
    saveBtn.disabled = !f?.dirty;
    prevBtn.hidden = !(f && /\.(md|markdown)$/i.test(f.path));
    tabs.replaceChildren();
    for (const f2 of open.values()) {
      const tab = el('button', `ftab${f2.path === st.current ? ' on' : ''}`);
      tab.append(el('span', null, `${f2.path.split('/').pop()}${f2.dirty ? ' ●' : ''}`));
      tab.title = f2.path;
      tab.onclick = () => switchTo(f2.path);
      const x = el('span', 'ftab-x', '×');
      x.title = 'Close';
      x.onclick = (e) => { e.stopPropagation(); closeTab(f2.path); };
      tab.append(x);
      tabs.append(tab);
    }
    tabs.hidden = open.size === 0;
  }

  function show() {
    const f = cur();
    preview.hidden = true;
    wrap.hidden = false;
    if (!f) { ta.value = ''; ta.disabled = true; colour(); paintChrome(); verSel.replaceChildren(); return; }
    ta.disabled = f.readonly;
    ta.value = f.text;
    ta.scrollTop = f.scroll ?? 0;
    say(f.note ?? '');
    colour();
    paintChrome();
    void loadVersions();
  }

  function remember() { const f = cur(); if (f && !f.readonly) { f.text = ta.value; f.scroll = ta.scrollTop; } }
  function switchTo(p) { remember(); st.current = p; show(); }
  function closeTab(p) {
    const f = open.get(p);
    if (f?.dirty && !ctx.confirm(`Discard unsaved changes in ${p}?`)) return;
    open.delete(p);
    if (st.current === p) st.current = [...open.keys()].at(-1) ?? null;
    show();
  }

  async function loadDir(rel, ul) {
    const r = await ask('list', { path: rel });
    if (!r) return;
    ul.replaceChildren();
    for (const e of r.entries) {
      const p = join(rel, e.name);
      const li = el('div', 'fitem');
      li.setAttribute('role', 'treeitem');
      const mark = st.git[p];
      const label = el('button', `fname ${e.type}${mark ? ` git-${mark === '?' ? 'u' : mark}` : ''}`, (e.type === 'dir' ? '▸ ' : '') + e.name);
      label.title = mark ? `${p} (${mark === '?' ? 'new' : mark === 'M' ? 'modified' : 'deleted'})` : p;
      const kids = el('div', 'fkids');
      kids.hidden = true;
      label.onclick = async () => {
        if (e.type === 'dir') {
          st.cwd = p;
          kids.hidden = !kids.hidden;
          label.firstChild.textContent = (kids.hidden ? '▸ ' : '▾ ') + e.name;
          if (!kids.hidden) await loadDir(p, kids);
        } else await openFile(p);
      };
      const ren = el('button', 'fact', '✎'); ren.title = 'Rename or move';
      ren.onclick = async () => {
        const to = prompt('New path (relative to this folder)', p);
        if (!to || to === p) return;
        const x = await ask('rename', { path: p, to });
        if (x) {
          const f = open.get(p);
          if (f) { open.delete(p); f.path = to; f.lang = languageOf(to); open.set(to, f); if (st.current === p) st.current = to; }
          await refresh();
          paintChrome();
        }
      };
      const del = el('button', 'fact', '×'); del.title = 'Delete (moves to a trash, can be recovered)';
      del.onclick = async () => {
        if (!ctx.confirm(`Delete "${p}"? It moves to a trash, it is not erased.`)) return;
        const x = await ask('remove', { path: p });
        if (!x) return;
        open.delete(p);
        if (st.current === p) st.current = [...open.keys()].at(-1) ?? null;
        await refresh();
        show();
      };
      li.append(label, ren, del, kids);
      ul.append(li);
    }
    if (r.truncated) ul.append(el('div', 'fmsg', 'Only the first entries are shown.'));
  }

  async function refresh() {
    const s = await ask('status');
    st.git = s?.status ?? {};
    await loadDir('', tree);
  }

  async function openFile(p, line) {
    if (open.has(p)) {
      switchTo(p);
      if (line) jumpTo(line);
      return;
    }
    const r = await ask('read', { path: p });
    if (!r) return;
    remember();
    const file = { path: p, text: r.text ?? '', mtime: r.mtimeMs, dirty: false, lang: languageOf(p), readonly: !!(r.binary || r.tooLarge), note: unreadableNote(r) };
    open.set(p, file);
    st.current = p;
    show();
    if (line) jumpTo(line);
  }

  function jumpTo(line) {
    const lines = ta.value.split('\n');
    const offset = lines.slice(0, Math.max(0, line - 1)).join('\n').length + (line > 1 ? 1 : 0);
    ta.focus();
    ta.setSelectionRange(offset, offset + (lines[line - 1]?.length ?? 0));
    ta.scrollTop = Math.max(0, (line - 4) * 18);
    hl.scrollTop = ta.scrollTop;
  }

  async function loadVersions() {
    verSel.replaceChildren();
    verSel.append(new Option('Versions', ''));
    const f = cur();
    if (!f || f.readonly) return;
    const r = await ask('versions', { path: f.path });
    for (const v of r?.versions ?? []) verSel.append(new Option(new Date(v.at).toLocaleString(), v.id));
  }

  async function save() {
    const f = cur();
    if (!f || !f.dirty) return;
    f.text = ta.value;
    const r = await ask('write', { path: f.path, text: f.text, expectedMtime: f.mtime });
    if (!r) return;
    f.mtime = r.mtimeMs; f.dirty = false;
    say('Saved.');
    paintChrome();
    await loadVersions();
    const s = await ask('status'); st.git = s?.status ?? {};
  }

  ta.addEventListener('input', () => { const f = cur(); if (f) { f.dirty = true; paintChrome(); colour(); } });
  ta.addEventListener('scroll', () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
  });
  saveBtn.onclick = () => void save();
  prevBtn.onclick = () => {
    preview.hidden = !preview.hidden; wrap.hidden = !preview.hidden;
    if (!preview.hidden) renderMarkdown(ta.value, preview);
  };
  verSel.onchange = async () => {
    const f = cur();
    if (!verSel.value || !f) return;
    const r = await ask('version', { path: f.path, version: verSel.value });
    verSel.value = '';
    if (r && ctx.confirm('Replace the editor text with this version? Save to keep it.')) { ta.value = r.text; f.dirty = true; f.text = r.text; paintChrome(); colour(); }
  };
  const make = (kind) => async () => {
    const name = prompt(kind === 'dir' ? 'Folder name' : 'File name', '');
    if (!name) return;
    const p = join(st.cwd, name);
    const r = await ask('create', { path: p, kind });
    if (r) { await refresh(); if (kind === 'file') await openFile(p); }
  };
  newBtn.onclick = make('file');
  dirBtn.onclick = make('dir');
  refBtn.onclick = () => void refresh();

  // search in files
  let searchTimer;
  search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { search.value = ''; results.hidden = true; tree.hidden = false; } });
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = search.value.trim();
    if (q.length < 2) { results.hidden = true; tree.hidden = false; return; }
    searchTimer = setTimeout(async () => {
      const r = await ask('search', { query: q });
      if (!r || search.value.trim() !== q) return;
      results.replaceChildren();
      tree.hidden = true;
      results.hidden = false;
      if (!r.results.length) results.append(el('div', 'fmsg', 'Nothing found.'));
      for (const hit of r.results) {
        const row = el('button', 'fhit');
        row.append(el('b', null, `${hit.path}:${hit.line}`), el('span', null, ` ${hit.text}`));
        row.onclick = () => void openFile(hit.path, hit.line);
        results.append(row);
      }
      if (r.truncated) results.append(el('div', 'fmsg', 'More matches exist; narrow the search.'));
    }, 250);
  });

  paintChrome();
  void refresh();
  view.cleanup = () => { pending.clear(); clearTimeout(searchTimer); };
}
