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

const code = (c) => c.codePointAt(0);
const isDigit = (c) => code(c) >= 48 && code(c) <= 57;
const isAlpha = (c) => (code(c) >= 65 && code(c) <= 90) || (code(c) >= 97 && code(c) <= 122) || c === '_' || c === '$';
const isWord = (c) => isAlpha(c) || isDigit(c);
const isHexLetter = (c) => (code(c) >= 97 && code(c) <= 102) || (code(c) >= 65 && code(c) <= 70);
const isNumberPart = (c) => isDigit(c) || isHexLetter(c) || c === '.' || c === '_' || c === 'x' || c === 'X';

/** End of a quoted string that starts at `i` (a line for ' and ", the rest of the file for `). */
function stringEnd(text, i) {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === '\\') j += 1;
    else if (text[j] === quote) return j + 1;
    else if (text[j] === '\n' && quote !== '`') return j;
  }
  return text.length;
}

function lineEnd(text, i) {
  const j = text.indexOf('\n', i);
  return j < 0 ? text.length : j;
}

function runEnd(text, i, test) {
  let j = i + 1;
  while (j < text.length && test(text[j])) j += 1;
  return j;
}

/** One coloured token at `i` as [end, class], or null when the text there is plain. */
function tokenAt(text, i, lang, keywords) {
  const c = text[i];
  const comment = COMMENT[lang];
  if (comment && text.startsWith(comment, i)) return [lineEnd(text, i), 'hl-c'];
  if (lang === 'js' && text.startsWith('/*', i)) { const j = text.indexOf('*/', i + 2); return [j < 0 ? text.length : j + 2, 'hl-c']; }
  if (c === '"' || c === "'" || (c === '`' && lang === 'js')) return [stringEnd(text, i), 'hl-s'];
  if (isDigit(c) && (i === 0 || !isWord(text[i - 1]))) return [runEnd(text, i, isNumberPart), 'hl-n'];
  if (isAlpha(c)) { const j = runEnd(text, i, isWord); return keywords.has(text.slice(i, j)) ? [j, 'hl-k'] : [j, null]; }
  return null;
}

/** @returns {Array<[string, string|null]>} pieces of text with a colour class or null */
export function tokenize(text, lang) {
  const keywords = new Set((KEYWORDS[lang] ?? '').split(' '));
  const out = [];
  let plainFrom = 0;
  let i = 0;
  while (i < text.length) {
    const tok = tokenAt(text, i, lang, keywords);
    if (!tok) { i += 1; continue; }
    const [end, cls] = tok;
    if (cls) {
      if (i > plainFrom) out.push([text.slice(plainFrom, i), null]);
      out.push([text.slice(i, end), cls]);
      plainFrom = end;
    }
    i = end;
  }
  if (plainFrom < text.length) out.push([text.slice(plainFrom), null]);
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
