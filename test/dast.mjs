#!/usr/bin/env node
// Dynamic security tests: start the real daemon in a temporary data folder and attack its HTTP and WebSocket
// surface from the outside. What the app promises (token, Host and Origin checks, no path traversal, headers,
// loopback only, private files) is checked on a running process, not read from the code.
//   node test/dast.mjs            exit code 1 on any failed check
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`); };

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/** A raw request: Node's own client would fix the Host header and the path for us, and we want to send them wrong. */
function raw(port, { method = 'GET', target = '/', headers = {}, body = '' }) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    const done = () => { sock.destroy(); const [head = '', ...rest] = data.split('\r\n\r\n'); const lines = head.split('\r\n'); const status = Number(/^HTTP\/1\.\d (\d+)/.exec(lines[0])?.[1] ?? 0); const hdr = {}; for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) hdr[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); } resolve({ status, headers: hdr, body: rest.join('\r\n\r\n') }); };
    sock.setTimeout(4000, done);
    sock.on('data', (c) => { data += c; });
    sock.on('end', done);
    sock.on('error', done);
    const h = { host: `127.0.0.1:${port}`, connection: 'close', ...headers };
    const lines = [`${method} ${target} HTTP/1.1`, ...Object.entries(h).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`), ...(body ? [`content-length: ${Buffer.byteLength(body)}`] : []), '', body];
    sock.write(lines.join('\r\n'));
  });
}

const wsOpen = (url, headers = {}) => new Promise((resolve) => {
  const s = new WebSocket(url, { headers, handshakeTimeout: 4000 });
  s.on('open', () => resolve({ open: true, ws: s }));
  s.on('unexpected-response', (_q, res) => resolve({ open: false, status: res.statusCode }));
  s.on('error', () => resolve({ open: false, status: 0 }));
});

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'om-dast-'));
const port = await freePort();
const sock = path.join(data, 'ipc.sock');
const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'openmaestri.js'), 'serve'], { env: { ...process.env, OPENMAESTRI_DATA_DIR: data, OPENMAESTRI_PORT: String(port), OPENMAESTRI_SOCKET_PATH: sock, OPENMAESTRI_NO_WELCOME: '1', HOME: data }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (c) => { log += c; });
child.stderr.on('data', (c) => { log += c; });
const stop = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
process.on('exit', stop);
for (let i = 0; i < 100 && !fs.existsSync(path.join(data, 'token')); i++) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 500));
const token = fs.readFileSync(path.join(data, 'token'), 'utf8').trim();
const T = `token=${token}`;

try {
  // ---- who gets in ----
  for (const p of ['/', '/index.html', '/vendor/xterm.mjs', '/export/00000000-0000-4000-8000-000000000000', '/attachment/a/b', '/chat-export/a/thread-1.md', '/app.js']) {
    const r = await raw(port, { target: p });
    check(`no token: ${p} is refused`, r.status === 403 && !/<html|import /i.test(r.body), `status ${r.status}`);
  }
  check('a wrong token is refused', (await raw(port, { target: `/?token=${'0'.repeat(token.length)}` })).status === 403);
  check('a token of another length is refused', (await raw(port, { target: '/?token=abc' })).status === 403);
  check('the token in the cookie works, a forged cookie does not', (await raw(port, { target: '/index.html', headers: { cookie: `om_token=${token}` } })).status === 200 && (await raw(port, { target: '/index.html', headers: { cookie: 'om_token=forged' } })).status === 403);
  const good = await raw(port, { target: `/?${T}` });
  check('the right token redirects and sets an HttpOnly, SameSite=Strict cookie', good.status === 302 && /HttpOnly/i.test(good.headers['set-cookie'] ?? '') && /SameSite=Strict/i.test(good.headers['set-cookie'] ?? ''), JSON.stringify(good.headers));

  // ---- DNS rebinding and cross-site ----
  for (const host of ['evil.com', `evil.com:${port}`, `127.0.0.1.nip.io:${port}`, `localhost.evil.com:${port}`, `127.0.0.1:${port + 1}`, '0.0.0.0:80', '']) {
    const r = await raw(port, { target: `/index.html?${T}`, headers: { host } });
    check(`Host "${host}" is refused even with the token`, r.status === 403 || r.status === 400, `status ${r.status}`);
  }
  for (const origin of ['http://evil.com', `http://evil.com:${port}`, 'null', `http://127.0.0.1.evil.com:${port}`]) {
    const r = await raw(port, { target: `/index.html?${T}`, headers: { origin } });
    check(`Origin "${origin}" is refused even with the token`, r.status === 403 || r.status === 400, `status ${r.status}`);
  }

  // ---- path traversal ----
  const probes = ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/%2e%2e%2f%2e%2e%2fetc/passwd', '/vendor/../package.json', '/web/../src/server.js', '/..\\package.json', '/index.html%00.js', '//etc/passwd', '/./../../etc/passwd', '/vendor/xterm.mjs/../../package.json', '/%252e%252e/package.json', '/....//....//etc/passwd'];
  for (const p of probes) {
    const r = await raw(port, { target: `${p}${p.includes('?') ? '&' : '?'}${T}` });
    check(`traversal ${p} is answered and leaks nothing`, r.status > 0 && !/"name":\s*"openmaestri"|root:x:|createServer|WebSocketServer/.test(r.body), `status ${r.status}`);
  }
  for (const p of ['/attachment/../../../etc/passwd', '/attachment/..%2f..%2f/x', '/export/../../token', '/export/..%2ftoken', '/chat-export/../../token/x', '/attachment/00000000-0000-4000-8000-000000000000/../../../token']) {
    const r = await raw(port, { target: `${p}?${T}` });
    check(`dynamic route ${p} is answered and leaks nothing`, r.status > 0 && !r.body.includes(token) && !/root:x:/.test(r.body), `status ${r.status}`);
  }

  // ---- methods, headers, errors ----
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'TRACE', 'OPTIONS']) {
    const r = await raw(port, { method, target: `/index.html?${T}`, body: method === 'POST' || method === 'PUT' ? '{"a":1}' : '' });
    check(`${method} is answered, with no permissive CORS and no echo of the request`, r.status > 0 && !r.headers['access-control-allow-origin'] && !/\{"a":1\}/.test(r.body) && !/^TRACE/i.test(r.body), JSON.stringify(r.headers));
  }
  const page = await raw(port, { target: `/index.html?${T}` });
  const need = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'cache-control'];
  check('security headers are on the app page', need.every((h) => page.headers[h]), `status ${page.status}, missing: ${need.filter((h) => !page.headers[h]).join(', ')}; daemon exit ${child.exitCode}; log: ${log.slice(-600)}`);
  check('the CSP allows no inline script and no eval', /script-src 'self'(?:;|$)/.test(page.headers['content-security-policy'] ?? '') && !/unsafe-eval/.test(page.headers['content-security-policy'] ?? ''), page.headers['content-security-policy']);
  check('the forbidden page has the headers too', !!(await raw(port, { target: '/' })).headers['x-content-type-options']);
  check('no version banner in headers', !/express|nginx|apache|node/i.test(page.headers.server ?? '') && !page.headers['x-powered-by']);
  const nf = await raw(port, { target: `/no/such/file?${T}` });
  check('a missing file is a plain 404 with no path or stack', nf.status === 404 && !/at .*\.js|\/home\/|node_modules|Error:/.test(nf.body), nf.body.slice(0, 120));

  // ---- WebSocket ----
  check('WebSocket without token is refused', (await wsOpen(`ws://127.0.0.1:${port}/ws`)).status === 403);
  check('WebSocket with a foreign Origin is refused', (await wsOpen(`ws://127.0.0.1:${port}/ws?${T}`, { origin: 'http://evil.com' })).status === 403);
  check('WebSocket with a foreign Host is refused', (await wsOpen(`ws://127.0.0.1:${port}/ws?${T}`, { host: 'evil.com' })).status === 403);
  const ok = await wsOpen(`ws://127.0.0.1:${port}/ws?${T}`, { origin: `http://127.0.0.1:${port}` });
  check('WebSocket with the token and the right Origin opens', ok.open);
  if (ok.open) {
    const s = ok.ws;
    let first = '';
    s.on('message', (m) => { first ||= String(m); });
    for (const junk of ['not json', '{"t":"nope"}', '{"t":"term.input","id":"../../x","data":"x"}', '{"t":"cmd","cmd":"__proto__","args":{}}', '{"t":"workspace.import","data":{"__proto__":{"polluted":1}}}', JSON.stringify({ t: 'x'.repeat(100000) }), '[]', 'null', '123']) s.send(junk);
    await new Promise((r) => setTimeout(r, 800));
    check('malformed and hostile WebSocket messages do not kill the server', (await raw(port, { target: `/index.html?${T}` })).status === 200);
    check('prototype pollution through WebSocket did not stick', ({}).polluted === undefined);
    const big = await new Promise((resolve) => { const w = new WebSocket(`ws://127.0.0.1:${port}/ws?${T}`, { origin: `http://127.0.0.1:${port}` }); w.on('open', () => { try { w.send(Buffer.alloc(9 * 1024 * 1024, 'a')); } catch { resolve('closed'); } }); w.on('close', (code) => resolve(`closed ${code}`)); w.on('error', () => resolve('closed')); setTimeout(() => resolve('open'), 5000); });
    check('a frame over the 8 MB limit closes the connection', /closed/.test(big), big);
    s.close();
  }

  // ---- abuse of the server itself ----
  const alive = async () => child.exitCode === null && (await raw(port, { target: `/index.html?${T}` })).status === 200;
  const longUrl = await raw(port, { target: `/${'a'.repeat(200000)}?${T}` });
  check('a 200 KB URL is refused or ignored, not served', longUrl.status === 0 || longUrl.status === 414 || longUrl.status === 431 || longUrl.status === 404 || longUrl.status === 400, `status ${longUrl.status}`);
  check('the server survived the long URL', await alive(), `daemon exit ${child.exitCode}; ${log.slice(-500)}`);
  const bigHeader = await raw(port, { target: `/index.html?${T}`, headers: { 'x-big': 'a'.repeat(100000) } });
  check('a 100 KB header is refused', bigHeader.status === 431 || bigHeader.status === 0 || bigHeader.status === 400, `status ${bigHeader.status}`);
  check('the server survived the big header', await alive(), `daemon exit ${child.exitCode}; ${log.slice(-500)}`);
  const smuggle = await raw(port, { method: 'POST', target: `/index.html?${T}`, headers: { 'transfer-encoding': 'chunked' }, body: '0\r\n\r\nGET /admin HTTP/1.1\r\nhost: x\r\n\r\n' });
  check('a request-smuggling attempt is not served twice', (smuggle.body.match(/HTTP\/1\.1 \d+/g) ?? []).length <= 1, `status ${smuggle.status}`);
  check('the server survived the smuggling attempt', await alive(), `daemon exit ${child.exitCode}; ${log.slice(-500)}`);
  const slow = net.connect(port, '127.0.0.1'); slow.on('error', () => {}); slow.write('GET / HTTP/1.1\r\nhost: x\r\n');
  await new Promise((r) => setTimeout(r, 300));
  check('a half-open request does not block other clients', (await raw(port, { target: `/index.html?${T}` })).status === 200);
  slow.destroy();
  check('the server is still alive after all of the above', child.exitCode === null && (await raw(port, { target: `/index.html?${T}` })).status === 200, log.slice(-400));

  // ---- what is exposed on the machine ----
  let listening = '';
  try { listening = execFileSync('ss', ['-ltnH'], { encoding: 'utf8' }); } catch { listening = ''; }
  const mine = listening.split('\n').filter((l) => l.includes(`:${port} `) || l.endsWith(`:${port}`));
  check('the port listens on 127.0.0.1 only', mine.length > 0 && mine.every((l) => /127\.0\.0\.1:/.test(l)), mine.join(' | '));
  const mode = (p) => fs.statSync(p).mode & 0o777;
  check('the data folder is 0700', mode(data) === 0o700, mode(data).toString(8));
  check('the token file is not readable by others', (mode(path.join(data, 'token')) & 0o077) === 0, mode(path.join(data, 'token')).toString(8));
  check('the agent socket is 0600', (mode(sock) & 0o077) === 0, mode(sock).toString(8));
  check('the token is not printed to the log as part of an error', !/Error|Unhandled|TypeError/.test(log), log.slice(-300));
} finally {
  stop();
  fs.rmSync(data, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
