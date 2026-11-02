import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.resolve('bin/openmaestri.js');
const VERSION = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;

// Outside an agent terminal a bare command starts the server; these must print and exit instead.
for (const args of [['--version'], ['version']]) {
  test(`openmaestri ${args.join(' ')} prints the version and exits without starting the server`, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'om-ver-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: home, OPENMAESTRI_DATA_DIR: home, OPENMAESTRI_NO_WELCOME: '1' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), VERSION);
  });
}
