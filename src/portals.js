// Portals: a real Chromium per portal, driven over the DevTools Protocol (see cdp.js).
// Agents get the commands in `openmaestri portal ...`; the human sees the same page in the
// canvas through a screencast and drives it with the mouse and keyboard.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpPipe, CdpError } from './cdp.js';

export class PortalError extends Error {}
const fail = (m) => { throw new PortalError(m); };

const IDLE_MS = 15 * 60 * 1000;
const MAX_TEXT = 200000;
const BLOCKED_URLS = ['file:*', 'chrome:*', 'chrome-untrusted:*', 'devtools:*', 'view-source:*', 'ftp:*'];

export function findChrome(env = process.env) {
  const candidates = [
    env.OPENMAESTRI_CHROME, env.CHROME_BIN,
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  try {
    const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
    for (const d of fs.readdirSync(cache)) if (/^chromium-\d+$/.test(d)) candidates.push(path.join(cache, d, 'chrome-linux64', 'chrome'));
  } catch { /* no playwright cache */ }
  return candidates.find((c) => c && fs.existsSync(c)) ?? null;
}

/** Only web pages. file:, chrome: and friends would let a page or an agent read the machine. */
export function checkUrl(raw) {
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `http://${raw}`); } catch { fail(`invalid URL: ${raw}`); }
  if (u.protocol === 'about:' && u.href === 'about:blank') return u.href;
  if (!['http:', 'https:'].includes(u.protocol)) fail('only http and https pages can be opened in a portal');
  return u.href;
}

const UA = {
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  chrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  desktop: '',
};

const KEYS = {
  Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Esc: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'],
  ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
  Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], Space: [32, 'Space', ' '], Insert: [45, 'Insert'],
};
for (let i = 1; i <= 12; i++) KEYS[`F${i}`] = [111 + i, `F${i}`];
const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };

/** "ctrl+a", "shift+tab", "Enter" -> CDP key event pieces. */
export function parseKey(spec) {
  const parts = String(spec).split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) fail('empty key');
  let modifiers = 0;
  while (parts.length > 1 && Object.hasOwn(MODS, parts[0].toLowerCase())) modifiers |= MODS[parts.shift().toLowerCase()];
  const name = parts.join('+');
  const named = Object.keys(KEYS).find((k) => k.toLowerCase() === name.toLowerCase());
  if (named) {
    const [vk, code, text] = KEYS[named];
    return { key: named === 'Esc' ? 'Escape' : named === 'Space' ? ' ' : named, code, vk, text: modifiers & ~8 ? undefined : text, modifiers };
  }
  if (name.length !== 1) fail(`unknown key "${name}" (Enter, Tab, Escape, ArrowDown, F5, a, ctrl+a, shift+tab ...)`);
  const up = name.toUpperCase();
  const code = /[a-z]/i.test(name) ? `Key${up}` : /\d/.test(name) ? `Digit${name}` : '';
  const command = modifiers & (2 | 4) ? EDIT_COMMANDS[name.toLowerCase()] : undefined;
  return { key: name, code, vk: up.charCodeAt(0), text: modifiers & (1 | 2 | 4) ? undefined : name, modifiers, commands: command ? [modifiers & 8 && name.toLowerCase() === 'z' ? 'redo' : command] : undefined };
}

const INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'textarea']);
const STRUCTURAL = new Set(['heading', 'img', 'navigation', 'main', 'banner', 'contentinfo', 'form', 'dialog', 'alert', 'table', 'list', 'region', 'search', 'status']);
const STATE_PROPS = ['disabled', 'checked', 'expanded', 'selected', 'pressed', 'required', 'invalid', 'readonly', 'focused', 'busy'];

class Portal extends EventEmitter {
  constructor(manager, node) {
    super();
    this.manager = manager;
    this.id = node.id;
    this.node = node;
    this.child = null;
    this.cdp = null;
    this.session = null;
    this.profile = null;
    this.refs = new Map();
    this.logs = null;
    this.viewers = 0;
    this.lastUse = Date.now();
    this.nav = { url: node.url, title: '', canBack: false, canForward: false };
    this.viewport = node.viewport ?? { w: Math.max(320, Math.round(node.w)), h: Math.max(240, Math.round(node.h) - 34) };
    this.starting = null;
  }

  touch() { this.lastUse = Date.now(); }

  async start() {
    if (this.cdp && !this.cdp.closed) return;
    this.starting ??= this.launch().finally(() => { this.starting = null; });
    await this.starting;
  }

  async launch() {
    const bin = this.manager.chrome;
    if (!bin) fail('no Chrome or Chromium found. Install one (apt install chromium, or google-chrome) or set OPENMAESTRI_CHROME to its path');
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'om-portal-'));
    const args = [
      '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${this.profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
      '--disable-sync', '--disable-default-apps', '--mute-audio', '--hide-scrollbars', '--password-store=basic', '--use-mock-keychain',
      '--disable-features=Translate,MediaRouter', `--window-size=${this.viewport.w},${this.viewport.h}`,
    ];
    if (process.env.OPENMAESTRI_CHROME_NO_SANDBOX === '1') args.push('--no-sandbox');
    args.push('about:blank');
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: process.env.HOME } });
    let stderr = '';
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
    this.child = child;
    const cdp = new CdpPipe(child);
    this.cdp = cdp;
    cdp.once('closed', () => { this.session = null; this.emit('closed'); });
    try {
      const { targetInfos } = await cdp.send('Target.getTargets', {}, undefined, 20000);
      let page = targetInfos.find((t) => t.type === 'page');
      if (!page) page = { targetId: (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId };
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      this.session = sessionId;
      this.targetId = page.targetId;
      await Promise.all(['Page', 'Runtime', 'DOM', 'Accessibility', 'Network', 'Log'].map((d) => this.cmd(`${d}.enable`)));
      await this.cmd('Network.setBlockedURLs', { urls: BLOCKED_URLS });
      await this.applyViewport();
      this.wire(cdp);
    } catch (e) {
      await this.dispose();
      const hint = /sandbox|namespace|No usable/i.test(stderr) ? ' (the Chrome sandbox could not start; in a container set OPENMAESTRI_CHROME_NO_SANDBOX=1, understanding the trade-off)' : '';
      fail(`could not start the browser: ${e.message}${hint}${stderr ? `\n${stderr.trim().split('\n').slice(-3).join('\n')}` : ''}`);
    }
    const target = this.node.url && this.node.url !== 'about:blank' ? this.node.url : null;
    if (target) await this.navigate(target).catch(() => {});
  }

  wire(cdp) {
    cdp.on('Page.frameNavigated', (p, sid) => {
      if (sid !== this.session || p.frame.parentId) return;
      this.nav.url = p.frame.url;
      this.refs.clear();
      const u = p.frame.url;
      if (u.startsWith('http://') || u.startsWith('https://') || u === 'about:blank') this.node.url = u;
      void this.refreshNav();
    });
    cdp.on('Page.screencastFrame', (p, sid) => {
      if (sid !== this.session) return;
      this.cmd('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      this.emit('frame', { data: p.data, w: p.metadata.deviceWidth, h: p.metadata.deviceHeight });
    });
    const log = (line) => { if (this.logs) { this.logs.push(line); if (this.logs.length > 500) this.logs.shift(); } };
    cdp.on('Runtime.consoleAPICalled', (p, sid) => { if (sid === this.session) log(`console.${p.type}: ${p.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`); });
    cdp.on('Runtime.exceptionThrown', (p, sid) => { if (sid === this.session) log(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`); });
    cdp.on('Log.entryAdded', (p, sid) => { if (sid === this.session) log(`${p.entry.level}: ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`); });
    // a page that opens a new window stays in this portal
    cdp.on('Target.targetCreated', (p) => {
      const t = p.targetInfo;
      if (t.type === 'page' && t.targetId !== this.targetId && t.openerId) cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    });
    cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    cdp.on('Page.javascriptDialogOpening', (p, sid) => { if (sid === this.session) this.cmd('Page.handleJavaScriptDialog', { accept: p.type !== 'beforeunload' }).catch(() => {}); });
  }

  cmd(method, params = {}, timeoutMs) {
    if (!this.cdp || this.cdp.closed) return Promise.reject(new PortalError('the portal browser is not running'));
    return this.cdp.send(method, params, this.session, timeoutMs).catch((e) => { throw e instanceof CdpError ? new PortalError(e.message) : e; });
  }

  async applyViewport() {
    const { w, h } = this.viewport;
    await this.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false, screenWidth: w, screenHeight: h });
  }

  async refreshNav() {
    try {
      const h = await this.cmd('Page.getNavigationHistory');
      const cur = h.entries[h.currentIndex];
      this.nav = { url: cur?.url ?? this.nav.url, title: cur?.title ?? '', canBack: h.currentIndex > 0, canForward: h.currentIndex < h.entries.length - 1 };
      this.emit('nav', this.nav);
    } catch { /* browser going away */ }
  }

  async startScreencast() {
    await this.start();
    await this.cmd('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: this.viewport.w, maxHeight: this.viewport.h, everyNthFrame: 1 });
  }
  stopScreencast() { return this.cmd('Page.stopScreencast').catch(() => {}); }

  // ---------------------------------------------------------------- page actions
  async navigate(url) {
    await this.start();
    const href = checkUrl(url);
    const loaded = new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.cdp.off('Page.loadEventFired', onLoad); resolve(); };
      const onLoad = (_p, sid) => { if (sid === this.session) done(); };
      const t = setTimeout(done, 30000);
      this.cdp.on('Page.loadEventFired', onLoad);
    });
    const r = await this.cmd('Page.navigate', { url: href });
    if (r.errorText) fail(`could not open ${href}: ${r.errorText}`);
    await loaded;
    await this.refreshNav();
    return this.nav;
  }

  async history(delta) {
    await this.start();
    const h = await this.cmd('Page.getNavigationHistory');
    const entry = h.entries[h.currentIndex + delta];
    if (!entry) fail(delta < 0 ? 'there is nothing to go back to' : 'there is nothing to go forward to');
    await this.cmd('Page.navigateToHistoryEntry', { entryId: entry.id });
    await new Promise((r) => setTimeout(r, 400));
    await this.refreshNav();
    return this.nav;
  }

  async reload() { await this.start(); await this.cmd('Page.reload'); await new Promise((r) => setTimeout(r, 500)); await this.refreshNav(); return this.nav; }

  async evaluate(expression) {
    await this.start();
    const r = await this.cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: 20000 });
    if (r.exceptionDetails) fail(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'the script threw');
    const v = r.result.value;
    const out = v === undefined ? (r.result.description ?? 'undefined') : typeof v === 'string' ? v : JSON.stringify(v);
    return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT)}\n... (truncated)` : out;
  }

  async info() {
    await this.start();
    const raw = await this.evaluate('JSON.stringify({url: location.href, title: document.title, width: innerWidth, height: innerHeight})');
    return JSON.parse(raw);
  }

  async html() {
    const s = await this.evaluate('document.documentElement.outerHTML');
    return s;
  }

  /** Accessibility tree, compact, with refs (@e1...) for the things an agent can act on. */
  async snapshot() {
    await this.start();
    const { nodes } = await this.cmd('Accessibility.getFullAXTree');
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    this.refs.clear();
    const lines = [];
    let counter = 0;
    const prop = (n, name) => n.properties?.find((p) => p.name === name)?.value?.value;
    const walk = (n, depth) => {
      if (lines.length >= 700) return;
      const role = n.role?.value;
      const name = (n.name?.value ?? '').replace(/\s+/g, ' ').trim();
      let nextDepth = depth;
      if (!n.ignored && role) {
        const interactive = INTERACTIVE.has(role);
        const show = interactive || (STRUCTURAL.has(role) && (name || role === 'heading')) || (role === 'StaticText' && name && !n.skipText);
        if (show) {
          let line = `${'  '.repeat(Math.min(depth, 8))}`;
          if (n.backendDOMNodeId && role !== 'StaticText' && (interactive || role === 'heading' || role === 'img')) {
            const ref = `e${++counter}`;
            this.refs.set(ref, n.backendDOMNodeId);
            line += `@${ref} `;
          }
          line += role === 'StaticText' ? `"${name.slice(0, 160)}"` : `${role}${name ? ` "${name.slice(0, 120)}"` : ''}`;
          const states = STATE_PROPS.filter((s) => { const v = prop(n, s); return v === true || (typeof v === 'string' && v && v !== 'false'); });
          for (const s of states) line += ` [${s}${typeof prop(n, s) === 'string' ? `=${prop(n, s)}` : ''}]`;
          const level = prop(n, 'level'); if (role === 'heading' && level) line += ` [level=${level}]`;
          const val = n.value?.value; if (val !== undefined && val !== '' && interactive) line += ` value="${String(val).slice(0, 80)}"`;
          lines.push(line);
          nextDepth = depth + 1;
          // a link or button is already named by its text; do not repeat it
          if (interactive) for (const c of n.childIds ?? []) { const ch = byId.get(c); if (ch) ch.skipText = true; }
        }
      }
      for (const cid of n.childIds ?? []) {
        const c = byId.get(cid);
        if (!c) continue;
        if (n.skipText && c.role?.value === 'StaticText') c.skipText = true;
        walk(c, nextDepth);
      }
    };
    const root = nodes.find((n) => !n.parentId) ?? nodes[0];
    if (root) walk(root, 0);
    const info = await this.info().catch(() => ({ url: this.nav.url, title: '' }));
    const head = `page: ${info.title || '(untitled)'}  ${info.url}`;
    if (!lines.length) return `${head}\n(the page has no accessible content yet)`;
    return `${head}\n${lines.join('\n')}${lines.length >= 700 ? '\n... (truncated)' : ''}`;
  }

  // ---------------------------------------------------------------- targets
  /** @eN | CSS selector | x,y  ->  {objectId} or {x,y} */
  async resolve(target, { needPoint = false } = {}) {
    await this.start();
    const t = String(target ?? '').trim();
    if (!t) fail('a target is required: @e3, a CSS selector, or x,y');
    const xy = t.split(',');
    if (xy.length === 2 && xy.every((v) => v.trim() !== '' && Number.isFinite(Number(v)))) return { x: Number(xy[0]), y: Number(xy[1]), kind: 'point' };
    let objectId;
    if (/^@?e\d+$/.test(t)) {
      const ref = t.replace('@', '');
      const backendNodeId = this.refs.get(ref);
      if (!backendNodeId) fail(`unknown reference @${ref}. Run \`portal snapshot\` first (references reset when the page changes)`);
      try { objectId = (await this.cmd('DOM.resolveNode', { backendNodeId })).object.objectId; } catch { fail(`@${ref} is gone from the page. Run \`portal snapshot\` again`); }
    } else {
      const r = await this.cmd('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(t)})` }).catch((e) => fail(`bad selector: ${e.message}`));
      if (r.exceptionDetails) fail(`bad selector "${t}"`);
      if (r.result.subtype === 'null' || !r.result.objectId) fail(`nothing matches "${t}"`);
      objectId = r.result.objectId;
    }
    if (!needPoint) return { objectId, kind: 'element' };
    await this.cmd('DOM.scrollIntoViewIfNeeded', { objectId }).catch(() => {});
    const { quads } = await this.cmd('DOM.getContentQuads', { objectId }).catch(() => ({ quads: [] }));
    if (!quads?.length) fail(`"${t}" is not visible on the page`);
    const q = quads[0];
    return { objectId, kind: 'element', x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
  }

  async point(target) {
    const r = await this.resolve(target, { needPoint: true });
    return r;
  }

  async mouse(type, x, y, extra = {}) {
    await this.cmd('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra });
  }

  async click(target, { count = 1 } = {}) {
    const p = await this.point(target);
    await this.mouse('mouseMoved', p.x, p.y);
    for (let i = 1; i <= count; i++) {
      await this.mouse('mousePressed', p.x, p.y, { button: 'left', clickCount: i, buttons: 1 });
      await this.mouse('mouseReleased', p.x, p.y, { button: 'left', clickCount: i, buttons: 0 });
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  async hover(target) { const p = await this.point(target); await this.mouse('mouseMoved', p.x, p.y); }

  async drag(from, to) {
    const a = await this.point(from);
    const b = await this.point(to);
    await this.mouse('mouseMoved', a.x, a.y);
    await this.mouse('mousePressed', a.x, a.y, { button: 'left', clickCount: 1, buttons: 1 });
    const steps = 8;
    for (let i = 1; i <= steps; i++) await this.mouse('mouseMoved', a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, { button: 'left', buttons: 1 });
    await this.mouse('mouseReleased', b.x, b.y, { button: 'left', clickCount: 1, buttons: 0 });
  }

  async fn(objectId, body, args = []) {
    const r = await this.cmd('Runtime.callFunctionOn', { objectId, functionDeclaration: body, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) fail(r.exceptionDetails.exception?.description?.split('\n')[0] ?? 'the page script failed');
    return r.result.value;
  }

  async focus(target) {
    const { objectId } = await this.resolve(target);
    await this.cmd('DOM.focus', { objectId }).catch(async () => { await this.fn(objectId, 'function(){ this.focus(); }'); });
  }

  async fill(target, text) {
    const { objectId } = await this.resolve(target);
    const ok = await this.fn(objectId, `function(t){
      this.focus();
      const tag = this.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(this, t);
      } else if (this.isContentEditable) {
        this.textContent = t;
      } else return false;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }`, [String(text)]);
    if (!ok) fail('that element is not a text field');
  }

  async clear(target) { if (target) await this.fill(target, ''); else await this.key('ctrl+a').then(() => this.key('Backspace')); }

  async type(text) { await this.start(); await this.cmd('Input.insertText', { text: String(text) }); }

  async key(spec, target) {
    if (target) await this.focus(target);
    await this.start();
    const k = parseKey(spec);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.modifiers };
    await this.cmd('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}), ...(k.commands ? { commands: k.commands } : {}) });
    await this.cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async selectAll(target) {
    if (target) await this.focus(target);
    await this.key('ctrl+a');
  }

  async select(target, option) {
    const { objectId } = await this.resolve(target);
    const res = await this.fn(objectId, `function(want){
      if (this.tagName !== 'SELECT') return { error: 'not a <select>' };
      const opts = [...this.options];
      const hit = opts.find((o) => o.text.trim() === want) || opts.find((o) => o.value === want) || opts.find((o) => o.text.trim().toLowerCase() === want.toLowerCase());
      if (!hit) return { error: 'no option "' + want + '". Options: ' + opts.map((o) => o.text.trim()).join(' | ') };
      this.value = hit.value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: hit.text.trim() };
    }`, [String(option)]);
    if (res.error) fail(res.error);
    return res.ok;
  }

  async setChecked(target, want) {
    const { objectId } = await this.resolve(target);
    const state = await this.fn(objectId, 'function(){ return this.type === "checkbox" || this.type === "radio" ? this.checked : (this.getAttribute("aria-checked") === "true"); }');
    if (state !== want) await this.click(target);
    return want;
  }

  async text(target) {
    const { objectId } = await this.resolve(target);
    const t = await this.fn(objectId, 'function(){ return this.innerText ?? this.textContent ?? this.value ?? ""; }');
    return String(t).length > MAX_TEXT ? `${String(t).slice(0, MAX_TEXT)}\n... (truncated)` : String(t);
  }

  async wait(target, timeoutMs = 5000) {
    await this.start();
    const end = Date.now() + Math.min(Math.max(timeoutMs, 100), 120000);
    for (;;) {
      try {
        const r = await this.resolve(target, { needPoint: true });
        if (r.kind === 'point' || r.x !== undefined) return 'found';
      } catch (e) { if (!(e instanceof PortalError)) throw e; }
      if (Date.now() > end) fail(`timed out waiting for ${target}`);
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  async scroll(direction, amount = 300, target) {
    const dir = String(direction).toLowerCase();
    if (!['up', 'down', 'left', 'right'].includes(dir)) fail('scroll direction is up, down, left or right');
    const p = target ? await this.point(target) : { x: this.viewport.w / 2, y: this.viewport.h / 2 };
    const n = Number(amount);
    if (!Number.isFinite(n)) fail('scroll amount must be a number of pixels');
    await this.mouse('mouseWheel', p.x, p.y, { deltaX: dir === 'left' ? -n : dir === 'right' ? n : 0, deltaY: dir === 'up' ? -n : dir === 'down' ? n : 0 });
    await new Promise((r) => setTimeout(r, 150));
  }

  async scrollIntoView(target) { const { objectId } = await this.resolve(target); await this.cmd('DOM.scrollIntoViewIfNeeded', { objectId }); }

  async upload(target, files) {
    const { objectId } = await this.resolve(target);
    const roots = this.manager.uploadRoots();
    const real = files.map((f) => {
      let p;
      try { p = fs.realpathSync(path.resolve(f)); } catch { fail(`no such file: ${f}`); }
      if (!roots.some((r) => p === r || p.startsWith(r + path.sep))) fail(`${f} is outside the workspace; only files inside the workspace or a floor can be uploaded`);
      if (!fs.statSync(p).isFile()) fail(`${f} is not a file`);
      return p;
    });
    const { node } = await this.cmd('DOM.describeNode', { objectId });
    await this.cmd('DOM.setFileInputFiles', { files: real, backendNodeId: node.backendNodeId });
    return real.length;
  }

  async screenshot() {
    await this.start();
    const { data } = await this.cmd('Page.captureScreenshot', { format: 'png' });
    const dir = path.join(this.manager.dataRoot, 'portals', this.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `shot-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'), { mode: 0o600 });
    // keep the folder small
    for (const old of fs.readdirSync(dir).sort().slice(0, -20)) fs.rmSync(path.join(dir, old), { force: true });
    return file;
  }

  async resize(w, h) {
    const W = Math.round(Number(w)), H = Math.round(Number(h));
    if (!(W >= 100 && W <= 4000 && H >= 100 && H <= 4000)) fail('size must be between 100 and 4000 pixels');
    this.viewport = { w: W, h: H };
    this.node.viewport = { ...this.viewport };
    await this.start();
    await this.applyViewport();
    if (this.viewers) await this.startScreencast();
    return this.viewport;
  }

  async userAgent(preset) {
    await this.start();
    if (!preset) return `presets: ${Object.keys(UA).join(', ')}\ncurrent: ${await this.evaluate('navigator.userAgent')}`;
    if (!Object.hasOwn(UA, preset)) fail(`unknown preset "${preset}" (${Object.keys(UA).join(', ')})`);
    await this.cmd('Emulation.setUserAgentOverride', { userAgent: UA[preset] || (await this.cmd('Browser.getVersion')).userAgent });
    return preset;
  }

  startLogs() { this.logs = []; }
  readLogs() {
    if (!this.logs) fail('logging is off. Run `portal logs-start` once, after navigating');
    const out = this.logs.splice(0);
    return out.length ? out.join('\n') : '(no new messages)';
  }

  // ---------------------------------------------------------------- human input from the canvas
  async input(ev) {
    await this.start();
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    if (ev.kind === 'mouse') {
      const type = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved', wheel: 'mouseWheel' }[ev.type];
      if (!type) return;
      const button = ['left', 'middle', 'right'].includes(ev.button) ? ev.button : 'left';
      await this.mouse(type, n(ev.x), n(ev.y), type === 'mouseMoved' ? { buttons: n(ev.buttons) } : type === 'mouseWheel' ? { deltaX: n(ev.deltaX), deltaY: n(ev.deltaY) } : { button, clickCount: Math.max(1, Math.min(3, n(ev.clickCount) || 1)), buttons: type === 'mousePressed' ? 1 : 0 });
    } else if (ev.kind === 'key') {
      const type = ev.type === 'up' ? 'keyUp' : ev.text ? 'keyDown' : 'rawKeyDown';
      const mods = n(ev.modifiers) & 15;
      const k = String(ev.key ?? '').slice(0, 20);
      let vk = Number(ev.vk);
      if (!Number.isFinite(vk)) vk = (KEYS[k]?.[0]) ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
      const text = typeof ev.text === 'string' ? ev.text.slice(0, 8) : undefined;
      const cmdName = mods & (2 | 4) && k.length === 1 ? EDIT_COMMANDS[k.toLowerCase()] : undefined;
      await this.cmd('Input.dispatchKeyEvent', { type, key: k, code: String(ev.code ?? '').slice(0, 20), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods, ...(text && type === 'keyDown' ? { text, unmodifiedText: text } : {}), ...(cmdName && type !== 'keyUp' ? { commands: [cmdName] } : {}) });
    } else if (ev.kind === 'paste' && typeof ev.text === 'string') {
      await this.cmd('Input.insertText', { text: ev.text.slice(0, 100000) });
    }
  }

  async dispose() {
    this.refs.clear();
    try { this.cdp?.shutdown(new CdpError('closed')); } catch { /* already closed */ }
    if (this.child && this.child.exitCode === null) {
      try { this.child.kill('SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { if (this.child.exitCode === null) this.child.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref();
    }
    this.cdp = null;
    if (this.profile) { const p = this.profile; this.profile = null; setTimeout(() => fs.rmSync(p, { recursive: true, force: true }), 500).unref(); }
  }
}

export class Portals extends EventEmitter {
  /** @param {{dataRoot: string, uploadRoots: () => string[], chrome?: string|null}} deps */
  constructor({ dataRoot, uploadRoots, chrome }) {
    super();
    this.dataRoot = dataRoot;
    this.uploadRoots = uploadRoots;
    this.chrome = chrome === undefined ? findChrome() : chrome;
    this.map = new Map();
    this.reaper = setInterval(() => this.reap(), 60000);
    this.reaper.unref();
  }

  get available() { return !!this.chrome; }

  get(node) {
    let p = this.map.get(node.id);
    if (!p) {
      p = new Portal(this, node);
      p.on('frame', (f) => this.emit('frame', node.id, f));
      p.on('nav', (n) => this.emit('nav', node.id, n));
      p.on('closed', () => this.map.delete(node.id));
      this.map.set(node.id, p);
    }
    p.node = node;
    p.touch();
    return p;
  }

  has(id) { return this.map.has(id); }

  async attach(node) {
    const p = this.get(node);
    p.viewers += 1;
    await p.startScreencast();
    return p;
  }

  async detach(id) {
    const p = this.map.get(id);
    if (!p) return;
    p.viewers = Math.max(0, p.viewers - 1);
    if (p.viewers === 0) await p.stopScreencast();
  }

  async dispose(id) {
    const p = this.map.get(id);
    this.map.delete(id);
    if (p) await p.dispose();
  }

  reap() {
    for (const [id, p] of this.map) {
      if (!p.viewers && Date.now() - p.lastUse > IDLE_MS) void this.dispose(id);
    }
  }

  async stop() {
    clearInterval(this.reaper);
    await Promise.all([...this.map.keys()].map((id) => this.dispose(id)));
  }
}
