#!/usr/bin/env node
// Functional orchestration challenge: a Maestro has to coordinate an Auditor and a Dev through several round trips.
// Real agents:  node test/challenge/run.mjs --maestro 'opencode -m opencode/big-pickle' --worker 'opencode -m opencode/big-pickle'
// Scripted agents (no model, used by npm test):  node test/challenge/run.mjs --scripted
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../../src/server.js';
import { MAESTRO_BOOTSTRAP } from '../../src/prompts.js';
import crypto from 'node:crypto';
import { buildScenario, writeScenario, CHALLENGE, buggyFlagScript } from './scenario.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byName = (a, b) => a.localeCompare(b);
/** What agent programs print when the account is out of quota (free tiers end). */
export const PROVIDER_LIMIT = /rate limit exceeded|free usage limit reached|free-models-per-day|insufficient (?:credits|balance)|quota exceeded/i;
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The word an Auditor answered with (a reply that has both words counts as a rejection), or ? when it gave neither. */
export function verdictOf(text) {
  if (/\bREJECTED\b/.test(text)) return 'REJECTED';
  return /\bAPPROVED\b/.test(text) ? 'APPROVED' : '?';
}

/** Messages to a teammate that were sent more than once, word for word. */
export function repeatedCount(trace) {
  return trace.filter((x, i) => x.to !== 'Maestro' && trace.findIndex((y) => y.to === x.to && y.text === x.text) !== i).length;
}

/** Messages to a teammate that carry two or more of the true per-region revenues: the Maestro dictating what the teammate should compute. */
export function leakedCount(trace, stats) {
  const figures = new Set(Object.values(stats).map((r) => String(r.revenue)));
  return trace.filter((x) => x.to !== 'Maestro' && (x.text.match(/\d+/g) ?? []).filter((d) => figures.has(d)).length >= 2).length;
}

const fileHash = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);

/** One line per run for the per-model table (`summary.mjs`): who played which part and how it went. */
export function recordLine(r, { maestro, worker, seed, inject }) {
  const model = (cmd) => /-m\s+(\S+)/.exec(cmd)?.[1] ?? cmd.trim().split(/\s+/).at(-1);
  return {
    date: new Date().toISOString().slice(0, 10), maestro: model(maestro), worker: model(worker), seed, inject: !!inject,
    outcome: r.outcome, passed: r.passed, seconds: r.seconds, messages: r.roundTrips, repeated: r.repeated, leaked: r.leaked,
    gated: r.gated, gatesFailed: r.gatesFailed, verdicts: r.verdicts.join(','), failed: Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k),
  };
}

/** What a run has to show. The last three only apply when a bug was planted (`inject`). */
export function buildChecks({ inject, final, answered, scriptOut, key, team, toName, reads, repeated, leaked, planted, verdicts, checksFailed, finalHash, verifyOut = null, buggyOut = null }) {
  const checks = {
    'final answer says APPROVED': /VERDICT:\s*APPROVED/i.test(final),
    'flagged regions match the answer key': sameList(answered, key),
    'flag.py exists and prints the answer key': scriptOut !== null && sameList(scriptOut, key),
    'Auditor and Dev were recruited': ['Auditor', 'Dev'].every((n) => team.some((x) => x.name === n)),
    'Auditor was asked at least twice (rules, then review)': toName('Auditor') >= 2,
    'Dev was asked at least once': toName('Dev') >= 1,
    'the Maestro did not read the data itself': reads < 5,
    'no message to a teammate was sent twice': repeated === 0,
    'the Maestro did not dictate sales figures to a teammate': leaked === 0,
  };
  if (inject) {
    checks['the planted bug was caught (the program\'s check failed, or the Auditor said REJECTED)'] = planted !== null && (verdicts.includes('REJECTED') || checksFailed > 0);
    checks['the Dev was asked again after the rejection'] = toName('Dev') >= 2;
    checks['flag.py was fixed, not left as planted'] = planted !== null && finalHash !== planted;
    // the Auditor's verify.py is the oracle: if it is empty or always agrees, the program's check proved nothing
    checks['the Auditor\'s verify.py prints the answer key'] = verifyOut !== null && sameList(verifyOut, key);
    checks['the Auditor\'s verify.py tells the planted bug apart'] = verifyOut !== null && buggyOut !== null && !sameList(verifyOut, buggyOut);
  }
  return checks;
}

/**
 * @param {{maestro: string, worker: string, seed?: number, timeoutMs?: number, stallMs?: number, bootMs?: number, bootstrap?: boolean, inject?: boolean, record?: string, outDir?: string, log?: (s: string) => void}} o
 */
export async function runChallenge({ maestro, worker, seed = 7, timeoutMs = 30 * 60 * 1000, stallMs = 8 * 60 * 1000, bootMs = 15000, bootstrap = true, inject = false, record, outDir, log = () => {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'om-challenge-'));
  const dir = path.join(root, 'work');
  fs.mkdirSync(dir);
  const sc = buildScenario(seed);
  writeScenario(dir, sc);
  const app = await main({ port: 0, dataRoot: path.join(root, 'data'), socketPath: path.join(root, 'ipc.sock'), quiet: true });
  const { core } = app;
  const started = Date.now();
  const t = () => Math.round((Date.now() - started) / 1000);
  const trace = [];
  const events = [];
  const asks = [];
  let planted = null;
  let lastActivity = Date.now();
  try {
    const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
    ws.dir = dir;
    core.store.settings.presets.push({ name: 'Worker', command: worker, maestro: false });
    core.store.saveSettings();

    const orig = core.terminals.deliver.bind(core.terminals);
    core.terminals.deliver = (id, text, opts) => {
      const node = ws.nodes.find((n) => n.id === id);
      trace.push({ at: t(), to: node?.name ?? id, text: String(text).replace(/\s+/g, ' ').slice(0, 300) });
      lastActivity = Date.now();
      log(`[${t()}s] -> ${node?.name}: ${String(text).replace(/\s+/g, ' ').slice(0, 100)}`);
      return orig(id, text, opts);
    };

    // fault injection: the moment the Dev hands over flag.py, before the Maestro can run it, swap in one with the classic mistake;
    // the review has to catch it and the Dev has to fix it
    const flagPath = path.join(dir, 'flag.py');
    let devAnswered = false;
    const plant = () => {
      if (!inject || planted || !devAnswered || !fs.existsSync(flagPath)) return;
      fs.writeFileSync(flagPath, buggyFlagScript(sc.limits));
      planted = fileHash(flagPath);
      events.push({ at: t(), text: 'harness planted a bug in flag.py (every row counts)' });
      log(`[${t()}s] harness planted a bug in flag.py`);
    };

    // how long each wait for an answer took and how much text came back: an ask that returns in a blink with nothing is the failure to look for
    const origWait = core.terminals.waitIdle.bind(core.terminals);
    core.terminals.waitIdle = async (id, o) => {
      const t0 = Date.now();
      const state = await origWait(id, o);
      // the Dev has just stopped: swap in the buggy flag.py before the program checks it
      if (state === 'idle' && ws.nodes.find((n) => n.id === id)?.name === 'Dev') { devAnswered = true; plant(); }
      asks.push({ at: t(), to: ws.nodes.find((n) => n.id === id)?.name ?? id, state, secs: Math.round((Date.now() - t0) / 1000) });
      return state;
    };

    // what ask handed back to the Maestro, per teammate: the evidence of who said what (a TUI redraws, so the screen alone loses it)
    const answers = [];
    const origCommand = core.command.bind(core);
    core.command = async (ctx, cmd, a) => {
      const r = await origCommand(ctx, cmd, a);
      if (cmd === 'ask' && a?.name && r?.data) answers.push({ at: t(), from: r.data.name, output: String(r.data.output ?? ''), verdict: r.data.gate?.verdict?.status ?? null, gate: r.data.gate ?? null });
      return r;
    };

    const boss = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir, command: maestro });
    core.startTerminal(ws, boss);
    await sleep(bootMs);
    // CHALLENGE_BOOTSTRAP replaces the first message (experiments); {CLI} is the absolute path of the openmaestri command
    const first = (process.env.CHALLENGE_BOOTSTRAP || MAESTRO_BOOTSTRAP).replaceAll('{CLI}', core.terminals.env.cliBin ?? 'openmaestri');
    if (bootstrap) { core.terminals.deliver(boss.id, first); await sleep(Math.min(bootMs, 20000)); }
    core.chatSend(ws, { text: `${CHALLENGE(dir)}\nUse the preset named Worker for both teammates.` });

    const said = () => core.chat.history(ws.id, core.chat.active(ws.id), { turns: 200 }).filter((m) => m.role === 'agent' && !m.progress);
    let outcome = 'timeout';
    let screenLen = 0;
    while (Date.now() - started < timeoutMs) {
      await sleep(2000);
      if (said().some((m) => /VERDICT:/i.test(m.text))) { outcome = 'answered'; break; }
      // fault injection that did not fit when the Dev answered (no flag.py yet) is done here, as soon as the file is there
      plant();
      const len = ws.nodes.reduce((n, x) => n + (x.kind === 'terminal' ? core.terminals.text(x.id, { lastLines: 400 }).length : 0), 0);
      if (len !== screenLen) { screenLen = len; lastActivity = Date.now(); }
      // a provider that says "no more today" will not change its mind in the next minutes: stop and say so
      const limited = ws.nodes.some((x) => x.kind === 'terminal' && PROVIDER_LIMIT.test(core.terminals.text(x.id, { lastLines: 40 })));
      if (limited) { outcome = 'provider-limit'; break; }
      if (Date.now() - lastActivity > stallMs) { outcome = 'stalled'; break; }
    }

    const final = said().findLast((m) => /VERDICT:/i.test(m.text))?.text ?? '';
    const flaggedLine = /FLAGGED:\s*(.*)/i.exec(final)?.[1] ?? '';
    const answered = flaggedLine.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean).sort(byName);
    const ran = spawnSync('/usr/bin/python3', ['flag.py'], { cwd: dir, encoding: 'utf8', timeout: 20000 });
    const scriptOut = fs.existsSync(path.join(dir, 'flag.py')) && ran.status === 0 ? ran.stdout.split('\n').map((x) => x.trim()).filter(Boolean).sort(byName) : null;
    const team = ws.nodes.filter((n) => n.kind === 'terminal' && !n.maestro);
    const toName = (n) => trace.filter((x) => x.to === n).length;
    const repeated = repeatedCount(trace);
    const leaked = leakedCount(trace, sc.stats);
    const verdicts = answers.filter((a) => a.from === 'Auditor').map((a) => a.verdict ?? verdictOf(a.output));
    const checksFailed = (core.events.get(ws.id) ?? []).filter((e) => e.kind === 'check' && e.ok === false).length;
    const finalHash = fileHash(path.join(dir, 'flag.py'));
    const reads = (core.terminals.text(boss.id, { lastLines: 2000 }).match(/ORD-\d{4},/g) ?? []).length;
    const listOf = (r) => (r.status === 0 ? r.stdout.split('\n').map((x) => x.trim()).filter(Boolean).sort(byName) : null);
    const verifyOut = inject && fs.existsSync(path.join(dir, 'verify.py')) ? listOf(spawnSync('/usr/bin/python3', ['verify.py'], { cwd: dir, encoding: 'utf8', timeout: 20000 })) : null;
    const buggyOut = inject ? listOf(spawnSync('/usr/bin/python3', ['-c', buggyFlagScript(sc.limits)], { cwd: dir, encoding: 'utf8', timeout: 20000 })) : null;
    const checks = buildChecks({ inject, final, answered, scriptOut, key: sc.flagged, team, toName, reads, repeated, leaked, planted, verdicts, checksFailed, finalHash, verifyOut, buggyOut });
    const result = {
      outcome, seconds: t(), passed: Object.values(checks).every(Boolean), checks, key: sc.flagged, answered, scriptOut,
      roundTrips: trace.filter((x) => x.to !== 'Maestro').length, toDev: toName('Dev'), toAuditor: toName('Auditor'),
      finalAnswer: final, trace, events, asks, answers, verdicts, repeated, leaked, checksFailed, nudges: (core.events.get(ws.id) ?? []).filter((e) => e.kind === 'nudge').length, gated: answers.filter((a) => a.gate).length, gatesFailed: answers.filter((a) => a.gate && !a.gate.ok).length,
      screens: Object.fromEntries(ws.nodes.filter((n) => n.kind === 'terminal').map((n) => [n.name, core.terminals.text(n.id, { lastLines: 60 })])),
    };
    const out = outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'om-challenge-report-'));
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(out, 'report.md'), report(result, { maestro, worker, seed }));
    for (const f of ['flag.py']) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(out, f));
    // the whole session of every terminal, for reading what a model actually did
    for (const n of ws.nodes.filter((x) => x.kind === 'terminal')) fs.writeFileSync(path.join(out, `${n.name}.txt`), core.terminals.text(n.id, { lastLines: 4000 }));
    result.reportDir = out;
    if (record) fs.appendFileSync(record, `${JSON.stringify(recordLine(result, { maestro, worker, seed, inject }))}\n`);
    return result;
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

function report(r, { maestro, worker, seed }) {
  const rows = Object.entries(r.checks).map(([k, v]) => `| ${v ? 'PASS' : 'FAIL'} | ${k} |`).join('\n');
  const tr = r.trace.map((x) => `- ${String(x.at).padStart(4)}s to **${x.to}**: ${x.text.slice(0, 160)}`).join('\n');
  const scr = Object.entries(r.screens).map(([n, s]) => `### ${n}\n\`\`\`\n${s.split('\n').slice(-25).join('\n')}\n\`\`\``).join('\n\n');
  return `# Orchestration challenge: ${r.passed ? 'PASSED' : 'FAILED'}

Maestro: \`${maestro}\`  Workers: \`${worker}\`  Seed: ${seed}  Outcome: ${r.outcome}  Time: ${r.seconds}s

| Result | Check |
|---|---|
${rows}

Answer key: ${r.key.join(', ')}. Maestro answered: ${r.answered.join(', ') || '(nothing)'}.
Messages sent to teammates: ${r.roundTrips} (Dev ${r.toDev}, Auditor ${r.toAuditor}). Repeated: ${r.repeated}. With sales figures in them: ${r.leaked}.
Asks judged by the program (--check, --verdict): ${r.gated}, failed: ${r.gatesFailed}. Checks that failed: ${r.checksFailed}. Reminders sent to the Maestro: ${r.nudges}.
Auditor verdicts in order (from what ask returned): ${r.verdicts.join(', ') || '(none)'}.
Waits for an answer: ${r.asks.map((a) => `${a.to} ${a.state} ${a.secs}s`).join(', ') || '(none)'}.
Harness events: ${r.events.map((e) => `${e.at}s ${e.text}`).join('; ') || '(none)'}.

## Final answer
${r.finalAnswer || '(none)'}

## Messages delivered, in order
${tr || '(none)'}

## Screens at the end
${scr}
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const scripted = args.includes('--scripted');
  const fx = path.join(HERE, 'agents');
  const r = await runChallenge({
    maestro: scripted ? `bash ${fx}/maestro.sh` : get('maestro'),
    worker: scripted ? `bash ${fx}/worker.sh` : get('worker', get('maestro')),
    seed: Number(get('seed', 7)),
    timeoutMs: Number(get('timeout', 30)) * 60 * 1000,
    stallMs: Number(get('stall', 8)) * 60 * 1000,
    bootMs: Number(get('boot', scripted ? 1500 : 15)) * (scripted ? 1 : 1000),
    bootstrap: !scripted,
    inject: args.includes('--inject'),
    record: get('record'),
    outDir: get('out'),
    log: (s) => console.error(s),
  });
  console.log(`${r.passed ? 'PASSED' : 'FAILED'} (${r.outcome}, ${r.seconds}s, ${r.roundTrips} messages to teammates). Report: ${r.reportDir}/report.md`);
  process.exit(r.passed ? 0 : 1);
}
