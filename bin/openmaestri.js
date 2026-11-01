#!/usr/bin/env node
// openmaestri CLI. Only works inside an openmaestri terminal: the daemon exports
// OPENMAESTRI_SOCKET / OPENMAESTRI_TERMINAL_ID into every pty it spawns.
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BOOL = new Set(['existing-branch', 'copy', 'no-git', 'copy-ground', 'delete-branch', 'keep-floor', 'keep-branch', 'keep-folder', 'open', 'version', 'json', 'raw-flag', 'batch', 'force', 'none', 'clear', 'without-me', 'no-notify', 'disabled', 'reminder', 'agent', 'note', 'band', 'fichario', 'portal', 'help']);

const HELP = `openmaestri - a spatial workspace for AI agents (open implementation)

Usage:
  openmaestri [serve] [--open]                       Start the app (outside a terminal): daemon + web UI. --open launches the browser
  openmaestri list                                   List connected agents, notes and portals
  openmaestri notify "message"                       Send the user a notification
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
  openmaestri recruit "New" --preset P --replace "Old"
  openmaestri dismiss "Name"
  openmaestri connect "From" "To" [--agent|--band|--note|--fichario|--portal]   |   disconnect "From" "To"
  openmaestri band create "Name" ["Agent" ...] [--without-me] | add "Band" "Agent" | remove "Band" "Agent" | dissolve "Band"
  openmaestri partitura list | insert "Name" | create "Name" ["Agent" ...] [--commands on|off] [--note-text on|off] [--scope current|global] | update ... | delete "Name"
  openmaestri preset list|show|create|set|delete ...
  openmaestri role list|show|create|write|edit|assign|delete ...
  openmaestri routine list|show|create|edit|enable|disable|run|delete ...
      schedules: --every 30m | --daily 09:00 | --weekly mon,fri@09:00 | --once "2026-12-01 15:00"
      options:   --terminal "Name" | --count N | --until DATE | --pre-run "cmd" ({{output}} in the command) | --no-notify | --disabled
  openmaestri workspace list|create|rename ...
  openmaestri floor create "Name" [--from PATH] [--branch B] [--existing-branch] [--copy] [--no-git] [--copy-ground] [--partitura P] | --dir PATH | --pull-request N|URL
  openmaestri floor list | land "Name" [--into B] [--delete-branch] [--keep-floor] | delete "Name" [--keep-branch] [--keep-folder] [--force] | set-dir "Name" PATH | unload "Name"
  openmaestri floor status ["Text" --state working|blocked|review|done --progress 2/5 | --clear] [--floor F]
  openmaestri recruit ... [--floor F]   (place the teammate on another floor; "Ground" for the ground floor)
  openmaestri guide                                  How agents should use openmaestri (give this to your agent)
  openmaestri debug
Global flags: --json (machine-readable output)`;

export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const key = (eq > 0 ? a.slice(2, eq) : a.slice(2));
      if (eq > 0) flags[key] = a.slice(eq + 1);
      else if (BOOL.has(key)) flags[key] = true;
      else if (argv[i + 1] !== undefined) flags[key] = argv[++i];
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
    case 'check': need(c1, 'check "Agent" [--lines N]'); return { cmd: 'check', args: { name: c1, lines: flags.lines ? Number(flags.lines) : undefined } };
    case 'note': {
      const [name, ...more] = rest;
      switch (c1) {
        case 'create': return { cmd: 'note.create', args: { content: name ?? '', name: flags.name, color: flags.color, stack: flags.stack } };
        case 'stack': need(name, 'note stack "Note" ["Stack"]'); return { cmd: 'note.stack', args: { name, stack: more[0] } };
        case 'unstack': need(name, 'note unstack "Note"'); return { cmd: 'note.unstack', args: { name } };
        case 'read': need(name, 'note read "Note" [offset] [limit]'); return { cmd: 'note.read', args: { name, offset: more[0] ? Number(more[0]) : undefined, limit: more[1] ? Number(more[1]) : undefined } };
        case 'write': need(name && more.length, 'note write "Note" "content"'); return { cmd: 'note.write', args: { name, content: more.join(' ') } };
        case 'edit': need(name && more.length >= 2, 'note edit "Note" "old" "new"'); return { cmd: 'note.edit', args: { name, old: more[0], new: more[1] } };
        case 'delete': need(name || flags.stack, 'note delete "Note" | note delete --stack "Stack"'); return { cmd: 'note.delete', args: { name, stack: flags.stack } };
        default: throw new Error('usage: note create|read|write|edit|stack|unstack|delete');
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
        default: throw new Error('usage: partitura list|insert|create|update|delete');
      }
    }
    case 'recruit': return { cmd: 'recruit', args: { name: c1, preset: flags.preset, role: flags.role, dir: flags.dir, command: flags.command, color: flags.color, icon: flags.icon, replace: flags.replace, account: flags.account, floor: flags.floor } };
    case 'dismiss': need(c1, 'dismiss "Name"'); return { cmd: 'dismiss', args: { name: c1 } };
    case 'connect': need(c1 && rest[0], 'connect "From" "To" [--agent|--band|--note|--fichario|--portal]'); return { cmd: 'connect', args: { from: c1, to: rest[0], kind: ['agent', 'band', 'note', 'fichario', 'portal'].find((k) => flags[k]) } };
    case 'disconnect': need(c1 && rest[0], 'disconnect "From" "To"'); return { cmd: 'disconnect', args: { from: c1, to: rest[0] } };
    case 'preset': {
      const [name] = rest;
      switch (c1) {
        case 'list': return { cmd: 'preset.list', args: {} };
        case 'show': case 'delete': need(name, `preset ${c1} "Name"`); return { cmd: `preset.${c1}`, args: { name } };
        case 'create': need(name, 'preset create "Name" [--command C] [--maestro on|off]'); return { cmd: 'preset.create', args: { name, command: flags.command, maestro: onOff(flags.maestro) } };
        case 'set': need(name, 'preset set "Name" [--name N] [--command C] [--maestro on|off]'); return { cmd: 'preset.set', args: { name, newName: flags.name, command: flags.command, maestro: onOff(flags.maestro) } };
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
        default: throw new Error('usage: role list|show|create|write|edit|assign|delete');
      }
    }
    case 'routine': {
      const [name] = rest;
      const sched = { every: flags.every, daily: flags.daily, weekly: flags.weekly, once: flags.once };
      switch (c1) {
        case 'list': return { cmd: 'routine.list', args: {} };
        case 'show': case 'enable': case 'disable': case 'run': case 'delete': need(name, `routine ${c1} "Name"`); return { cmd: `routine.${c1}`, args: { name } };
        case 'create': need(name && flags.command, 'routine create "Name" --command "..." <schedule>');
          return { cmd: 'routine.create', args: { name, command: flags.command, terminal: flags.terminal, ...sched, count: flags.count, until: flags.until, preRun: flags['pre-run'], noNotify: !!flags['no-notify'], disabled: !!flags.disabled, reminder: !!flags.reminder } };
        case 'edit': need(name, 'routine edit "Name" [flags]'); return { cmd: 'routine.edit', args: { name, newName: flags.name, command: flags.command, terminal: flags.terminal, ...sched } };
        default: throw new Error('usage: routine list|show|create|edit|enable|disable|run|delete');
      }
    }
    case 'workspace': {
      const [name, ...more] = rest;
      switch (c1) {
        case 'list': return { cmd: 'workspace.list', args: {} };
        case 'create': need(name && flags.dir, 'workspace create "Name" --dir PATH [--from "Source"]'); return { cmd: 'workspace.create', args: { name, dir: flags.dir, from: flags.from } };
        case 'rename': need(name && more[0], 'workspace rename "Current" "New"'); return { cmd: 'workspace.rename', args: { name, newName: more[0] } };
        default: throw new Error('usage: workspace list|create|rename');
      }
    }
    case 'floor': {
      const [name, p2] = rest;
      switch (c1) {
        case 'create': need(name || flags['pull-request'], 'floor create "Name" [--from PATH] [--branch B] [--existing-branch] [--copy] [--no-git] [--copy-ground] [--partitura P] | --dir PATH | --pull-request N|URL');
          return { cmd: 'floor.create', args: { name, from: flags.from, branch: flags.branch, existingBranch: !!flags['existing-branch'], copy: !!flags.copy, noGit: !!flags['no-git'], copyGround: !!flags['copy-ground'], partitura: flags.partitura, dir: flags.dir, pullRequest: flags['pull-request'] } };
        case 'list': return { cmd: 'floor.list', args: {} };
        case 'land': need(name, 'floor land "Name" [--into BRANCH] [--delete-branch] [--keep-floor]'); return { cmd: 'floor.land', args: { name, into: flags.into, deleteBranch: !!flags['delete-branch'], keepFloor: !!flags['keep-floor'] } };
        case 'delete': need(name, 'floor delete "Name" [--keep-branch] [--keep-folder] [--force]'); return { cmd: 'floor.delete', args: { name, keepBranch: !!flags['keep-branch'], keepFolder: !!flags['keep-folder'], force: !!flags.force } };
        case 'set-dir': need(name && p2, 'floor set-dir "Name" PATH'); return { cmd: 'floor.set-dir', args: { name, path: p2 } };
        case 'unload': need(name, 'floor unload "Name"'); return { cmd: 'floor.unload', args: { name } };
        case 'status': return { cmd: 'floor.status', args: { text: name, state: flags.state, progress: flags.progress, clear: !!flags.clear, floor: flags.floor } };
        default: throw new Error('usage: floor create|list|land|delete|set-dir|unload|status');
      }
    }
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

async function run(argv) {
  const parsed = parseArgs(argv);
  const insideTerminal = !!process.env.OPENMAESTRI_SOCKET;
  if (!insideTerminal && (parsed.pos.length === 0 || parsed.pos[0] === 'serve') && !parsed.flags.help) return serve(parsed.flags);
  if (!parsed.pos.length || parsed.pos[0] === 'help' || parsed.flags.help) { console.log(HELP); return 0; }
  if (parsed.pos[0] === 'version' || parsed.flags.version) { console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); return 0; }
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
