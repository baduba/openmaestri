// Preferences: the few switches that can be changed from the page. Text from the server goes in
// with textContent.
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export function createPrefs({ send }) {
  let dlg = null;

  function build(p) {
    dlg?.remove();
    dlg = el('dialog', 'prefs');
    dlg.id = 'dlg-prefs';
    const form = el('form');
    form.method = 'dialog';
    form.append(el('h3', null, 'Preferences'));

    const persist = el('label', 'chk');
    const box = el('input');
    box.type = 'checkbox';
    box.name = 'persist';
    box.checked = p.persistTerminals;
    box.disabled = !p.tmuxInstalled || p.persistForcedByEnv;
    box.onchange = () => send({ t: 'prefs.set', persistTerminals: box.checked });
    persist.append(box, ' Keep terminals running when openmaestri restarts');
    form.append(persist);
    let note = 'Uses tmux. Takes effect the next time openmaestri starts.';
    if (!p.tmuxInstalled) note = 'tmux is not installed (sudo apt install tmux), so this cannot be turned on.';
    else if (p.persistForcedByEnv) note = 'Turned on by OPENMAESTRI_PERSIST=tmux.';
    else if (p.persistTerminals && !p.persistActive) note += ' It is on in the settings but not active yet.';
    form.append(el('p', 'muted', note));

    const again = el('button', null, 'Show the welcome screen again');
    again.type = 'button';
    again.disabled = !p.onboarded;
    again.onclick = () => { send({ t: 'prefs.set', showWelcomeAgain: true }); again.disabled = true; again.textContent = 'It will show on the next empty workspace'; };
    form.append(again);

    const facts = el('dl', 'prefs-facts');
    for (const [k, v] of [['Version', p.version], ['Data folder', p.dataDir], ['Secret store', p.secretStore]]) facts.append(el('dt', null, k), el('dd', null, v));
    form.append(facts);
    const link = el('a', null, 'Releases and updates');
    link.href = 'https://github.com/baduba/openmaestri/releases';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    form.append(el('p', 'muted', 'Updates arrive as a new .deb: '), link);

    const actions = el('div', 'actions');
    const close = el('button', 'primary', 'Close');
    close.type = 'button';
    close.onclick = () => dlg.close();
    actions.append(close);
    form.append(actions);
    dlg.append(form);
    document.body.append(dlg);
    return dlg;
  }

  return {
    open() { send({ t: 'prefs.get' }); },
    show(p) { build(p).showModal(); },
  };
}
