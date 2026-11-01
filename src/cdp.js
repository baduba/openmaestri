// Minimal Chrome DevTools Protocol client over a pipe (--remote-debugging-pipe).
// The browser reads commands from fd 3 and writes replies to fd 4, NUL-delimited JSON.
// No TCP debugging port is opened, so nothing else on the machine can attach to the browser.
import { EventEmitter } from 'node:events';

export class CdpError extends Error {}

export class CdpPipe extends EventEmitter {
  /** @param {import('node:child_process').ChildProcess} child spawned with stdio [ignore, ignore, pipe, pipe, pipe] */
  constructor(child) {
    super();
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.closed = false;
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', (chunk) => this.onData(chunk));
    child.stdio[3].on('error', () => {});
    child.once('exit', () => this.shutdown(new CdpError('the browser exited')));
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\0')) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new CdpError(msg.error.message || 'protocol error'));
        else p.resolve(msg.result ?? {});
      } else if (msg.method) {
        this.emit('event', msg);
        this.emit(msg.method, msg.params ?? {}, msg.sessionId);
      }
    }
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new CdpError('the browser is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CdpError(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const msg = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      try { this.child.stdio[3].write(`${JSON.stringify(msg)}\0`); } catch (e) { this.pending.delete(id); clearTimeout(timer); reject(new CdpError(e.message)); }
    });
  }

  shutdown(err) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    this.emit('closed');
  }
}
