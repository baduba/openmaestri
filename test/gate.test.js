import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { clipLog, parseVerdict, correction, similarity, AskLog, repeatNotice, reportText, VERDICT_FORMAT } from '../src/gate.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BLOCK = (status, reason) => `<<<VERDICT\nSTATUS: ${status}\nREASON: ${reason}\nVERDICT>>>`;

test('clipLog keeps the start and the end of a long log', () => {
  const log = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const out = clipLog(log);
  assert.match(out, /^line 0\n/);
  assert.match(out, /line 199$/);
  assert.match(out, /140 lines left out/);
  assert.ok(out.split('\n').length <= 61);
  assert.equal(clipLog('short'), 'short');
});

test('parseVerdict: the one-line form, with markdown around it, and only an exact status', () => {
  assert.deepEqual(parseVerdict('I checked.\nVERDICT: REJECTED - Norte is flagged by mistake'), { status: 'REJECTED', reason: 'Norte is flagged by mistake' });
  assert.deepEqual(parseVerdict('**VERDICT: APPROVED** - the output matches the rules'), { status: 'APPROVED', reason: 'the output matches the rules' });
  assert.deepEqual(parseVerdict('  ┃  VERDICT: APPROVED: all three regions check out'.replace('┃', '')), { status: 'APPROVED', reason: 'all three regions check out' });
  assert.equal(parseVerdict('VERDICT: APPROVED'), null, 'a reason is required');
  assert.equal(parseVerdict('VERDICT: NOT APPROVED - no'), null);
  assert.equal(parseVerdict('VERDICT: <APPROVED or REJECTED> - <what you found>'), null, 'the template is not a verdict');
  assert.equal(parseVerdict('VERDICT: APPROVED - <reason>'), null, 'a placeholder is not a reason');
  assert.equal(parseVerdict('VERDICT: MAYBE - unsure'), null);
  assert.equal(parseVerdict('VERDICT: APPROVED - first\nVERDICT: REJECTED - second').status, 'REJECTED', 'the last one wins');
});

test('parseVerdict: the older block still counts, the last one wins, loose words are not a verdict', () => {
  assert.deepEqual(parseVerdict(`I looked.\n${BLOCK('REJECTED', 'Norte is flagged by mistake')}`), { status: 'REJECTED', reason: 'Norte is flagged by mistake' });
  assert.equal(parseVerdict('APPROVED, looks fine'), null);
  assert.equal(parseVerdict(BLOCK('MAYBE', 'x')), null, 'STATUS is one of two words');
  assert.equal(parseVerdict('<<<VERDICT\nSTATUS: APPROVED\nVERDICT>>>'), null, 'a reason is required');
  assert.equal(parseVerdict('<<<VERDICT\nSTATUS: APPROVED\nREASON: fine'), null, 'an unclosed block is not a verdict');
  assert.equal(parseVerdict(VERDICT_FORMAT), null, 'the template itself is not a verdict');
  assert.equal(parseVerdict(`${BLOCK('APPROVED', 'first')}\n${BLOCK('REJECTED', 'second')}`).status, 'REJECTED');
  assert.equal(parseVerdict('<<<VERDICT\nSTATUS: NOT APPROVED\nREASON: x\nVERDICT>>>'), null, '"NOT APPROVED" is not APPROVED');
});

test('correction: the failure goes back in a fixed wording with the shortened output', () => {
  const c = correction({ kind: 'check', command: 'python3 flag.py', exitCode: 1, output: Array.from({ length: 100 }, (_, i) => `err ${i}`).join('\n') });
  assert.match(c, /Command: python3 flag.py/);
  assert.match(c, /exited with code 1/);
  assert.match(c, /lines left out/);
  assert.match(correction({ kind: 'format' }), /VERDICT: <APPROVED or REJECTED>/);
  assert.match(correction({ kind: 'check', command: 'x', timedOut: true, output: '' }), /timed out/);
});

test('similarity and the loop log: near copies of a message are counted per teammate', () => {
  assert.ok(similarity('Read data/rules.md and explain the rules', 'Read data/rules.md and explain the rules please') > 0.8);
  assert.ok(similarity('Read data/rules.md and explain the rules', 'Write flag.py that prints the regions') < 0.3);
  const log = new AskLog();
  const now = Date.now();
  assert.equal(log.note('w', 'a', 'Read data/rules.md and explain the rules', now), 0);
  assert.equal(log.note('w', 'a', 'Read data/rules.md and explain the rules.', now + 1000), 1);
  assert.equal(log.note('w', 'b', 'Read data/rules.md and explain the rules', now + 2000), 0, 'another teammate');
  assert.equal(log.note('w', 'a', 'Read data/rules.md and explain the rules', now + 16 * 60 * 1000), 0, 'an old one does not count');
  assert.match(repeatNotice(2, 'Dev'), /3 times/);
});

test('reportText: one line per event and the totals', () => {
  const at = '2026-11-03T12:00:00.000Z';
  const txt = reportText([
    { at, kind: 'ask', to: 'Dev', ok: true, secs: 12, note: '300 chars' },
    { at, kind: 'check', to: 'Dev', ok: false, secs: 1, note: 'python3 flag.py exit 1' },
    { at, kind: 'retry', to: 'Dev', note: 'check' },
    { at, kind: 'verdict', to: 'Auditor', ok: true, note: 'REJECTED Norte' },
  ]);
  assert.match(txt, /1 asks, 1 checks \(1 failed\), 1 verdicts \(1 rejected\), 1 corrections sent/);
  assert.match(reportText([]), /Nothing to report/);
});

/** A daemon, a Maestro, and teammates that are small bash programs: each runs `body` for every prompt it receives (all its lines). */
async function setup(t, mates) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-gate-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  const maestro = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir });
  for (const [name, body] of Object.entries(mates)) {
    const sub = path.join(dir, name);
    fs.mkdirSync(sub);
    const script = `echo ready; n=0; while read -r q; do while read -r -t 0.15 more; do q="$q $more"; done; n=$((n+1)); ${body}; done`;
    const node = core.store.createNode(ws, 'terminal', { name, cwd: sub, command: `bash -c '${script.replaceAll("'", "'\\''")}'` });
    core.startTerminal(ws, node);
  }
  await sleep(500);
  const ask = (args) => core.command({ terminalId: maestro.id }, 'ask', { quietMs: 900, timeoutMs: 20000, ...args });
  return { core, ws, dir, maestro, ask };
}

test('ask --check: the program runs the command in the teammate folder and says FAILED with the output', async (t) => {
  const { ask } = await setup(t, { Dev: 'echo bad > status.txt; echo "all done"' });
  const r = await ask({ name: 'Dev', prompt: 'make status.txt say ok', check: 'grep -q ok status.txt || { echo "status.txt says: $(cat status.txt)"; exit 3; }', retries: 0 });
  assert.match(r.text, /^\[gate\] FAILED after 1 attempt: the check .* exited with 3/);
  assert.match(r.text, /status\.txt says: bad/);
  assert.equal(r.data.gate.ok, false);
  const ok = await ask({ name: 'Dev', prompt: 'a different request about the readme file', check: 'test -f status.txt', retries: 0 });
  assert.match(ok.text, /^\[gate\] PASSED after 1 attempt/);
});

test('ask --check --retries: the failure goes back to the teammate by itself and the second try passes', async (t) => {
  const { ask, core, ws } = await setup(t, { Dev: 'if [ $n -ge 2 ]; then echo ok > status.txt; else echo bad > status.txt; fi; echo "done $n"' });
  const r = await ask({ name: 'Dev', prompt: 'write ok into status.txt', check: 'grep -q ok status.txt', retries: 1 });
  assert.match(r.text, /^\[gate\] PASSED after 2 attempts/);
  assert.equal(r.data.gate.attempts, 2);
  const kinds = core.events.get(ws.id).map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k !== 'ask'), ['check', 'retry', 'check']);
});

test('retries are capped at 2 whatever is asked for', async (t) => {
  const { ask } = await setup(t, { Dev: 'echo never > status.txt; echo "done"' });
  const r = await ask({ name: 'Dev', prompt: 'write ok into status.txt', check: 'grep -q ok status.txt', retries: 50 });
  assert.match(r.text, /FAILED after 3 attempts/);
});

test('ask --verdict: a reply without the block is sent back once and then accepted', async (t) => {
  const { ask } = await setup(t, { Auditor: 'if [ $n -ge 2 ]; then printf "%s\\n" "<<<VERDICT" "STATUS: REJECTED" "REASON: Norte has revenue 10994 which is under the limit" "VERDICT>>>"; else echo "looks fine to me"; fi' });
  const r = await ask({ name: 'Auditor', prompt: 'review the output Centro Leste Litoral Norte against the rules', verdict: true, retries: 1 });
  assert.match(r.text, /^\[gate\] PASSED after 2 attempts\. VERDICT: REJECTED: Norte has revenue 10994/);
  assert.deepEqual(r.data.gate.verdict, { status: 'REJECTED', reason: 'Norte has revenue 10994 which is under the limit' });
});

test('ask --verdict fails closed: a teammate that never writes the block is reported as FAILED', async (t) => {
  const { ask } = await setup(t, { Auditor: 'echo "APPROVED"' });
  const r = await ask({ name: 'Auditor', prompt: 'review the output against the rules', verdict: true, retries: 1 });
  assert.match(r.text, /^\[gate\] FAILED after 2 attempts: no verdict line in the required shape/);
  assert.equal(r.data.gate.verdict, null);
});

test('ask --then: when one teammate cannot pass, the task goes to another and the answer says so', async (t) => {
  const { ask, core, ws } = await setup(t, { Weak: 'echo bad > status.txt; echo "done"', Strong: 'echo ok > status.txt; echo "done"' });
  const r = await ask({ name: 'Weak', prompt: 'write ok into status.txt', check: 'grep -q ok status.txt', retries: 0, handTo: 'Strong' });
  assert.match(r.text, /^\[gate\] PASSED after 1 attempt by Strong, after Weak did not pass/);
  assert.equal(r.data.gate.handedTo, 'Strong');
  assert.ok(core.events.get(ws.id).some((e) => e.kind === 'forward' && e.to === 'Strong'));
});

test('a Maestro that sends the same message over and over is warned, then refused', async (t) => {
  const { ask, core, ws } = await setup(t, { Dev: 'echo "done $n"' });
  const same = 'Read data/rules.md and explain every rule in your own words';
  const texts = [];
  for (let i = 0; i < 4; i++) texts.push((await ask({ name: 'Dev', prompt: same })).text);
  assert.doesNotMatch(texts[1], /\[loop\]/);
  assert.match(texts[2], /\[loop\] "Dev" has now been sent almost the same message 3 times/);
  await assert.rejects(ask({ name: 'Dev', prompt: same }), /5 times/);
  assert.ok(core.events.get(ws.id).some((e) => e.kind === 'loop'));
});

test('report: written from what happened, and only a Maestro can make the program run a command', async (t) => {
  const { ask, core, maestro, ws } = await setup(t, { Dev: 'echo ok > status.txt; echo done' });
  await ask({ name: 'Dev', prompt: 'write ok', check: 'grep -q ok status.txt' });
  const rep = await core.command({ terminalId: maestro.id }, 'report', {});
  assert.match(rep.text, /-> Dev/);
  assert.match(rep.text, /1 checks \(0 failed\)/);
  const worker = core.store.createNode(ws, 'terminal', { name: 'Worker', cwd: ws.dir, command: 'cat' });
  await assert.rejects(core.command({ terminalId: worker.id }, 'ask', { name: 'Dev', prompt: 'x', check: 'true' }), /only available to Maestro/);
});

/** A stand-in Maestro that reads what it is typed and never answers the human. */
async function quietMaestro(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-nudge-'));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  const saved = { idle: process.env.OPENMAESTRI_NUDGE_IDLE_MS, tick: process.env.OPENMAESTRI_NUDGE_TICK_MS };
  process.env.OPENMAESTRI_NUDGE_IDLE_MS = '400';
  process.env.OPENMAESTRI_NUDGE_TICK_MS = '100';
  t.after(async () => {
    for (const [k, v] of [['OPENMAESTRI_NUDGE_IDLE_MS', saved.idle], ['OPENMAESTRI_NUDGE_TICK_MS', saved.tick]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  const boss = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir, command: `bash -c 'echo ready; while IFS= read -r l; do echo "GOT: $l"; done'` });
  core.startTerminal(ws, boss);
  await sleep(600);
  return { core, ws, boss };
}
const count = (text, needle) => text.split(needle).length - 1;

test('a Maestro that goes quiet after the human wrote is reminded twice, in fixed words, and no more', async (t) => {
  const { core, ws, boss } = await quietMaestro(t);
  core.chatSend(ws, { thread: '1', text: 'please plan the release' });
  await sleep(3500);
  assert.equal(count(core.terminals.text(boss.id), 'GOT: [openmaestri] The human wrote'), 2, 'the stand-in prints back each line it was typed');
  assert.equal(core.events.get(ws.id).filter((e) => e.kind === 'nudge').length, 2);
  assert.match(reportText(core.events.get(ws.id)), /2 reminders to the Maestro/);
});

test('a Maestro that answered the human is left alone', async (t) => {
  const { core, ws, boss } = await quietMaestro(t);
  const msg = core.chatSend(ws, { thread: '1', text: 'hello' });
  core.chat.append(ws.id, msg.threadId, { role: 'agent', sender: 'Maestro', text: 'hi, here is the plan' });
  await sleep(2000);
  assert.equal(count(core.terminals.text(boss.id), 'GOT: [openmaestri] The human wrote'), 0);
});

test('an answer to the human over a failed check carries the notice; once the check passes it does not', async (t) => {
  const { core, ws, boss } = await quietMaestro(t);
  core.noteEvent(ws, { kind: 'check', to: 'Dev', ok: false, note: 'python3 flag.py exit 1' });
  await core.command({ terminalId: boss.id }, 'say', { text: 'VERDICT: APPROVED' });
  const first = core.chat.history(ws.id, core.chat.active(ws.id)).filter((m) => m.role === 'agent').at(-1).text;
  assert.match(first, /VERDICT: APPROVED\n\n\[openmaestri\] Not verified: a check on the work of Dev: python3 flag\.py exit 1 failed/);
  assert.ok(core.events.get(ws.id).some((e) => e.kind === 'unverified'));
  core.noteEvent(ws, { kind: 'check', to: 'Dev', ok: true, note: 'python3 flag.py exit 0' });
  await core.command({ terminalId: boss.id }, 'say', { text: 'second answer' });
  const second = core.chat.history(ws.id, core.chat.active(ws.id)).filter((m) => m.role === 'agent').at(-1).text;
  assert.equal(second, 'second answer');
  await core.command({ terminalId: boss.id }, 'say', { text: 'progress only', progress: true });
});

test('resume: what was asked and checked survives a restart, and a Maestro that joins late is told what is still open', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const start = () => main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  const first = await start();
  const ws1 = first.core.store.workspaces.get(first.core.store.settings.activeWorkspaceId);
  const boss = first.core.store.createNode(ws1, 'terminal', { name: 'Maestro', maestro: true, cwd: dir });
  first.core.noteEvent(ws1, { kind: 'ask', to: 'Dev', ok: true, secs: 30, note: '300 chars' });
  first.core.noteEvent(ws1, { kind: 'check', to: 'Dev', ok: false, secs: 1, note: 'python3 flag.py exit 1' });
  first.core.noteEvent(ws1, { kind: 'check', to: 'Auditor', ok: true, secs: 1, note: 'python3 verify.py exit 0' });
  await first.close();

  const second = await start();
  t.after(() => second.close());
  const ws2 = second.core.store.workspaces.get(ws1.id);
  assert.equal(second.core.eventsFor(ws2.id).length, 3, 'the events are back after the restart');
  const r = await second.core.command({ terminalId: boss.id }, 'resume', {});
  assert.match(r.text, /3 recorded events/);
  assert.match(r.text, /Still open[\s\S]*Dev: python3 flag\.py exit 1/);
  assert.doesNotMatch(r.text, /Still open[\s\S]*Auditor: python3 verify/, 'a check that passed is not open');
  assert.match(second.core.resumeBrief(ws2), /Continue from here; do not redo what already passed/);
});

test('resume: a workspace with nothing recorded says so, and a damaged events file is ignored', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-resume2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  const ws = app.core.store.workspaces.get(app.core.store.settings.activeWorkspaceId);
  const boss = app.core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir });
  assert.match((await app.core.command({ terminalId: boss.id }, 'resume', {})).text, /Nothing has happened/);
  fs.mkdirSync(app.core.store.wsDir(ws.id), { recursive: true });
  fs.writeFileSync(path.join(app.core.store.wsDir(ws.id), 'events.json'), '{not json');
  await app.close();
  const again = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(() => again.close());
  assert.equal(again.core.eventsFor(ws.id).length, 0);
});

test('the Maestro bootstrap names the full path of the program, tells it to use its shell tool, and never tells it to ask the human', async () => {
  const { maestroBootstrap } = await import('../src/prompts.js');
  const text = maestroBootstrap('/opt/om/bin/openmaestri');
  assert.match(text, /The program is \/opt\/om\/bin\/openmaestri/);
  assert.match(text, /First run: \/opt\/om\/bin\/openmaestri guide/);
  assert.match(text, /shell tool/);
  assert.match(text, /Do not ask them anything with a question tool/);
  assert.doesNotMatch(text, /Ask the human what the goal is/i);
});
