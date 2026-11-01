// Agent usage: tokens, estimated cost, turns and active time per terminal.
// Where the numbers come from is always recorded, and never invented:
//   reported  an agent or wrapper said so with `openmaestri usage report`   (exact)
//   parsed    a line like "Tokens: 1.2k sent, 340 received" in the terminal  (best effort)
// There is deliberately no token estimate from terminal bytes: an agent UI redraws its screen
// constantly, so byte counts say nothing about tokens. Without reported or parsed numbers a
// terminal shows turns and active time only.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { atomicWrite } from './store.js';

export class UsageError extends Error {}
const fail = (m) => { throw new UsageError(m); };

const MAX_TOKENS = 1e9;
const MAX_LINE = 4096;
const DAYS_KEPT = 90;

/** USD per million tokens. Checked against the vendor's price page on 2026-11-01; override with <data dir>/prices.json. */
export const DEFAULT_PRICES = {
  'deepseek-flash': { input: 0.15, output: 0.6, peak: { input: 0.3, output: 1.2 } },
  'deepseek-v4-pro': { input: 0.66, output: 1.98, peak: { input: 1.32, output: 3.96 } },
};
/** DeepSeek's peak window (UTC, Monday to Friday): 01:00-04:00 and 06:00-10:00. */
export function isPeak(date = new Date()) {
  const day = date.getUTCDay();
  const h = date.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

/** Model ids like deepseek-flash or deepseek/deepseek-flash; never a path. */
const validModel = (m) => typeof m === 'string' && /^[\w./:-]{1,80}$/.test(m) && !m.includes('..') && !m.startsWith('/');
const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10000;
function cleanPrice(p) {
  if (!p || !num(p.input) || !num(p.output)) return null;
  const out = { input: p.input, output: p.output };
  if (p.peak && num(p.peak.input) && num(p.peak.output)) out.peak = { input: p.peak.input, output: p.peak.output };
  return out;
}

/** Built-in prices plus <file>, which is untrusted input: strict shape, numbers only, anything else ignored. */
export function loadPrices(file) {
  const prices = { ...DEFAULT_PRICES };
  const problems = [];
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') problems.push(`prices.json is not valid JSON`); return { prices, problems }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { prices, problems: ['prices.json must be an object of model -> prices'] };
  for (const [model, p] of Object.entries(raw)) {
    const ok = validModel(model) ? cleanPrice(p) : null;
    if (ok) prices[model] = ok; else problems.push(`ignored the price for "${String(model).slice(0, 40)}"`);
  }
  return { prices, problems };
}

export function costOf(price, tokensIn, tokensOut, at = new Date()) {
  if (!price) return null;
  const p = price.peak && isPeak(at) ? price.peak : price;
  return (tokensIn * p.input + tokensOut * p.output) / 1e6;
}

const ESC = String.fromCharCode(27);
export function stripAnsi(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ESC) { out += s[i]; continue; }
    const next = s[i + 1];
    if (next === '[') { i += 2; while (i < s.length && !(s.charCodeAt(i) >= 64 && s.charCodeAt(i) <= 126)) i++; }
    else if (next === ']') { i += 2; while (i < s.length && s[i] !== '\u0007' && !(s[i] === ESC && s[i + 1] === '\\')) i++; if (s[i] === ESC) i++; }
    else i += 1;
  }
  return out;
}

/** "1.2k" -> 1200, "15,300" -> 15300, "2m" -> 2000000; anything else null. */
export function parseCount(word) {
  let w = String(word).replaceAll(',', '').toLowerCase();
  if (w.length === 0 || w.length > 16) return null;
  let mult = 1;
  const last = w[w.length - 1];
  if (last === 'k' || last === 'm') { mult = last === 'k' ? 1e3 : 1e6; w = w.slice(0, -1); }
  const [whole, frac, extra] = w.split('.');
  const digits = (x) => x !== undefined && x.length > 0 && [...x].every((c) => c >= '0' && c <= '9');
  if (extra !== undefined || !digits(whole) || whole.length > 10 || (frac !== undefined && (!digits(frac) || frac.length > 3))) return null;
  const n = Number(frac === undefined ? whole : `${whole}.${frac}`) * mult;
  return Number.isFinite(n) && n <= MAX_TOKENS ? Math.round(n) : null;
}

/**
 * Look for "Tokens: 1.2k sent, 340 received" (also "input"/"output") in one line of terminal text.
 * No regex over the whole line: it is split into words, so hostile output cannot make this slow.
 */
export function parseUsageLine(line) {
  const text = stripAnsi(line).slice(0, MAX_LINE);
  if (!/tokens?/i.test(text.slice(0, 200))) return null;
  const words = text.split(/\s+/).filter(Boolean);
  let input = null;
  let output = null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/[.,;:]+$/, '').toLowerCase();
    const n = parseCount(words[i - 1].replace(/[.,;:]+$/, ''));
    if (n === null) continue;
    if (w === 'sent' || w === 'input' || w === 'in' || w === 'prompt') input = (input ?? 0) + n;
    else if (w === 'received' || w === 'output' || w === 'out' || w === 'completion') output = (output ?? 0) + n;
  }
  return input === null && output === null ? null : { input: input ?? 0, output: output ?? 0 };
}

const emptyRec = () => ({
  turns: 0, activeSeconds: 0, reported: { input: 0, output: 0 }, parsed: { input: 0, output: 0 }, costUsd: 0, costKnown: false,
  model: null, firstAt: Date.now(), lastAt: Date.now(), days: {},
});

export class Usage extends EventEmitter {
  /** @param {{file: string, pricesFile: string}} deps */
  constructor({ file, pricesFile }) {
    super();
    this.file = file;
    this.pricesFile = pricesFile;
    this.data = { terminals: {}, archived: { turns: 0, input: 0, output: 0, costUsd: 0 } };
    this.partial = new Map();
    this.timer = null;
    this.dirty = false;
    this.load();
    this.reloadPrices();
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && typeof d === 'object' && d.terminals && typeof d.terminals === 'object') this.data = { archived: this.data.archived, ...d };
    } catch { /* first run or damaged: start empty, never crash */ }
  }

  reloadPrices() {
    const r = loadPrices(this.pricesFile);
    this.prices = r.prices;
    this.priceProblems = r.problems;
  }

  rec(id) { return (this.data.terminals[id] ??= emptyRec()); }

  flushSoon() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.save(); this.emit('changed'); }, 2000);
    this.timer.unref();
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    atomicWrite(this.file, JSON.stringify(this.data));
  }

  close() { clearTimeout(this.timer); this.timer = null; this.save(); }

  /** Which model a terminal is using, for pricing. An explicit report wins over what the preset implies. */
  modelFor(node, env = {}) {
    if (node?.usageModel) return node.usageModel;
    if (`${node?.preset ?? ''} ${node?.command ?? ''}`.toLowerCase().includes('deepseek')) return env.OPENMAESTRI_DEEPSEEK_MODEL || 'deepseek-flash';
    return null;
  }

  addTokens(id, kind, tokens, { model = null, node = null, env = {}, at = new Date() } = {}) {
    const r = this.rec(id);
    r[kind].input += tokens.input;
    r[kind].output += tokens.output;
    const m = model ?? this.modelFor(node, env);
    if (m) r.model = m;
    const price = r.model ? this.prices[r.model] : null;
    const cost = costOf(price, tokens.input, tokens.output, at);
    if (cost !== null) { r.costUsd += cost; r.costKnown = true; }
    const day = at.toISOString().slice(0, 10);
    const d = (r.days[day] ??= { input: 0, output: 0, costUsd: 0 });
    d.input += tokens.input; d.output += tokens.output; d.costUsd += cost ?? 0;
    for (const k of Object.keys(r.days).sort((a, b) => a.localeCompare(b)).slice(0, -DAYS_KEPT)) delete r.days[k];
    r.lastAt = Date.now();
    this.flushSoon();
  }

  /** An agent says exactly what it used. Numbers are validated; nothing else is trusted. */
  report(id, { input, output, model, costUsd }, ctx = {}) {
    const i = Number(input ?? 0);
    const o = Number(output ?? 0);
    for (const v of [i, o]) if (!Number.isInteger(v) || v < 0 || v > MAX_TOKENS) fail(`token counts are whole numbers from 0 to ${MAX_TOKENS.toExponential(0)}`);
    if (!i && !o) fail('report at least one of --in or --out');
    if (model !== undefined && !validModel(String(model))) fail('model names use letters, digits and . _ / : -');
    this.addTokens(id, 'reported', { input: i, output: o }, { ...ctx, model: model ?? null });
    if (costUsd !== undefined) {
      const c = Number(costUsd);
      if (!Number.isFinite(c) || c < 0 || c > 100000) fail('cost is a number of US dollars');
      const r = this.rec(id);
      // the agent knows its real bill better than our table does: replace what the table added for this report
      const table = costOf(r.model ? this.prices[r.model] : null, i, o, ctx.at ?? new Date()) ?? 0;
      r.costUsd += c - table;
      r.costKnown = true;
    }
  }

  /** Terminal output, in chunks: pick complete lines out of it and look for usage lines. */
  observe(id, chunk, getCtx = () => ({})) {
    const buf = (this.partial.get(id) ?? '') + chunk;
    const lines = buf.split(/\r?\n|\r/);
    this.partial.set(id, lines.pop().slice(-MAX_LINE));
    for (const line of lines) {
      const u = parseUsageLine(line);
      if (u) this.addTokens(id, 'parsed', u, getCtx());
    }
  }

  turn(id) { this.rec(id).turns += 1; this.rec(id).lastAt = Date.now(); this.flushSoon(); }
  tick(id) { this.rec(id).activeSeconds += 1; this.dirty = true; }

  forget(id) {
    const r = this.data.terminals[id];
    if (!r) return;
    const a = this.data.archived;
    a.turns += r.turns; a.input += r.reported.input + r.parsed.input; a.output += r.reported.output + r.parsed.output; a.costUsd += r.costUsd;
    delete this.data.terminals[id];
    this.partial.delete(id);
    this.flushSoon();
  }

  reset(id) { delete this.data.terminals[id]; this.partial.delete(id); this.flushSoon(); }

  /** A summary for one terminal, with the source of every number spelled out. */
  summary(id, { days } = {}) {
    const r = this.data.terminals[id];
    if (!r) return { turns: 0, activeSeconds: 0, tokens: null, costUsd: null, model: null, source: 'none' };
    const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : null;
    let input = r.reported.input + r.parsed.input;
    let output = r.reported.output + r.parsed.output;
    let cost = r.costUsd;
    if (cutoff) {
      input = 0; output = 0; cost = 0;
      for (const [d, v] of Object.entries(r.days)) if (d >= cutoff) { input += v.input; output += v.output; cost += v.costUsd; }
    }
    const hasTokens = r.reported.input + r.reported.output + r.parsed.input + r.parsed.output > 0;
    const source = !hasTokens ? 'none' : r.reported.input + r.reported.output > 0 ? (r.parsed.input + r.parsed.output > 0 ? 'reported+parsed' : 'reported') : 'parsed';
    return { turns: r.turns, activeSeconds: r.activeSeconds, tokens: hasTokens ? { input, output } : null, costUsd: hasTokens && r.costKnown ? cost : null, model: r.model, source, lastAt: r.lastAt };
  }
}
