#!/usr/bin/env node
// openmaestri CLI. Only works inside an openmaestri terminal: the daemon exports
// OPENMAESTRI_SOCKET / OPENMAESTRI_TERMINAL_ID into every pty it spawns.
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const BOOL = new Set(['no-check', 'summary', 'archive', 'apply', 'trust', 'global', 'overwrite', 'progress', 'all', 'existing-branch', 'copy', 'no-git', 'copy-ground', 'delete-branch', 'keep-floor', 'no-hooks', 'clear-hooks', 'keep-branch', 'keep-folder', 'open', 'version', 'json', 'raw-flag', 'batch', 'force', 'none', 'clear', 'without-me', 'no-notify', 'disabled', 'reminder', 'agent', 'floors', 'dry-run', 'no-network', 'yes', 'verify', 'note', 'band', 'fichario', 'portal', 'help']);

const HELP = `openmaestri - a spatial workspace for AI agents (open implementation)

Usage:
  openmaestri [serve] [--open]                       Start the app (outside a terminal): daemon + web UI. --open launches the browser
  openmaestri list                                   List connected agents, notes and portals
  openmaestri notify "message"                       Send the user a notification
  openmaestri run "task" --agents a,b [--floors] [--dry-run] [--sandbox IMAGE [--no-network]]   Same task to several one-shot agents in parallel; report kept as a note
  openmaestri chat summarize [thread] --with DRIVER   Ask an agent you choose to write a summary of a chat thread (shown by recall --summary)
  openmaestri ps [--all] | ps stop "Terminal" PID [--force]   Processes, memory and CPU of your terminals; stop one process
  openmaestri agent claude|codex|gemini|agy|kimi|opencode|aider|goose "prompt"   One-shot run of an agent CLI, prints its answer (no terminal)
  openmaestri ask "Agent" "prompt" [--timeout 120s]  Send a prompt to a connected agent, wait until it settles, print what it produced
  openmaestri ask --batch '{"A":"prompt","B":"prompt"}'  Ask several agents in parallel; prints a JSON array
  openmaestri ask "Agent" --raw "2\\n"                Send raw keystrokes (\\n \\t \\e \\xNN); prints the resulting terminal text
  openmaestri check "Agent" [--lines N]              Read an agent's current terminal screen
  openmaestri note create ["content"] [--name N] [--color C]
  openmaestri note read "Note" [offset] [limit]
  openmaestri note write "Note" "content"
  openmaestri note edit "Note" "old" "new"
  openmaestri note delete "Note" | note delete --stack "Stack"
  openmaestri note create "text" --stack ["Stack"] | note stack "Note" ["Stack"] | note unstack "Note"
  openmaestri portal create URL ["Name"] [--size WxH] | edit "Portal" --url URL | close "Portal"
  openmaestri portal snapshot|info|html|text|screenshot|check|logs-start|logs|reload|back|forward "Portal" [...]
  openmaestri portal click|hover|focus|fill|type|key|select|check|uncheck|clear|selectall|scroll|drag|upload|wait|evaluate|navigate|resize|ua "Portal" ...
      targets: @e3 (from snapshot) | CSS selector | x,y     e.g.  portal fill "App" @e2 "hello"  /  portal key "App" ctrl+a
  openmaestri arrange ["Name" [--name N] [--color C] [--icon I]]
  Maestro terminals only:
  openmaestri recruit "Name" [--preset P] [--role R] [--dir PATH] [--command C] [--color C]
  openmaestri recruit "Name" --preset "OpenCode (DeepSeek)" --model deepseek-v4-pro [--no-check]   (checks the agent is installed)
  openmaestri recruit "New" --preset P --replace "Old"
  openmaestri dismiss "Name"
  openmaestri connect "From" "To" [--agent|--band|--note|--fichario|--portal]   |   disconnect "From" "To"
  openmaestri band create "Name" ["Agent" ...] [--without-me] | add "Band" "Agent" | remove "Band" "Agent" | dissolve "Band"
  openmaestri partitura list | insert "Name" | create "Name" ["Agent" ...] [--commands on|off] [--note-text on|off] [--scope current|global] | update ... | delete "Name"
  openmaestri preset list|show|create|set|delete ...
  openmaestri role list|show|create|write|edit|assign|delete ...
  openmaestri role discover | install "Role" --agent "Name" [--apply] [--trust] | uninstall "Role" --agent "Name" [--apply]   Dry run unless --apply
  openmaestri routine list|show|create|edit|enable|disable|run|delete|history ...
      schedules: --every 30m | --daily 09:00 | --weekly mon,fri@09:00 | --once "2026-12-01 15:00"
      options:   --terminal "Name" | --count N | --until DATE | --pre-run "cmd" ({{output}} in the command) | --no-notify | --disabled
  openmaestri workspace list|create|rename ...
  openmaestri floor hooks "Floor" [--post-agent CMD] [--pre-land CMD] [--rollback-on-fail on|off]   Checks after each agent and before landing
  openmaestri floor snapshot|snapshots|rollback ["Floor"] ...  Remember the files of a floor, list the memories, put them back (rollback is itself undoable)
  openmaestri floor prs [--provider github|gitlab] [--json]   Open pull/merge requests with their checks (needs gh or glab, signed in)
  openmaestri floor create "Name" [--from PATH] [--branch B] [--existing-branch] [--copy] [--no-git] [--copy-ground] [--partitura P] | --dir PATH | --pull-request N|URL
  openmaestri floor list | land "Name" [--into B] [--delete-branch] [--keep-floor] | delete "Name" [--keep-branch] [--keep-folder] [--force] | set-dir "Name" PATH | unload "Name"
  openmaestri floor status ["Text" --state working|blocked|review|done --progress 2/5 | --clear] [--floor F]
  openmaestri recruit ... [--floor F]   (place the teammate on another floor; "Ground" for the ground floor)
  openmaestri say "text" [--file PATH] [--attach PATH]... [--progress] [--thread N]   Answer the human in the chat (what a Maestro does)
  openmaestri memory status [thread] | memory compress [thread]   Long threads are condensed into a local summary; the full text stays archived
  openmaestri recall [thread] [--summary] [--archive] [--turns N | --last day|week|month | --from DATE [--to DATE] | --all] [--json] | recall list | recall attachment <id>
  openmaestri prompt list | read "name" | use "name" | save "name" "text" [--global] [--overwrite] | delete "name" | undo   Saved prompts (save/delete: Maestro)
  openmaestri prompt parse|materialize "text with @agent:Name @note:Name @file:path"   Expand mentions (files up to 32 KB, workspace only)
  openmaestri usage ["Agent"] [--days N] [--json] | usage report --in N --out N [--model M] [--cost USD] | usage reset ["Agent"]   Tokens, cost, turns
  openmaestri accounts set|list|rm                  Named environments for agents (work / personal keys); run in your own shell
  openmaestri audit [--verify] [--tail N]           Show or check the append-only record of keys, agent runs, imports and exports
  openmaestri secrets set|list|status|rm            Keep API keys outside the env file (secret://name); run in your own shell
  openmaestri persist list | stop --yes             The tmux sessions behind persistent terminals; run in your own shell
  openmaestri desktop                               Open the optional desktop window (one-time: npm --prefix desktop install)
  openmaestri doctor                                 Check what is installed and how to fix what is missing (works anywhere)
  openmaestri guide                                  How agents should use openmaestri (give this to your agent)
  openmaestri debug
Global flags: --json (machine-readable output)`;

const REPEAT = new Set(['attach']);
function setFlag(flags, key, value) {
  if (REPEAT.has(key)) flags[key] = [...(Array.isArray(flags[key]) ? flags[key] : []), value];
  else flags[key] = value;
}

export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const key = (eq > 0 ? a.slice(2, eq) : a.slice(2));
      if (eq > 0) setFlag(flags, key, a.slice(eq + 1));
      else if (BOOL.has(key)) flags[key] = true;
      else if (argv[i + 1] !== undefined) setFlag(flags, key, argv[++i]);
      else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function duration(v) {
  if (v == null) return undefined;
  const m = /^(\d+)(ms|s|m)?$/.exec(String(v));
  if (!m) throw new Error(`bad duration: ${v}`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60000, undefined: 1000 }[m[2]];
}
const optStr = (v) => (v === undefined ? undefined : v === true ? '' : String(v));
const onOff = (v) => (v === undefined ? undefined : /^(on|true|1|yes)$/i.test(String(v)));

/** Map argv to {cmd, args}. Throws Error with a usage message on bad input. */
export function build({ pos, flags }) {
  const [c0, c1, ...rest] = pos;
  const need = (cond, usage) => { if (!cond) throw new Error(`usage: ${usage}`); };
  switch (c0) {
    case 'list': return { cmd: 'list', args: {} };
    case 'notify': need(c1, 'notify "message"'); return { cmd: 'notify', args: { message: [c1, ...rest].join(' ') } };
    case 'ask': {
      const timeoutMs = duration(flags.timeout);
      if (flags.batch) {
        need(c1, 'ask --batch \'{"A": "prompt"}\'');
        let items;
        try { items = JSON.parse(c1); } catch { throw new Error('--batch needs a JSON object {"Agent": "prompt"}'); }
        return { cmd: 'ask.batch', args: { items, timeoutMs } };
      }
      need(c1, 'ask "Agent" "prompt"');
      if (flags.raw !== undefined) return { cmd: 'ask', args: { name: c1, raw: String(flags.raw === true ? rest.join(' ') : flags.raw), timeoutMs } };
      need(rest.length, 'ask "Agent" "prompt"');
      return { cmd: 'ask', args: { name: c1, prompt: rest.join(' '), timeoutMs } };
    }
    case 'run': {
      need(c1 && flags.agents, 'run "task" --agents claude,codex [--floors] [--dry-run] [--model M] [--timeout 10m] [--sandbox IMAGE [--no-network]]');
      return { cmd: 'run', args: { task: [c1, ...rest].join(' '), agents: String(flags.agents), floors: !!flags.floors, dryRun: !!flags['dry-run'], model: flags.model === undefined ? undefined : String(flags.model), timeoutMs: duration(flags.timeout), account: flags.account === undefined ? undefined : String(flags.account), sandbox: optStr(flags.sandbox), noNetwork: !!flags['no-network'] } };
    }
    case 'chat': {
      if (c1 !== 'summarize') throw new Error('usage: chat summarize [thread] --with DRIVER [--account A]');
      need(flags.with, 'chat summarize [thread] --with DRIVER [--account A]');
      return { cmd: 'chat.summarize', args: { thread: rest[0], driver: String(flags.with), account: flags.account === undefined ? undefined : String(flags.account), timeoutMs: duration(flags.timeout) } };
    }
    case 'ps': {
      if (c1 === 'stop') { need(rest[0] && rest[1], 'ps stop "Terminal" PID [--force]'); return { cmd: 'ps', args: { stop: rest[0], pid: rest[1], force: !!flags.force } }; }
      return { cmd: 'ps', args: { all: !!flags.all } };
    }
    case 'agent': {
      need(c1 && rest.length, 'agent <driver> "prompt" [--model M] [--floor NAME] [--timeout 10m]');
      return { cmd: 'agent.run', args: { driver: c1, prompt: rest.join(' '), model: flags.model === undefined ? undefined : String(flags.model), floor: flags.floor === undefined ? undefined : String(flags.floor), timeoutMs: duration(flags.timeout), account: flags.account === undefined ? undefined : String(flags.account), sandbox: optStr(flags.sandbox), noNetwork: !!flags['no-network'] } };
    }
    case 'check': need(c1, 'check "Agent" [--lines N]'); return { cmd: 'check', args: { name: c1, lines: flags.lines ? Number(flags.lines) : undefined } };
    case 'note': {
      const [name, ...more] = rest;
      switch (c1) {
        case 'create': return { cmd: 'note.create', args: { content: name ?? '', name: flags.name, color: flags.color, stack: flags.stack } };
        case 'from-file': need(name, 'note from-file PATH [--name N]'); return { cmd: 'note.fromfile', args: { path: name, name: flags.name } };
        case 'stack': need(name, 'note stack "Note" ["Stack"]'); return { cmd: 'note.stack', args: { name, stack: more[0] } };
        case 'unstack': need(name, 'note unstack "Note"'); return { cmd: 'note.unstack', args: { name } };
        case 'read': need(name, 'note read "Note" [offset] [limit]'); return { cmd: 'note.read', args: { name, offset: more[0] ? Number(more[0]) : undefined, limit: more[1] ? Number(more[1]) : undefined } };
        case 'write': need(name && more.length, 'note write "Note" "content"'); return { cmd: 'note.write', args: { name, content: more.join(' ') } };
        case 'edit': need(name && more.length >= 2, 'note edit "Note" "old" "new"'); return { cmd: 'note.edit', args: { name, old: more[0], new: more[1] } };
        case 'delete': need(name || flags.stack, 'note delete "Note" | note delete --stack "Stack"'); return { cmd: 'note.delete', args: { name, stack: flags.stack } };
        default: throw new Error('usage: note create|read|write|edit|from-file|stack|unstack|delete');
      }
    }
    case 'portal': {
      const [a, b, ...more] = rest;
      switch (c1) {
        case undefined: throw new Error('usage: portal <command> "Portal" ... (see: openmaestri help)');
        case 'create':
          if (flags.simulator) throw new Error('Android device portals are not implemented yet');
          need(a, 'portal create URL ["Name"] [--size WxH]');
          return { cmd: 'portal.create', args: { url: a, name: b, size: flags.size } };
        case 'edit': need(a && flags.url, 'portal edit "Portal" --url URL'); return { cmd: 'portal.edit', args: { name: a, url: flags.url } };
        case 'close': need(a, 'portal close "Portal"'); return { cmd: 'portal.close', args: { name: a } };
        case 'devices': throw new Error('Android device portals are not implemented yet');
        default:
          need(a, `portal ${c1} "Portal" ...`);
          return { cmd: 'portal.act', args: { op: c1, name: a, rest: [b, ...more].filter((x) => x !== undefined) } };
      }
    }
    case 'arrange': return { cmd: 'arrange', args: { name: c1, newName: flags.name, color: flags.color, icon: flags.icon, kind: ['agent', 'note', 'band', 'fichario'].find((k) => flags[k]) } };
    case 'band': {
      const [a, b] = rest;
      switch (c1) {
        case 'create': need(a, 'band create "Name" ["Agent" ...] [--without-me]'); return { cmd: 'band.create', args: { name: a, agents: rest.slice(1), withoutMe: !!flags['without-me'], color: flags.color, icon: flags.icon } };
        case 'add': need(a && b, 'band add "Band" "Agent"'); return { cmd: 'band.add', args: { band: a, agent: b } };
        case 'remove': need(a && b, 'band remove "Band" "Agent"'); return { cmd: 'band.remove', args: { band: a, agent: b } };
        case 'dissolve': need(a, 'band dissolve "Band"'); return { cmd: 'band.dissolve', args: { band: a } };
        default: throw new Error('usage: band create|add|remove|dissolve');
      }
    }
    case 'partitura': {
      const [a] = rest;
      const common = { agents: rest.slice(1), withoutMe: !!flags['without-me'], commands: onOff(flags.commands), noteText: onOff(flags['note-text']), description: flags.description, icon: flags.icon, color: flags.color, scope: flags.scope };
      switch (c1) {
        case 'list': return { cmd: 'partitura.list', args: {} };
        case 'insert': need(a, 'partitura insert "Name" [--floor F]'); return { cmd: 'partitura.insert', args: { name: a, floor: flags.floor } };
        case 'create': need(a, 'partitura create "Name" ["Agent" ...] [--commands on|off] [--note-text on|off] [--description D] [--scope current|global]'); return { cmd: 'partitura.create', args: { name: a, ...common } };
        case 'update': need(a, 'partitura update "Name" ["Agent" ...] [--name N] [flags]'); return { cmd: 'partitura.update', args: { name: a, newName: flags.name, ...common } };
        case 'delete': need(a, 'partitura delete "Name"'); return { cmd: 'partitura.delete', args: { name: a } };
        case 'export': need(a, 'partitura export "Name" > layout.json'); return { cmd: 'partitura.export', args: { name: a } };
        case 'import': {
          need(a, 'partitura import layout.json [--name "New name"]');
          // one descriptor for the size check and the read, so the file cannot change in between
          let file;
          let fd;
          try {
            fd = fs.openSync(a, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
            const st = fs.fstatSync(fd);
            if (!st.isFile() || st.size > (5 << 20)) throw new Error('partitura import needs a JSON file of at most 5 MB');
            file = JSON.parse(fs.readFileSync(fd, 'utf8'));
          } catch (e) {
            if (/at most 5 MB/.test(e.message)) throw e;
            throw new Error(`${a} cannot be read as JSON`, { cause: e });
          } finally { if (fd !== undefined) fs.closeSync(fd); }
          return { cmd: 'partitura.import', args: { file, name: flags.name } };
        }
        default: throw new Error('usage: partitura list|insert|create|update|delete|export|import');
      }
    }
    case 'recruit': return { cmd: 'recruit', args: { name: c1, preset: flags.preset, role: flags.role, dir: flags.dir, command: flags.command, color: flags.color, icon: flags.icon, replace: flags.replace, account: flags.account, floor: flags.floor, model: flags.model, noCheck: !!flags['no-check'] } };
    case 'dismiss': need(c1, 'dismiss "Name"'); return { cmd: 'dismiss', args: { name: c1 } };
    case 'connect': need(c1 && rest[0], 'connect "From" "To" [--agent|--band|--note|--fichario|--portal]'); return { cmd: 'connect', args: { from: c1, to: rest[0], kind: ['agent', 'band', 'note', 'fichario', 'portal'].find((k) => flags[k]) } };
    case 'disconnect': need(c1 && rest[0], 'disconnect "From" "To"'); return { cmd: 'disconnect', args: { from: c1, to: rest[0] } };
    case 'preset': {
      const [name] = rest;
      switch (c1) {
        case 'list': return { cmd: 'preset.list', args: {} };
        case 'show': case 'delete': need(name, `preset ${c1} "Name"`); return { cmd: `preset.${c1}`, args: { name } };
        case 'create': need(name, 'preset create "Name" [--command C] [--maestro on|off]'); return { cmd: 'preset.create', args: { name, command: flags.command, maestro: onOff(flags.maestro), account: flags.account } };
        case 'set': need(name, 'preset set "Name" [--name N] [--command C] [--maestro on|off]'); return { cmd: 'preset.set', args: { name, newName: flags.name, command: flags.command, maestro: onOff(flags.maestro), account: flags.account } };
        default: throw new Error('usage: preset list|show|create|set|delete');
      }
    }
    case 'role': {
      const [name, ...more] = rest;
      switch (c1) {
        case 'list': return { cmd: 'role.list', args: {} };
        case 'show': need(name, 'role show "Name"'); return { cmd: 'role.show', args: { name } };
        case 'create': need(name && more.length, 'role create "Name" "Prompt" [--scope current|global]'); return { cmd: 'role.create', args: { name, prompt: more.join(' '), scope: flags.scope } };
        case 'write': need(name && more.length, 'role write "Name" "prompt"'); return { cmd: 'role.write', args: { name, prompt: more.join(' ') } };
        case 'edit': need(name, 'role edit "Name" "old" "new" [--scope S]'); return { cmd: 'role.edit', args: { name, old: more[0], new: more[1], scope: flags.scope } };
        case 'assign': need(name && (more[0] || flags.none), 'role assign "Recruit" "Role" | --none'); return { cmd: 'role.assign', args: { recruit: name, role: more[0], none: !!flags.none } };
        case 'delete': need(name, 'role delete "Name" [--force]'); return { cmd: 'role.delete', args: { name, force: !!flags.force } };
        case 'discover': return { cmd: 'role.discover', args: {} };
        case 'install': case 'uninstall': need(name && flags.agent, `role ${c1} "Role" --agent "Name" [--apply]`); return { cmd: `role.${c1}`, args: { role: name, agent: flags.agent, apply: !!flags.apply, trust: !!flags.trust } };
        default: throw new Error('usage: role list|show|create|write|edit|assign|delete|discover|install|uninstall');
      }
    }
    case 'routine': {
      const [name] = rest;
      const sched = { every: flags.every, daily: flags.daily, weekly: flags.weekly, once: flags.once };
      switch (c1) {
        case 'list': return { cmd: 'routine.list', args: {} };
        case 'show': case 'enable': case 'disable': case 'run': case 'delete': case 'history': need(name, `routine ${c1} "Name"`); return { cmd: `routine.${c1}`, args: { name } };
        case 'create': need(name && flags.command, 'routine create "Name" --command "..." <schedule>');
          return { cmd: 'routine.create', args: { name, command: flags.command, terminal: flags.terminal, ...sched, count: flags.count, until: flags.until, preRun: flags['pre-run'], noNotify: !!flags['no-notify'], disabled: !!flags.disabled, reminder: !!flags.reminder } };
        case 'edit': need(name, 'routine edit "Name" [flags]'); return { cmd: 'routine.edit', args: { name, newName: flags.name, command: flags.command, terminal: flags.terminal, ...sched } };
        default: throw new Error('usage: routine list|show|create|edit|enable|disable|run|delete|history');
      }
    }
    case 'workspace': {
      const [name, ...more] = rest;
      switch (c1) {
        case 'list': return { cmd: 'workspace.list', args: {} };
        case 'create': need(name && flags.dir, 'workspace create "Name" --dir PATH [--from "Source"]'); return { cmd: 'workspace.create', args: { name, dir: flags.dir, from: flags.from } };
        case 'set': need(name && (flags.icon !== undefined || flags.group !== undefined), 'workspace set "Name" [--icon X] [--group G]'); return { cmd: 'workspace.set', args: { name, icon: optStr(flags.icon), group: optStr(flags.group) } };
        case 'unload': need(name, 'workspace unload "Name"'); return { cmd: 'workspace.unload', args: { name } };
        case 'rename': need(name && more[0], 'workspace rename "Current" "New"'); return { cmd: 'workspace.rename', args: { name, newName: more[0] } };
        default: throw new Error('usage: workspace list|create|rename|set|unload');
      }
    }
    case 'floor': {
      const [name, p2] = rest;
      switch (c1) {
        case 'hooks': need(name, 'floor hooks "Floor" [--post-agent CMD] [--pre-land CMD] [--rollback-on-fail on|off] [--sandbox IMAGE] [--clear-hooks]'); return { cmd: 'floor.hooks', args: { name, postAgent: flags['post-agent'] === undefined ? undefined : String(flags['post-agent']), preLand: flags['pre-land'] === undefined ? undefined : String(flags['pre-land']), rollbackOnFail: onOff(flags['rollback-on-fail']), clear: !!flags['clear-hooks'], sandbox: optStr(flags.sandbox) } };
        case 'snapshot': return { cmd: 'floor.snapshot', args: { name, label: flags.label === undefined ? undefined : String(flags.label) } };
        case 'snapshots': return { cmd: 'floor.snapshots', args: { name } };
        case 'rollback': need(name, 'floor rollback "Floor" [SNAPSHOT_ID]'); return { cmd: 'floor.rollback', args: { name, id: p2 } };
        case 'prs': return { cmd: 'floor.prs', args: { provider: flags.provider, json: !!flags.json } };
        case 'create': need(name || flags['pull-request'], 'floor create "Name" [--from PATH] [--branch B] [--existing-branch] [--copy] [--no-git] [--copy-ground] [--partitura P] | --dir PATH | --pull-request N|URL');
          return { cmd: 'floor.create', args: { name, from: flags.from, branch: flags.branch, existingBranch: !!flags['existing-branch'], copy: !!flags.copy, noGit: !!flags['no-git'], copyGround: !!flags['copy-ground'], partitura: flags.partitura, dir: flags.dir, pullRequest: flags['pull-request'], provider: flags.provider } };
        case 'list': return { cmd: 'floor.list', args: {} };
        case 'land': need(name, 'floor land "Name" [--into BRANCH] [--delete-branch] [--keep-floor]'); return { cmd: 'floor.land', args: { name, into: flags.into, deleteBranch: !!flags['delete-branch'], keepFloor: !!flags['keep-floor'], noHooks: !!flags['no-hooks'] } };
        case 'delete': need(name, 'floor delete "Name" [--keep-branch] [--keep-folder] [--force]'); return { cmd: 'floor.delete', args: { name, keepBranch: !!flags['keep-branch'], keepFolder: !!flags['keep-folder'], force: !!flags.force } };
        case 'set-dir': need(name && p2, 'floor set-dir "Name" PATH'); return { cmd: 'floor.set-dir', args: { name, path: p2 } };
        case 'unload': need(name, 'floor unload "Name"'); return { cmd: 'floor.unload', args: { name } };
        case 'status': return { cmd: 'floor.status', args: { text: name, state: flags.state, progress: flags.progress, clear: !!flags.clear, floor: flags.floor } };
        default: throw new Error('usage: floor create|list|land|delete|set-dir|unload|status');
      }
    }
    case 'say': {
      const abs = (p) => path.resolve(String(p));
      const text = [c1, ...rest].filter((x) => x !== undefined).join(' ');
      need(text || flags.file || flags.attach, 'say "text" [--file PATH] [--attach PATH]... [--progress] [--thread N]');
      if (flags.file === true) throw new Error('say --file needs a path to a text or image file');
      return { cmd: 'say', args: { text, file: flags.file ? abs(flags.file) : undefined, attach: (flags.attach ?? []).map(abs), progress: !!flags.progress, thread: flags.thread } };
    }
    case 'recall': {
      const base = { summary: !!flags.summary, archive: !!flags.archive, turns: flags.turns ? Number(flags.turns) : undefined, last: flags.last, from: flags.from, to: flags.to, all: !!flags.all, json: !!flags.json };
      if (c1 === 'list') return { cmd: 'recall', args: { list: true } };
      if (c1 === 'attachment') { need(rest[0], 'recall attachment <id>'); return { cmd: 'recall', args: { attachment: rest[0] } }; }
      return { cmd: 'recall', args: { ...base, thread: c1 } };
    }
    case 'prompt': {
      switch (c1) {
        case 'parse': case 'materialize': need(rest.length, `prompt ${c1} "text with @agent:Name @note:Name @file:path"`); return { cmd: `prompt.${c1}`, args: { text: rest.join(' ') } };
        case 'list': case 'undo': return { cmd: `prompt.${c1}`, args: {} };
        case 'read': case 'use': case 'delete': need(rest[0], `prompt ${c1} "name"`); return { cmd: `prompt.${c1}`, args: { name: rest[0] } };
        case 'save': need(rest[0] && rest.length > 1, 'prompt save "name" "text" [--global] [--overwrite]'); return { cmd: 'prompt.save', args: { name: rest[0], text: rest.slice(1).join(' '), global: !!flags.global, overwrite: !!flags.overwrite } };
        default: throw new Error('usage: prompt list|read|use|save|delete|undo|parse|materialize');
      }
    }
    case 'usage': {
      if (c1 === 'report') {
        need(flags.in !== undefined || flags.out !== undefined, 'usage report --in N --out N [--model M] [--cost USD]');
        return { cmd: 'usage.report', args: { input: flags.in, output: flags.out, model: flags.model, costUsd: flags.cost } };
      }
      if (c1 === 'reset') return { cmd: 'usage.reset', args: { terminal: rest[0] } };
      return { cmd: 'usage', args: { terminal: c1, days: flags.days ? Number(flags.days) : undefined, json: !!flags.json } };
    }
    case 'memory': need(c1 === 'status' || c1 === 'compress', 'memory status [thread] | memory compress [thread]'); return { cmd: `memory.${c1}`, args: { thread: rest[0] } };
    case 'guide': return { cmd: 'guide', args: {} };
    case 'debug': return { cmd: 'debug', args: {} };
    default: throw new Error(`unknown command "${c0}". Run: openmaestri help`);
  }
}

function call(socketPath, terminalId, cmd, args) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, ctx: { terminalId }, cmd, args }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl >= 0) { sock.end(); try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); } }
    });
    sock.on('error', (e) => reject(new Error(`cannot reach the openmaestri daemon at ${socketPath} (${e.code || e.message})`)));
    sock.on('close', () => { if (!buf.includes('\n')) reject(new Error('daemon closed the connection without replying')); });
  });
}

function openBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

/** Start (or reattach to) the daemon + web UI. Used from a normal shell, never from inside an agent terminal. */
async function serve(flags) {
  const { main, loadToken } = await import('../src/server.js');
  const { dataDir } = await import('../src/store.js');
  try {
    const app = await main();
    if (flags.open) openBrowser(app.url);
    const bye = async () => { await app.close(); process.exit(0); };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
    return new Promise(() => {}); // run until signalled
  } catch (e) {
    if (e.code !== 'ALREADY_RUNNING') throw e;
    const url = `http://127.0.0.1:${process.env.OPENMAESTRI_PORT ?? 7777}/?token=${loadToken(dataDir())}`;
    console.log(`openmaestri is already running\n  UI: ${url}`);
    if (flags.open) openBrowser(url);
    return 0;
  }
}

/** Secrets are for people: an agent in a terminal can neither read nor change them through this command. */
async function secretsCommand(parsed, insideTerminal) {
  if (insideTerminal) { console.error('openmaestri secrets: run it in your own shell, not inside an agent terminal.'); return 2; }
  const { Secrets, SecretError } = await import('../src/secrets.js');
  const { dataDir } = await import('../src/store.js');
  const { Audit } = await import('../src/audit.js');
  const audit = new Audit(path.join(dataDir(), 'audit.log'));
  const [, sub, name] = parsed.pos;
  try {
    const store = new Secrets({ root: dataDir() });
    if (sub === 'list') {
      for (const n of store.list()) console.log(`${n}  (secret://${n})`);
      return 0;
    }
    if (sub === 'status') { console.log(`backend: ${store.kind}\nstored: ${store.list().length}`); return 0; }
    if (sub === 'rm' && name) { audit.record('secret.remove', { name }, 'cli'); console.log(store.remove(name) ? `removed ${name}` : `no secret named ${name}`); return 0; }
    if (sub === 'set' && name) {
      store.set(name, await readSecretValue());
      audit.record('secret.set', { name, backend: store.kind }, 'cli');
      console.log(`stored ${name}. Use it in ${path.join(dataDir(), 'env')} as:  SOME_API_KEY=secret://${name}`);
      return 0;
    }
  } catch (e) {
    if (!(e instanceof SecretError)) throw e;
    console.error(`openmaestri secrets: ${e.message}`);
    return 1;
  }
  console.error('usage: openmaestri secrets set NAME   (value from stdin, or typed without echo)\n       openmaestri secrets list | status | rm NAME');
  return 2;
}

/** The value comes from a pipe, or is typed with the terminal echo off; it is never an argument (it would show in `ps` and shell history). */
async function readSecretValue() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }
  process.stderr.write('Value (hidden): ');
  const { stdin } = process;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let v = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); resolve(v); return; }
        if (c === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f') v = v.slice(0, -1); else v += c;
      }
    };
    stdin.on('data', onData);
  });
}

/** `openmaestri accounts set|list|rm`: named environments for agents. For people, outside agent terminals. */
async function accountsCommand(parsed, insideTerminal) {
  if (insideTerminal) { console.error('openmaestri accounts: run it in your own shell, not inside an agent terminal.'); return 2; }
  const { Accounts, AccountError } = await import('../src/accounts.js');
  const { Audit } = await import('../src/audit.js');
  const { dataDir } = await import('../src/store.js');
  const root = dataDir();
  const accounts = new Accounts(path.join(root, 'accounts.json'));
  const audit = new Audit(path.join(root, 'audit.log'));
  const [, sub, name, ...rest] = parsed.pos;
  try {
    if (sub === 'list') {
      for (const a of accounts.list()) console.log(`${a.name}  ${a.vars.join(' ')}`);
      return 0;
    }
    if (sub === 'set' && name && rest.length) {
      const pairs = {};
      for (const kv of rest) {
        const eq = kv.indexOf('=');
        if (eq < 1) throw new AccountError(`"${kv.slice(0, 30)}" is not VAR=value`);
        pairs[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      accounts.set(name, pairs);
      audit.record('account.set', { name, vars: Object.keys(pairs) }, 'cli');
      console.log(`account ${name} now has ${Object.keys(accounts.read()[name].env).length} variables. Use it with: recruit "Name" --preset P --account ${name}`);
      return 0;
    }
    if (sub === 'rm' && name) {
      const done = accounts.unset(name, rest) && (rest.length || accounts.remove(name));
      audit.record('account.remove', { name, vars: rest }, 'cli');
      console.log(done ? `removed ${rest.length ? rest.join(' ') + ' from ' : ''}${name}` : `no account named ${name}`);
      return 0;
    }
  } catch (e) {
    if (!(e instanceof AccountError)) throw e;
    console.error(`openmaestri accounts: ${e.message}`);
    return 1;
  }
  console.error('usage: openmaestri accounts set NAME VAR=value ...   (keys as VAR=secret://name)\n       openmaestri accounts list | rm NAME [VAR ...]');
  return 2;
}

/** `openmaestri audit [--verify] [--tail N]`: for people, outside agent terminals. */
async function auditCommand(parsed, insideTerminal) {
  if (insideTerminal) { console.error('openmaestri audit: run it in your own shell, not inside an agent terminal.'); return 2; }
  const { Audit } = await import('../src/audit.js');
  const { dataDir } = await import('../src/store.js');
  const log = new Audit(path.join(dataDir(), 'audit.log'));
  if (parsed.flags.verify) {
    const r = log.verify();
    if (r.ok) { console.log(`ok: ${r.count} events, head ${r.head ? r.head.slice(0, 16) : '(empty)'}`); return 0; }
    console.error(`BROKEN at line ${r.at}: ${r.problem}`);
    return 1;
  }
  const n = Math.min(Math.max(Number(parsed.flags.tail) || 20, 1), 500);
  for (const e of log.read(n)) console.log(`${e.seq ?? '?'}  ${e.at ?? ''}  ${e.event}  ${e.actor ?? ''}  ${e.detail ? JSON.stringify(e.detail) : ''}`);
  return 0;
}

/** `openmaestri persist list|stop`: the tmux sessions behind persistent terminals, from your own shell. */
async function persistCommand(parsed, insideTerminal) {
  if (insideTerminal) { console.error('openmaestri persist: run it in your own shell, not inside an agent terminal.'); return 2; }
  const { Persist } = await import('../src/persist.js');
  const p = Persist.detect();
  if (!p) { console.error('tmux is not installed (sudo apt install tmux).'); return 1; }
  const [, sub] = parsed.pos;
  const rows = p.details();
  if (sub === 'list') {
    if (!rows.length) console.log('No persistent sessions are running.');
    for (const r of rows) console.log(`${r.id}  since ${r.created.toISOString().slice(0, 16).replace('T', ' ')} UTC  running: ${r.command}`);
    return 0;
  }
  if (sub === 'stop') {
    if (!parsed.flags.yes) { console.error(`This ends ${rows.length} persistent session(s) and the programs in them. Run again with --yes to confirm.`); return 1; }
    const { Audit } = await import('../src/audit.js');
    const { dataDir } = await import('../src/store.js');
    let n = 0;
    for (const r of rows) if (p.kill(r.id)) n += 1;
    new Audit(path.join(dataDir(), 'audit.log')).record('persist.stop', { sessions: n }, 'cli');
    console.log(`ended ${n} session(s)`);
    return 0;
  }
  console.error('usage: openmaestri persist list | stop --yes');
  return 2;
}

/** `openmaestri desktop`: the optional Electron window (needs `npm --prefix desktop install` once). */
async function desktopCommand() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop');
  const electron = path.join(dir, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electron)) {
    console.error(`The desktop window is optional and not installed. Install it once with:\n  npm --prefix ${dir} install\nthen run: openmaestri desktop`);
    return 1;
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // set by some editors; it would make Electron behave as plain Node
  const child = spawn(electron, [dir], { env, stdio: 'inherit' });
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}

async function run(argv) {
  const parsed = parseArgs(argv);
  if (parsed.pos[0] === 'doctor') {
    const { runDoctor, formatDoctor } = await import('../src/doctor.js');
    const rows = await runDoctor();
    console.log(parsed.flags.json ? JSON.stringify(rows, null, 2) : formatDoctor(rows));
    return rows.some((r) => r.level === 'fail') ? 1 : 0;
  }
  const insideTerminal = !!process.env.OPENMAESTRI_SOCKET;
  if (parsed.pos[0] === 'secrets') return secretsCommand(parsed, insideTerminal);
  if (parsed.pos[0] === 'audit') return auditCommand(parsed, insideTerminal);
  if (parsed.pos[0] === 'accounts') return accountsCommand(parsed, insideTerminal);
  if (parsed.pos[0] === 'desktop' && !insideTerminal) return desktopCommand();
  if (parsed.pos[0] === 'persist') return persistCommand(parsed, insideTerminal);
  if (parsed.pos[0] === 'version' || parsed.flags.version) { console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); return 0; }
  if (!insideTerminal && (parsed.pos.length === 0 || parsed.pos[0] === 'serve') && !parsed.flags.help) return serve(parsed.flags);
  if (!parsed.pos.length || parsed.pos[0] === 'help' || parsed.flags.help) { console.log(HELP); return 0; }
  const socket = process.env.OPENMAESTRI_SOCKET;
  const terminalId = process.env.OPENMAESTRI_TERMINAL_ID;
  if (!socket || !terminalId) {
    console.error('openmaestri: only available inside openmaestri terminals (OPENMAESTRI_SOCKET not set).');
    return 2;
  }
  let req;
  try { req = build(parsed); } catch (e) { console.error(e.message); return 2; }
  try {
    const res = await call(socket, terminalId, req.cmd, req.args);
    if (!res.ok) { console.error(`openmaestri: ${res.error}`); return 1; }
    if (parsed.flags.json) console.log(JSON.stringify(res.data ?? { text: res.text }, null, 2));
    else if (res.text) console.log(res.text);
    return 0;
  } catch (e) {
    console.error(`openmaestri: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  process.exit(await run(process.argv.slice(2)));
}
