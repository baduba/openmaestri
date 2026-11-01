// The chat panel: seven threads, one conversation with the Maestro. Every piece of text that
// comes from an agent or a file goes in through textContent, never innerHTML, because this page
// can drive shells (a script injected through a chat message would be remote code execution).

const hhmm = (ts) => new Date(ts).toTimeString().slice(0, 5);

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
  let searchId = 0;

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
    if (!msgs.length && !progress.size) list.append(el('div', 'chat-empty', 'Nothing here yet. Write to your Maestro below; it answers with `openmaestri say`.'));
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

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  sendBtn.onclick = submit;
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
