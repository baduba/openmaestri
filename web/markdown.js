// Markdown to DOM, a small safe subset: headings, lists, quotes, fenced code, bold, italic, code,
// http(s) links and pictures from this workspace's attachment vault. Nothing is ever set through
// innerHTML: text goes in with textContent, so raw HTML in a note or file is just text.
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** Markdown to DOM, a small safe subset: headings, lists, quotes, fenced code, bold, italic, code, http(s) links. */
export function renderMarkdown(src, into) {
  into.replaceChildren();
  const inline = (parent, text) => {
    const re = /(!\[[^\]\n]{0,100}\]\(\/attachment\/[0-9a-f-]{36}\/att_[0-9a-f]{16}\)|`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
    let last = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('![')) {
        // only pictures from this workspace's own vault: the pattern above admits nothing else
        const close = t.indexOf('](');
        const img = el('img');
        img.alt = t.slice(2, close);
        img.src = t.slice(close + 2, -1);
        img.loading = 'lazy';
        img.className = 'md-img';
        parent.append(img);
      } else if (t.startsWith('`')) parent.append(el('code', null, t.slice(1, -1)));
      else if (t.startsWith('**')) parent.append(el('strong', null, t.slice(2, -2)));
      else if (t.startsWith('*')) parent.append(el('em', null, t.slice(1, -1)));
      else {
        const close = t.indexOf('](');
        const label = t.slice(1, close);
        let url = null;
        try { url = new URL(t.slice(close + 2, -1)); } catch { /* not a URL: plain text */ }
        if (url && (url.protocol === 'https:' || url.protocol === 'http:')) {
          const a = el('a', null, label);
          a.href = url.href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          parent.append(a);
        } else parent.append(label);
      }
      last = m.index + t.length;
    }
    if (last < text.length) parent.append(text.slice(last));
  };
  const lines = String(src).split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code = [];
      for (i += 1; i < lines.length && !lines[i].startsWith('```'); i += 1) code.push(lines[i]);
      i += 1;
      const pre = el('pre'); pre.append(el('code', null, code.join('\n'))); into.append(pre);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { const e = el(`h${h[1].length}`); inline(e, h[2]); into.append(e); i += 1; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const ul = el('ul');
      for (; i < lines.length && /^\s*[-*]\s+/.test(lines[i]); i += 1) { const li = el('li'); inline(li, lines[i].replace(/^\s*[-*]\s+/, '')); ul.append(li); }
      into.append(ul);
      continue;
    }
    if (line.startsWith('>')) { const q = el('blockquote'); inline(q, line.replace(/^>\s?/, '')); into.append(q); i += 1; continue; }
    if (!line.trim()) { i += 1; continue; }
    const p = el('p');
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*[-*]\s)/.test(lines[i]); i += 1) para.push(lines[i]);
    if (!para.length) { para.push(line); i += 1; }
    inline(p, para.join(' '));
    into.append(p);
  }
}
