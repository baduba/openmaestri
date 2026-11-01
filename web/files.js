// The Files node: a tree of the workspace (or floor) folder and a plain text editor beside it.
// Everything that comes from a file or a file name goes in through textContent / createElement,
// never innerHTML: this page can drive shells, and a file is untrusted text.

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** Markdown to DOM, a small safe subset: headings, lists, quotes, fenced code, bold, italic, code, http(s) links. */
export function renderMarkdown(src, into) {
  into.replaceChildren();
  const inline = (parent, text) => {
    const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('`')) parent.append(el('code', null, t.slice(1, -1)));
      else if (t.startsWith('**')) parent.append(el('strong', null, t.slice(2, -2)));
      else if (t.startsWith('*')) parent.append(el('em', null, t.slice(1, -1)));
      else {
        const close = t.indexOf('](');
        const a = el('a', null, t.slice(1, close));
        a.href = t.slice(close + 2, -1);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        parent.append(a);
      }
      last = m.index + t.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  };
  const lines = String(src).split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code = [];
      for (i += 1; i < lines.length && !lines[i].startsWith('```'); i += 1) code.push(lines[i]);
      i += 1;
      const pre = el('pre'); pre.append(el('code', null, code.join('\n'))); into.append(pre);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { const e = el(`h${h[1].length}`); inline(e, h[2]); into.append(e); i += 1; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const ul = el('ul');
      for (; i < lines.length && /^\s*[-*]\s+/.test(lines[i]); i += 1) { const li = el('li'); inline(li, lines[i].replace(/^\s*[-*]\s+/, '')); ul.append(li); }
      into.append(ul);
      continue;
    }
    if (line.startsWith('>')) { const q = el('blockquote'); inline(q, line.replace(/^>\s?/, '')); into.append(q); i += 1; continue; }
    if (!line.trim()) { i += 1; continue; }
    const p = el('p');
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*[-*]\s)/.test(lines[i]); i += 1) para.push(lines[i]);
    if (!para.length) { para.push(line); i += 1; }
    inline(p, para.join(' '));
    into.append(p);
  }
}

/**
 * @param view     the node view (gets .filesResult and .cleanup)
 * @param body     the node body element
 * @param ctx      { send(msg), nodeId(), wsId(), confirm(text) }
 */
export function buildFiles(view, body, dot, ctx) {
  dot.style.background = 'var(--accent)';
  const pane = el('div', 'files');
  const tree = el('div', 'ftree');
  tree.setAttribute('role', 'tree');
  const side = el('div', 'fmain');
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
  const ta = el('textarea', 'feditor');
  ta.spellcheck = false;
  ta.disabled = true;
  const preview = el('div', 'fpreview');
  preview.hidden = true;
  const msg = el('div', 'fmsg');
  side.append(bar, msg, ta, preview);
  pane.append(tree, side);
  body.append(pane);

  const st = { open: null, mtime: 0, dirty: false, git: {}, dirs: new Map(), cwd: '' };
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
  const setDirty = (d) => { st.dirty = d; dirtyEl.textContent = d ? '●' : ''; dirtyEl.title = d ? 'Unsaved changes' : ''; saveBtn.disabled = !d; };
  setDirty(false);
  const join = (a, b) => (a ? `${a}/${b}` : b);

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
        if (x) { if (st.open === p) { st.open = to; pathEl.textContent = to; } await refresh(); }
      };
      const del = el('button', 'fact', '×'); del.title = 'Delete (moves to a trash, can be recovered)';
      del.onclick = async () => {
        if (!ctx.confirm(`Delete "${p}"? It moves to a trash, it is not erased.`)) return;
        const x = await ask('remove', { path: p });
        if (x) { if (st.open === p) closeFile(); await refresh(); }
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

  function closeFile() {
    st.open = null; ta.value = ''; ta.disabled = true; pathEl.textContent = 'Pick a file'; setDirty(false);
    verSel.replaceChildren(); preview.hidden = true; ta.hidden = false;
  }

  async function openFile(p) {
    if (st.dirty && !ctx.confirm('Discard unsaved changes?')) return;
    const r = await ask('read', { path: p });
    if (!r) return;
    st.open = p; st.mtime = r.mtimeMs;
    pathEl.textContent = p;
    if (r.binary || r.tooLarge) {
      ta.value = ''; ta.disabled = true; setDirty(false);
      say(r.binary ? 'Binary file: not shown.' : 'Over 1 MB: not opened here.');
      return;
    }
    say('');
    ta.disabled = false; ta.value = r.text; setDirty(false);
    prevBtn.hidden = !/\.(md|markdown)$/i.test(p);
    preview.hidden = true; ta.hidden = false;
    await loadVersions();
  }

  async function loadVersions() {
    verSel.replaceChildren();
    verSel.append(new Option('Versions', ''));
    if (!st.open) return;
    const r = await ask('versions', { path: st.open });
    for (const v of r?.versions ?? []) verSel.append(new Option(new Date(v.at).toLocaleString(), v.id));
  }

  async function save() {
    if (!st.open || !st.dirty) return;
    const r = await ask('write', { path: st.open, text: ta.value, expectedMtime: st.mtime });
    if (!r) return;
    st.mtime = r.mtimeMs; setDirty(false); say('Saved.');
    await loadVersions();
    const s = await ask('status'); st.git = s?.status ?? {};
  }

  ta.addEventListener('input', () => setDirty(true));
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
  });
  saveBtn.onclick = () => void save();
  prevBtn.onclick = () => {
    preview.hidden = !preview.hidden; ta.hidden = !preview.hidden;
    if (!preview.hidden) renderMarkdown(ta.value, preview);
  };
  verSel.onchange = async () => {
    if (!verSel.value || !st.open) return;
    const r = await ask('version', { path: st.open, version: verSel.value });
    verSel.value = '';
    if (r && ctx.confirm('Replace the editor text with this version? Save to keep it.')) { ta.value = r.text; setDirty(true); }
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
  void refresh();
  view.cleanup = () => pending.clear();
}
