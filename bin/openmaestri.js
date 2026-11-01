#!/usr/bin/env node
// openmaestri CLI. Only works inside an openmaestri terminal: the daemon exports
// OPENMAESTRI_SOCKET / OPENMAESTRI_TERMINAL_ID into every pty it spawns.
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BOOL = new Set(['open', 'version', 'json', 'raw-flag', 'batch', 'force', 'none', 'clear', 'without-me', 'no-notify', 'disabled', 'reminder', 'agent', 'note', 'band', 'fichario', 'portal', 'help']);

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
  openmaestri note delete "Note"
  openmaestri portal create URL ["Name"] [--size WxH]
  openmaestri portal edit "Portal" --url URL | close "Portal" | info "Portal"
  openmaestri arrange ["Name" [--name N] [--color C] [--icon I]]
  Maestro terminals only:
  openmaestri recruit "Name" [--preset P] [--role R] [--dir PATH] [--command C] [--color C]
  openmaestri recruit "New" --preset P --replace "Old"
  openmaestri dismiss "Name"
  openmaestri connect "From" "To"   |   disconnect "From" "To"
  openmaestri preset list|show|create|set|delete ...
  openmaestri role list|show|create|write|edit|assign|delete ...
  openmaestri routine list|show|create|edit|enable|disable|run|delete ...
      schedules: --every 30m | --daily 09:00 | --weekly mon,fri@09:00 | --once "2026-12-01 15:00"
      options:   --terminal "Name" | --count N | --until DATE | --pre-run "cmd" ({{output}} in the command) | --no-notify | --disabled
  openmaestri workspace list|create|rename ...
  openmaestri floor status ["Text" --state working|blocked|review|done --progress 2/5 | --clear]
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
        case 'create': return { cmd: 'note.create', args: { content: name ?? '', name: flags.name, color: flags.color } };
        case 'read': need(name, 'note read "Note" [offset] [limit]'); return { cmd: 'note.read', args: { name, offset: more[0] ? Number(more[0]) : undefined, limit: more[1] ? Number(more[1]) : undefined } };
        case 'write': need(name && more.length, 'note write "Note" "content"'); return { cmd: 'note.write', args: { name, content: more.join(' ') } };
        case 'edit': need(name && more.length >= 2, 'note edit "Note" "old" "new"'); return { cmd: 'note.edit', args: { name, old: more[0], new: more[1] } };
        case 'delete': need(name, 'note delete "Note"'); return { cmd: 'note.delete', args: { name } };
        default: throw new Error('usage: note create|read|write|edit|delete');
      }
    }
    case 'portal': {
      const [a, b, ...more] = rest;
      switch (c1) {
        case 'create': need(a, 'portal create URL ["Name"] [--size WxH]'); return { cmd: 'portal.create', args: { url: a, name: b, size: flags.size } };
        case 'edit': need(a && flags.url, 'portal edit "Portal" --url URL'); return { cmd: 'portal.edit', args: { name: a, url: flags.url } };
        case 'close': need(a, 'portal close "Portal"'); return { cmd: 'portal.close', args: { name: a } };
        case 'info': need(a, 'portal info "Portal"'); return { cmd: 'portal.info', args: { name: a } };
        default: throw new Error(`portal ${c1 ?? ''}: page automation is not implemented in openmaestri yet (supported: create, edit, close, info)`);
      }
    }
    case 'arrange': return { cmd: 'arrange', args: { name: c1, newName: flags.name, color: flags.color, icon: flags.icon } };
    case 'recruit': return { cmd: 'recruit', args: { name: c1, preset: flags.preset, role: flags.role, dir: flags.dir, command: flags.command, color: flags.color, icon: flags.icon, replace: flags.replace, account: flags.account } };
    case 'dismiss': need(c1, 'dismiss "Name"'); return { cmd: 'dismiss', args: { name: c1 } };
    case 'connect': need(c1 && rest[0], 'connect "From" "To"'); return { cmd: 'connect', args: { from: c1, to: rest[0] } };
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
      if (c1 !== 'status') throw new Error('floor: only "floor status" is implemented (git-worktree floors are planned)');
      return { cmd: 'floor.status', args: { text: rest[0], state: flags.state, progress: flags.progress, clear: !!flags.clear } };
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
