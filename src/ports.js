// Every floor (and the ground floor of a workspace) gets its own block of 100 ports, so two agents that each start
// a dev server, a database or a mock do not fight over 3000 or 5432. The agent reads OPENMAESTRI_PORT_BASE (and PORT).
import { slugify } from './floors.js';

export const PORT_START = 20000;
export const PORT_STEP = 100;
export const PORT_SLOTS = 200;

/** The first free block across every workspace. `records` are all ground/floor records that already have a portBase. */
export function freePortBase(taken) {
  const used = new Set(taken);
  for (let i = 0; i < PORT_SLOTS; i++) {
    const p = PORT_START + i * PORT_STEP;
    if (!used.has(p)) return p;
  }
  return null;
}

/**
 * Variables for anything started in a floor. `floor` is null for the ground floor, where nothing the person already
 * runs there should change: it only learns its block (OPENMAESTRI_PORT_BASE). A real floor also gets PORT and its own
 * compose project, because that is where two copies of the same project run side by side.
 */
export function floorVars(ws, floor, portBase) {
  const base = { OPENMAESTRI_FLOOR: floor ? floor.name : 'ground', OPENMAESTRI_PORT_BASE: String(portBase) };
  if (!floor) return base;
  const label = slugify(floor.name) || 'floor';
  return { ...base, PORT: String(portBase), COMPOSE_PROJECT_NAME: `om-${String(ws.id).replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}-${label}`.slice(0, 60) };
}
