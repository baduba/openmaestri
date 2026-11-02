// First-run setup: pick the project folder and an agent, press Start. Everything that comes from
// the server (agent names, paths) goes in through textContent.
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export function createWelcome({ send, wsId }) {
  let dlg = null;
  let asked = false;

  function build(info) {
    dlg?.remove();
    dlg = el('dialog', 'welcome');
    dlg.id = 'dlg-welcome';
    const form = el('form');
    form.method = 'dialog';
    form.append(el('h3', null, 'Welcome to openmaestri'));
    form.append(el('p', 'muted', 'Pick your project folder and the agent that will be your Maestro. It opens in a terminal on the canvas and can recruit more agents.'));

    const folder = el('label', null, 'Project folder');
    const dirInput = el('input');
    dirInput.name = 'dir';
    dirInput.value = info.dir;
    dirInput.autocomplete = 'off';
    dirInput.setAttribute('aria-label', 'Project folder');
    folder.append(dirInput);
    form.append(folder);

    form.append(el('div', 'muted', 'Agent'));
    const list = el('div', 'welcome-agents');
    let chosen = info.agents.find((a) => a.installed)?.name ?? info.agents[0]?.name;
    for (const a of info.agents) {
      const row = el('label', 'chk welcome-agent');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'agent';
      radio.value = a.name;
      radio.checked = a.name === chosen;
      radio.onchange = () => { chosen = a.name; };
      row.append(radio, ` ${a.name}`, el('span', a.installed ? 'ok' : 'warn', a.installed ? ' installed' : ' not installed'));
      list.append(row);
    }
    form.append(list);
    if (!info.agents.some((a) => a.installed)) form.append(el('p', 'muted', 'No agent program was found on this machine. Run "openmaestri doctor" in a terminal to see how to install one.'));

    const instr = el('label', 'chk');
    const box = el('input');
    box.type = 'checkbox';
    box.name = 'instructions';
    instr.append(box, ' Add an AGENTS.md (CLAUDE.md for Claude) that explains openmaestri to the agents. An existing file is never changed.');
    form.append(instr);

    const actions = el('div', 'actions');
    const skip = el('button', null, 'Skip');
    skip.type = 'button';
    skip.onclick = () => { send({ t: 'welcome.skip' }); dlg.close(); };
    const go = el('button', 'primary', 'Start');
    go.type = 'button';
    go.disabled = !info.agents.length;
    go.onclick = () => {
      send({ t: 'welcome.start', workspaceId: wsId(), dir: dirInput.value.trim(), preset: chosen, instructions: box.checked });
      dlg.close();
    };
    actions.append(skip, go);
    form.append(actions);
    dlg.append(form);
    document.body.append(dlg);
    return dlg;
  }

  return {
    /** Ask once per page load whether this is a first run. */
    check() {
      if (asked) return;
      asked = true;
      send({ t: 'welcome.info', workspaceId: wsId() });
    },
    handle(m) {
      if (m.t !== 'welcome.info') return;
      if (!m.needed) return;
      build(m).showModal();
    },
  };
}
