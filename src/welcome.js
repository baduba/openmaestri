// First run: turn an empty workspace into a project with a working Maestro in one step.
// It only composes what already exists (workspace folder, a Maestro terminal from a preset) and
// never overwrites a file: the optional instructions file is created only when it is missing.
import fs from 'node:fs';
import path from 'node:path';
import { agentKind, AGENT_FILES } from './roles.js';

export class WelcomeError extends Error {}
const fail = (m) => { throw new WelcomeError(m); };

/** Presets a person can start with: real agents (not the Maestro variants), with whether the program is installed. */
export function agentChoices(presets, available) {
  const seen = new Set();
  const out = [];
  for (const p of presets) {
    if (!p.command || p.maestro) continue;
    const key = p.command.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: p.name, command: p.command, installed: available(p.command) });
  }
  // installed ones first, in the order of the preset list
  return [...out.filter((a) => a.installed), ...out.filter((a) => !a.installed)];
}

/** A folder that exists, is a directory and is not the file system root. Returns its real path. */
export function checkFolder(dir) {
  const raw = String(dir ?? '').trim();
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw)) fail('give the full path of your project folder, for example /home/you/my-project');
  let real;
  try { real = fs.realpathSync(raw); } catch { return fail(`${raw} does not exist`); }
  if (!fs.statSync(real).isDirectory()) fail(`${raw} is not a folder`);
  if (real === path.parse(real).root) fail('pick your project folder, not the root of the disk');
  return real;
}

const INSTRUCTIONS = `# Working with openmaestri

This project is orchestrated with [openmaestri](https://github.com/baduba/openmaestri).
Inside an openmaestri terminal:

- \`openmaestri guide\` explains every command.
- \`openmaestri list\` shows the agents and notes you can reach.
- \`openmaestri say "..."\` answers the human in the chat.

Keep API keys out of the repository: they live in \`~/.openmaestri/env\` or in \`openmaestri secrets\`.
`;

/** Create AGENTS.md (CLAUDE.md or GEMINI.md for those agents) if it does not exist. Never touches an existing file. */
export function writeInstructions(dir, command, preset) {
  const kind = agentKind({ command, preset });
  const file = AGENT_FILES[kind] ?? 'AGENTS.md';
  const full = path.join(dir, file);
  try {
    fs.writeFileSync(full, INSTRUCTIONS, { flag: 'wx', mode: 0o644 });
    return { file, created: true };
  } catch (e) {
    if (e.code === 'EEXIST') return { file, created: false };
    return fail(`could not write ${file}: ${e.code ?? e.message}`);
  }
}
