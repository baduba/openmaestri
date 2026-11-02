// Terminals that survive a restart of openmaestri, by running each one inside its own tmux
// session on a private tmux server (socket name "openmaestri", no user config, no status bar, no
// prefix key). openmaestri attaches a client to the session; when openmaestri stops, the client
// goes away and the session keeps running; when it starts again it attaches to the same session.
//
// The tmux server is started with a nearly empty environment, and each session receives the
// environment of the moment it is created (listed through update-environment), so one terminal's
// keys never become another's. Values are passed in the environment of the tmux client, never on
// a command line where `ps` could show them.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { commandPath } from './terminals.js';

const SOCKET = 'openmaestri';
const PREFIX = 'om-';
const ID_RE = /^[0-9a-f-]{36}$/;

const clean = (env) => Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string'));

export class Persist {
  /** @param {{bin: string, socket?: string}} deps */
  constructor({ bin, socket = SOCKET }) {
    this.bin = bin;
    this.socket = socket;
  }

  /** A Persist for this machine, or null when tmux is not installed. */
  static detect(env = process.env) {
    const forced = env.OPENMAESTRI_TMUX;
    const bin = forced && path.isAbsolute(forced) ? forced : commandPath('tmux');
    const socket = /^[A-Za-z0-9_-]{1,40}$/.test(env.OPENMAESTRI_TMUX_SOCKET ?? '') ? env.OPENMAESTRI_TMUX_SOCKET : SOCKET;
    return bin ? new Persist({ bin, socket }) : null;
  }

  name(id) {
    if (!ID_RE.test(String(id))) throw new Error('not a terminal id');
    return `${PREFIX}${id}`;
  }

  run(args, { env, input } = {}) {
    return spawnSync(this.bin, ['-L', this.socket, '-f', '/dev/null', ...args], { env: clean(env ?? process.env), input, encoding: 'utf8', timeout: 10000 });
  }

  has(id) { return this.run(['has-session', '-t', `=${this.name(id)}`]).status === 0; }

  sessions() {
    const r = this.run(['list-sessions', '-F', '#{session_name}']);
    return r.status === 0 ? r.stdout.split('\n').filter((n) => n.startsWith(PREFIX) && ID_RE.test(n.slice(PREFIX.length))).map((n) => n.slice(PREFIX.length)) : [];
  }

  /** Start the private server with a minimal environment (once) and the options every session needs. */
  startServer(home) {
    const minimal = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TERM: 'xterm-256color', LANG: process.env.LANG ?? 'C.UTF-8' };
    this.run(['start-server', ';', 'set-option', '-g', 'exit-empty', 'off', ';', 'set-option', '-g', 'status', 'off', ';', 'set-option', '-g', 'prefix', 'None', ';', 'set-option', '-g', 'prefix2', 'None', ';', 'set-option', '-g', 'mouse', 'off', ';', 'set-option', '-g', 'escape-time', '0', ';', 'set-option', '-g', 'window-size', 'latest', ';', 'set-option', '-g', 'history-limit', '5000'], { env: minimal });
  }

  /**
   * Create the session for terminal `id` running `argv` in `cwd`.
   * @returns {boolean} whether it was created
   */
  create(id, { cwd, env, argv, cols, rows }) {
    this.startServer(env.HOME ?? '/');
    const names = Object.keys(env).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
    const r = this.run(['set-option', '-g', 'update-environment', names.join(' '), ';', 'new-session', '-d', '-s', this.name(id), '-x', String(cols), '-y', String(rows), '-c', cwd, '--', ...argv], { env });
    return r.status === 0;
  }

  /** Command and arguments for the client that shows the session. */
  attachArgs(id) { return { file: this.bin, args: ['-L', this.socket, '-f', '/dev/null', 'attach-session', '-t', `=${this.name(id)}`] }; }

  /** The program in the foreground of the session's pane, e.g. "claude" or "bash". */
  foreground(id) {
    const r = this.run(['display-message', '-p', '-t', `=${this.name(id)}:`, '#{pane_current_command}']);
    return r.status === 0 ? r.stdout.trim() : '';
  }

  /** [{id, created: Date, command}] for each running session, oldest first. */
  details() {
    const r = this.run(['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{pane_current_command}']);
    if (r.status !== 0) return [];
    return r.stdout.split('\n').filter(Boolean).map((line) => line.split('\t')).filter(([n]) => n.startsWith(PREFIX) && ID_RE.test(n.slice(PREFIX.length)))
      .map(([n, created, command]) => ({ id: n.slice(PREFIX.length), created: new Date(Number(created) * 1000), command: command ?? '' }))
      .sort((a, b) => a.created - b.created);
  }

  kill(id) { return this.run(['kill-session', '-t', `=${this.name(id)}`]).status === 0; }

  /** Remove sessions whose terminal no longer exists. */
  sweep(known) {
    const keep = new Set(known);
    let removed = 0;
    for (const id of this.sessions()) if (!keep.has(id) && this.kill(id)) removed += 1;
    return removed;
  }
}
