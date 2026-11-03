import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { quotaRefused } from '../src/headless.js';

test('quotaRefused knows an exhausted account from an ordinary failure', () => {
  assert.equal(quotaRefused({ ok: false, stderr: 'opencode stopped: Free usage limit reached.', text: '' }), true);
  assert.equal(quotaRefused({ ok: false, stderr: '', text: 'litellm.RateLimitError: 429 Too Many Requests' }), true);
  assert.equal(quotaRefused({ ok: false, stderr: 'Your credit balance is too low', text: '' }), true);
  assert.equal(quotaRefused({ ok: false, stderr: 'SyntaxError: unexpected token', text: '' }), false);
  assert.equal(quotaRefused({ ok: true, stderr: '', text: 'the quota doc says...' }), false);
  assert.equal(quotaRefused({ ok: false, timedOut: true, stderr: 'quota', text: '' }), false);
});

async function app(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-fb-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const script = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  script('opencode', 'echo "Free usage limit reached" >&2; exit 1');
  script('kimi', 'echo "kimi answers: $2"');
  const a = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ws = a.core.store.workspaces.get(a.core.store.settings.activeWorkspaceId);
  ws.dir = dir;
  // programs are found through the user's shell: point it at our fake ones
  const real = a.core.safeBin.bind(a.core);
  a.core.safeBin = (w, b) => (fs.existsSync(path.join(bin, b)) ? path.join(bin, b) : real(w, b));
  const boss = a.core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: dir });
  return { core: a.core, ws, boss, dir, bin };
}

test('fallback: when the first driver is out of quota the next one answers, and the first is skipped for a while', async (t) => {
  const { core, boss } = await app(t);
  const run = (args) => core.command({ terminalId: boss.id }, 'agent.run', { prompt: 'hi', ...args });
  await assert.rejects(run({ driver: 'opencode' }), /Free usage limit reached/);
  assert.match((await run({ driver: 'opencode', fallback: ['kimi'] })).text, /kimi answers: hi[\s\S]*\[kimi, .*skipped opencode/);
  // the second call does not even start opencode: it was out of quota a moment ago
  const again = await run({ driver: 'opencode', fallback: ['kimi'] });
  assert.match(again.text, /opencode \(out of quota a moment ago, skipped\)/);
});

test('fallback set/list/clear are saved in the settings and used without a flag', async (t) => {
  const { core, boss } = await app(t);
  const x = (cmd, args) => core.command({ terminalId: boss.id }, cmd, args);
  await assert.rejects(x('fallback.set', { driver: 'opencode', list: 'nope' }), /no driver named "nope"/);
  await assert.rejects(x('fallback.set', { driver: 'opencode', list: 'opencode' }), /its own fallback/);
  assert.match((await x('fallback.set', { driver: 'opencode', list: 'kimi' })).text, /opencode -> kimi/);
  assert.match((await x('fallback.list', {})).text, /opencode -> kimi/);
  assert.match((await x('agent.run', { driver: 'opencode', prompt: 'ping' })).text, /kimi answers: ping/);
  await x('fallback.clear', { driver: 'opencode' });
  assert.match((await x('fallback.list', {})).text, /no fallbacks set/);
});

test('run --agents never swaps one agent for another', async (t) => {
  const { core, boss } = await app(t);
  await core.command({ terminalId: boss.id }, 'fallback.set', { driver: 'opencode', list: 'kimi' });
  await assert.rejects(core.command({ terminalId: boss.id }, 'run', { task: 'hello', agents: 'opencode' }), (e) => /opencode: failed/.test(e.message) && !/kimi answers/.test(e.message));
});

test('agent --check: an answer whose work fails the check goes to the next driver of the chain, and a failing last driver is reported with the output', async (t) => {
  const { core, boss, dir, bin } = await app(t);
  const script = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  script('codex', 'echo bad > out.txt; echo "codex says done"');
  script('kimi', 'echo ok > out.txt; echo "kimi says done"');
  const run = (args) => core.command({ terminalId: boss.id }, 'agent.run', { prompt: 'write ok', check: 'grep -q ok out.txt', ...args });
  const r = await run({ driver: 'codex', fallback: ['kimi'] });
  assert.match(r.text, /kimi says done[\s\S]*skipped codex \(its work failed the check \(exit 1\)\)/);
  assert.equal(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8').trim(), 'ok');
  await assert.rejects(run({ driver: 'codex' }), /codex answered, but the check "grep -q ok out.txt" failed \(exit 1\)[\s\S]*codex says done/);
  await assert.rejects(core.command({ terminalId: boss.id }, 'agent.run', { driver: 'kimi', prompt: 'x', check: '' }), /hook is a command/);
});
