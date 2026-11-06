import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, DEFAULT_PRESETS, PRESETS_VERSION } from '../src/store.js';

const STARTERS = ['Starter Maestro (DeepSeek V4.1 Flash)', 'Starter Dev (DeepSeek V4.1 Flash)', 'Starter Auditor (gpt-oss-120b)'];

test('the starter team: one Maestro and two workers, on the models that passed the runs, each changeable by a variable', () => {
  const by = Object.fromEntries(DEFAULT_PRESETS.map((p) => [p.name, p]));
  for (const name of STARTERS) assert.ok(by[name], name);
  assert.equal(by[STARTERS[0]].maestro, true);
  assert.equal(by[STARTERS[1]].maestro, false);
  assert.equal(by[STARTERS[2]].maestro, false);
  assert.match(by[STARTERS[0]].command, /openrouter\/\$\{OPENMAESTRI_STARTER_MAESTRO:-deepseek\/deepseek-v4\.1-flash\}/);
  assert.match(by[STARTERS[2]].command, /OPENMAESTRI_STARTER_AUDITOR:-openai\/gpt-oss-120b/);
  assert.equal(DEFAULT_PRESETS.filter((p) => p.maestro).length, 3, 'the starter adds exactly one Maestro preset');
});

test('an existing installation gets the starter presets once, and a preset it deleted later does not come back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-starter-'));
  try {
    const root = path.join(dir, 'data');
    fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
    const old = DEFAULT_PRESETS.filter((p) => !STARTERS.includes(p.name));
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ presets: old, presetsVersion: 2, roles: [], partituras: [], activeWorkspaceId: null }));
    const first = new Store(root);
    first.load();
    const names = first.settings.presets.map((p) => p.name);
    for (const name of STARTERS) assert.equal(names.filter((n) => n === name).length, 1, `${name} added once`);
    assert.equal(first.settings.presetsVersion, PRESETS_VERSION);
    // the user deletes one; the next start (same version) must not bring it back
    first.settings.presets = first.settings.presets.filter((p) => p.name !== STARTERS[2]);
    first.saveSettings();
    const second = new Store(root);
    second.load();
    assert.equal(second.settings.presets.some((p) => p.name === STARTERS[2]), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
