// Undo/redo for the canvas structure (nodes and connections). It records after the fact:
// every time a workspace is touched, the new state is compared with the last recorded one,
// so no call site has to remember to push an undo step. Note text is not part of a snapshot
// (it has its own file); deleted notes are kept in a trash folder so undo can restore them.

const stripGeometry = (json) => {
  const o = JSON.parse(json);
  for (const n of o.nodes) { delete n.x; delete n.y; delete n.w; delete n.h; }
  return JSON.stringify(o);
};

export class History {
  constructor({ limit = 80, coalesceMs = 1500 } = {}) {
    this.limit = limit;
    this.coalesceMs = coalesceMs;
    this.byWs = new Map();
  }

  static snapshot(ws) {
    return JSON.stringify({ nodes: ws.nodes, connections: ws.connections });
  }

  entry(ws) {
    let e = this.byWs.get(ws.id);
    if (!e) {
      e = { undo: [], redo: [], last: History.snapshot(ws), geometryAt: 0 };
      this.byWs.set(ws.id, e);
    }
    return e;
  }

  /** Call after any change. Returns true when a new undo step was recorded. */
  record(ws, now = Date.now()) {
    const e = this.entry(ws);
    const current = History.snapshot(ws);
    if (current === e.last) return false;
    const geometryOnly = stripGeometry(current) === stripGeometry(e.last);
    // dragging fires many patches: fold a burst of pure moves/resizes into one step
    const fold = geometryOnly && now - e.geometryAt < this.coalesceMs && e.undo.length > 0;
    if (!fold) {
      e.undo.push(e.last);
      if (e.undo.length > this.limit) e.undo.shift();
    }
    e.geometryAt = geometryOnly ? now : 0;
    e.redo = [];
    e.last = current;
    return true;
  }

  /** Move the workspace one step back. Returns the restored {nodes, connections} or null. */
  undo(ws) {
    const e = this.entry(ws);
    this.record(ws); // capture changes made since the last touch so they are undoable too
    const prev = e.undo.pop();
    if (prev === undefined) return null;
    e.redo.push(e.last);
    e.last = prev;
    e.geometryAt = 0;
    return JSON.parse(prev);
  }

  redo(ws) {
    const e = this.entry(ws);
    const next = e.redo.pop();
    if (next === undefined) return null;
    e.undo.push(e.last);
    e.last = next;
    e.geometryAt = 0;
    return JSON.parse(next);
  }

  state(ws) {
    const e = this.entry(ws);
    return { canUndo: e.undo.length > 0, canRedo: e.redo.length > 0 };
  }

  forget(wsId) { this.byWs.delete(wsId); }
}
