// Auto-layout ("tidy"): lay the graph out in columns by distance from the Maestro(s),
// so an orchestrator sits on the left with its team, notes and portals fanning out to the right.

const GAP_X = 90;
const GAP_Y = 50;

/**
 * @returns {Map<string, {x:number,y:number}>} new top-left position per node id
 */
export function tidy(ws, origin = { x: 0, y: 0 }) {
  const nodes = ws.nodes.filter((n) => n.kind !== 'band' && !n.stackId);
  const adj = new Map(nodes.map((n) => [n.id, new Set()]));
  const link = (a, b) => { if (adj.has(a) && adj.has(b)) { adj.get(a).add(b); adj.get(b).add(a); } };
  for (const c of ws.connections) link(c.from, c.to);
  for (const band of ws.nodes.filter((n) => n.kind === 'band')) {
    // a connection to a band is a connection to every member
    for (const c of ws.connections) {
      const other = c.from === band.id ? c.to : c.to === band.id ? c.from : null;
      if (other) for (const m of band.members) link(other, m);
    }
  }

  const level = new Map();
  const roots = [
    ...nodes.filter((n) => n.kind === 'terminal' && n.maestro),
    ...nodes.filter((n) => n.kind === 'terminal' && !n.maestro).sort((a, b) => adj.get(b.id).size - adj.get(a.id).size),
  ];
  for (const root of roots) {
    if (level.has(root.id)) continue;
    level.set(root.id, 0);
    const queue = [root.id];
    while (queue.length) {
      const id = queue.shift();
      for (const next of [...adj.get(id)].sort()) {
        if (!level.has(next)) { level.set(next, level.get(id) + 1); queue.push(next); }
      }
    }
  }
  const loose = nodes.filter((n) => !level.has(n.id));
  for (const n of loose) level.set(n.id, 0);

  const cols = new Map();
  for (const n of nodes) {
    const l = level.get(n.id);
    if (!cols.has(l)) cols.set(l, []);
    cols.get(l).push(n);
  }
  const kindOrder = { terminal: 0, stack: 1, note: 2, portal: 3 };
  const out = new Map();
  let x = origin.x;
  for (const l of [...cols.keys()].sort((a, b) => a - b)) {
    const col = cols.get(l).sort((a, b) => (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9) || a.name.localeCompare(b.name));
    let y = origin.y;
    for (const n of col) { out.set(n.id, { x: Math.round(x), y: Math.round(y) }); y += n.h + GAP_Y; }
    x += Math.max(...col.map((n) => n.w)) + GAP_X;
  }
  return out;
}

export function snapTo(v, grid = 20) { return Math.round(v / grid) * grid; }
