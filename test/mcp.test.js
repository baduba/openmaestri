import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/server.js';
import { buildServer, parseCommand, planInstall, McpError } from '../src/mcp.js';

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'om-mcp-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('a command is plain words: no shell, no quotes, no operators', () => {
  assert.deepEqual(parseCommand('npx -y @upstash/context7-mcp'), ['npx', '-y', '@upstash/context7-mcp']);
  for (const bad of ['npx -y x; rm -rf ~', 'sh -c "x"', 'cat $HOME/x', 'a | b', '']) assert.throws(() => parseCommand(bad), McpError, bad);
});

test('servers: presets, remote needs https, and a key never goes in as text', () => {
  assert.deepEqual(buildServer({ name: 'context7' }), { type: 'remote', url: 'https://mcp.context7.com/mcp' });
  assert.deepEqual(buildServer({ name: 'context7', key: 'CONTEXT7_API_KEY' }).headers, { Authorization: 'Bearer ${CONTEXT7_API_KEY}' });
  assert.throws(() => buildServer({ name: 'x', url: 'http://example.com/mcp' }), /https/);
  assert.equal(buildServer({ name: 'x', url: 'http://localhost:8080/mcp' }).url, 'http://localhost:8080/mcp');
  assert.throws(() => buildServer({ name: 'x', url: 'https://user:pw@example.com/mcp' }), /credentials/);
  assert.throws(() => buildServer({ name: 'x', url: 'https://example.com/mcp?token=abc' }), /query/);
  assert.throws(() => buildServer({ name: 'x', url: 'https://example.com/mcp', header: ['Authorization=Bearer sk-abcdefghijklmnopqrstuvwxyz123456'] }), /credential/);
  assert.throws(() => buildServer({ name: 'x', command: 'node s.js', env: ['API_KEY=ghp_abcdefghijklmnopqrstuvwxyz'] }), /credential/);
  assert.deepEqual(buildServer({ name: 'x', command: 'node s.js', env: ['API_KEY=${MY_KEY}', 'MODE=fast'] }).env, { API_KEY: '${MY_KEY}', MODE: 'fast' });
  assert.throws(() => buildServer({ name: 'Bad Name', url: 'https://e.com' }), /name/);
  assert.throws(() => buildServer({ name: 'nothing' }), /--command or --url/);
});

const servers = {
  context7: buildServer({ name: 'context7', key: 'CONTEXT7_API_KEY' }),
  tools: buildServer({ name: 'tools', command: 'node srv.js --x', env: ['TOKEN_FILE=${TOKEN_FILE}'] }),
};

test('install: claude gets .mcp.json, opencode gets opencode.json with {env:VAR}, other entries survive', (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } } }));
  const c = planInstall({ cwd: dir, kind: 'claude', servers });
  assert.equal(c.changed, true);
  assert.equal(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'), c.before, 'a dry run writes nothing');
  const doc = JSON.parse(c.after).mcpServers;
  assert.deepEqual(Object.keys(doc).sort(), ['context7', 'mine', 'tools']);
  assert.deepEqual(doc.context7, { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { Authorization: 'Bearer ${CONTEXT7_API_KEY}' } });
  assert.deepEqual(doc.tools, { command: 'node', args: ['srv.js', '--x'], env: { TOKEN_FILE: '${TOKEN_FILE}' } });
  planInstall({ cwd: dir, kind: 'claude', servers, apply: true });
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('.mcp.json.bak-')));
  assert.equal(planInstall({ cwd: dir, kind: 'claude', servers }).changed, false, 'idempotent');
  const o = planInstall({ cwd: dir, kind: 'opencode', servers, apply: true });
  const oc = JSON.parse(fs.readFileSync(o.file, 'utf8'));
  assert.equal(oc.$schema, 'https://opencode.ai/config.json');
  assert.deepEqual(oc.mcp.context7, { type: 'remote', url: 'https://mcp.context7.com/mcp', enabled: true, headers: { Authorization: 'Bearer {env:CONTEXT7_API_KEY}' } });
  assert.deepEqual(oc.mcp.tools, { type: 'local', command: ['node', 'srv.js', '--x'], enabled: true, environment: { TOKEN_FILE: '{env:TOKEN_FILE}' } });
  const gone = planInstall({ cwd: dir, kind: 'claude', servers, remove: true, apply: true });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(gone.file, 'utf8')).mcpServers), ['mine']);
});

test('install refuses what it should not touch', (t) => {
  const dir = tmp(t);
  assert.throws(() => planInstall({ cwd: dir, kind: 'codex', servers }), /global file/);
  fs.writeFileSync(path.join(dir, 'opencode.jsonc'), '{}');
  assert.throws(() => planInstall({ cwd: dir, kind: 'opencode', servers }), /opencode\.jsonc/);
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{ not json');
  assert.throws(() => planInstall({ cwd: dir, kind: 'claude', servers }), /not valid JSON/);
  fs.rmSync(path.join(dir, '.mcp.json'));
  fs.writeFileSync(path.join(dir, 'real.json'), '{}');
  fs.symlinkSync(path.join(dir, 'real.json'), path.join(dir, '.mcp.json'));
  assert.throws(() => planInstall({ cwd: dir, kind: 'claude', servers }), /symbolic link/);
});

test('the Maestro manages servers and installs them; others only read', async (t) => {
  const dir = tmp(t);
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const app = await main({ port: 0, dataRoot: path.join(dir, 'data'), socketPath: path.join(dir, 'ipc.sock'), quiet: true });
  t.after(async () => { await app.close(); });
  const { core } = app;
  const ws = core.store.workspaces.get(core.store.settings.activeWorkspaceId);
  ws.dir = work;
  const boss = core.store.createNode(ws, 'terminal', { name: 'Maestro', maestro: true, cwd: work });
  const dev = core.store.createNode(ws, 'terminal', { name: 'Dev', cwd: work, command: 'opencode' });
  const cmd = (c, a, who = boss) => core.command({ terminalId: who.id }, c, a);
  assert.match((await cmd('mcp', {})).text, /no MCP servers.*mcp add context7/);
  await assert.rejects(cmd('mcp', { action: 'add', name: 'context7' }, dev), /Maestro/);
  await cmd('mcp', { action: 'add', name: 'context7' });
  assert.match((await cmd('mcp', {}, dev)).text, /context7 {2}remote {2}https:\/\/mcp\.context7\.com\/mcp/);
  const dry = await cmd('mcp', { action: 'install', agent: 'Dev' });
  assert.match(dry.text, /Dry run/);
  assert.ok(!fs.existsSync(path.join(work, 'opencode.json')));
  await cmd('mcp', { action: 'install', agent: 'Dev', apply: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'opencode.json'), 'utf8')).mcp.context7.type, 'remote');
  await assert.rejects(cmd('mcp', { action: 'install', agent: 'Dev' }, dev), /Maestro/);
  assert.match((await cmd('mcp', { action: 'install', agent: 'Dev' })).text, /already up to date/);
  assert.match((await cmd('mcp', { action: 'rm', name: 'context7' })).text, /removed context7/);
});
