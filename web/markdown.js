// Markdown to DOM, a small safe subset: headings, lists, quotes, fenced code, bold, italic, code,
// http(s) links and pictures from this workspace's attachment vault. Nothing is ever set through
// innerHTML: text goes in with textContent, so raw HTML in a note or file is just text.
// The scanner is written by hand (no big regular expressions) so odd input cannot make it slow.
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const HEX = '0123456789abcdef';
const allIn = (s, set) => s.length > 0 && [...s].every((ch) => set.includes(ch));
const oneLine = (s) => !s.includes('\n');

/** "/attachment/<workspace id>/att_<16 hex>": the only address a picture may have. */
export function isVaultPath(url) {
  const parts = url.split('/');
  return parts.length === 4 && parts[0] === '' && parts[1] === 'attachment' && parts[2].length === 36 && allIn(parts[2], `${HEX}-`) && parts[3].length === 20 && parts[3].startsWith('att_') && allIn(parts[3].slice(4), HEX);
}

function isHttpUrl(url) {
  if (/\s/.test(url) || url.includes(')') || url.length > 2000) return false;
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}

/** `[label](url)` or `![alt](url)` starting at `i` (which points at the bracket): {end, label, url} or null. */
function bracketed(text, i) {
  const close = text.indexOf(']', i + 1);
  if (close < 0 || close - i > 120 || !oneLine(text.slice(i, close)) || text[close + 1] !== '(') return null;
  const end = text.indexOf(')', close + 2);
  if (end < 0) return null;
  return { end: end + 1, label: text.slice(i + 1, close), url: text.slice(close + 2, end) };
}

function delimited(text, i, mark) {
  const end = text.indexOf(mark, i + mark.length);
  if (end <= i + mark.length || !oneLine(text.slice(i, end))) return null;
  return { end: end + mark.length, body: text.slice(i + mark.length, end) };
}

/** The piece of inline Markdown at `i`, as {end, node}, or null when it is plain text. */
function inlineAt(text, i) {
  const c = text[i];
  if (c === '`') { const m = delimited(text, i, '`'); return m && { end: m.end, node: el('code', null, m.body) }; }
  if (c === '*') {
    const strong = text.startsWith('**', i) ? delimited(text, i, '**') : null;
    if (strong) return { end: strong.end, node: el('strong', null, strong.body) };
    const m = delimited(text, i, '*');
    return m && { end: m.end, node: el('em', null, m.body) };
  }
  if (c === '!' && text[i + 1] === '[') {
    const b = bracketed(text, i + 1);
    if (!b || !isVaultPath(b.url)) return null;
    const img = el('img', 'md-img');
    img.alt = b.label.slice(0, 100);
    const [, , workspace, attachment] = b.url.split('/');
    img.src = `/attachment/${encodeURIComponent(workspace)}/${encodeURIComponent(attachment)}`;
    img.loading = 'lazy';
    return { end: b.end, node: img };
  }
  if (c === '[') {
    const b = bracketed(text, i);
    if (!b || !isHttpUrl(b.url)) return null;
    const a = el('a', null, b.label);
    a.href = new URL(b.url).href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return { end: b.end, node: a };
  }
  return null;
}

function inline(parent, text) {
  let plain = '';
  let i = 0;
  while (i < text.length) {
    const hit = '`*![' .includes(text[i]) ? inlineAt(text, i) : null;
    if (hit) { if (plain) { parent.append(plain); plain = ''; } parent.append(hit.node); i = hit.end; } else { plain += text[i]; i += 1; }
  }
  if (plain) parent.append(plain);
}

const isBullet = (line) => { const t = line.trimStart(); return t.startsWith('- ') || t.startsWith('* '); };
const bulletText = (line) => line.trimStart().slice(2);

/** Number of leading # (1 to 6) when the line is a heading, else 0. */
function headingLevel(line) {
  let n = 0;
  while (line[n] === '#') n += 1;
  return n >= 1 && n <= 6 && line[n] === ' ' ? n : 0;
}

const startsBlock = (line) => headingLevel(line) > 0 || line.startsWith('```') || line.startsWith('>') || isBullet(line);

function fence(lines, start, into) {
  const code = [];
  let i = start + 1;
  while (i < lines.length && !lines[i].startsWith('```')) { code.push(lines[i]); i += 1; }
  const pre = el('pre');
  pre.append(el('code', null, code.join('\n')));
  into.append(pre);
  return i + 1;
}

function list(lines, start, into) {
  const ul = el('ul');
  let i = start;
  while (i < lines.length && isBullet(lines[i])) { const li = el('li'); inline(li, bulletText(lines[i])); ul.append(li); i += 1; }
  into.append(ul);
  return i;
}

function paragraph(lines, start, into) {
  const parts = [];
  let i = start;
  while (i < lines.length && lines[i].trim() && (i === start || !startsBlock(lines[i]))) { parts.push(lines[i]); i += 1; }
  const p = el('p');
  inline(p, parts.join(' '));
  into.append(p);
  return i;
}

export function renderMarkdown(src, into) {
  into.replaceChildren();
  const lines = String(src).split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const level = headingLevel(line);
    if (line.startsWith('```')) i = fence(lines, i, into);
    else if (level) { const h = el(`h${level}`); inline(h, line.slice(level + 1)); into.append(h); i += 1; } else if (isBullet(line)) i = list(lines, i, into);
    else if (line.startsWith('>')) { const q = el('blockquote'); inline(q, line.slice(line[1] === ' ' ? 2 : 1)); into.append(q); i += 1; } else if (!line.trim()) i += 1;
    else i = paragraph(lines, i, into);
  }
}
