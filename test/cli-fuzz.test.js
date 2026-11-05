import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, build } from '../bin/openmaestri.js';

// A seeded generator, so a failure can be replayed: the test prints the argv that broke it.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const COMMANDS = ['list', 'notify', 'ask', 'check', 'note', 'portal', 'recruit', 'floor', 'preset', 'role', 'memory', 'usage', 'secrets', 'accounts', 'mcp', 'run', 'agent', 'report', 'resume', 'budget', 'sandbox', 'persist', 'doctor', 'chat', 'fallback', 'ps', 'guide', 'version', 'help', 'serve', 'export', 'import', 'hooks', 'snapshot', 'rollback', 'say'];
const SUBS = ['create', 'list', 'show', 'set', 'delete', 'read', 'write', 'edit', 'stack', 'unstack', 'status', 'land', 'prs', 'add', 'rm', 'stop', 'clear'];
const FLAGS = ['--timeout', '--check', '--verdict', '--retries', '--then', '--relay', '--raw', '--batch', '--preset', '--role', '--dir', '--command', '--sandbox', '--no-network', '--model', '--json', '--days', '--in', '--out', '--cost', '--state', '--progress', '--floor', '--name', '--color', '--size', '--url', '--lines', '--stack', '--with', '--summary', '--force', '--all'];
const ODD = ['', ' ', '--', '-', '---', '--=', '--a=', '--=b', '__proto__', 'constructor', 'prototype', '--__proto__', '--__proto__=x', '--constructor=y', '0', '-1', '1e309', 'NaN', 'Infinity', '9'.repeat(400), '\u0000', String.fromCharCode(0x202e), '', '😀', '../../etc/passwd', '$(id)', '`id`', '"', "'", '\\', '%s%s%s', '{"A":', '{"__proto__":{"x":1}}', '[]', 'null', 'a\nb', '10s', '5m', '0ms', '-5s', '1.5s', 'x'.repeat(100000)];

function randomArgv(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const n = Math.floor(rand() * 9);
  const argv = [];
  if (rand() < 0.9) argv.push(pick(COMMANDS));
  if (rand() < 0.5) argv.push(pick(SUBS));
  for (let i = 0; i < n; i++) {
    const r = rand();
    argv.push(r < 0.35 ? pick(FLAGS) : r < 0.45 ? `${pick(FLAGS)}=${pick(ODD)}` : pick(ODD));
  }
  return argv;
}

test('cli arguments: random argv never crashes the parser, never pollutes Object, and only fails with a usage error', () => {
  const rand = rng(1234);
  const polluted = () => ({}).x !== undefined || ({}).y !== undefined || Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted');
  for (let i = 0; i < 20000; i++) {
    const argv = randomArgv(rand);
    let parsed;
    try { parsed = parseArgs(argv); } catch (e) { assert.fail(`parseArgs threw ${e?.stack}\nargv: ${JSON.stringify(argv).slice(0, 300)}`); }
    assert.ok(Array.isArray(parsed.pos) && parsed.flags && typeof parsed.flags === 'object');
    assert.equal(polluted(), false, `Object.prototype was changed by ${JSON.stringify(argv).slice(0, 300)}`);
    try { build(parsed); } catch (e) {
      assert.ok(e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError) && !(e instanceof ReferenceError),
        `build threw an internal ${e?.constructor?.name}: ${e?.message}\nargv: ${JSON.stringify(argv).slice(0, 300)}`);
    }
  }
});
