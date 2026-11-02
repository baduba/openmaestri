// The chat panel: seven threads, one conversation with the Maestro. Every piece of text that
// comes from an agent or a file goes in through textContent, never innerHTML, because this page
// can drive shells (a script injected through a chat message would be remote code execution).

const hhmm = (ts) => new Date(ts).toTimeString().slice(0, 5);

const quoteRef = (ref) => (/^[^\s"\\]+$/.test(ref) ? ref : `"${ref.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`);
export const mentionToken = (kind, ref) => `@${kind}:${quoteRef(ref)}`;

/** The "@..." fragment being typed right before the caret, or null. */
export function activeMention(value, caret) {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  const frag = before.slice(at + 1);
  if (/[\r\n]/.test(frag) || frag.length > 80) return null;
  const quoted = frag.includes('"');
  if (!quoted && /\s/.test(frag)) return null;
  const m = /^(agent|note|file):/.exec(frag);
  return { start: at, query: (m ? frag.slice(m[0].length) : frag).replaceAll('"', '').replaceAll('\\', ''), kind: m?.[1] ?? null };
}

export function createChat({ state, send, wsId, toast, $, el }) {
  const panel = $('#chat');
  const tabs = $('#chat-tabs');
  const list = $('#chat-list');
  const input = $('#chat-input');
  const sendBtn = $('#chat-send');
  const badge = $('#chat-badge');
  const searchBox = $('#chat-search');
  let current = null;
  let loadedFor = null;
  let progress = new Map();
  let summaryText = '';
  let searchId = 0;
  let mentionId = 0;
  let mentionItems = [];
  let mentionSel = 0;
  let mentionTimer;
  const pop = $('#chat-mentions');

  const chat = () => state.ws?.chat ?? { threads: [], active: 'thread-1', attention: [], maestroAttention: false };
  const open = () => !panel.hidden;

  function setOpen(on) {
    panel.hidden = !on;
    $('#chat-btn').classList.toggle('on', on);
    if (on) { load(chat().active); input.focus(); }
  }

  function renderTabs() {
    const c = chat();
    tabs.replaceChildren();
    for (const t of c.threads) {
      const b = el('button', `ctab${t.id === current ? ' on' : ''}`);
      b.append(el('span', 'ctab-n', t.id.replace('thread-', '')));
      if (t.unread) b.append(el('span', 'ctab-u', String(t.unread)));
      b.title = `${t.title}${t.empty ? ' (empty)' : `: ${t.turnCount} messages`}\nDouble-click to rename`;
      b.onclick = () => { send({ t: 'chat.switch', workspaceId: wsId(), threadId: t.id }); load(t.id); };
      b.ondblclick = () => { const title = prompt('Rename thread', t.title); if (title) send({ t: 'chat.rename', workspaceId: wsId(), threadId: t.id, title }); };
      tabs.append(b);
    }
    const unread = c.threads.reduce((n, t) => n + (t.unread || 0), 0);
    badge.hidden = !(unread || c.maestroAttention);
    badge.textContent = c.maestroAttention ? '●' : String(unread);
    $('#chat-title').textContent = c.threads.find((t) => t.id === current)?.title ?? '';
  }

  function bubble(m) {
    const d = el('div', `msg ${m.role}${m.progress ? ' progress' : ''}`);
    const head = el('div', 'msg-h');
    head.append(el('b', null, m.sender), el('span', 'msg-t', hhmm(m.ts)));
    const body = el('div', 'msg-b', m.text);
    d.append(head, body);
    for (const a of m.attachments ?? []) {
      const link = el('a', 'att', `${a.name} (${Math.max(1, Math.round(a.size / 1024))} KB)`);
      link.href = `/attachment/${encodeURIComponent(wsId())}/${encodeURIComponent(a.id)}`;
      link.rel = 'noopener';
      link.target = '_blank';
      if (/^image\//.test(a.mime)) {
        const img = el('img', 'att-img');
        img.src = link.href;
        img.alt = a.name;
        img.loading = 'lazy';
        d.append(img);
      }
      d.append(link);
    }
    return d;
  }

  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;

  function renderList(msgs) {
    list.replaceChildren();
    if (!msgs.length && !progress.size && !summaryText) list.append(el('div', 'chat-empty', 'Nothing here yet. Write to your Maestro below; it answers with `openmaestri say`.'));
    if (summaryText) {
      const d = el('details', 'chat-summary');
      d.append(el('summary', null, 'Earlier messages are summarised'), el('pre', null, summaryText));
      list.append(d);
    }
    for (const m of msgs) list.append(bubble(m));
    renderProgress();
    list.scrollTop = list.scrollHeight;
  }

  function renderProgress() {
    for (const n of list.querySelectorAll('.msg.progress')) n.remove();
    for (const m of progress.values()) list.append(bubble(m));
  }

  function load(tid) {
    current = tid;
    loadedFor = tid;
    progress = new Map();
    renderTabs();
    send({ t: 'chat.history', workspaceId: wsId(), threadId: tid });
  }

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    send({ t: 'chat.send', workspaceId: wsId(), threadId: current, text });
  }

  $('#chat-export').onclick = () => { location.href = `/chat-export/${encodeURIComponent(wsId())}/${encodeURIComponent(current)}.md`; };
  $('#chat-copy').onclick = () => {
    const text = [...document.querySelectorAll('#chat .msg')].map((d) => `${d.querySelector('.msg-h b')?.textContent ?? ''}: ${d.querySelector('.msg-b')?.textContent ?? ''}`).join('\n\n');
    navigator.clipboard?.writeText(text).then(() => toast('Thread copied', 'chat'), () => toast('Could not copy', 'chat', true));
  };

  // Drop files on the chat to send them to the Maestro (up to 10 MB each, three at a time).
  const dropPanel = $('#chat');
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  dropPanel.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); dropPanel.classList.add('dropping'); } });
  dropPanel.addEventListener('dragleave', (e) => { if (e.target === dropPanel) dropPanel.classList.remove('dropping'); });
  dropPanel.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropPanel.classList.remove('dropping');
    const files = [...e.dataTransfer.files].slice(0, 3);
    const caption = input.value.trim();
    if (caption) input.value = '';
    files.forEach((file, i) => {
      if (file.size > 10 * 1024 * 1024) { toast(`${file.name} is over 10 MB`, 'chat', true); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result).split(',')[1] ?? '';
        send({ t: 'chat.upload', workspaceId: wsId(), threadId: current, name: file.name, data, text: i === 0 ? caption : '' });
      };
      reader.readAsDataURL(file);
    });
  });

  function closeMentions() { pop.hidden = true; mentionItems = []; }
  function renderMentions() {
    pop.replaceChildren();
    mentionItems.forEach((it, i) => {
      const li = el('li', i === mentionSel ? 'on' : '');
      li.setAttribute('role', 'option');
      li.append(el('span', `mk mk-${it.kind}`, it.kind), el('span', 'mn', it.name), el('span', 'md', it.detail || ''));
      li.onmousedown = (e) => { e.preventDefault(); pick(i); };
      pop.append(li);
    });
    pop.hidden = !mentionItems.length;
  }
  function pick(i) {
    const it = mentionItems[i];
    const cur = activeMention(input.value, input.selectionStart);
    if (!it || !cur) { closeMentions(); return; }
    const token = `${mentionToken(it.kind, it.ref)} `;
    input.value = input.value.slice(0, cur.start) + token + input.value.slice(input.selectionStart);
    const pos = cur.start + token.length;
    input.setSelectionRange(pos, pos);
    closeMentions();
    input.focus();
  }
  input.addEventListener('input', () => {
    clearTimeout(mentionTimer);
    const cur = activeMention(input.value, input.selectionStart);
    if (!cur) { closeMentions(); return; }
    mentionTimer = setTimeout(() => { mentionId += 1; send({ t: 'prompter.mentions', workspaceId: wsId(), requestId: mentionId, query: cur.query }); }, 120);
  });
  input.addEventListener('blur', () => setTimeout(closeMentions, 150));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (!pop.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionSel = (mentionSel + 1) % mentionItems.length; renderMentions(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionSel = (mentionSel - 1 + mentionItems.length) % mentionItems.length; renderMentions(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(mentionSel); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeMentions(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  sendBtn.onclick = submit;
  // ----- saved prompts -----
  const drawer = $('#chat-prompts');
  const libList = $('#chat-lib-list');
  const requestPrompts = () => send({ t: 'prompts.list', workspaceId: wsId() });
  function renderPrompts(items) {
    libList.replaceChildren();
    if (!items.length) libList.append(el('li', 'lib-empty', 'Nothing saved yet. Type a message, then press Save current.'));
    for (const p of items) {
      const li = el('li', 'lib-item');
      const main = el('button', 'lib-main');
      main.append(el('b', null, p.name), el('span', `lib-scope ${p.scope}`, p.scope), el('span', 'lib-prev', p.preview));
      main.onclick = () => send({ t: 'prompts.get', workspaceId: wsId(), name: p.name, scope: p.scope });
      const del = el('button', 'lib-del', '×');
      del.title = `Delete "${p.name}" (you can undo)`;
      del.onclick = () => send({ t: 'prompts.delete', workspaceId: wsId(), name: p.name, scope: p.scope });
      li.append(main, del);
      libList.append(li);
    }
  }
  $('#chat-lib').onclick = () => { drawer.hidden = !drawer.hidden; if (!drawer.hidden) requestPrompts(); };
  $('#chat-lib-close').onclick = () => { drawer.hidden = true; };
  $('#chat-lib-save').onclick = () => {
    const text = input.value.trim();
    if (!text) { toast('Type the prompt in the message box first', 'prompts', true); return; }
    const name = prompt('Name for this prompt (letters, digits, spaces, dots, dashes)');
    if (!name) return;
    const global = confirm('Keep it for every workspace?\n\nOK = every workspace, Cancel = only this one');
    send({ t: 'prompts.save', workspaceId: wsId(), name, text, global });
  };
  $('#chat-undo-btn').onclick = () => { send({ t: 'prompts.undo', workspaceId: wsId() }); $('#chat-undo').hidden = true; };

  $('#chat-preview').onclick = () => { const text = input.value.trim(); if (text) send({ t: 'prompter.preview', workspaceId: wsId(), requestId: ++searchId, text }); };
  $('#chat-preview-close').onclick = () => { $('#chat-preview-box').hidden = true; };
  $('#chat-close').onclick = () => setOpen(false);
  $('#chat-interrupt').onclick = () => send({ t: 'chat.interrupt', workspaceId: wsId() });
  $('#chat-clear').onclick = () => { if (confirm('Erase everything in this thread?')) send({ t: 'chat.clear', workspaceId: wsId(), threadId: current }); };
  $('#chat-btn').onclick = () => setOpen(!open());
  let searchTimer;
  searchBox.addEventListener('keydown', (e) => e.stopPropagation());
  searchBox.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = searchBox.value.trim();
      if (q.length < 2) { load(current); return; }
      searchId += 1;
      send({ t: 'chat.search', workspaceId: wsId(), requestId: searchId, query: q });
    }, 250);
  });

  return {
    /** Called after every workspace update: tabs and badges follow the server state. */
    sync() {
      const c = chat();
      if (!current || !c.threads.some((t) => t.id === current)) current = c.active;
      renderTabs();
      if (open() && loadedFor !== current) load(current);
    },
    toggle: setOpen,
    handle(m) {
      switch (m.t) {
        case 'chat.history':
          if (m.threadId !== current) return true;
          progress = new Map(m.progress.map((p) => [p.sender, p]));
          summaryText = m.summary || '';
          if (state.ws) state.ws.chat = m.chat;
          renderTabs();
          renderList(m.messages);
          return true;
        case 'chat.message': {
          if (m.workspaceId !== wsId() || m.message.threadId !== current) return true;
          const stick = nearBottom();
          progress.delete(m.message.sender);
          list.querySelector('.chat-empty')?.remove();
          renderProgress();
          list.insertBefore(bubble(m.message), list.querySelector('.msg.progress'));
          if (stick) list.scrollTop = list.scrollHeight;
          if (open() && m.message.role !== 'human') send({ t: 'chat.markRead', workspaceId: wsId(), threadId: current });
          return true;
        }
        case 'chat.progress':
          if (m.workspaceId !== wsId() || m.message.threadId !== current) return true;
          progress.set(m.message.sender, m.message);
          renderProgress();
          list.scrollTop = list.scrollHeight;
          return true;
        case 'chat.state':
          if (m.workspaceId === wsId() && state.ws) { state.ws.chat = m.chat; this.sync(); window.dispatchEvent(new CustomEvent('om-chat-state')); }
          return true;
        case 'prompts.list': renderPrompts(m.items); return true;
        case 'prompts.changed': if (!drawer.hidden) requestPrompts(); return true;
        case 'prompts.item': {
          const sep = input.value && !input.value.endsWith('\n') ? '\n' : '';
          input.value += sep + m.text;
          input.focus();
          return true;
        }
        case 'prompts.deleted':
          $('#chat-undo-text').textContent = `Deleted "${m.name}".`;
          $('#chat-undo').hidden = false;
          return true;
        case 'prompter.mentions':
          if (m.requestId !== mentionId || !activeMention(input.value, input.selectionStart)) return true;
          mentionItems = m.items;
          mentionSel = 0;
          renderMentions();
          return true;
        case 'prompter.preview': {
          const notes = m.mentions.filter((x) => !x.ok).map((x) => `# not included: @${x.kind}:${x.ref} (${x.reason})`);
          $('#chat-preview-text').textContent = [m.text, ...notes].join('\n');
          $('#chat-preview-box').hidden = false;
          return true;
        }
        case 'chat.search':
          if (m.requestId !== searchId) return true;
          list.replaceChildren();
          if (!m.hits.length) list.append(el('div', 'chat-empty', 'No matches.'));
          for (const h of m.hits) {
            const row = el('button', 'hit');
            row.append(el('b', null, `${h.threadId.replace('thread-', 'Thread ')}  ${h.sender}`), el('span', null, h.snippet));
            row.onclick = () => { searchBox.value = ''; send({ t: 'chat.switch', workspaceId: wsId(), threadId: h.threadId }); load(h.threadId); };
            list.append(row);
          }
          return true;
        default: return false;
      }
    },
    notifyError(message) { toast(message, 'chat', true); },
  };
}
