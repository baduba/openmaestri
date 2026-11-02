// A small syntax colouring for the file editor: comments, strings, numbers and keywords for the
// languages people open most. It builds DOM nodes with textContent, never HTML strings, so file
// content cannot become markup. It colours; it does not parse, so odd code just looks plain.

const KEYWORDS = {
  js: 'break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await null true false undefined interface type enum implements public private protected readonly',
  py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self',
  sh: 'if then else elif fi for while until do done case esac function in return exit local export readonly source echo cd set unset trap',
  json: 'true false null',
  css: 'important',
};

const LANG_BY_EXT = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', json: 'json', py: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', css: 'css', yml: 'sh', yaml: 'sh', toml: 'sh' };
const COMMENT = { js: '//', py: '#', sh: '#', json: null, css: null };
export const MAX_HIGHLIGHT = 200 * 1024;

export function languageOf(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  return Object.hasOwn(LANG_BY_EXT, ext) ? LANG_BY_EXT[ext] : null;
}

const code = (c) => c.charCodeAt(0);
const isDigit = (c) => code(c) >= 48 && code(c) <= 57;
const isAlpha = (c) => (code(c) >= 65 && code(c) <= 90) || (code(c) >= 97 && code(c) <= 122) || c === '_' || c === '$';
const isWord = (c) => isAlpha(c) || isDigit(c);
const isNumberPart = (c) => isDigit(c) || c === '.' || c === '_' || c === 'x' || c === 'X' || (code(c) >= 97 && code(c) <= 102) || (code(c) >= 65 && code(c) <= 70);

/** @returns {Array<[string, string|null]>} pieces of text with a colour class or null */
export function tokenize(text, lang) {
  const kw = new Set((KEYWORDS[lang] ?? '').split(' '));
  const lineComment = COMMENT[lang];
  const out = [];
  let plain = '';
  const flush = () => { if (plain) { out.push([plain, null]); plain = ''; } };
  const push = (t, cls) => { flush(); out.push([t, cls]); };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (lineComment && text.startsWith(lineComment, i)) {
      let j = text.indexOf('\n', i);
      if (j < 0) j = text.length;
      push(text.slice(i, j), 'hl-c'); i = j; continue;
    }
    if (lang === 'js' && text.startsWith('/*', i)) {
      let j = text.indexOf('*/', i + 2);
      j = j < 0 ? text.length : j + 2;
      push(text.slice(i, j), 'hl-c'); i = j; continue;
    }
    if (c === '"' || c === "'" || (c === '`' && lang === 'js')) {
      let j = i + 1;
      while (j < text.length && text[j] !== c && (text[j] !== '\n' || c === '`')) { if (text[j] === '\\') j += 1; j += 1; }
      j = Math.min(text.length, j + 1);
      push(text.slice(i, j), 'hl-s'); i = j; continue;
    }
    if (isDigit(c) && (i === 0 || !isWord(text[i - 1]))) {
      let j = i + 1;
      while (j < text.length && isNumberPart(text[j])) j += 1;
      push(text.slice(i, j), 'hl-n'); i = j; continue;
    }
    if (isAlpha(c)) {
      let j = i + 1;
      while (j < text.length && isWord(text[j])) j += 1;
      const word = text.slice(i, j);
      if (kw.has(word)) push(word, 'hl-k'); else plain += word;
      i = j; continue;
    }
    plain += c; i += 1;
  }
  flush();
  return out;
}

/** Fill `into` with coloured spans for `text`. */
export function highlightInto(into, text, lang) {
  into.replaceChildren();
  if (!lang || text.length > MAX_HIGHLIGHT) { into.append(text); return; }
  for (const [t, cls] of tokenize(text, lang)) {
    if (!cls) into.append(t);
    else { const s = document.createElement('span'); s.className = cls; s.textContent = t; into.append(s); }
  }
}
