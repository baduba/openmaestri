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
import { buildScenario, writeScenario, CHALLENGE } from './scenario.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byName = (a, b) => a.localeCompare(b);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * @param {{maestro: string, worker: string, seed?: number, timeoutMs?: number, stallMs?: number, bootMs?: number, bootstrap?: boolean, outDir?: string, log?: (s: string) => void}} o
 */
export async function runChallenge({ maestro, worker, seed = 7, timeoutMs = 30 * 60 * 1000, stallMs = 8 * 60 * 1000, bootMs = 15000, bootstrap = true, outDir, log = () => {} }) {
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

    const boss = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir, command: maestro });
    core.startTerminal(ws, boss);
    await sleep(bootMs);
    if (bootstrap) { core.terminals.deliver(boss.id, MAESTRO_BOOTSTRAP); await sleep(Math.min(bootMs, 20000)); }
    core.chatSend(ws, { text: `${CHALLENGE(dir)}\nUse the preset named Worker for both teammates.` });

    const said = () => core.chat.history(ws.id, core.chat.active(ws.id), { turns: 200 }).filter((m) => m.role === 'agent' && !m.progress);
    let outcome = 'timeout';
    let screenLen = 0;
    while (Date.now() - started < timeoutMs) {
      await sleep(2000);
      if (said().some((m) => /VERDICT:/i.test(m.text))) { outcome = 'answered'; break; }
      const len = ws.nodes.reduce((n, x) => n + (x.kind === 'terminal' ? core.terminals.text(x.id, { lastLines: 400 }).length : 0), 0);
      if (len !== screenLen) { screenLen = len; lastActivity = Date.now(); }
      if (Date.now() - lastActivity > stallMs) { outcome = 'stalled'; break; }
    }

    const final = said().findLast((m) => /VERDICT:/i.test(m.text))?.text ?? '';
    const flaggedLine = /FLAGGED:\s*(.*)/i.exec(final)?.[1] ?? '';
    const answered = flaggedLine.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean).sort(byName);
    const ran = spawnSync('/usr/bin/python3', ['flag.py'], { cwd: dir, encoding: 'utf8', timeout: 20000 });
    const scriptOut = fs.existsSync(path.join(dir, 'flag.py')) && ran.status === 0 ? ran.stdout.split('\n').map((x) => x.trim()).filter(Boolean).sort(byName) : null;
    const team = ws.nodes.filter((n) => n.kind === 'terminal' && !n.maestro);
    const toName = (n) => trace.filter((x) => x.to === n).length;
    const reads = (core.terminals.text(boss.id, { lastLines: 2000 }).match(/ORD-\d{4},/g) ?? []).length;
    const checks = {
      'final answer says APPROVED': /VERDICT:\s*APPROVED/i.test(final),
      'flagged regions match the answer key': sameList(answered, sc.flagged),
      'flag.py exists and prints the answer key': scriptOut !== null && sameList(scriptOut, sc.flagged),
      'Auditor and Dev were recruited': ['Auditor', 'Dev'].every((n) => team.some((x) => x.name === n)),
      'Auditor was asked at least twice (rules, then review)': toName('Auditor') >= 2,
      'Dev was asked at least once': toName('Dev') >= 1,
      'the Maestro did not read the data itself': reads < 5,
    };
    const result = {
      outcome, seconds: t(), passed: Object.values(checks).every(Boolean), checks, key: sc.flagged, answered, scriptOut,
      roundTrips: trace.filter((x) => x.to !== 'Maestro').length, toDev: toName('Dev'), toAuditor: toName('Auditor'),
      finalAnswer: final, trace,
      screens: Object.fromEntries(ws.nodes.filter((n) => n.kind === 'terminal').map((n) => [n.name, core.terminals.text(n.id, { lastLines: 60 })])),
    };
    const out = outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'om-challenge-report-'));
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(out, 'report.md'), report(result, { maestro, worker, seed }));
    for (const f of ['flag.py']) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(out, f));
    result.reportDir = out;
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
Messages sent to teammates: ${r.roundTrips} (Dev ${r.toDev}, Auditor ${r.toAuditor}).

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
    outDir: get('out'),
    log: (s) => console.error(s),
  });
  console.log(`${r.passed ? 'PASSED' : 'FAILED'} (${r.outcome}, ${r.seconds}s, ${r.roundTrips} messages to teammates). Report: ${r.reportDir}/report.md`);
  process.exit(r.passed ? 0 : 1);
}
