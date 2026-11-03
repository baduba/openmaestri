// Core: owns the store, the terminal runtime and the scheduler, and implements
// every command that either the CLI (inside a terminal) or the UI can issue.
import crypto from 'node:crypto';
import { Secrets } from './secrets.js';
import { Audit, sha256 } from './audit.js';
import { Accounts, AccountError } from './accounts.js';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Store, dataDir } from './store.js';
import { GUIDE } from './prompts.js';
import { Terminals } from './terminals.js';
import { freePortBase, floorVars } from './ports.js';
import { Mcp, McpError, buildServer, mcpText, planInstall } from './mcp.js';
import { Facts, FactsError, factsText, factsBrief, factsBlock } from './facts.js';
import { handoffText, takeoverLine, SELF_REPORT_PROMPT } from './handoff.js';
import { DRIVERS, customDrivers, workerEnv, runHeadless, HeadlessError, checkSandbox, quotaRefused, dockerTerminalCommand } from './headless.js';
import { discover as discoverRoles, plan as planRole, diffText, agentKind, RoleError, AGENT_FILES } from './roles.js';
import { Files, FilesError } from './files.js';
import { Persist } from './persist.js';
import { redact as redactChat } from './memory.js';
import { tree as procTree, summarize as procSummary, stopProcess, ProcError } from './procinfo.js';
import { runHook, describeHook, checkCommand, HookError } from './hooks.js';
import { takeSnapshot, listSnapshots, rollback as rollbackFloor, dropSnapshots } from './snapshots.js';
import { ForgeError, detectProvider, normalizeProvider, providerInfo, listChanges, formatChanges } from './forge.js';
import { newScreenText, looksBusy } from './screen.js';
import { MAX_AGENTS, parseAgents, planText, reportText } from './taskrun.js';
import { Usage, UsageError } from './usage.js';
import { readUserEnv, TerminalError, commandAvailable, commandPath } from './terminals.js';
import { PromptLib, PromptError } from './promptlib.js';
import { Chat, ChatError, THREAD_IDS, threadId, cleanText } from './chat.js';
import { materialize as materializeMentions, parse as parseMentions, fileIndex, rank, readMentionedFile } from './prompter.js';
import { Portals, PortalError, checkUrl } from './portals.js';
import { History } from './history.js';
import { tidy as tidyLayout } from './layout.js';
import { capturePartitura, instantiatePartitura, exportPartitura, importPartitura } from './transfer.js';
import { createFloor, removeFloor, landFloor, floorStateOf, findFloor, groundOf, floorById, repoTop, git, withLock, FloorError } from './floors.js';
import { Scheduler, parseSchedule, describeSchedule, nextRun } from './routines.js';

export class CommandError extends Error {}
const fail = (msg) => { throw new CommandError(msg); };

/** Escapes accepted by `ask --raw`: \n \t \e \r \\ and \xNN. */
export function unescapeRaw(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|[ntre\\])/g, (_m, g) => {
    if (g[0] === 'x') return String.fromCharCode(parseInt(g.slice(1), 16));
    return { n: '\r', t: '\t', r: '\r', e: '\x1b', '\\': '\\' }[g];
  });
}

export class Core extends EventEmitter {
  constructor({ dataRoot = dataDir(), socketPath, cliDir, cliBin }) {
    super();
    this.store = new Store(dataRoot);
    this.persist = null;
    // the secret store is opened lazily: a broken keyring must not stop the daemon, only the references that need it
    let secrets = null;
    const resolveSecret = (ref) => { try { secrets ??= new Secrets({ root: dataRoot }); return secrets.resolve(ref); } catch { return undefined; } };
    this.audit = new Audit(path.join(dataRoot, 'audit.log'));
    this.facts = new Facts({ dir: (id) => this.store.wsDir(id) });
    this.mcp = new Mcp({ dir: (id) => this.store.wsDir(id) });
    this.resolveSecret = resolveSecret;
    this.headless = new Set();
    this.accounts = new Accounts(path.join(dataRoot, 'accounts.json'));
    const accountEnv = (name) => { try { return this.accounts.env(name, resolveSecret); } catch (e) { console.warn(`[accounts] ${e.message}`); return {}; } };
    this.terminals = new Terminals({ socketPath, cliDir, cliBin, envFile: path.join(dataRoot, 'env'), resolveSecret, accountEnv, floorEnv: (w, n) => this.floorEnv(w, n), sandboxCommand: (n, c, d) => this.terminalBox(n, c, d) });
    this.socketPath = socketPath;
    this.startedAt = Date.now();
    this.notifyLog = new Map();
    this.history = new History();
    this.portals = new Portals({ dataRoot, uploadRoots: () => this.uploadRoots() });
    this.chat = new Chat({ store: this.store, allowedRoots: (wsId) => this.chatRoots(wsId) });
    this.prompts = new PromptLib({ globalDir: path.join(dataRoot, 'prompts'), localDir: (id) => path.join(this.store.wsDir(id), 'prompts') });
    this.usage = new Usage({ file: path.join(dataRoot, 'usage.json'), pricesFile: path.join(dataRoot, 'prices.json') });
    this.dataRoot = dataRoot;
    this.files = new Files({ backupDir: (id) => path.join(this.store.wsDir(id), 'file-backups') });
    this.attention = new Map(); // workspace id -> Set of terminal ids waiting for the human
    this.sayLog = new Map();
    this.scheduler = new Scheduler({
      workspaces: () => this.store.workspaces.values(),
      changed: (ws) => this.touch(ws),
      fire: (ws, r, text) => {
        const node = ws.nodes.find((n) => n.id === r.terminalId);
        if (!node) return;
        this.terminals.ensure(node, ws);
        this.terminals.deliver(node.id, text);
        if (r.notify) this.emit('notify', { workspaceId: ws.id, from: `routine ${r.name}`, message: `Fired: ${r.name}` });
      },
    });
  }

  start() {
    // the undo baseline of a workspace is its state when it appeared, so even its first change can be undone
    this.store.onCreate = (ws) => this.history.entry(ws);
    this.store.load();
    // persistent terminals are decided once the settings are known; leftovers of deleted terminals are cleared
    const wantsPersist = process.env.OPENMAESTRI_PERSIST === 'tmux' || this.store.settings.persistTerminals === true;
    this.persist = wantsPersist ? Persist.detect() : null;
    if (wantsPersist && !this.persist) console.warn('[persist] tmux was asked for but is not installed; terminals will not survive a restart');
    this.terminals.persist = this.persist;
    this.persist?.sweep([...this.store.workspaces.values()].flatMap((w) => w.nodes.filter((n) => n.kind === 'terminal').map((n) => n.id)));
    for (const ws of this.store.workspaces.values()) this.history.entry(ws);
    this.scheduler.start();
    this.terminals.on('data', (id, data) => this.emit('term-data', id, data));
    this.terminals.on('exit', (id, code) => this.emit('term-status', id, 'exited', code));
    this.terminals.on('status', (id, st) => this.emit('term-status', id, st));
    this.chat.on('message', (wsId, message) => this.emit('chat-message', wsId, message));
    this.chat.on('progress', (wsId, message) => this.emit('chat-progress', wsId, message));
    this.chat.on('state', (wsId) => this.emit('chat-state', wsId));
    this.prompts.on('changed', (wsId) => this.emit('prompts-changed', wsId));
    this.terminals.on('data', (id, data) => this.usage.observe(id, data, () => this.usageCtx(id)));
    this.terminals.on('turn', (id) => this.usage.turn(id));
    this.usage.on('changed', () => this.emit('usage-changed'));
    this.usageTimer = setInterval(() => { for (const [id] of this.terminals.rt) if (this.terminals.status(id) === 'working') this.usage.tick(id); }, 1000);
    this.usageTimer.unref();
  }

  stop() {
    clearInterval(this.usageTimer);
    this.usage.close();
    this.prompts.close();
    this.portals.stop().catch(() => { /* shutting down */ });
    this.scheduler.stop();
    this.store.flush();
    for (const ac of this.headless) ac.abort();
    this.terminals.disposeAll();
  }

  // ---------- state helpers ----------
  payload(ws) {
    const notes = {};
    for (const n of ws.nodes) if (n.kind === 'note') notes[n.id] = this.store.readNote(ws.id, n.id);
    const status = {};
    for (const n of ws.nodes) if (n.kind === 'terminal') status[n.id] = this.terminals.status(n.id);
    const usage = {};
    for (const n of ws.nodes) if (n.kind === 'terminal') usage[n.id] = this.usage.summary(n.id);
    return { ...ws, notes, status, history: this.history.state(ws), chat: this.chatState(ws), usage };
  }

  /** What the preferences window shows. Only a few switches can be changed from the interface. */
  preferences() {
    const tmux = Persist.detect();
    return {
      version: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
      dataDir: this.dataRoot,
      persistTerminals: this.store.settings.persistTerminals === true || process.env.OPENMAESTRI_PERSIST === 'tmux',
      persistActive: !!this.persist,
      persistForcedByEnv: process.env.OPENMAESTRI_PERSIST === 'tmux',
      tmuxInstalled: !!tmux,
      onboarded: this.store.settings.onboarded === true,
      secretStore: (() => { try { return new Secrets({ root: this.dataRoot }).kind; } catch { return 'unavailable'; } })(),
    };
  }

  summary() {
    return {
      active: this.store.settings.activeWorkspaceId,
      workspaces: [...this.store.workspaces.values()].map((w) => ({ id: w.id, name: w.name, dir: w.dir, nodes: w.nodes.length, icon: w.icon ?? null, group: w.group ?? null, running: w.nodes.filter((n) => n.kind === 'terminal' && this.terminals.has(n.id)).length })),
      presets: this.store.settings.presets,
      accounts: (() => { try { return this.accounts.list().map((a) => a.name); } catch { return []; } })(),
      portalsAvailable: this.portals.available,
      partituras: (this.store.settings.partituras ?? []).map((p) => ({ id: p.id, name: p.name, description: p.description, icon: p.icon, color: p.color, scope: p.scope, nodes: p.nodes.length })),
    };
  }

  /** Mark a workspace changed: persist (debounced) and tell every listener. */
  touch(ws) {
    this.reapPortals();
    this.reapUsage();
    this.history.record(ws);
    this.store.saveWorkspace(ws.id);
    this.emit('workspace', ws.id);
  }

  /** Replace the structure with a snapshot from history; terminals of removed nodes stop, trashed notes return. */
  applySnapshot(ws, snap) {
    const before = new Set(ws.nodes.map((n) => n.id));
    ws.nodes = snap.nodes;
    ws.connections = snap.connections;
    const after = new Set(ws.nodes.map((n) => n.id));
    for (const id of before) if (!after.has(id)) this.terminals.dispose(id);
    for (const n of ws.nodes) if (n.kind === 'note' && !before.has(n.id)) this.store.untrashNote(ws.id, n.id);
    ws.routines = ws.routines.filter((r) => after.has(r.terminalId));
    this.store.saveWorkspace(ws.id);
    this.emit('workspace', ws.id);
  }

  undo(ws) {
    const snap = this.history.undo(ws);
    if (!snap) return false;
    this.applySnapshot(ws, snap);
    return true;
  }

  redo(ws) {
    const snap = this.history.redo(ws);
    if (!snap) return false;
    this.applySnapshot(ws, snap);
    return true;
  }

  tidy(ws, floorId = null) {
    const pos = tidyLayout(ws, { x: 0, y: 0 }, floorId);
    for (const [id, p] of pos) this.store.patchNode(ws, id, p);
    this.touch(ws);
  }

  partiturasFor(ws) {
    return (this.store.settings.partituras ?? []).filter((p) => p.scope === null || p.scope === ws.id);
  }

  wsOrFail(id) {
    return this.store.workspaces.get(id) || fail(`unknown workspace: ${id}`);
  }
  nodeOrFail(ws, id) {
    return ws.nodes.find((n) => n.id === id) || fail(`unknown node: ${id}`);
  }

  // ---------- name resolution ----------
  reachable(ws, me) {
    if (!me.maestro) return this.store.neighbors(ws, me.id);
    // a Maestro sees its whole floor, plus whatever is cabled to it from other floors
    const mine = (me.floorId ?? null);
    const extra = new Set(this.store.neighbors(ws, me.id).map((n) => n.id));
    return ws.nodes.filter((n) => n.id !== me.id && n.kind !== 'band' && ((n.floorId ?? null) === mine || extra.has(n.id)));
  }

  resolve(ws, me, name, kinds = null) {
    if (!name) fail('a name is required');
    const pool = this.reachable(ws, me).filter((n) => !kinds || kinds.includes(n.kind));
    const lc = String(name).toLowerCase();
    const exact = pool.filter((n) => n.name.toLowerCase() === lc);
    if (exact.length === 1) return exact[0];
    const prefix = pool.filter((n) => n.name.toLowerCase().startsWith(lc));
    if (prefix.length === 1) return prefix[0];
    if (prefix.length > 1) fail(`"${name}" is ambiguous: ${prefix.map((n) => n.name).join(', ')}`);
    fail(`no ${kinds ? kinds.join('/') : 'node'} named "${name}" is connected to you. Connected: ${pool.map((n) => n.name).join(', ') || '(none)'}`);
  }

  resolveAny(ws, name, kinds = null) {
    const lc = String(name).toLowerCase();
    const pool = ws.nodes.filter((n) => !kinds || kinds.includes(n.kind));
    const hit = pool.find((n) => n.name.toLowerCase() === lc) || pool.filter((n) => n.name.toLowerCase().startsWith(lc));
    if (Array.isArray(hit)) {
      if (hit.length === 1) return hit[0];
      fail(hit.length ? `"${name}" is ambiguous: ${hit.map((n) => n.name).join(', ')}` : `no node named "${name}"`);
    }
    return hit || fail(`no node named "${name}"`);
  }

  requireMaestro(me) {
    if (!me.maestro) fail('this command is only available to Maestro terminals');
  }

  // ---------- spawning ----------
  startTerminal(ws, node) {
    return this.terminals.ensure(node, ws);
  }

  placeBeside(ws, anchor, size) {
    const gap = 60;
    const x = anchor.x + anchor.w + gap;
    let y = anchor.y;
    const sameFloor = ws.nodes.filter((n) => (n.floorId ?? null) === (anchor.floorId ?? null));
    const overlaps = (yy) => sameFloor.some((n) => x < n.x + n.w + 20 && x + size.w + 20 > n.x && yy < n.y + n.h + 20 && yy + size.h + 20 > n.y);
    while (overlaps(y)) y += 40;
    return { x, y };
  }

  // ---------- CLI commands ----------
  /**
   * @param {{terminalId: string}} ctx  caller identity (from the env the pty was spawned with)
   */
  async command(ctx, cmd, a = {}) {
    const ws = this.store.workspaceOfNode(ctx.terminalId) || fail('unknown terminal (was it removed?)');
    const me = this.nodeOrFail(ws, ctx.terminalId);
    const h = Object.hasOwn(HANDLERS, cmd) ? HANDLERS[cmd] : null;
    if (!h) fail(`unknown command: ${cmd}`);
    try {
      return await h.call(this, ws, me, a);
    } catch (e) {
      if (e instanceof ChatError || e instanceof PromptError || e instanceof UsageError || e instanceof RoleError || e instanceof TerminalError || e instanceof FilesError || e instanceof HeadlessError || e instanceof FactsError || e instanceof McpError || e instanceof ForgeError || e instanceof AccountError || e instanceof HookError || e instanceof ProcError) fail(e.message);
      throw e;
    }
  }

  get handlers() {
    return HANDLERS;
  }
}

const textOf = (rows) => rows.join('\n');
const kindLabel = { terminal: 'agent', note: 'note', portal: 'portal', stack: 'stack', band: 'band' };
const KIND_FLAGS = { agent: 'terminal', note: 'note', portal: 'portal', fichario: 'stack', stack: 'stack', band: 'band' };

const MAX_HEADLESS = MAX_AGENTS;

/** One row of `ps`. */
function psLine(name, pid, sum, status, persistent) {
  const cols = [name.padEnd(20), String(pid ?? '-').padStart(7), `${String(sum.processes).padStart(3)} proc`, `${String(sum.rssMb).padStart(5)} MB`, `${String(sum.cpuSeconds).padStart(7)} s cpu`, `[${status}]`];
  return `${cols.join('  ')}${persistent ? ' [kept in tmux]' : ''}`;
}

const HANDLERS = {
  guide() {
    return { text: GUIDE };
  },

  list(ws, me) {
    const nodes = this.reachable(ws, me);
    const rows = nodes.map((n) => {
      const extra = n.kind === 'terminal' ? ` [${this.terminals.status(n.id)}]${n.maestro ? ' (maestro)' : ''}` : n.kind === 'portal' ? ` ${n.url}` : '';
      return `${kindLabel[n.kind].padEnd(7)} ${n.name}${extra}`;
    });
    const myBands = ws.nodes.filter((n) => n.kind === 'band' && n.members.includes(me.id));
    for (const b of myBands) rows.push(`band    ${b.name} (${b.members.map((m) => ws.nodes.find((n) => n.id === m)?.name).join(', ')})`);
    return {
      text: rows.length ? textOf(rows) : '(nothing is connected to this terminal)',
      data: { self: me.name, workspace: ws.name, nodes: nodes.map((n) => ({ name: n.name, kind: n.kind, status: n.kind === 'terminal' ? this.terminals.status(n.id) : undefined, maestro: n.maestro || undefined, url: n.url })) },
    };
  },

  notify(ws, me, { message }) {
    if (!message) fail('usage: notify "message"');
    // a looping agent must not be able to flood the human with notifications
    const now = Date.now();
    const recent = (this.notifyLog.get(me.id) ?? []).filter((t) => now - t < 60000);
    if (recent.length >= 20) fail('notification rate limit reached (20 per minute)');
    this.notifyLog.set(me.id, [...recent, now]);
    this.markAttention(ws, me.id);
    this.emit('notify', { workspaceId: ws.id, from: me.name, message: String(message).slice(0, 500) });
    return { text: 'sent' };
  },

  async ask(ws, me, { name, prompt, raw, timeoutMs = 120000, quietMs }) {
    const target = this.resolve(ws, me, name, ['terminal']);
    if (target.id === me.id) fail('an agent cannot ask itself');
    this.startTerminal(ws, target);
    // a teammate that was just started is still drawing its screen, and what is typed meanwhile is lost: let it settle first
    const rt = this.terminals.rt.get(target.id);
    if (raw == null && rt && Date.now() - rt.startedAt < 60000) await this.terminals.whenReady(target.id, { busy: () => looksBusy(this.terminals.lines(target.id, 60)) });
    const since = Date.now();
    const fromLine = this.terminals.cursorLine(target.id);
    const before = this.terminals.lines(target.id);
    if (raw != null) {
      this.terminals.write(target.id, unescapeRaw(String(raw)));
    } else {
      if (!prompt) fail('usage: ask "Agent" "prompt"');
      this.terminals.deliver(target.id, String(prompt));
    }
    const state = await this.terminals.waitIdle(target.id, { since, timeoutMs, quietMs: quietMs ?? (raw != null ? 800 : 2500), busy: () => looksBusy(this.terminals.lines(target.id, 60)) });
    // a full-screen program redraws in place: what it said is what is new on the screen, not what follows the old cursor line
    const output = newScreenText(before, this.terminals.lines(target.id)) || this.terminals.text(target.id, { fromLine });
    return { text: output || '(no output)', data: { name: target.name, state, output } };
  },

  /** A one-shot run of any agent CLI in its non-interactive mode: no terminal, the answer comes back as text. */
  async 'agent.run'(ws, me, { driver, prompt, model, floor, timeoutMs, account, sandbox, noNetwork, fallback }) {
    this.requireMaestro(me);
    const drivers = { ...DRIVERS, ...customDrivers(this.store.settings.drivers) };
    if (!driver) fail(`usage: agent <driver> "prompt". Drivers: ${Object.keys(drivers).join(', ')}`);
    if (this.headless.size >= MAX_HEADLESS) fail(`${this.headless.size} one-shot agents are already running (the limit is ${MAX_HEADLESS}); wait for one to finish`);
    const rec = floor ? ws.floors.find((f) => f.slug === floor || f.name.toLowerCase() === String(floor).toLowerCase()) : null;
    if (floor && !rec) fail(`no floor named "${floor}" (see: floor list)`);
    const cwd = [rec?.dir, me.cwd, ws.dir].find((d) => d && fs.existsSync(d)) ?? process.env.HOME;
    const expanded = materializeMentions(String(prompt ?? ''), this.prompterCtx(ws, me)).text;
    this.audit.record('agent.run', { driver, account: account ?? '', by: me.name, folder: path.basename(cwd), model: model ?? '', promptChars: expanded.length, promptSha256: sha256(expanded) }, 'terminal');
    const box = this.sandboxFrom(sandbox, noNetwork);
    const r = await this.execAgent({ driver, drivers, prompt: expanded, cwd, model, timeoutMs, ws, account, sandbox: box, fallback, extraEnv: this.floorEnv(ws, rec ?? floorById(ws, me.floorId)) });
    const secs = (r.ms / 1000).toFixed(1);
    const who = r.driver ?? driver;
    if (r.timedOut) fail(`${who} did not finish in time and was stopped (${secs}s)${r.text ? `. Partial output:\n${r.text}` : ''}`);
    if (r.cancelled) fail(`${who} was stopped`);
    if (!r.ok) fail(`${who} ${r.reportedError ? 'reported an error' : `exited with ${r.exitCode ?? r.signal ?? 'an error'}`} after ${secs}s${r.stderr ? `:\n${r.stderr}` : ''}${r.text ? `\nOutput:\n${r.text}` : ''}${r.tried.length ? `\nAlso tried: ${r.tried.map((t) => `${t.driver} (${t.why})`).join(', ')}` : ''}`);
    const skipped = r.tried.length ? `; skipped ${r.tried.map((t) => `${t.driver} (${t.why})`).join(', ')}` : '';
    return { text: `${r.text || '(no output)'}${r.truncated ? '\n[output cut at 400 KB]' : ''}\n[${r.driver}, ${secs}s, ${path.basename(cwd)}${skipped}]` };
  },

  /** Who answers when a driver's account is out of quota: `fallback set opencode kimi,agy`. */
  'fallback.list'(ws, me) {
    this.requireMaestro(me);
    const saved = this.store.settings.fallbacks ?? {};
    const rows = Object.entries(saved).map(([d, list]) => `${d} -> ${list.join(', ')}`);
    return { text: rows.length ? rows.join('\n') : 'no fallbacks set. Example: openmaestri fallback set opencode kimi,agy', data: saved };
  },
  'fallback.set'(ws, me, { driver, list }) {
    this.requireMaestro(me);
    const drivers = { ...DRIVERS, ...customDrivers(this.store.settings.drivers) };
    const names = [...new Set(String(list ?? '').split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
    if (!driver || !names.length) fail('usage: fallback set DRIVER other1,other2');
    for (const n of [driver, ...names]) if (!Object.hasOwn(drivers, n)) fail(`no driver named "${n}". Drivers: ${Object.keys(drivers).join(', ')}`);
    if (names.includes(driver)) fail('a driver cannot be its own fallback');
    this.store.settings.fallbacks = { ...(this.store.settings.fallbacks ?? {}), [driver]: names.slice(0, 5) };
    this.store.saveSettings();
    return { text: `${driver} -> ${names.slice(0, 5).join(', ')}` };
  },
  'fallback.clear'(ws, me, { driver }) {
    this.requireMaestro(me);
    const saved = { ...(this.store.settings.fallbacks ?? {}) };
    if (!driver || !Object.hasOwn(saved, driver)) fail(`no fallback set for "${driver ?? ''}"`);
    delete saved[driver];
    this.store.settings.fallbacks = saved;
    this.store.saveSettings();
    return { text: `cleared the fallback of ${driver}` };
  },

  /** One task for several one-shot agents in parallel; the report is also left as a note on the canvas. */
  async run(ws, me, args) {
    this.requireMaestro(me);
    return this.runTask(ws, me, args);
  },

  async 'ask.batch'(ws, me, { items, timeoutMs }) {
    const entries = Object.entries(items || {});
    if (!entries.length) fail('usage: ask --batch \'{"A": "prompt"}\'');
    const results = await Promise.all(entries.map(async ([name, prompt]) => {
      try {
        const r = await HANDLERS.ask.call(this, ws, me, { name, prompt, timeoutMs });
        return { agent: r.data.name, state: r.data.state, output: r.data.output };
      } catch (e) {
        return { agent: name, error: e.message };
      }
    }));
    return { text: JSON.stringify(results, null, 2), data: results };
  },

  check(ws, me, { name, lines = 200 }) {
    const target = this.resolve(ws, me, name, ['terminal']);
    this.startTerminal(ws, target);
    return { text: this.terminals.text(target.id, { lastLines: lines }) || '(empty)' };
  },

  // ----- notes -----
  'note.create'(ws, me, { content = '', name, color, stack }) {
    const pos = this.placeBeside(ws, me, { w: 320, h: 260 });
    const note = this.store.createNode(ws, 'note', { name: name || (String(content).split('\n')[0].slice(0, 40).trim() || 'Note'), text: content, color, floorId: me.floorId, ...pos });
    if (stack) this.fileIntoStack(ws, me, note, stack === true ? 'Stack' : String(stack));
    else this.store.connect(ws, me.id, note.id);
    this.touch(ws);
    return { text: note.name, data: { name: note.name } };
  },
  /** Copy a text file of the project into a new note (up to 32 KB; nothing that looks like a secret). */
  'note.fromfile'(ws, me, { path: rel, name }) {
    this.requireMaestro(me);
    const r = readMentionedFile(this.chatRoots(ws.id), String(rel ?? ''));
    if (!r.ok) fail(`cannot make a note from that file: ${r.reason}`);
    return HANDLERS['note.create'].call(this, ws, me, { content: r.text, name: name || path.basename(r.path) });
  },
  'note.stack'(ws, me, { name, stack }) {
    const note = this.resolve(ws, me, name, ['note']);
    const st = this.fileIntoStack(ws, me, note, stack ? String(stack) : 'Stack');
    this.touch(ws);
    return { text: `${note.name} -> ${st.name}` };
  },
  'note.unstack'(ws, me, { name }) {
    const note = this.resolve(ws, me, name, ['note']);
    if (!note.stackId) fail(`"${note.name}" is not in a stack`);
    const st = this.store.removeFromStack(ws, note.id);
    this.store.connect(ws, me.id, note.id);
    this.touch(ws);
    return { text: `${note.name} freed from ${st.name}` };
  },
  'note.read'(ws, me, { name, offset, limit }) {
    const note = this.resolve(ws, me, name, ['note']);
    let lines = this.store.readNote(ws.id, note.id).split('\n');
    if (offset != null || limit != null) lines = lines.slice(Math.max(0, (offset ?? 1) - 1), limit != null ? Math.max(0, (offset ?? 1) - 1) + limit : undefined);
    return { text: lines.join('\n') };
  },
  'note.write'(ws, me, { name, content }) {
    const note = this.resolve(ws, me, name, ['note']);
    this.store.writeNote(ws.id, note.id, content ?? '');
    this.touch(ws);
    return { text: `wrote ${note.name}` };
  },
  'note.edit'(ws, me, { name, old, new: next }) {
    const note = this.resolve(ws, me, name, ['note']);
    const body = this.store.readNote(ws.id, note.id);
    if (!old) fail('usage: note edit "Note" "old text" "new text"');
    const first = body.indexOf(old);
    if (first < 0) fail('the text to replace was not found in the note');
    if (body.indexOf(old, first + 1) >= 0) fail('the text to replace appears more than once; include more context');
    this.store.writeNote(ws.id, note.id, body.slice(0, first) + (next ?? '') + body.slice(first + old.length));
    this.touch(ws);
    return { text: `edited ${note.name}` };
  },
  'note.delete'(ws, me, { name, stack }) {
    if (stack) {
      const st = this.resolve(ws, me, stack === true ? name : stack, ['stack']);
      const count = st.order.length;
      this.store.deleteNode(ws, st.id, { keepStackNotes: false });
      this.touch(ws);
      return { text: `deleted stack ${st.name} and ${count} note(s)` };
    }
    const note = this.resolve(ws, me, name, ['note']);
    this.store.deleteNode(ws, note.id);
    this.touch(ws);
    return { text: `deleted ${note.name}` };
  },

  // ----- portals (URL panes; page automation is not implemented) -----
  'portal.create'(ws, me, { url, name, size }) {
    if (!url) fail('usage: portal create URL ["Name"]');
    let u;
    try { u = new URL(checkUrl(url, { selfPorts: this.portals.selfPorts })); } catch (e) { fail(e.message); }
    const dims = size && /^(\d+)x(\d+)$/.exec(size);
    const pos = this.placeBeside(ws, me, { w: 520, h: 380 });
    const node = this.store.createNode(ws, 'portal', { floorId: me.floorId, name: name || u.hostname || 'Portal', url: u.href, w: dims ? +dims[1] : undefined, h: dims ? +dims[2] : undefined, ...pos });
    this.store.connect(ws, me.id, node.id);
    this.touch(ws);
    return { text: node.name };
  },
  async 'portal.edit'(ws, me, { name, url }) {
    const p = this.resolve(ws, me, name, ['portal']);
    let href;
    try { href = checkUrl(url, { selfPorts: this.portals.selfPorts }); } catch (e) { fail(e.message); }
    if (this.portals.has(p.id)) await this.runPortal(() => this.portals.get(p).navigate(href));
    else this.store.patchNode(ws, p.id, { url: href });
    this.store.saveWorkspace(ws.id);
    this.touch(ws);
    return { text: `${p.name} -> ${href}` };
  },
  async 'portal.close'(ws, me, { name }) {
    const p = this.resolve(ws, me, name, ['portal']);
    await this.portals.dispose(p.id);
    this.store.deleteNode(ws, p.id);
    this.touch(ws);
    return { text: `closed ${p.name}` };
  },
  /** Everything an agent can do inside a portal: snapshot, click, fill, ... (see docs/portals.md). */
  async 'portal.act'(ws, me, { op, name, rest = [] }) {
    const node = this.resolve(ws, me, name, ['portal']);
    const p = this.portals.get(node);
    const [a, b, ...more] = rest;
    const need = (cond, usage) => { if (!cond) fail(`usage: portal ${op} "${node.name}" ${usage}`); };
    const out = await this.runPortal(async () => {
      switch (op) {
        case 'info': { const i = await p.info(); return `url: ${i.url}\ntitle: ${i.title}\nviewport: ${i.width}x${i.height}`; }
        case 'snapshot': case 'a11y': return p.snapshot();
        case 'click': need(a, '@e3 | CSS | x,y'); await p.click(a); return 'clicked';
        case 'fill': need(a && b !== undefined, '@e2 "text"'); await p.fill(a, b); return 'filled';
        case 'type': need(a !== undefined, '"text"'); await p.type(a); return 'typed';
        case 'key': need(a, '"Enter" (also ctrl+a, shift+tab)'); await p.key(a); return `pressed ${a}`;
        case 'focus': need(a, '@e2'); await p.focus(a); return 'focused';
        case 'select': need(a && b !== undefined, '@e5 "Option"'); return `selected ${await p.select(a, b)}`;
        case 'check': if (!a) return `screenshot: ${await p.screenshot()}`; await p.setChecked(a, true); return 'checked';
        case 'uncheck': need(a, '@e6'); await p.setChecked(a, false); return 'unchecked';
        case 'selectall': await p.selectAll(a); return 'selected all';
        case 'clear': await p.clear(a); return 'cleared';
        case 'navigate': need(a, '"url"'); { const n = await p.navigate(a); this.store.saveWorkspace(ws.id); return `${n.title || '(untitled)'}  ${n.url}`; }
        case 'back': { const n = await p.history(-1); return n.url; }
        case 'forward': { const n = await p.history(1); return n.url; }
        case 'reload': { const n = await p.reload(); return n.url; }
        case 'screenshot': return p.screenshot();
        case 'scroll': need(a, 'down [300] [@e5 | x,y]'); return (await p.scroll(a, b ?? 300, more[0]), 'scrolled');
        case 'scrollintoview': need(a, '@e10'); await p.scrollIntoView(a); return 'scrolled into view';
        case 'hover': need(a, '@e3'); await p.hover(a); return 'hovering';
        case 'drag': need(a && b, '@e3 @e7'); await p.drag(a, b); return 'dragged';
        case 'upload': need(a && b, '@e4 file [file...]'); return `attached ${await p.upload(a, [b, ...more])} file(s)`;
        case 'text': need(a, '@e1'); return p.text(a);
        case 'wait': need(a, '@e3 [timeoutMs]'); return p.wait(a, b === undefined ? 5000 : Number(b));
        case 'evaluate': need(a !== undefined, '"js"'); return p.evaluate(a);
        case 'html': return p.html();
        case 'logs-start': p.startLogs(); return 'capturing console output';
        case 'logs': return p.readLogs();
        case 'resize': need(a && b, '390 844'); { const v = await p.resize(a, b); return `viewport ${v.w}x${v.h}`; }
        case 'ua': return p.userAgent(a);
        case 'devices': case 'tap': case 'swipe': case 'button': case 'home': case 'lock': case 'launch': case 'terminate':
          return fail('Android device portals are not implemented yet');
        default: return fail(`unknown portal command "${op}"`);
      }
    });
    this.store.saveWorkspace(ws.id);
    return { text: typeof out === 'string' ? out : JSON.stringify(out) };
  },

  // ----- orchestration (maestro only) -----
  async recruit(ws, me, { name, preset, role, dir, command, color, icon, replace, floor, model, noCheck, account, noHandoff, handoff, sandbox, noNetwork }) {
    this.requireMaestro(me);
    const accountName = account ?? this.store.settings.presets.find((p) => p.name.toLowerCase() === String(preset ?? '').toLowerCase())?.account ?? null;
    if (accountName) this.accounts.env(accountName); // fails with a clear message when it does not exist
    const presetObj = preset ? this.store.settings.presets.find((p) => p.name.toLowerCase() === String(preset).toLowerCase()) : null;
    if (preset && !presetObj) fail(`no preset named "${preset}" (see: preset list)`);
    let cmd = command ?? presetObj?.command ?? '';
    if (model !== undefined) {
      const m = String(model);
      if (!/^[\w./:-]{1,80}$/.test(m) || m.includes('..') || m.startsWith('/')) fail('model names use letters, digits and . _ / : -');
      if (!cmd.includes('OPENMAESTRI_DEEPSEEK_MODEL')) fail('this preset has no model setting. --model works with the DeepSeek presets');
      cmd = `OPENMAESTRI_DEEPSEEK_MODEL='${m}' ${cmd}`;
    }
    const box = this.sandboxFrom(sandbox, noNetwork);
    if (box) {
      if (presetObj?.maestro) fail('the Maestro cannot run in a box: it has to reach the app to coordinate. Put its workers in boxes instead');
      if (!cmd) fail('a plain shell cannot run in a box. Give the agent a --preset or a --command');
      if (!commandPath('docker')) fail('"docker" was not found in your shell, so the box cannot start');
    }
    if (cmd && !noCheck && !box) { // in a box the program lives in the image; only docker has to exist here
      const avail = commandAvailable(cmd);
      if (!avail.ok) fail(`"${avail.word}" was not found in your shell, so the agent could not start. Install it (run: openmaestri doctor) or add --no-check`);
    }
    if (replace) {
      const old = this.resolveAny(ws, replace, ['terminal']);
      // the retiring agent leaves a note first, unless the terminal was a plain shell or the Maestro said not to
      const note = noHandoff || !old.command ? null : await this.writeHandoff(ws, me, old, { ask: handoff === 'ask' });
      const oldName = old.name;
      this.terminals.dispose(old.id);
      this.store.patchNode(ws, old.id, { command: cmd, ...(name ? { name } : {}) });
      if (box) old.sandbox = box; // a box that was already there stays; asking for one sets it
      this.startTerminal(ws, old);
      if (note && cmd) setTimeout(() => { try { this.terminals.deliver(old.id, [takeoverLine(note, oldName), this.factsBrief(ws)].filter(Boolean).join('\n\n')); } catch { /* the terminal was closed meanwhile */ } }, 3000).unref?.();
      this.touch(ws);
      return { text: note ? `${old.name} (handoff note: ${note})` : old.name, data: { name: old.name, handoff: note } };
    }
    if (!name) fail('usage: recruit "Name" [--preset P] [--role R] [--dir PATH] [--command C]');
    const target = floor === undefined ? floorById(ws, me.floorId) ?? groundOf(ws) : findFloor(ws, floor);
    const cwd = dir ? path.resolve(target.dir, dir) : target.dir;
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) fail(`directory does not exist: ${cwd}`);
    let rolePrompt = null;
    if (role) {
      const r = this.findRole(ws, role);
      rolePrompt = r.prompt;
    }
    const anchor = { ...me, floorId: target.id };
    const pos = this.placeBeside(ws, anchor, { w: 640, h: 400 });
    const node = this.store.createNode(ws, 'terminal', { name, command: cmd, cwd, color, icon, role: role || null, preset: presetObj?.name ?? null, account: accountName, maestro: !!presetObj?.maestro, floorId: target.id, ...pos });
    if (model !== undefined) node.usageModel = String(model);
    if (box) node.sandbox = box;
    this.store.connect(ws, me.id, node.id);
    this.startTerminal(ws, node);
    const intro = [rolePrompt, cmd ? this.factsBrief(ws) : ''].filter(Boolean).join('\n\n');
    if (intro) setTimeout(() => { try { this.terminals.deliver(node.id, intro); } catch {} }, 3000);
    this.touch(ws);
    return { text: node.name, data: { name: node.name } };
  },

  /** `mcp [list] | add NAME ... | rm NAME | install "Agent" [--apply] [--remove]`: the MCP servers of this workspace. */
  mcp(ws, me, { action = 'list', name, command, url, env, header, key, agent, apply, remove }) {
    if (action === 'list') return { text: mcpText(this.mcp.list(ws.id)), data: this.mcp.list(ws.id) };
    this.requireMaestro(me);
    if (action === 'add') {
      this.mcp.set(ws.id, name, buildServer({ name, command, url, env, header, key }));
      this.audit.record('mcp.add', { name }, 'terminal');
      return { text: `added ${name}. Put it in an agent's project config with: openmaestri mcp install "Agent"` };
    }
    if (action === 'rm') { this.mcp.remove(ws.id, name); return { text: `removed ${name} (files already written are not touched; use mcp install --remove first)` }; }
    if (action !== 'install') return fail('usage: mcp [list] | add | rm | install');
    const all = this.mcp.list(ws.id);
    if (!Object.keys(all).length) fail('there are no MCP servers yet. Add one: openmaestri mcp add context7');
    const node = this.resolve(ws, me, agent, ['terminal']);
    const kind = agentKind(node);
    let cwd;
    try { cwd = fs.realpathSync(node.cwd); } catch { return fail(`the folder of ${node.name} is missing`); }
    if (!this.chatRoots(ws.id).some((r) => cwd === r || cwd.startsWith(r + path.sep))) fail('that agent works outside the workspace; MCP config is only written inside it');
    const r = planInstall({ cwd, kind: kind ?? 'unknown', servers: all, remove: !!remove, apply: !!apply });
    if (!r.changed) return { text: `${remove ? 'nothing to remove from' : 'already up to date in'} ${r.file}` };
    if (!apply) return { text: `Dry run: this would update ${r.file}\n\n${diffText(r.file, r.before, r.after)}\n\nThese servers start commands or reach the network when ${node.name} starts, so read the diff. Run again with --apply to write it${r.existed ? ' (a backup is made first)' : ''}.` };
    this.audit.record('mcp.install', { agent: node.name, file: path.basename(r.file), remove: !!remove }, 'terminal');
    return { text: `${remove ? 'removed from' : 'written to'} ${r.file}${r.backup ? `\nbackup: ${r.backup}` : ''}\n${r.note}` };
  },
  /** `remember "text" [--kind decision|lesson|fact]`: any agent can leave a fact for the ones that come later. */
  remember(ws, me, { text, kind }) {
    const row = this.facts.add(ws.id, { kind: kind ?? 'fact', text, by: me.name });
    return { text: row.repeated ? `already remembered (${row.id})` : `remembered ${row.id}: ${row.text}`, data: row };
  },
  /** `facts [list] [--kind K] | search WORD | rm ID | export --agent NAME [--apply]` */
  facts(ws, me, { action = 'list', kind, word, id, agent, apply }) {
    if (action === 'list' || action === 'search') {
      const rows = this.facts.find(ws.id, { kind, word: action === 'search' ? word : undefined });
      return { text: factsText(rows), data: rows };
    }
    this.requireMaestro(me);
    if (action === 'rm') {
      const gone = this.facts.remove(ws.id, id);
      return { text: `forgot ${gone.id}: ${gone.text}` };
    }
    if (action === 'export') return this.exportFacts(ws, me, { agent, apply });
    return fail('usage: facts [list] [--kind K] | facts search WORD | facts rm ID | facts export "Name" [--apply]');
  },

  /** `handoff "Agent" [--ask]`: leave a note with the state of an agent, for whoever works next. The agent stays. */
  async handoff(ws, me, { name, ask }) {
    this.requireMaestro(me);
    const n = this.resolve(ws, me, name, ['terminal']);
    const note = await this.writeHandoff(ws, me, n, { ask: !!ask });
    return { text: `note "${note}" written and cabled to ${n.name}`, data: { note } };
  },

  dismiss(ws, me, { name }) {
    this.requireMaestro(me);
    const n = this.resolve(ws, me, name, ['terminal']);
    this.terminals.dispose(n.id);
    this.store.deleteNode(ws, n.id);
    this.touch(ws);
    return { text: `dismissed ${n.name}` };
  },

  connect(ws, me, { from, to, kind }) {
    this.requireMaestro(me);
    const kinds = kind ? [KIND_FLAGS[kind]].filter(Boolean) : null;
    if (kind && !kinds.length) fail(`unknown kind "${kind}" (agent, band, note, fichario, portal)`);
    const a = this.resolveAny(ws, from);
    const b = this.resolveAny(ws, to, kinds);
    this.store.connect(ws, a.id, b.id);
    this.touch(ws);
    return { text: `${a.name} <-> ${b.name}` };
  },

  disconnect(ws, me, { from, to }) {
    this.requireMaestro(me);
    const a = this.resolveAny(ws, from);
    const b = this.resolveAny(ws, to);
    const removed = this.store.disconnect(ws, [a.id, b.id]);
    if (!removed) fail(`${a.name} and ${b.name} are not connected`);
    this.touch(ws);
    return { text: `${a.name} -/- ${b.name}` };
  },

  arrange(ws, me, { name, newName, color, icon, kind }) {
    if (!name) {
      const rows = [me, ...this.reachable(ws, me)].map((n) => `${kindLabel[n.kind].padEnd(7)} ${n.name}  color=${n.color ?? '-'} icon=${n.icon ?? '-'}`);
      return { text: textOf(rows) };
    }
    const kinds = kind ? [KIND_FLAGS[kind]].filter(Boolean) : null;
    let target;
    if (name.toLowerCase() === me.name.toLowerCase() && !kinds) target = me;
    else if (kinds?.includes('band')) {
      // a band is reachable by its members (and any Maestro)
      target = ws.nodes.find((n) => n.kind === 'band' && n.name.toLowerCase() === name.toLowerCase() && (me.maestro || n.members.includes(me.id))) || fail(`no band named "${name}" that you belong to`);
    } else target = this.resolve(ws, me, name, kinds);
    const patch = {};
    if (newName) patch.name = newName;
    if (color) patch.color = color;
    if (icon) patch.icon = icon;
    if (!Object.keys(patch).length) fail('nothing to change: pass --name, --color or --icon');
    this.store.patchNode(ws, target.id, patch);
    this.touch(ws);
    return { text: target.name };
  },

  // ----- bands (Maestro) -----
  'band.create'(ws, me, { name, agents = [], withoutMe, color, icon }) {
    this.requireMaestro(me);
    if (!name) fail('usage: band create "Name" ["Agent" ...] [--without-me]');
    const wanted = String(name).trim();
    if (ws.nodes.some((n) => n.kind === 'band' && n.name.toLowerCase() === wanted.toLowerCase())) fail(`a band named "${wanted}" already exists`);
    const named = agents.map((a) => this.resolve(ws, me, a, ['terminal']).id);
    const team = named.length ? named : this.reachable(ws, me).filter((n) => n.kind === 'terminal').map((n) => n.id);
    const ids = [...(withoutMe ? [] : [me.id]), ...team];
    let band;
    try { band = this.store.createBand(ws, name, ids, { color, icon }); } catch (e) { fail(e.message); }
    this.touch(ws);
    return { text: `${band.name}: ${band.members.length} member(s)` };
  },
  'band.add'(ws, me, { band, agent }) {
    this.requireMaestro(me);
    const b = this.findBand(ws, band);
    const t = this.resolve(ws, me, agent, ['terminal']);
    try { this.store.addToBand(ws, b, t.id); } catch (e) { fail(e.message); }
    this.touch(ws);
    return { text: `${t.name} joined ${b.name}` };
  },
  'band.remove'(ws, me, { band, agent }) {
    this.requireMaestro(me);
    const b = this.findBand(ws, band);
    const t = ws.nodes.find((n) => n.kind === 'terminal' && n.name.toLowerCase() === String(agent).toLowerCase()) || fail(`no agent named "${agent}"`);
    try { this.store.removeFromBand(ws, b, t.id); } catch (e) { fail(e.message); }
    this.touch(ws);
    return { text: `${t.name} left ${b.name}` };
  },
  'band.dissolve'(ws, me, { band }) {
    this.requireMaestro(me);
    const b = this.findBand(ws, band);
    this.store.deleteNode(ws, b.id);
    this.touch(ws);
    return { text: `dissolved ${b.name}` };
  },

  // ----- partituras: saved layouts (Maestro) -----
  'partitura.list'(ws, me) {
    this.requireMaestro(me);
    const rows = this.partiturasFor(ws).map((p) => `${p.name}  (${p.scope === null ? 'global' : 'workspace'}, ${p.nodes.length} items)${p.description ? '  ' + p.description : ''}`);
    return { text: rows.length ? textOf(rows) : '(no partituras)' };
  },
  'partitura.create'(ws, me, { name, agents = [], withoutMe, commands = true, noteText = true, description, icon, color, scope = 'current' }) {
    this.requireMaestro(me);
    if (!name) fail('usage: partitura create "Name" ["Agent" ...]');
    const list = this.store.settings.partituras ??= [];
    if (list.some((p) => p.name.toLowerCase() === name.toLowerCase() && (p.scope === null || p.scope === ws.id))) fail(`partitura "${name}" already exists (use partitura update)`);
    const part = this.capture(ws, me, { name, agents, withoutMe, commands, noteText, description, icon, color, scope });
    list.push(part);
    this.store.saveSettings();
    this.emit('workspace-list');
    return { text: `saved ${part.name}: ${part.nodes.length} items` };
  },
  'partitura.update'(ws, me, { name, agents = [], withoutMe, commands, noteText, newName, description, icon, color, scope }) {
    this.requireMaestro(me);
    const old = this.findPartitura(ws, name);
    const resave = agents.length || withoutMe || commands !== undefined || noteText !== undefined;
    if (resave) {
      const fresh = this.capture(ws, me, { name: newName ?? old.name, agents, withoutMe, commands: commands ?? old.options.commands, noteText: noteText ?? old.options.noteText, description: description ?? old.description, icon: icon ?? old.icon, color: color ?? old.color, scope: scope ?? (old.scope === null ? 'global' : 'current') });
      Object.assign(old, { ...fresh, id: old.id });
    } else {
      if (newName) old.name = newName;
      if (description !== undefined) old.description = description;
      if (icon !== undefined) old.icon = icon;
      if (color !== undefined) old.color = color;
      if (scope) old.scope = scope === 'global' ? null : ws.id;
    }
    this.store.saveSettings();
    this.emit('workspace-list');
    return { text: `updated ${old.name}` };
  },
  /** One layout as a file: a closed format, no ids, safe to send to someone. */
  'partitura.export'(ws, me, { name }) {
    this.requireMaestro(me);
    const p = this.findPartitura(ws, name);
    const file = exportPartitura(p);
    this.audit.record('partitura.export', { name: p.name, items: p.nodes.length, by: me.name }, 'terminal');
    return { text: JSON.stringify(file, null, 2), data: file };
  },
  /** Add a layout from a file. Anything it asks to run stays held back until you trust it. */
  'partitura.import'(ws, me, { file, name }) {
    this.requireMaestro(me);
    const part = importPartitura(file, { name });
    const list = this.store.settings.partituras ??= [];
    if (list.some((p) => p.name.toLowerCase() === part.name.toLowerCase() && (p.scope === null || p.scope === ws.id))) fail(`a partitura named "${part.name}" already exists; import it with --name "Another name"`);
    part.scope = ws.id;
    list.push(part);
    this.store.saveSettings();
    this.audit.record('partitura.import', { name: part.name, items: part.nodes.length, commandsHeldBack: part.nodes.filter((n) => n.kind === 'terminal' && n.command).length, by: me.name }, 'terminal');
    this.emit('workspace-list');
    return { text: `imported ${part.name}: ${part.nodes.length} items. Commands in it will not run until you trust them. Insert it with: partitura insert "${part.name}"` };
  },
  'partitura.insert'(ws, me, { name, floor }) {
    this.requireMaestro(me);
    const part = this.findPartitura(ws, name);
    const { created } = this.insertPartitura(ws, part, me, floor === undefined ? null : findFloor(ws, floor));
    this.touch(ws);
    return { text: `inserted ${part.name}: ${created.map((n) => n.name).join(', ')}` };
  },
  'partitura.delete'(ws, me, { name }) {
    this.requireMaestro(me);
    const part = this.findPartitura(ws, name);
    this.store.settings.partituras = this.store.settings.partituras.filter((p) => p !== part);
    this.store.saveSettings();
    this.emit('workspace-list');
    return { text: `deleted ${part.name}` };
  },

  // ----- presets & roles -----
  'preset.list'(ws, me) {
    this.requireMaestro(me);
    const rows = this.store.settings.presets.map((p) => `${p.name}${p.maestro ? ' (maestro)' : ''}  ${p.command || '(plain shell)'}`);
    return { text: textOf(rows) };
  },
  'preset.show'(ws, me, { name }) {
    this.requireMaestro(me);
    const p = this.findPreset(name);
    return { text: JSON.stringify(p, null, 2) };
  },
  'preset.create'(ws, me, { name, command = '', maestro = false, account }) {
    this.requireMaestro(me);
    if (!name) fail('usage: preset create "Name" [--command C] [--maestro on|off]');
    if (this.store.settings.presets.some((p) => p.name.toLowerCase() === name.toLowerCase())) fail(`preset "${name}" already exists`);
    if (account) this.accounts.env(account);
    this.store.settings.presets.push({ name, command, maestro: !!maestro, ...(account ? { account } : {}) });
    this.store.saveSettings();
    return { text: `created preset ${name}` };
  },
  'preset.set'(ws, me, { name, newName, command, maestro, account }) {
    this.requireMaestro(me);
    const p = this.findPreset(name);
    if (newName) p.name = newName;
    if (command != null) p.command = command;
    if (maestro != null) p.maestro = !!maestro;
    if (account !== undefined) {
      if (account) this.accounts.env(account);
      if (account) p.account = account; else delete p.account;
    }
    this.store.saveSettings();
    return { text: `updated preset ${p.name}` };
  },
  'preset.delete'(ws, me, { name }) {
    this.requireMaestro(me);
    const p = this.findPreset(name);
    this.store.settings.presets = this.store.settings.presets.filter((x) => x !== p);
    this.store.saveSettings();
    return { text: `deleted preset ${p.name}` };
  },

  'role.list'(ws, me) {
    this.requireMaestro(me);
    const roles = this.store.settings.roles;
    const rows = roles.map((r) => `${r.name}  (${r.workspaceId ? 'workspace' : 'global'})`);
    return { text: rows.length ? textOf(rows) : '(no roles)' };
  },
  'role.show'(ws, me, { name }) {
    this.requireMaestro(me);
    return { text: this.findRole(ws, name).prompt };
  },
  'role.create'(ws, me, { name, prompt, scope = 'current' }) {
    this.requireMaestro(me);
    if (!name || !prompt) fail('usage: role create "Name" "Prompt" [--scope current|global]');
    if (this.store.settings.roles.some((r) => r.name.toLowerCase() === name.toLowerCase() && (!r.workspaceId || r.workspaceId === ws.id))) fail(`role "${name}" already exists`);
    this.store.settings.roles.push({ name, prompt, workspaceId: scope === 'global' ? null : ws.id });
    this.store.saveSettings();
    return { text: `created role ${name}` };
  },
  'role.write'(ws, me, { name, prompt }) {
    this.requireMaestro(me);
    this.findRole(ws, name).prompt = prompt;
    this.store.saveSettings();
    return { text: `updated role ${name}` };
  },
  'role.edit'(ws, me, { name, old, new: next, scope }) {
    this.requireMaestro(me);
    const r = this.findRole(ws, name);
    if (old != null) {
      if (!r.prompt.includes(old)) fail('the text to replace was not found in the role');
      r.prompt = r.prompt.replace(old, () => next ?? '');
    }
    if (scope) r.workspaceId = scope === 'global' ? null : ws.id;
    this.store.saveSettings();
    return { text: `edited role ${name}` };
  },
  'role.assign'(ws, me, { recruit, role, none }) {
    this.requireMaestro(me);
    const t = this.resolve(ws, me, recruit, ['terminal']);
    if (none) { this.store.patchNode(ws, t.id, { role: null }); this.touch(ws); return { text: `cleared role on ${t.name}` }; }
    const r = this.findRole(ws, role);
    this.store.patchNode(ws, t.id, { role: r.name });
    this.touch(ws);
    this.startTerminal(ws, t);
    this.terminals.deliver(t.id, r.prompt);
    return { text: `${t.name} -> ${r.name}` };
  },
  'role.delete'(ws, me, { name, force }) {
    this.requireMaestro(me);
    const r = this.findRole(ws, name);
    const users = ws.nodes.filter((n) => n.role === r.name);
    if (users.length && !force) fail(`role "${r.name}" is still used by ${users.map((n) => n.name).join(', ')} (use --force)`);
    for (const n of users) n.role = null;
    this.store.settings.roles = this.store.settings.roles.filter((x) => x !== r);
    this.store.saveSettings();
    this.touch(ws);
    return { text: `deleted role ${r.name}` };
  },

  // ----- routines -----
  'routine.list'(ws, me) {
    this.requireMaestro(me);
    const rows = ws.routines.map((r) => `${r.enabled ? 'on ' : 'off'} ${r.name}  ${describeSchedule(r.schedule)}  -> ${ws.nodes.find((n) => n.id === r.terminalId)?.name ?? '?'}`);
    return { text: rows.length ? textOf(rows) : '(no routines)' };
  },
  'routine.show'(ws, me, { name }) {
    this.requireMaestro(me);
    return { text: JSON.stringify(this.findRoutine(ws, name), null, 2) };
  },
  'routine.create'(ws, me, { name, command, terminal, every, daily, weekly, once, count, until, preRun, noNotify, disabled, reminder }) {
    this.requireMaestro(me);
    if (!name || !command) fail('usage: routine create "Name" --command "..." <schedule>');
    const target = terminal ? this.resolve(ws, me, terminal, ['terminal']) : me;
    const r = this.scheduler.create(ws, {
      name, command, terminalId: target.id, schedule: parseSchedule({ every, daily, weekly, once }),
      count: count != null ? Number(count) : null, until, preRun, reminder, notify: !noNotify, enabled: !disabled,
    });
    return { text: `${r.name}: ${describeSchedule(r.schedule)}` };
  },
  'routine.edit'(ws, me, { name, newName, command, every, daily, weekly, once, terminal }) {
    this.requireMaestro(me);
    const r = this.findRoutine(ws, name);
    if (newName) r.name = newName;
    if (command != null) r.command = command;
    if (terminal) r.terminalId = this.resolve(ws, me, terminal, ['terminal']).id;
    if (every || daily || weekly || once) {
      r.schedule = parseSchedule({ every, daily, weekly, once });
      r.nextRunAt = this.scheduleNext(r);
    }
    this.touch(ws);
    return { text: `edited ${r.name}` };
  },
  'routine.enable'(ws, me, { name }) {
    this.requireMaestro(me);
    const r = this.findRoutine(ws, name);
    r.enabled = true;
    r.nextRunAt = this.scheduleNext(r);
    this.touch(ws);
    return { text: `enabled ${r.name}` };
  },
  'routine.disable'(ws, me, { name }) {
    this.requireMaestro(me);
    const r = this.findRoutine(ws, name);
    r.enabled = false;
    this.touch(ws);
    return { text: `disabled ${r.name}` };
  },
  async 'routine.run'(ws, me, { name }) {
    this.requireMaestro(me);
    const r = this.findRoutine(ws, name);
    await this.scheduler.runNow(ws, r, 'manual').finally(() => this.touch(ws));
    return { text: `fired ${r.name}` };
  },
  'routine.history'(ws, me, { name }) {
    this.requireMaestro(me);
    const r = this.findRoutine(ws, name);
    const rows = (r.history ?? []).slice().reverse().map((h) => `${h.at.replace('T', ' ').slice(0, 19)} UTC  ${h.trigger.padEnd(8)} ${h.ok ? 'ok    ' : 'FAILED'} ${String(h.ms).padStart(5)}ms${h.preRun === 'failed' ? '  (pre-run command failed)' : ''}${h.error ? `  ${h.error}` : ''}`);
    return { text: rows.length ? textOf(rows) : `${r.name} has not run yet`, data: r.history ?? [] };
  },
  'routine.delete'(ws, me, { name }) {
    this.requireMaestro(me);
    const r = this.findRoutine(ws, name);
    ws.routines = ws.routines.filter((x) => x !== r);
    this.touch(ws);
    return { text: `deleted ${r.name}` };
  },

  // ----- workspaces & floors -----
  'workspace.list'(ws, me) {
    this.requireMaestro(me);
    const rows = [...this.store.workspaces.values()].map((w) => `${w.id === ws.id ? '*' : ' '} ${w.name}  ${w.dir}`);
    return { text: textOf(rows) };
  },
  'workspace.create'(ws, me, { name, dir, from }) {
    this.requireMaestro(me);
    if (!name || !dir) fail('usage: workspace create "Name" --dir PATH');
    const wantedName = String(name).trim();
    if ([...this.store.workspaces.values()].some((w) => w.name.toLowerCase() === wantedName.toLowerCase())) fail(`a workspace named "${wantedName}" already exists`);
    const abs = path.resolve(ws.dir, dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) fail(`directory does not exist: ${abs}`);
    const src = from ? [...this.store.workspaces.values()].find((w) => w.name.toLowerCase() === from.toLowerCase()) || fail(`no workspace named "${from}"`) : null;
    const created = this.store.createWorkspace({ name, dir: abs, from: src?.id });
    this.emit('workspace-list');
    return { text: created.name };
  },
  /** Icon and sidebar group of a workspace. An empty value clears it. */
  'workspace.set'(ws, me, { name, icon, group }) {
    this.requireMaestro(me);
    const w = this.workspaceNamed(name);
    this.applyWorkspaceLook(w, { icon, group });
    return { text: `${w.name}: icon ${w.icon ?? '(none)'}, group ${w.group ?? '(none)'}` };
  },
  /** Stop everything a workspace is running (terminals and portals) and keep all of its data. */
  'workspace.unload'(ws, me, { name }) {
    this.requireMaestro(me);
    const w = this.workspaceNamed(name);
    if (w.id === ws.id) fail('a workspace cannot unload itself; run this from another workspace');
    return { text: this.unloadWorkspace(w) };
  },
  'workspace.rename'(ws, me, { name, newName }) {
    this.requireMaestro(me);
    const w = [...this.store.workspaces.values()].find((x) => x.name.toLowerCase() === String(name).toLowerCase()) || fail(`no workspace named "${name}"`);
    w.name = this.store.uniqueWorkspaceName(newName);
    this.store.saveWorkspace(w.id);
    this.emit('workspace-list');
    return { text: w.name };
  },
  'floor.status'(ws, me, { text, state, progress, clear, floor }) {
    const target = floor === undefined ? floorById(ws, me.floorId) ?? groundOf(ws) : findFloor(ws, floor);
    const mine = (me.floorId ?? null) === target.id;
    const set = (v) => { if (target.id === null) ws.floorStatus = v; else floorById(ws, target.id).status = v; };
    if (clear) { if (!mine && !me.maestro) fail('you can only clear the status of your own floor'); set(null); this.touch(ws); return { text: 'cleared' }; }
    if (text == null) return { text: target.status ? `${target.status.state ?? 'working'}${target.status.progress ? ` (${target.status.progress})` : ''}: ${target.status.text}` : '(no status)' };
    if (!mine && !me.maestro) fail('you can only post the status of your own floor');
    if (state && !['working', 'blocked', 'review', 'done'].includes(state)) fail('state must be working, blocked, review or done');
    set({ text, state: state ?? 'working', progress: progress ?? null, by: me.name, at: new Date().toISOString() });
    this.touch(ws);
    return { text: 'status posted' };
  },

  // ----- floors (Maestro) -----
  async 'floor.create'(ws, me, args) {
    this.requireMaestro(me);
    return this.doFloorCreate(ws, args);
  },
  /** Ask an agent you choose to write a summary of a chat thread. The text it reads is the thread with credentials masked. */
  async 'chat.summarize'(ws, me, { thread, driver, account, timeoutMs }) {
    this.requireMaestro(me);
    if (!driver) fail('usage: chat summarize [thread] --with DRIVER');
    const tid = thread === undefined ? this.chat.active(ws.id) : threadId(thread);
    const rows = this.chat.history(ws.id, tid, { turns: 150, archive: true }).slice(-150);
    if (rows.length < 2) fail('this thread is too short to summarize');
    const transcript = rows.map((m) => `${m.sender}: ${redactChat(m.text)}`).join('\n').slice(-60000);
    const prompt = `Summarize this conversation between a person and their AI assistants in at most 12 short lines. Keep decisions, open questions, file names and who is doing what. Reply with the summary only.\n\n--- conversation ---\n${transcript}`;
    const drivers = { ...DRIVERS, ...customDrivers(this.store.settings.drivers) };
    if (!drivers[driver]) fail(`no driver named "${driver}". Available: ${Object.keys(drivers).join(', ')}`);
    const r = await this.execAgent({ driver, drivers, prompt, cwd: ws.dir, timeoutMs: timeoutMs ?? 5 * 60 * 1000, ws, account });
    const why = r.stderr ? `: ${r.stderr.split('\n')[0]}` : '';
    if (!r.ok || !r.text) fail(`${driver} could not write the summary${why}`);
    this.chat.memory.saveModelSummary(ws.id, tid, { text: r.text, driver, messages: rows.length });
    this.audit.record('chat.summarize', { thread: tid, driver, messages: rows.length, by: me.name }, 'terminal');
    return { text: `saved a summary of ${rows.length} messages written by ${driver}. Read it with: recall --summary` };
  },
  /** Processes and memory of the terminals you can reach. */
  ps(ws, me, { all, stop, pid, force }) {
    this.requireMaestro(me);
    if (stop) return this.stopProcessIn(ws, me, stop, Number(pid), !!force);
    const lines = [];
    const data = [];
    for (const n of this.reachable(ws, me).filter((x) => x.kind === 'terminal')) {
      const root = this.terminals.pidOf(n.id);
      const procs = root ? procTree(root) : [];
      const sum = procSummary(procs);
      data.push({ name: n.name, pid: root, ...sum });
      lines.push(psLine(n.name, root, sum, this.terminals.status(n.id), this.terminals.get(n.id)?.persistent));
      if (all) lines.push(...procs.slice(1).map((p) => `    ${String(p.pid).padStart(7)}  ${String(Math.round(p.rssKb / 1024)).padStart(5)} MB  ${p.cmd}`));
    }
    return { text: lines.length ? lines.join('\n') : '(no terminals)', data };
  },
  /** Checks that run on a floor: after each agent of `run --floors`, and before the floor is landed. */
  'floor.hooks'(ws, me, args) {
    this.requireMaestro(me);
    const f = findFloor(ws, args.name);
    if (f.id === null) fail('hooks belong to a floor; the ground floor has none');
    const rec = floorById(ws, f.id);
    if (this.editHooks(rec, args)) {
      this.audit.record('floor.hooks', { sandbox: rec.hooks?.sandbox?.image ?? '', floor: f.name, postAgent: !!rec.hooks?.postAgent, preLand: !!rec.hooks?.preLand, rollbackOnFail: !!rec.hooks?.rollbackOnFail, by: me.name }, 'terminal');
      this.touch(ws);
    }
    const h = rec.hooks ?? {};
    return { text: `${f.name}: after each agent: ${h.postAgent ?? '(none)'}\nbefore landing: ${h.preLand ?? '(none)'}\nroll the files back when the after-agent hook fails: ${h.rollbackOnFail ? 'yes' : 'no'}\nrun hooks in a container: ${h.sandbox ? h.sandbox.image : 'no (on this machine)'}`, data: h };
  },
  async 'floor.snapshot'(ws, me, { name, label }) {
    this.requireMaestro(me);
    const f = findFloor(ws, name);
    const snap = await withLock(ws.id, () => takeSnapshot(f, label));
    this.audit.record('floor.snapshot', { floor: f.name, id: snap.id, by: me.name }, 'terminal');
    return { text: `snapshot ${snap.id} of ${f.name}${snap.label ? ` (${snap.label})` : ''}. Put it back with: floor rollback "${f.name}" ${snap.id}`, data: snap };
  },
  async 'floor.snapshots'(ws, me, { name }) {
    this.requireMaestro(me);
    const f = findFloor(ws, name);
    const rows = await withLock(ws.id, () => listSnapshots(f));
    return { text: rows.length ? rows.map((r) => `${r.id}  ${r.at}  ${r.label || '-'}`).join('\n') : `No snapshots on ${f.name}. Take one with: floor snapshot "${f.name}"`, data: rows };
  },
  async 'floor.rollback'(ws, me, { name, id }) {
    this.requireMaestro(me);
    if (name == null) fail('usage: floor rollback "Floor" [SNAPSHOT_ID]');
    const f = findFloor(ws, name);
    for (const n of ws.nodes.filter((x) => x.floorId === f.id && x.kind === 'terminal')) {
      if (this.terminals.status(n.id) === 'working' && n.id !== me.id) fail(`"${n.name}" is working on ${f.name} right now; wait for it to stop before rolling the files back under it`);
    }
    const r = await withLock(ws.id, () => rollbackFloor(f, id));
    this.audit.record('floor.rollback', { floor: f.name, restoredFrom: id ?? 'latest', safety: r.safety.id, by: me.name }, 'terminal');
    this.touch(ws);
    return { text: `${f.name}: ${r.restored} files restored, ${r.removed} removed.${r.headMoved ? ' Note: the branch has new commits since the snapshot; they stay (use git reset to move the branch).' : ''}\nUndo this rollback with: floor rollback "${f.name}" ${r.safety.id}` };
  },
  /** Open pull requests (GitHub, via gh) or merge requests (GitLab, via glab) with their checks. Read-only. */
  async 'floor.prs'(ws, me, { provider, json }) {
    this.requireMaestro(me);
    const top = await repoTop(ws.dir);
    if (!top) fail('the workspace folder is not a git repository');
    const kind = await this.forgeOf(top, provider);
    const rows = await listChanges(top, { provider: kind, resolveBin: (b) => this.safeBin(ws, b) });
    this.audit.record('floor.prs', { provider: kind, count: rows.length, by: me.name }, 'terminal');
    return { text: json ? JSON.stringify(rows, null, 2) : `${formatChanges(rows, kind)}\n\nOpen one as a floor: openmaestri floor create --pull-request N`, data: rows };
  },
  async 'floor.list'(ws, me) {
    this.requireMaestro(me);
    const rows = [`${me.floorId == null ? '*' : ' '} Ground   ${ws.dir}${ws.floorStatus ? `   [${ws.floorStatus.state}] ${ws.floorStatus.text}` : ''}`];
    for (const f of ws.floors) {
      let extra;
      try { const st = await floorStateOf(f); extra = st.branch ? `  ${st.dirty ? 'uncommitted changes, ' : ''}${st.ahead} commit(s) ahead` : ''; } catch { extra = '  (checkout missing)'; }
      rows.push(`${me.floorId === f.id ? '*' : ' '} ${f.name.padEnd(8)} ${f.kind}${f.branch ? ` ${f.branch}` : ''}  ${f.dir}${extra}${f.status ? `   [${f.status.state}] ${f.status.text}` : ''}`);
    }
    return { text: textOf(rows) };
  },
  async 'floor.land'(ws, me, args) {
    this.requireMaestro(me);
    if (me.floorId != null) fail('floors are landed from the ground floor');
    return this.doFloorLand(ws, args);
  },
  async 'floor.delete'(ws, me, args) {
    this.requireMaestro(me);
    if (me.floorId != null) fail('floors are deleted from the ground floor');
    return this.doFloorDelete(ws, args);
  },
  'floor.set-dir'(ws, me, { name, path: p }) {
    this.requireMaestro(me);
    const f = findFloor(ws, name);
    if (f.id === null) fail('the ground floor is the workspace directory');
    const rec = floorById(ws, f.id);
    if (rec.kind === 'worktree' || rec.kind === 'clone') fail(`"${rec.name}" has a checkout of its own; delete the floor and create it on a folder instead`);
    const d = path.resolve(ws.dir, String(p ?? ''));
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) fail(`directory does not exist: ${d}`);
    rec.dir = d; rec.kind = 'dir';
    this.touch(ws);
    return { text: `${rec.name} -> ${d}` };
  },
  'floor.unload'(ws, me, { name }) {
    this.requireMaestro(me);
    const f = findFloor(ws, name);
    let n = 0;
    for (const node of ws.nodes.filter((x) => (x.floorId ?? null) === f.id && x.kind === 'terminal')) { this.terminals.dispose(node.id); n++; }
    this.touch(ws);
    return { text: `unloaded ${f.name}: stopped ${n} terminal(s). They restart when you open the floor` };
  },

  // ----- chat: the human talks to the Maestro; agents answer with `say` -----
  say(ws, me, { text, file, attach = [], progress, thread }) {
    const now = Date.now();
    const recent = (this.sayLog.get(me.id) ?? []).filter((t) => now - t < 60000);
    if (recent.length >= 30) fail('chat rate limit reached (30 messages per minute)');
    this.sayLog.set(me.id, [...recent, now]);
    const active = this.chat.active(ws.id);
    let tid = active;
    if (thread !== undefined) {
      if (!me.maestro) fail('only a Maestro can write to a thread other than the active one');
      tid = threadId(thread);
    }
    const files = [...attach, ...(file ? [file] : [])];
    let body = text ?? '';
    const attachments = [];
    for (const f of files) {
      const isImage = /\.(png|jpe?g|gif|webp)$/i.test(f);
      if (f === file && !isImage && !body) body = this.readTextFile(ws, f);
      else attachments.push(this.chat.attach(ws.id, f));
    }
    const msg = this.chat.append(ws.id, tid, { role: 'agent', sender: me.name, senderId: me.id, text: body, attachments, progress: !!progress });
    if (!progress) this.markAttention(ws, me.id);
    this.touchChat(ws);
    return { text: progress ? 'progress sent' : 'sent', data: { id: msg.id, thread: tid } };
  },

  recall(ws, me, { thread, turns, last, from, to, all, json, list, attachment, summary, archive }) {
    if (list) {
      const rows = this.chat.list(ws.id).map((t) => `${t.active ? '*' : ' '} ${t.id.replace('thread-', '')}  ${t.title.padEnd(14)} ${t.empty ? '(empty)' : `${t.turnCount} turns, last: ${t.preview}`}`);
      return { text: rows.join('\n'), data: this.chat.list(ws.id) };
    }
    if (attachment !== undefined) return { text: this.chat.attachmentPath(ws.id, attachment) };
    const active = this.chat.active(ws.id);
    const tid = thread === undefined ? active : threadId(thread);
    if (!me.maestro && tid !== active) fail('you can only recall the active thread');
    if (all && !me.maestro) fail('only a Maestro can recall every thread');
    const q = { turns: turns ?? (all ? 200 : 30), archive: !!archive };
    if (summary) {
      const text = this.chat.memory.summary(ws.id, tid);
      const model = this.chat.memory.loadModelSummary(ws.id, tid);
      const written = model ? `\n\nSummary written by ${model.driver} on ${model.at.slice(0, 10)} (${model.messages} messages):\n${model.text}` : '';
      return { text: `${text || '(this thread has no rule-based summary yet; it is made when a thread gets long)'}${written}`, data: { thread: tid, summary: text, modelSummary: model } };
    }
    const day = 86400000;
    if (last) {
      const span = { day, week: 7 * day, month: 30 * day }[last];
      if (!span) fail('--last takes day, week or month');
      q.since = Date.now() - span;
    }
    if (from) { q.since = Date.parse(from); if (Number.isNaN(q.since)) fail(`bad date: ${from}`); }
    if (to) { q.until = Date.parse(to); if (Number.isNaN(q.until)) fail(`bad date: ${to}`); }
    const ids = all ? THREAD_IDS : [tid];
    const rows = ids.flatMap((id) => this.chat.history(ws.id, id, q));
    rows.sort((a, b) => a.ts - b.ts);
    const out = rows.slice(-q.turns);
    if (json) return { text: JSON.stringify(out, null, 2), data: out };
    const fmt = (m) => `[${new Date(m.ts).toISOString().slice(0, 16).replace('T', ' ')}]${all ? ` ${m.threadId.replace('thread-', 't')}` : ''} ${m.sender}: ${m.text}${m.attachments.length ? ` (attachments: ${m.attachments.map((a) => `${a.name} ${a.id}`).join(', ')})` : ''}`;
    const earlier = !all && !from && !last && !archive ? this.chat.memory.summary(ws.id, tid) : '';
    const body = out.length ? out.map(fmt).join('\n') : '(nothing remembered in that range)';
    return { text: earlier ? `${earlier}\n\nRecent messages:\n${body}` : body };
  },

  'prompt.parse'(ws, me, { text }) {
    const blocks = parseMentions(text);
    return { text: blocks.map((b) => (b.type === 'text' ? JSON.stringify(b.text) : `${b.kind} ${JSON.stringify(b.ref)}`)).join('\n') || '(empty)', data: blocks };
  },
  'prompt.materialize'(ws, me, { text }) {
    const r = materializeMentions(String(text ?? ''), this.prompterCtx(ws, me));
    const notes = r.mentions.filter((m) => !m.ok).map((m) => `# not included: @${m.kind}:${m.ref} (${m.reason})`);
    return { text: [r.text, ...notes].join('\n'), data: r.mentions };
  },

  // ----- saved prompts -----
  'prompt.list'(ws) {
    const rows = this.prompts.list(ws.id);
    return { text: rows.length ? rows.map((p) => `${p.name.padEnd(24)} ${p.scope === 'global' ? '[global]   ' : '[workspace]'} ${p.preview}`).join('\n') : '(no saved prompts)', data: rows };
  },
  'prompt.read'(ws, me, { name }) { return { text: this.prompts.get(ws.id, name).text }; },
  'prompt.use'(ws, me, { name }) {
    const p = this.prompts.get(ws.id, name);
    return { text: materializeMentions(p.text, this.prompterCtx(ws, me)).text };
  },
  'prompt.save'(ws, me, { name, text, global, overwrite }) {
    this.requireMaestro(me);
    const r = this.prompts.save(ws.id, name, text, { scope: global ? 'global' : 'workspace', overwrite: !!overwrite });
    return { text: `saved "${r.name}" (${r.scope})` };
  },
  'prompt.delete'(ws, me, { name }) {
    this.requireMaestro(me);
    const r = this.prompts.remove(ws.id, name);
    return { text: `deleted "${r.name}"; restore it with: openmaestri prompt undo` };
  },
  'prompt.undo'(ws, me) {
    this.requireMaestro(me);
    const r = this.prompts.undo(ws.id);
    return { text: `restored "${r.name}"` };
  },

  // ----- role discovery and installation -----
  'role.discover'(ws, me) {
    this.requireMaestro(me);
    const rows = this.roleCatalog(ws).map((r) => `${r.id.padEnd(22)} ${r.source.padEnd(11)} ${r.trusted ? '        ' : 'UNTRUSTED'} ${r.description}`);
    return { text: rows.join('\n'), data: this.roleCatalog(ws).map((r) => ({ id: r.id, name: r.name, description: r.description, source: r.source, trusted: r.trusted })) };
  },
  'role.install'(ws, me, args) { return this.roleChange(ws, me, args, false); },
  'role.uninstall'(ws, me, args) { return this.roleChange(ws, me, args, true); },

  // ----- usage -----
  usage(ws, me, { terminal, days, json }) {
    const mine = ws.nodes.filter((n) => n.kind === 'terminal' && (me.maestro || n.id === me.id));
    const pick = terminal ? [this.resolve(ws, me, terminal, ['terminal'])] : mine;
    const rows = pick.map((n) => ({ name: n.name, ...this.usage.summary(n.id, { days }) }));
    if (json) return { text: JSON.stringify(rows, null, 2), data: rows };
    const fmtTok = (t) => (t ? `${t.input} in / ${t.output} out` : 'unknown');
    const fmtCost = (r) => (r.costUsd === null ? (r.tokens ? 'no price' : '-') : `$${r.costUsd.toFixed(4)}`);
    const lines = rows.map((r) => `${r.name.padEnd(18)} ${String(r.turns).padStart(4)} turns  ${String(Math.round(r.activeSeconds / 60)).padStart(4)} min  tokens ${fmtTok(r.tokens).padEnd(22)} cost ${fmtCost(r).padEnd(10)} ${r.source !== 'none' ? `(${r.source}${r.model ? `, ${r.model}` : ''})` : ''}`);
    const total = rows.reduce((a, r) => ({ cost: a.cost + (r.costUsd ?? 0), tin: a.tin + (r.tokens?.input ?? 0), tout: a.tout + (r.tokens?.output ?? 0) }), { cost: 0, tin: 0, tout: 0 });
    if (rows.length > 1) lines.push(`${'total'.padEnd(18)} ${' '.repeat(11)}${' '.repeat(11)}tokens ${`${total.tin} in / ${total.tout} out`.padEnd(22)} cost $${total.cost.toFixed(4)}`);
    if (this.usage.priceProblems.length) lines.push(`note: ${this.usage.priceProblems.join('; ')}`);
    return { text: lines.join('\n') || '(no agents)', data: rows };
  },
  'usage.report'(ws, me, { input, output, model, costUsd }) {
    this.usage.report(me.id, { input, output, model, costUsd }, { node: me, env: this.userEnv() });
    return { text: 'recorded' };
  },
  'usage.reset'(ws, me, { terminal }) {
    this.requireMaestro(me);
    const t = terminal ? this.resolve(ws, me, terminal, ['terminal']) : null;
    for (const n of t ? [t] : ws.nodes.filter((x) => x.kind === 'terminal')) this.usage.reset(n.id);
    return { text: t ? `usage of ${t.name} reset` : 'usage of every agent reset' };
  },

  'memory.status'(ws, me, { thread }) {
    const ids = thread === undefined ? THREAD_IDS : [threadId(thread)];
    if (!me.maestro && ids.some((id) => id !== this.chat.active(ws.id))) fail('you can only look at the active thread');
    const rows = ids.map((id) => this.chat.memory.status(ws.id, id));
    return { text: rows.map((r) => `${r.thread.replace('thread-', '')}: ${r.active} active, ${r.archived} archived, ${r.chapters} summary part(s)${r.due ? ' (long: it will be condensed on the next message)' : ''}`).join('\n'), data: rows };
  },
  'memory.compress'(ws, me, { thread }) {
    this.requireMaestro(me);
    const tid = threadId(thread) ?? this.chat.active(ws.id);
    const r = this.chat.memory.compress(ws.id, tid);
    return { text: r ? `thread ${tid.replace('thread-', '')}: archived ${r.archived} messages, kept ${r.kept}; the summary has ${r.chapters} part(s)` : 'nothing to condense yet: the thread is short' };
  },

  debug(ws, me) {
    const rt = this.terminals.get(me.id);
    return {
      text: [
        `openmaestri daemon: up ${Math.round((Date.now() - this.startedAt) / 1000)}s`,
        `socket: ${this.socketPath}`,
        `workspace: ${ws.name} (${ws.id})`,
        `terminal: ${me.name} (${me.id}) ${rt ? rt.status : 'no runtime'}`,
        `maestro: ${me.maestro ? 'yes' : 'no'}`,
        `connected: ${this.reachable(ws, me).map((n) => n.name).join(', ') || '(none)'}`,
      ].join('\n'),
    };
  },
};

// helpers hung on the prototype so HANDLERS can use `this`
Core.prototype.findPreset = function (name) {
  return this.store.settings.presets.find((p) => p.name.toLowerCase() === String(name).toLowerCase()) || fail(`no preset named "${name}"`);
};
Core.prototype.findRole = function (ws, name) {
  const lc = String(name).toLowerCase();
  const scoped = this.store.settings.roles.filter((r) => r.name.toLowerCase() === lc);
  return scoped.find((r) => r.workspaceId === ws.id) || scoped.find((r) => !r.workspaceId) || fail(`no role named "${name}"`);
};
Core.prototype.findRoutine = function (ws, name) {
  const lc = String(name).toLowerCase();
  return ws.routines.find((r) => r.name.toLowerCase() === lc) || fail(`no routine named "${name}"`);
};
Core.prototype.scheduleNext = function (r) {
  return nextRun(r.schedule);
};

Core.prototype.findBand = function (ws, name) {
  const lc = String(name).toLowerCase();
  return ws.nodes.find((n) => n.kind === 'band' && n.name.toLowerCase() === lc) || fail(`no band named "${name}"`);
};
Core.prototype.findPartitura = function (ws, name) {
  const lc = String(name).toLowerCase();
  const all = this.partiturasFor(ws).filter((p) => p.name.toLowerCase() === lc);
  return all.find((p) => p.scope === ws.id) || all[0] || fail(`no partitura named "${name}"`);
};
/** File a note into the stack called `stackName`, reachable from `me`; create (and wire) the stack if there is none. */
Core.prototype.fileIntoStack = function (ws, me, note, stackName) {
  let st = this.reachable(ws, me).find((n) => n.kind === 'stack' && n.name.toLowerCase() === stackName.toLowerCase());
  if (!st) {
    const pos = this.placeBeside(ws, me, { w: 360, h: 300 });
    st = this.store.createNode(ws, 'stack', { name: stackName, floorId: me.floorId, ...pos });
    this.store.connect(ws, me.id, st.id);
  }
  if (note.stackId && note.stackId !== st.id) this.store.removeFromStack(ws, note.id);
  this.store.addToStack(ws, note.id, st.id);
  // a stacked note is only reachable through its stack, so drop a now-redundant direct cable
  this.store.disconnect(ws, [me.id, note.id]);
  return st;
};
/** Everything a partitura should carry: the chosen agents plus what is wired to them. */
Core.prototype.capture = function (ws, me, { name, agents, withoutMe, commands, noteText, description, icon, color, scope }) {
  const named = agents.map((a) => this.resolve(ws, me, a, ['terminal']));
  const team = named.length ? named : this.reachable(ws, me).filter((n) => n.kind === 'terminal');
  const core = [...(withoutMe ? [] : [me]), ...team];
  if (!core.length) fail('nothing to save: no agents selected');
  const ids = new Set(core.map((n) => n.id));
  for (const t of core) for (const n of this.store.neighbors(ws, t.id)) if (n.kind !== 'terminal') ids.add(n.kind === 'note' && n.stackId ? n.stackId : n.id);
  for (const b of ws.nodes.filter((n) => n.kind === 'band' && n.members.every((m) => ids.has(m)))) ids.add(b.id);
  try {
    return capturePartitura(this.store, ws, [...ids], { name, description: description ?? '', icon: icon ?? null, color: color ?? null, commands: commands !== false, noteText: noteText !== false, scope });
  } catch (e) { return fail(e.message); }
};
Core.prototype.insertPartitura = function (ws, part, me, floor = null) {
  const target = floor ?? (me ? floorById(ws, me.floorId) ?? groundOf(ws) : groundOf(ws));
  const out = instantiatePartitura(this.store, ws, part, { floorId: target.id, baseDir: target.dir });
  for (const n of out.created) {
    if (n.kind === 'terminal') {
      if (me) this.store.connect(ws, me.id, n.id);
      this.startTerminal(ws, n);
    }
  }
  return out;
};

/** Fill a new floor from the ground canvas and/or a partitura. */
Core.prototype.seedFloor = function (ws, me, floor, { copyGround, partitura }) {
  if (copyGround) {
    const ground = ws.nodes.filter((n) => (n.floorId ?? null) === null && !n.stackId).map((n) => n.id);
    if (ground.length) {
      const part = capturePartitura(this.store, ws, ground, { name: `ground-${floor.slug}`, commands: true, noteText: true, scope: 'current' });
      this.startAll(ws, instantiatePartitura(this.store, ws, part, { floorId: floor.id, baseDir: floor.dir, origin: { x: 0, y: 0 } }).created);
    }
  }
  if (partitura) {
    const part = this.findPartitura(ws, partitura);
    this.startAll(ws, instantiatePartitura(this.store, ws, part, { floorId: floor.id, baseDir: floor.dir, origin: { x: 0, y: 0 } }).created);
  }
};
Core.prototype.startAll = function (ws, nodes) {
  for (const n of nodes) if (n.kind === 'terminal') this.startTerminal(ws, n);
};
/** Stop a floor's terminals, delete its nodes and checkout. Returns a text tail with any warnings. */
Core.prototype.dropFloor = async function (ws, floor, opts) {
  const rec = floorById(ws, floor.id);
  const nodes = ws.nodes.filter((x) => x.floorId === floor.id);
  for (const n of nodes) this.terminals.dispose(n.id); // processes first: they may hold the folder open
  // remove the checkout before the nodes, so a refusal (uncommitted changes) loses nothing
  const { warnings } = await withLock(ws.id, () => removeFloor(ws, rec, opts));
  if (rec.repo) await dropSnapshots(rec.repo, rec);
  for (const n of nodes) this.store.deleteNode(ws, n.id);
  return warnings.length ? `\nnote: ${warnings.join('; ')}` : '';
};

/** "123", "#123" or ".../pull/123" (".../merge_requests/123" for GitLab) to the number, or null. */
function pullNumber(raw, part) {
  const text = String(raw).trim().replace(/\/+$/, '');
  const tail = text.slice(text.lastIndexOf('/') + 1).replace(/^#/, '');
  const before = text.includes('/') ? text.slice(0, text.lastIndexOf('/')) : '';
  if (before && !before.endsWith(`/${part}`)) return null;
  return /^\d{1,7}$/.test(tail) ? [text, tail] : null;
}

/** github or gitlab: the --provider given, else read from the origin URL. */
Core.prototype.forgeOf = async function (top, given) {
  if (given) return normalizeProvider(given);
  let url = '';
  try { url = await git(top, ['remote', 'get-url', 'origin']); } catch { fail('this repository has no "origin" remote'); }
  return detectProvider(url) ?? fail('cannot tell if origin is GitHub or GitLab; add --provider github|gitlab');
};
Core.prototype.doFloorCreate = async function (ws, { name, from, branch, existingBranch, copy, noGit, copyGround, partitura, dir, pullRequest, provider: provider0 }) {
  const spec = { name, from, branch, existingBranch, copy, noGit, dir };
  try {
    if (pullRequest !== undefined) {
      const top = await repoTop(ws.dir);
      if (!top) fail('pull request floors need a git repository');
      const provider = await this.forgeOf(top, provider0);
      const info = providerInfo(provider);
      const m = pullNumber(pullRequest, info.urlPart);
      if (!m) fail(`--pull-request takes a number or a ${info.word} URL`);
      const ref = `refs/openmaestri/pr-${m[1]}`;
      await withLock(ws.id, () => git(top, ['fetch', '--no-tags', 'origin', `+${info.refspec(m[1])}:${ref}`], { timeout: 120000 }));
      Object.assign(spec, { name: name || `${provider === 'gitlab' ? 'MR' : 'PR'} ${m[1]}`, branch: `pr-${m[1]}`, startPoint: ref });
    }
    const created = await withLock(ws.id, () => createFloor(ws, spec, [...this.store.workspaces.values()]));
    this.seedFloor(ws, null, created, { copyGround, partitura });
    this.touch(ws);
    return { text: `${created.name}: ${created.kind}${created.branch ? ` on ${created.branch}` : ''} at ${created.dir}`, data: { id: created.id, dir: created.dir, branch: created.branch } };
  } catch (e) { return e instanceof FloorError ? fail(e.message) : Promise.reject(e); }
};
Core.prototype.doFloorLand = async function (ws, { name, into, deleteBranch, keepFloor, noHooks }) {
  const f = findFloor(ws, name);
  if (f.id === null) fail('the ground floor cannot be landed');
  try {
    if (f.hooks?.preLand && !noHooks) {
      const check = await runHook(f.hooks.preLand, { cwd: f.dir, sandbox: f.hooks.sandbox ?? null, docker: f.hooks.sandbox ? this.dockerPath(ws) : null, extraEnv: this.floorEnv(ws, f) });
      this.audit.record('floor.hook', { floor: f.name, hook: 'preLand', ok: check.ok, ms: check.ms }, 'system');
      if (!check.ok) fail(`${describeHook('pre-land', check)}\nNothing was landed. Fix it, or land without the check: floor land "${f.name}" --no-hooks`);
    }
    await withLock(ws.id, () => takeSnapshot(f, 'before land')).catch(() => {}); // a safety net, never a reason to refuse
    const out = await withLock(ws.id, () => landFloor(ws, f, { into }));
    let tail = '';
    if (!keepFloor) tail = await this.dropFloor(ws, f, { keepBranch: !deleteBranch });
    this.noteFact(ws, 'fact', `Floor "${f.name}" was landed into ${out.into}: ${String(out.summary).split('\n')[0]}`);
    this.touch(ws);
    return { text: `landed ${f.name} into ${out.into}: ${out.summary}${tail}` };
  } catch (e) { return e instanceof FloorError ? fail(e.message) : Promise.reject(e); }
};
Core.prototype.doFloorDelete = async function (ws, { name, keepBranch, keepFolder, force }) {
  const f = findFloor(ws, name);
  if (f.id === null) fail('the ground floor cannot be deleted');
  try {
    const tail = await this.dropFloor(ws, f, { keepBranch, keepFolder, force });
    this.touch(ws);
    return { text: `deleted ${f.name}${tail}` };
  } catch (e) { return e instanceof FloorError ? fail(e.message) : Promise.reject(e); }
};

/** Run a portal action, turning browser-side failures into plain command errors. */
Core.prototype.runPortal = async function (fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PortalError) fail(e.message);
    throw e;
  }
};
/** Folders an agent may upload files from: every workspace and floor directory. */
Core.prototype.uploadRoots = function () {
  const roots = [];
  for (const ws of this.store.workspaces.values()) {
    for (const d of [ws.dir, ...ws.floors.map((f) => f.dir)]) { try { roots.push(fs.realpathSync(d)); } catch { /* missing folder */ } }
  }
  return roots;
};
/** A portal whose node no longer exists anywhere has no reason to keep a browser open. */
Core.prototype.reapPortals = function () {
  for (const id of [...this.portals.map.keys()]) {
    const alive = [...this.store.workspaces.values()].some((w) => w.nodes.some((n) => n.id === id));
    if (!alive) this.portals.dispose(id).catch(() => { /* already gone */ });
  }
};

/** Folders an attachment may come from: the workspace and its floors. */
Core.prototype.chatRoots = function (wsId) {
  const ws = this.store.workspaces.get(wsId);
  if (!ws) return [];
  const roots = [];
  for (const d of [ws.dir, ...ws.floors.map((f) => f.dir)]) { try { roots.push(fs.realpathSync(d)); } catch { /* folder is gone */ } }
  return roots;
};
Core.prototype.readTextFile = function (ws, file) {
  const att = this.chat.attach(ws.id, file);
  const text = fs.readFileSync(this.chat.attachmentPath(ws.id, att.id));
  if (text.includes(0)) fail('--file takes a text or image file');
  return cleanText(text.toString('utf8'));
};
Core.prototype.markAttention = function (ws, terminalId) {
  if (!this.attention.has(ws.id)) this.attention.set(ws.id, new Set());
  this.attention.get(ws.id).add(terminalId);
};
Core.prototype.ackAttention = function (ws, terminalId) {
  const set = this.attention.get(ws.id);
  if (set && (terminalId === undefined ? set.size : set.delete(terminalId))) { if (terminalId === undefined) set.clear(); this.touchChat(ws); }
};
Core.prototype.chatState = function (ws) {
  const att = [...(this.attention.get(ws.id) ?? [])].filter((id) => ws.nodes.some((n) => n.id === id));
  const maestro = this.chatMaestro(ws);
  return { threads: this.chat.list(ws.id), active: this.chat.active(ws.id), attention: att, maestroId: maestro?.id ?? null, maestroAttention: !!maestro && att.includes(maestro.id) };
};
Core.prototype.touchChat = function (ws) { this.emit('chat-state', ws.id); };
/** The terminal the human is talking to: the first Maestro on the ground floor, else any Maestro. */
Core.prototype.chatMaestro = function (ws) {
  const maestros = ws.nodes.filter((n) => n.kind === 'terminal' && n.maestro);
  return maestros.find((n) => (n.floorId ?? null) === null) ?? maestros[0] ?? null;
};
/** Human message: stored in the thread, then typed into the Maestro's terminal. */
Core.prototype.chatSend = function (ws, { thread, text, attachments = [] }) {
  const maestro = this.chatMaestro(ws);
  if (!maestro) throw new ChatError('there is no Maestro yet. Create a terminal with Maestro ticked (for example "Maestro (OpenCode + DeepSeek)")');
  const tid = threadId(thread) ?? this.chat.active(ws.id);
  const clean = cleanText(text, 8000).trim();
  if (!clean && !attachments.length) throw new ChatError('write something first');
  const expanded = materializeMentions(clean, this.prompterCtx(ws));
  this.startTerminal(ws, maestro);
  // If the agent has exited, this terminal is now a plain shell and would run the message as commands
  if (!this.terminals.agentRunning(maestro.id)) throw new ChatError(`${maestro.name} is not running an agent right now (its terminal is a plain shell, which would execute your message). Restart it, or use a preset such as "Maestro (OpenCode + DeepSeek)"`);
  const msg = this.chat.append(ws.id, tid, { role: 'human', sender: 'You', text: clean, attachments });
  this.ackAttention(ws);
  const title = this.chat.list(ws.id).find((t) => t.id === tid)?.title ?? tid;
  const files = attachments.map((a) => ` [attached: ${a.name}, ${a.size} bytes. Get its path with: openmaestri recall attachment ${a.id}]`).join('');
  const line = `[openmaestri chat, ${title}] ${cleanText(expanded.text, 140000)}${files}\n(Answer the human with: openmaestri say "your answer". For long work, send short updates with: openmaestri say --progress "...")`;
  this.terminals.deliver(maestro.id, line);
  msg.mentions = expanded.mentions;
  return msg;
};
Core.prototype.chatInterrupt = function (ws) {
  const maestro = this.chatMaestro(ws);
  if (maestro) this.terminals.write(maestro.id, '\x03');
};

/** What a mention may resolve to. A Maestro or the human sees the workspace; any other agent only what is cabled to it. */
Core.prototype.prompterCtx = function (ws, me = null) {
  const visible = !me || me.maestro ? ws.nodes : [me, ...this.store.neighbors(ws, me.id)];
  return {
    roots: this.chatRoots(ws.id),
    notes: () => visible.filter((n) => n.kind === 'note').map((n) => ({ name: n.name, text: this.store.readNote(ws.id, n.id) })),
    agents: () => visible.filter((n) => n.kind === 'terminal').map((n) => ({ name: n.name, status: this.terminals.status(n.id) })),
  };
};
/** File list for the @file picker, cached briefly so typing does not rescan the disk. */
Core.prototype.workspaceFiles = async function (ws, signal) {
  const hit = this.fileCache?.get(ws.id);
  if (hit && Date.now() - hit.at < 20000) return hit.files;
  const { files, aborted } = await fileIndex(ws.dir, { signal });
  if (!aborted) { (this.fileCache ??= new Map()).set(ws.id, { at: Date.now(), files }); }
  return files;
};
Core.prototype.mentionTargets = async function (ws, query, signal) {
  const q = String(query ?? '');
  const ctx = this.prompterCtx(ws);
  const agents = rank(ctx.agents(), q, (a) => a.name, 8).map((a) => ({ kind: 'agent', ref: a.name, name: a.name, detail: a.status }));
  const notes = rank(ctx.notes(), q, (n) => n.name, 8).map((n) => ({ kind: 'note', ref: n.name, name: n.name, detail: 'note' }));
  const files = rank(await this.workspaceFiles(ws, signal), q, (f) => f, 14).map((f) => ({ kind: 'file', ref: f, name: path.basename(f), detail: path.dirname(f) === '.' ? '' : path.dirname(f) }));
  return [...agents, ...notes, ...files];
};

Core.prototype.userEnv = function () {
  return readUserEnv(path.join(this.dataRoot, 'env'));
};
Core.prototype.usageCtx = function (id) {
  const node = this.terminals.get(id)?.node ?? null;
  return { node, env: this.userEnv() };
};
/** Usage of a terminal that no longer exists moves into the archived total. */
Core.prototype.reapUsage = function () {
  const alive = new Set();
  for (const w of this.store.workspaces.values()) for (const n of w.nodes) alive.add(n.id);
  for (const id of Object.keys(this.usage.data.terminals)) if (!alive.has(id)) this.usage.forget(id);
};

Core.prototype.roleCatalog = function (ws) {
  return discoverRoles({
    userRoles: this.store.settings.roles.filter((r) => !r.workspaceId || r.workspaceId === ws.id),
    dataRoles: path.join(this.dataRoot, 'roles'),
    wsRoles: path.join(ws.dir, '.openmaestri', 'roles'),
    repoDir: ws.dir,
  });
};
/** Install or remove a role block in the instruction file of one agent. Dry run unless `apply`. */
Core.prototype.roleChange = function (ws, me, { role, agent, apply, trust }, remove) {
  this.requireMaestro(me);
  if (!role || !agent) fail(`usage: role ${remove ? 'uninstall' : 'install'} "Role" --agent "Name" [--apply]${remove ? '' : ' [--trust]'}`);
  const node = this.resolve(ws, me, agent, ['terminal']);
  const kind = agentKind(node);
  if (!kind) fail(`cannot tell which agent runs in "${node.name}". Supported: ${Object.keys(AGENT_FILES).join(', ')}`);
  const lc = String(role).toLowerCase();
  const matches = this.roleCatalog(ws).filter((r) => r.id === lc || r.name.toLowerCase() === lc);
  const found = matches.find((r) => r.trusted) ?? matches[0];
  if (!found) fail(`no role "${role}". See: openmaestri role discover`);
  if (!remove && !found.trusted && !trust) fail(`"${found.name}" comes from the repository, so anyone who can commit to it could have written it. Read it with "role discover", then add --trust to install it anyway`);
  let cwd;
  try { cwd = fs.realpathSync(node.cwd); } catch { return fail(`the folder of ${node.name} is missing`); }
  if (!this.chatRoots(ws.id).some((r) => cwd === r || cwd.startsWith(r + path.sep))) fail('that agent works outside the workspace; roles are only written inside it');
  const r = planRole({ cwd, kind, role: found, remove, apply: !!apply });
  if (!r.changed) return { text: remove ? 'nothing to remove' : `already installed in ${r.file}` };
  const verb = remove ? 'remove from' : 'add to';
  if (!apply) return { text: `Dry run: this would ${verb} ${r.file}\n\n${diffText(r.file, r.before, r.after)}\n\nRun again with --apply to write it${r.existed ? ' (a backup is made first)' : ''}.` };
  return { text: `${remove ? 'removed from' : 'installed in'} ${r.file}${r.backup ? `\nbackup: ${r.backup}` : ''}\nRestart ${node.name} so it reads the file again.` };
};

/** The folder a Files node browses: its floor's folder, or the workspace folder. */
/** Run one headless agent; tracked so shutdown and the concurrency limit see it. Never throws for a failed run. */
/** The sandbox asked for on the command line: an image name, and --no-network. null for none. */
Core.prototype.sandboxFrom = function (image, noNetwork) {
  if (!image) return null;
  return checkSandbox({ image: String(image), network: noNetwork ? 'none' : 'bridge' });
};

const QUOTA_HOLD_MS = 30 * 60 * 1000;
const DRIVER_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** Who to try, in order: the driver asked for, then its fallbacks (given now, or set with `fallback set`). */
Core.prototype.fallbackChain = function (driver, fallback) {
  const saved = this.store.settings.fallbacks;
  const extra = fallback ?? (saved && Object.hasOwn(saved, driver) ? saved[driver] : []);
  return [driver, ...new Set((Array.isArray(extra) ? extra : []).filter((d) => typeof d === 'string' && DRIVER_NAME.test(d) && d !== driver))];
};

/**
 * Run one headless agent. When the account is out of quota or credit, the next driver in the chain answers instead,
 * and the one that refused is not tried again for 30 minutes. The result says who answered and who was skipped.
 */
Core.prototype.execAgent = async function ({ driver, drivers, fallback, ...rest }) {
  const chain = this.fallbackChain(driver, fallback);
  const tried = [];
  this.quotaHold ??= new Map();
  let last;
  for (const [i, name] of chain.entries()) {
    const more = i < chain.length - 1;
    if (more && (this.quotaHold.get(name) ?? 0) > Date.now()) { tried.push({ driver: name, why: 'out of quota a moment ago, skipped' }); continue; }
    if (i > 0 && !drivers[name]) { tried.push({ driver: name, why: 'no such driver' }); continue; }
    let r;
    try {
      r = await this.execOne({ ...rest, driver: name, drivers, model: i === 0 ? rest.model : undefined, account: i === 0 ? rest.account : undefined });
    } catch (e) {
      if (i === 0 || !(e instanceof HeadlessError)) throw e;
      tried.push({ driver: name, why: e.message });
      continue;
    }
    r.driver = name;
    last = r;
    if (!quotaRefused(r)) { this.quotaHold.delete(name); return { ...r, tried }; }
    this.quotaHold.set(name, Date.now() + QUOTA_HOLD_MS);
    tried.push({ driver: name, why: (r.stderr || r.text).split('\n')[0].slice(0, 160) });
  }
  if (!last) fail(`no driver in the chain could run: ${tried.map((t) => `${t.driver} (${t.why})`).join('; ')}`);
  return { ...last, tried };
};

Core.prototype.execOne = async function ({ driver, drivers, prompt, cwd, model, timeoutMs, ac = new AbortController(), ws, account, sandbox = null, extraEnv = {} }) {
  this.headless.add(ac);
  try {
    const env = workerEnv(process.env, path.join(this.dataRoot, 'env'), this.resolveSecret, drivers[driver]);
    if (account) Object.assign(env, this.accounts.env(account, this.resolveSecret)); // the account was chosen on purpose, so its keys pass whatever the driver lists
    Object.assign(env, extraEnv);
    return await runHeadless({ driver, drivers, prompt, cwd, env, model, timeoutMs, signal: ac.signal, resolveBin: (b) => this.safeBin(ws, b), sandbox });
  } finally { this.headless.delete(ac); }
};

/** A program found through the user's shell, unless it lives inside the project: a repository must not be able to shadow an agent CLI by putting a same-named file on PATH. */
Core.prototype.safeBin = function (ws, bin) {
  const found = commandPath(bin);
  if (!found) return null;
  let real;
  try { real = fs.realpathSync(found); } catch { return null; }
  const inside = [ws?.dir, ...(ws?.floors ?? []).map((f) => f.dir)].filter(Boolean).some((d) => { try { const r = fs.realpathSync(d); return real === r || real.startsWith(r + path.sep); } catch { return false; } });
  if (inside) throw new HeadlessError(`"${bin}" resolves to ${real}, which is inside the project. Refusing to run a program that a repository could have planted; install it outside the project`);
  return found;
};

/** Problems that would stop a run before it starts: unknown driver, program not installed. */
/** The after-agent check of a floor; when it fails and the floor asks for it, the files go back to how they were before the agent. */
Core.prototype.runPostAgentHook = async function (ws, rec, beforeId, runSandbox = null) {
  // a run in a container checks its result in a container too, unless the floor names its own
  const box = rec.hooks.sandbox ?? runSandbox;
  const result = await runHook(rec.hooks.postAgent, { cwd: rec.dir, sandbox: box, docker: box ? this.dockerPath(ws) : null, extraEnv: this.floorEnv(ws, rec) });
  let text = describeHook('post-agent', result);
  if (!result.ok && rec.hooks.rollbackOnFail && beforeId) {
    try { await withLock(ws.id, () => rollbackFloor(rec, beforeId)); text += '\nThe files were rolled back to before the agent (the agent\'s work is in its after snapshot).'; } catch (e) { text += `\nThe rollback failed: ${e.message}`; }
  }
  this.audit.record('floor.hook', { floor: rec.name, hook: 'postAgent', ok: result.ok, ms: result.ms }, 'system');
  return { ok: result.ok, text };
};

Core.prototype.preflightAgents = function (ws, agents, drivers, box = null) {
  const problems = [];
  const missing = (bin, what) => { try { return this.safeBin(ws, bin) ? null : `"${bin}" (${what}) was not found in your shell`; } catch (e) { return e.message; } };
  for (const a of agents) {
    if (!drivers[a]) problems.push(`no driver named "${a}"`);
    // in a sandbox the agent program lives in the image; only docker has to exist on this machine
    else if (!box && !drivers[a].sandbox) { const m = missing(drivers[a].bin, `driver ${a}`); if (m) problems.push(m); }
  }
  if ((box || agents.some((a) => drivers[a]?.sandbox)) && !problems.length) { const m = missing('docker', 'needed for the sandbox'); if (m) problems.push(m); }
  return problems;
};

Core.prototype.runTask = async function (ws, me, { task, agents: rawAgents, floors, dryRun, model, timeoutMs, account, sandbox, noNetwork }) {
  const box = this.sandboxFrom(sandbox, noNetwork);
  if (account) this.accounts.env(account); // a missing account stops the run before it starts
  const text = String(task ?? '').trim();
  const agents = parseAgents(rawAgents);
  if (!text || !agents.length) fail('usage: run "task" --agents claude,codex [--floors] [--dry-run] [--model M] [--timeout 10m]');
  if (agents.length > MAX_AGENTS) fail(`at most ${MAX_AGENTS} agents per run`);
  const drivers = { ...DRIVERS, ...customDrivers(this.store.settings.drivers) };
  const problems = this.preflightAgents(ws, agents, drivers, box);
  if (problems.length) fail(`cannot start the run:\n- ${problems.join('\n- ')}`);
  if (floors && !(await repoTop(ws.dir))) fail('--floors needs the workspace folder to be a git repository; without one, agents would share the same folder');
  const plan = planText({ task: text, agents, floors: !!floors, model });
  if (dryRun) return { text: `${plan}\n\nDry run: nothing was started.` };
  if (this.headless.size + agents.length > MAX_HEADLESS) fail(`${this.headless.size} one-shot agents are already running; this run needs ${agents.length} of the ${MAX_HEADLESS} allowed`);
  const prompt = materializeMentions(text, this.prompterCtx(ws, me)).text;
  const tag = crypto.randomBytes(2).toString('hex');
  const base = me.cwd && fs.existsSync(me.cwd) ? me.cwd : ws.dir;
  this.audit.record('run', { agents, account: account ?? '', by: me.name, floors: !!floors, model: model ?? '', taskChars: prompt.length, taskSha256: sha256(prompt) }, 'terminal');
  // take the slots now, before any await: two runs started together cannot both pass the limit
  const slots = agents.map(() => new AbortController());
  for (const ac of slots) this.headless.add(ac);
  let results;
  try { results = await Promise.all(agents.map(async (driver, i) => {
    let floor = null;
    let cwd = base;
    if (floors) {
      try {
        const made = await this.doFloorCreate(ws, { name: `run ${driver} ${tag}` });
        floor = { name: `run ${driver} ${tag}`, dir: made.data.dir, branch: made.data.branch };
        cwd = made.data.dir;
      } catch (e) { return { driver, ok: false, problem: `the floor could not be created: ${e.message}` }; }
    }
    const rec = floor ? ws.floors.find((f) => f.dir === cwd) : null;
    const before = rec ? (await withLock(ws.id, () => takeSnapshot(rec, `before ${driver}`)).catch(() => null))?.id : null;
    const r = await this.execAgent({ driver, drivers, prompt, cwd, model, timeoutMs, ws, ac: slots[i], account, sandbox: box, fallback: [], extraEnv: this.floorEnv(ws, rec) });
    // what the agent left behind can be put back with `floor rollback`
    if (floor) floor.snapshot = (await withLock(ws.id, () => takeSnapshot(rec, `after ${driver}`)).catch(() => null))?.id;
    const hook = rec?.hooks?.postAgent && r.ok ? await this.runPostAgentHook(ws, rec, before, box) : null;
    return { driver, floor, ...r, ...(hook ? { hook } : {}) };
  })); } finally { for (const ac of slots) this.headless.delete(ac); }
  const report = reportText({ task: text, results, floors: !!floors });
  const pos = this.placeBeside(ws, me, { w: 420, h: 320 });
  const note = this.store.createNode(ws, 'note', { name: `Run ${tag}`, text: report, floorId: me.floorId, ...pos });
  this.store.connect(ws, me.id, note.id);
  this.noteFact(ws, 'fact', `Run "${text.slice(0, 80)}" with ${agents.join(', ')}: ${results.filter((r) => r.ok).length} of ${results.length} finished (note "${note.name}")`);
  this.touch(ws);
  if (!results.some((r) => r.ok)) fail(`${report}\n\n(also saved in the note "${note.name}")`);
  return { text: `${report}\n\n(also saved in the note "${note.name}")` };
};

/** Signal one process below a terminal's shell. */
Core.prototype.stopProcessIn = function (ws, me, terminal, pid, force) {
  const node = this.resolve(ws, me, terminal, ['terminal']);
  const root = this.terminals.pidOf(node.id);
  if (!root) fail(`${node.name} is not running`);
  stopProcess(root, pid, { force });
  this.audit.record('ps.stop', { terminal: node.name, pid, force, by: me.name }, 'terminal');
  return { text: `sent ${force ? 'SIGKILL' : 'SIGTERM'} to ${pid} in ${node.name}` };
};

/** Apply the hook settings that were given to a floor record. Returns whether anything changed. */
Core.prototype.editHooks = function (rec, { postAgent, preLand, rollbackOnFail, clear, sandbox }) {
  if (clear) { delete rec.hooks; return true; }
  if ([postAgent, preLand, rollbackOnFail, sandbox].every((v) => v === undefined)) return false;
  const next = { ...(rec.hooks ?? {}) };
  if (postAgent !== undefined) next.postAgent = checkCommand(postAgent);
  if (preLand !== undefined) next.preLand = checkCommand(preLand);
  if (rollbackOnFail !== undefined) next.rollbackOnFail = !!rollbackOnFail;
  if (sandbox !== undefined) { if (sandbox) next.sandbox = checkSandbox(String(sandbox)); else delete next.sandbox; }
  rec.hooks = next;
  return true;
};

/** The docker program for hooks, found the same careful way as the agent programs. */
Core.prototype.dockerPath = function (ws) {
  return this.safeBin(ws, 'docker') ?? fail('"docker" was not found in your shell, so the sandbox cannot start');
};

Core.prototype.workspaceNamed = function (name) {
  const lc = String(name ?? '').toLowerCase();
  return [...this.store.workspaces.values()].find((w) => w.name.toLowerCase() === lc) || fail(`no workspace named "${name}"`);
};

/** Icon: up to 8 characters of text or emoji. Group: up to 40 characters. No control characters in either. */
Core.prototype.applyWorkspaceLook = function (w, { icon, group }) {
  const clean = (v, max, what) => {
    const t = String(v).trim();
    if ([...t].length > max || [...t].some((ch) => ch.codePointAt(0) < 32 || ch.codePointAt(0) === 127)) fail(`${what} is at most ${max} characters, without control characters`);
    return t || null;
  };
  if (icon !== undefined) w.icon = clean(icon, 8, 'an icon');
  if (group !== undefined) w.group = clean(group, 40, 'a group name');
  this.store.saveWorkspace(w.id);
  this.emit('workspace-list');
};

Core.prototype.unloadWorkspace = function (w) {
  let stopped = 0;
  for (const n of w.nodes) {
    if (n.kind === 'terminal' && this.terminals.has(n.id)) { this.terminals.dispose(n.id); stopped += 1; }
    if (n.kind === 'portal') { this.portals.detach?.(n.id)?.catch?.(() => {}); }
  }
  this.audit.record('workspace.unload', { name: w.name, terminals: stopped }, 'system');
  this.emit('workspace-list');
  return `${w.name}: stopped ${stopped} terminal${stopped === 1 ? '' : 's'}; everything is kept and starts again when you open it`;
};

Core.prototype.filesRoot = function (ws, node) {
  if (node.kind !== 'files') throw new FilesError('that is not a file browser');
  return node.floorId ? (ws.floors.find((f) => f.id === node.floorId)?.dir ?? ws.dir) : ws.dir;
};

/** Build the handoff note of a terminal and put it on the canvas, cabled to the Maestro and to that terminal. Returns the note's name. */
Core.prototype.writeHandoff = async function (ws, me, node, { ask = false } = {}) {
  let selfReport = '';
  if (ask && this.terminals.agentRunning(node.id) && node.id !== me.id) {
    try { selfReport = (await HANDLERS.ask.call(this, ws, me, { name: node.name, prompt: SELF_REPORT_PROMPT, timeoutMs: 90000 })).data.output; } catch { /* it did not answer: the facts below still stand */ }
  }
  const info = { name: node.name, folder: path.basename(node.cwd ?? ''), command: node.command, selfReport, screen: this.terminals.text(node.id, { lastLines: 120 }) };
  const floor = floorById(ws, node.floorId);
  if (floor && floor.id !== groundOf(ws).id) Object.assign(info, { floor: floor.name, branch: floor.branch });
  if (node.cwd) {
    try { info.status = await git(node.cwd, ['status', '--short'], { timeout: 10000 }); info.diffstat = await git(node.cwd, ['diff', '--stat', 'HEAD'], { timeout: 10000 }); } catch { /* not a repository */ }
  }
  info.notes = this.store.neighbors(ws, node.id).filter((x) => x.kind === 'note').map((x) => x.name).filter((x) => !x.startsWith('Handoff:'));
  const stamp = new Date().toISOString().slice(11, 16);
  const made = HANDLERS['note.create'].call(this, ws, me, { content: handoffText({ ...info, at: new Date() }), name: `Handoff: ${node.name} ${stamp}` });
  const note = this.resolveAny(ws, made.text, ['note']);
  this.store.connect(ws, node.id, note.id);
  this.audit.record('handoff', { agent: node.name, ask, note: note.name }, 'terminal');
  return note.name;
};

/** Memory the next agent should start with, as one block of text (empty when there is none). */
Core.prototype.factsBrief = function (ws) { return factsBrief(this.facts.list(ws.id)); };

/** A line of project memory written by the app itself (a landing, a run). Never throws: memory must not break the work. */
Core.prototype.noteFact = function (ws, kind, text) {
  try { this.facts.add(ws.id, { kind, text, by: 'openmaestri', auto: true }); } catch { /* full disk or a bad line: skip it */ }
};

/** Write the facts into the instruction file of one agent (AGENTS.md, CLAUDE.md...), between markers. Dry run unless `apply`. */
Core.prototype.exportFacts = function (ws, me, { agent, apply }) {
  if (!agent) fail('usage: facts export "Name" [--apply]');
  const node = this.resolve(ws, me, agent, ['terminal']);
  const kind = agentKind(node);
  if (!kind) fail(`cannot tell which agent runs in "${node.name}". Supported: ${Object.keys(AGENT_FILES).join(', ')}`);
  let cwd;
  try { cwd = fs.realpathSync(node.cwd); } catch { return fail(`the folder of ${node.name} is missing`); }
  if (!this.chatRoots(ws.id).some((r) => cwd === r || cwd.startsWith(r + path.sep))) fail('that agent works outside the workspace; facts are only written inside it');
  const block = { id: 'project-memory', name: 'Project memory', heading: 'Project memory', prompt: factsBlock(this.facts.list(ws.id)) };
  const r = planRole({ cwd, kind, role: block, apply: !!apply });
  if (!r.changed) return { text: `already up to date in ${r.file}` };
  if (!apply) return { text: `Dry run: this would update ${r.file}\n\n${diffText(r.file, r.before, r.after)}\n\nRun again with --apply to write it${r.existed ? ' (a backup is made first)' : ''}.` };
  return { text: `updated ${r.file}${r.backup ? `\nbackup: ${r.backup}` : ''}\nRestart ${node.name} so it reads the file again.` };
};

/** The block of ports of a floor (null for the ground floor). Handed out on first use and kept in the workspace file. */
Core.prototype.portBaseOf = function (ws, floor) {
  const rec = floor ?? ws;
  if (Number.isInteger(rec.portBase)) return rec.portBase;
  const taken = [...this.store.workspaces.values()].flatMap((w) => [w.portBase, ...w.floors.map((f) => f.portBase)]).filter(Number.isInteger);
  const base = freePortBase(taken);
  if (base === null) return null;
  rec.portBase = base;
  this.store.saveWorkspace(ws.id);
  return base;
};

/** PORT, OPENMAESTRI_PORT_BASE, OPENMAESTRI_FLOOR and COMPOSE_PROJECT_NAME for whatever starts in this floor. */
Core.prototype.floorEnv = function (ws, nodeOrFloor) {
  const floor = nodeOrFloor?.kind === 'terminal' ? floorById(ws, nodeOrFloor.floorId) : nodeOrFloor ?? null;
  const base = this.portBaseOf(ws, floor);
  return base === null ? {} : floorVars(ws, floor, base);
};

/** The container command for a terminal that runs in a box, or null when docker is missing. Only account keys go in, by name. */
Core.prototype.terminalBox = function (node, command, cwd) {
  const docker = commandPath('docker');
  if (!docker) return null;
  const name = `om-t-${crypto.randomBytes(6).toString('hex')}`;
  const accountKeys = node.account ? Object.keys(this.accounts.env(node.account, this.resolveSecret)) : [];
  return { name, docker, command: dockerTerminalCommand(checkSandbox(node.sandbox), { name, cwd, command, envNames: accountKeys, docker }) };
};
