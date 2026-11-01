// PTY runtime. Each terminal node gets a pty plus a headless xterm that mirrors
// its screen, so `check` / `ask` can return what a human would actually see
// (cursor movement and redraws applied) instead of raw escape-sequence soup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import pty from 'node-pty';
import { refName } from './secrets.js';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

// Printed when the agent command ends, just before the fallback shell starts. The terminal
// recognises it so that chat messages are never typed into a plain shell.
const AGENT_EXIT_PRINTF = '\\033]777;openmaestri;agent-exit\\007';
const AGENT_EXIT_MARK = '\x1b]777;openmaestri;agent-exit\x07';

export class TerminalError extends Error {}

/** The program a command line starts: the first word that is not an NAME=value assignment. */
export function firstWord(command) {
  for (const raw of String(command ?? '').trim().split(/\s+/)) {
    if (!raw) continue;
    const word = raw.replace(/^["']|["']$/g, '');
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    return word;
  }
  return '';
}

const availableCache = new Map();
/** Ask the user's own interactive shell whether the program exists (it knows nvm, ~/.local/bin and friends). */
export function commandAvailable(command) {
  const word = firstWord(command);
  if (!word) return { ok: true, word: '' };
  const hit = availableCache.get(word);
  if (hit && Date.now() - hit.at < 60000) return { ok: hit.ok, word };
  let ok;
  if (word.includes('/')) { try { fs.accessSync(word, fs.constants.X_OK); ok = true; } catch { ok = false; } }
  else {
    try { execFileSync(defaultShell(), ['-ic', 'command -v -- "$0" >/dev/null 2>&1', word], { timeout: 5000, stdio: 'ignore' }); ok = true; } catch { ok = false; }
  }
  availableCache.set(word, { ok, at: Date.now() });
  return { ok, word };
}
const maxTerminals = () => Math.max(1, Number(process.env.OPENMAESTRI_MAX_TERMINALS) || 40);

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const SCROLLBACK = 5000;

/**
 * KEY=VALUE lines from <data dir>/env (keep it chmod 600). This is where API keys such as
 * DEEPSEEK_API_KEY live, so they never end up in workspace.json or in a repository.
 */
export function readUserEnv(file, resolve) {
  const out = {};
  let text;
  let fd;
  try {
    // stat and read through one descriptor so the file cannot be swapped between the check and the read
    fd = fs.openSync(file, 'r');
    if (fs.fstatSync(fd).mode & 0o077) console.warn(`[env] ${file} is readable by other users; run: chmod 600 ${file}`);
    text = fs.readFileSync(fd, 'utf8');
  } catch { return out; } finally { if (fd !== undefined) fs.closeSync(fd); }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.startsWith('export ') ? line.slice(7).trimStart() : line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (refName(v)) {
      // a reference to a stored secret; without the secret the variable is left out, never set to the reference text
      const secret = resolve?.(v);
      if (typeof secret !== 'string') { console.warn(`[env] ${m[1]} points to ${v}, which is not stored; run: openmaestri secrets set ${refName(v)}`); continue; }
      v = secret;
    }
    out[m[1]] = v;
  }
  return out;
}

/** POSIX single-quote escaping, safe for any path. */
const shellQuote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

function defaultShell() {
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return process.env.SHELL;
  return fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

class Runtime {
  constructor(node, proc, term, serializer) {
    this.node = node;
    this.proc = proc;
    this.term = term;
    this.serializer = serializer;
    this.lastDataAt = 0;
    this.bytes = 0;
    this.status = 'running';
    this.exitCode = null;
    this.agentExited = false;
    this.tail = '';
  }
}

export class Terminals extends EventEmitter {
  /**
   * @param {{socketPath: string, cliDir: string, cliBin: string}} env  values exported to children
   */
  constructor(env) {
    super();
    this.env = env;
    this.rt = new Map();
  }

  has(id) { return this.rt.has(id); }

  /** True while the terminal's agent command is the foreground program (not the fallback shell). */
  agentRunning(id) {
    const rt = this.rt.get(id);
    return !!rt && rt.status === 'running' && !rt.agentExited && !!rt.node.command && !rt.node.untrusted;
  }
  get(id) { return this.rt.get(id); }

  ensure(node, workspace) {
    const existing = this.rt.get(node.id);
    if (existing && existing.status === 'running') return existing;
    if (existing) this.dispose(node.id);
    return this.spawn(node, workspace);
  }

  spawn(node, workspace) {
    const running = [...this.rt.values()].filter((r) => r.status === 'running').length;
    if (running >= maxTerminals()) throw new TerminalError(`${running} terminals are already running (the limit is ${maxTerminals()}). Close some, or raise OPENMAESTRI_MAX_TERMINALS`);
    const shell = defaultShell();
    const cwd = node.cwd && fs.existsSync(node.cwd) ? node.cwd : workspace.dir && fs.existsSync(workspace.dir) ? workspace.dir : os.homedir();
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith('OPENMAESTRI_') || k.startsWith('ELECTRON_')) delete env[k];
    }
    Object.assign(env, readUserEnv(this.env.envFile, this.env.resolveSecret));
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      OPENMAESTRI_SOCKET: this.env.socketPath,
      OPENMAESTRI_TERMINAL_ID: node.id,
      OPENMAESTRI_WORKSPACE_ID: workspace.id,
      OPENMAESTRI_CLI: this.env.cliBin,
      OPENMAESTRI_NODE: process.execPath,
      OPENMAESTRI_WORKSPACE_DIR: workspace.dir,
      OPENMAESTRI_TERMINAL_NAME: node.name,
      PATH: `${this.env.cliDir}${path.delimiter}${env.PATH || ''}`,
    });
    // An agent command runs inside an interactive shell and falls back to that
    // shell when the agent exits, so the pane never silently dies.
    // a command that arrived through an imported file stays unrun until the user trusts it
    const command = node.untrusted ? '' : node.command;
    const args = command
      ? ['-i', '-c', `${command}\nprintf '${AGENT_EXIT_PRINTF}'\nexec ${shellQuote(shell)} -i`]
      : ['-i'];
    const proc = pty.spawn(shell, args, { name: 'xterm-256color', cols: DEFAULT_COLS, rows: DEFAULT_ROWS, cwd, env });
    const term = new Terminal({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS, scrollback: SCROLLBACK, allowProposedApi: true });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    const rt = new Runtime(node, proc, term, serializer);
    this.rt.set(node.id, rt);

    proc.onData((data) => {
      if (!rt.agentExited) {
        rt.tail = (rt.tail + data).slice(-80);
        if (rt.tail.includes(AGENT_EXIT_MARK)) rt.agentExited = true;
      }
      rt.lastDataAt = Date.now();
      rt.bytes += data.length;
      term.write(data);
      this.emit('data', node.id, data);
    });
    proc.onExit(({ exitCode }) => {
      rt.status = 'exited';
      rt.exitCode = exitCode;
      this.emit('exit', node.id, exitCode);
    });
    this.emit('status', node.id, 'running');
    return rt;
  }

  write(id, data) {
    const rt = this.rt.get(id);
    if (rt && rt.status === 'running') rt.proc.write(data);
  }

  resize(id, cols, rows) {
    const rt = this.rt.get(id);
    if (!rt || rt.status !== 'running') return;
    cols = Math.max(2, Math.min(500, cols | 0));
    rows = Math.max(1, Math.min(300, rows | 0));
    if (cols === rt.term.cols && rows === rt.term.rows) return;
    rt.proc.resize(cols, rows);
    rt.term.resize(cols, rows);
  }

  /** Replay string that reconstructs the current screen + scrollback in a fresh xterm. */
  snapshot(id) {
    const rt = this.rt.get(id);
    return rt ? rt.serializer.serialize({ scrollback: 1000 }) : '';
  }

  /** Absolute index of the line the cursor is on (scrollback included). */
  cursorLine(id) {
    const rt = this.rt.get(id);
    if (!rt) return 0;
    const b = rt.term.buffer.active;
    return b.baseY + b.cursorY;
  }

  /** Visible text from `fromLine` (absolute) to the end, trailing blanks trimmed. */
  text(id, { fromLine = null, lastLines = 200 } = {}) {
    const rt = this.rt.get(id);
    if (!rt) return '';
    const b = rt.term.buffer.active;
    const total = b.length;
    const start = Math.max(0, Math.min(fromLine ?? 0, total));
    const out = [];
    for (let i = start; i < total; i++) {
      const line = b.getLine(i);
      if (!line) continue;
      // isWrapped lines are continuations of the previous row
      const s = line.translateToString(true);
      if (line.isWrapped && out.length) out[out.length - 1] += s;
      else out.push(s);
    }
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    while (out.length && out[0].trim() === '') out.shift();
    // the buffer includes blank viewport rows below the cursor, so cut only after trimming them
    return (fromLine == null && lastLines ? out.slice(-lastLines) : out).join('\n');
  }

  status(id) {
    const rt = this.rt.get(id);
    if (!rt) return 'stopped';
    if (rt.status === 'exited') return 'exited';
    return Date.now() - rt.lastDataAt < 1500 ? 'working' : 'idle';
  }

  /**
   * Type a prompt into the terminal the way a person would. When the app has
   * bracketed paste on (every modern agent TUI), multi-line text is pasted as
   * one unit so embedded newlines do not submit early.
   */
  deliver(id, text, { submit = true } = {}) {
    const rt = this.rt.get(id);
    if (!rt || rt.status !== 'running') throw new Error('terminal is not running');
    this.emit('turn', id);
    const bracketed = rt.term.modes.bracketedPasteMode;
    const body = bracketed ? `\x1b[200~${text}\x1b[201~` : text.replace(/\r?\n/g, '\r');
    rt.proc.write(body);
    if (submit) setTimeout(() => rt.status === 'running' && rt.proc.write('\r'), bracketed ? 150 : 20);
  }

  /** Resolve once output has been quiet for `quietMs`, or `timeoutMs` elapsed. */
  waitIdle(id, { quietMs = 2000, timeoutMs = 120000, since = Date.now() } = {}) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const rt = this.rt.get(id);
        if (!rt || rt.status !== 'running') return resolve('exited');
        const now = Date.now();
        const sawOutput = rt.lastDataAt >= since;
        if (sawOutput && now - rt.lastDataAt >= quietMs) return resolve('idle');
        if (now - started >= timeoutMs) return resolve('timeout');
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  kill(id) {
    const rt = this.rt.get(id);
    if (rt && rt.status === 'running') {
      try { rt.proc.kill(); } catch {}
    }
  }

  dispose(id) {
    const rt = this.rt.get(id);
    if (!rt) return;
    this.kill(id);
    rt.term.dispose();
    this.rt.delete(id);
  }

  disposeAll() {
    for (const id of [...this.rt.keys()]) this.dispose(id);
  }
}
