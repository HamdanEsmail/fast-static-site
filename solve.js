// solve.js: a faster drop-in for makefun-site 1.0.0's build(input): the same output tree, byte for byte, for every
// input, written for CPU time. Pure JavaScript, no dependencies, nothing kept from one case to the next.
//
// How it is fast:
//   * Byte mode. cases.json is read as Latin-1, so every UTF-8 byte is one char and every string stays one-byte; the
//     answer's bytes are written back as they are. Only the Unicode rules need real characters (a slug's NFKD, a
//     template's \S), and those decode on the spot. An input where bytes and characters could disagree (a \u escape,
//     Unicode whitespace, bytes that are not UTF-8) takes the exact UTF-16 path instead.
//   * No parse of the files: cases.json is read token by token as JSON.stringify writes it (answerFast), and each
//     Markdown body stays in the JSON-escaped form it arrives in ("the escaped domain"): native replaces HTML-escape it,
//     only its Markdown markers are looked at, and plain text is copied from input to output untouched. A document or
//     a body shaped any other way is noticed and built the decoded way, rule by rule as makefun-site does.
//   * No JSON.stringify of the pages: Markdown and templates write their HTML already JSON-escaped, and the answer is
//     written as JSON text through a small reused buffer, a page at a time.
//   * Templates: compiled per site and per kind of page by partial evaluation: whatever reads only site, tags and recent
//     (headers, navs, tag clouds, footers) is rendered once into constant text, loops over known arrays unroll, and the
//     rest is a few closures over the page's own values.

import { isUtf8 } from 'node:buffer';

const hasOwn = Object.hasOwn;
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Byte mode (strings are UTF-8 bytes, one per char) or the exact UTF-16 mode. Set per call. */
let BYTE = false;

// ---------------------------------------------------------------- escaping

// HJ[c]: what char code c (< 128) becomes when HTML-escaped (& < > " ') and then JSON-escaped (\ and controls), or
// undefined when it stays itself. Codes from 128 up never change.
const HJ = new Array(128).fill(undefined);
for (let c = 0; c < 32; c++) HJ[c] = JSON.stringify(String.fromCharCode(c)).slice(1, -1);
HJ[38] = '&amp;';
HJ[60] = '&lt;';
HJ[62] = '&gt;';
HJ[34] = '&quot;';
HJ[39] = '&#39;';
HJ[92] = '\\\\';
const HJ_HIT = new Uint8Array(128);
for (let c = 0; c < 128; c++) HJ_HIT[c] = HJ[c] === undefined ? 0 : 1;

const HJ_RE = /[\u0000-\u001f"&'<>\\]/;

/** `s` HTML-escaped (& < > " '), then JSON-escaped: how a template's {{ }} writes into the answer. */
function escHJ(s) {
  // Most strings hold nothing to escape, which one native test tells.
  if (!HJ_RE.test(s)) return s;
  const n = s.length;
  let i = 0;
  let c = 0;
  for (; i < n; i++) {
    c = s.charCodeAt(i);
    if (c < 128 && HJ_HIT[c] === 1) break;
  }
  if (i === n) return s;
  let out = i === 0 ? HJ[c] : s.slice(0, i) + HJ[c];
  let last = ++i;
  for (; i < n; i++) {
    c = s.charCodeAt(i);
    if (c < 128 && HJ_HIT[c] === 1) {
      out += i > last ? s.slice(last, i) + HJ[c] : HJ[c];
      last = i + 1;
    }
  }
  return last < n ? out + s.slice(last) : out;
}

/** escHJ of a template variable's text, remembered within a build: a title or a summary is written many times. */
let escMemo = new Map();
function escVar(s) {
  if (!HJ_RE.test(s)) return s;
  let r = escMemo.get(s);
  if (r === undefined) {
    r = escHJ(s);
    escMemo.set(s, r);
  }
  return r;
}

const J_RE = /["\\\u0000-\u001f]/;

/** `s` JSON-escaped (the inside of a JSON string). */
function escJ(s) {
  return J_RE.test(s) ? JSON.stringify(s).slice(1, -1) : s;
}

/** A value whose text is already JSON-escaped HTML (a page's content, an excerpt, a heading's HTML). */
const JV = Symbol('json');
const JRAW = Symbol('raw');
const jv = (json) => ({ [JV]: json });
/** The plain text of a JSON-escaped value. */
function rawOf(v) {
  let r = v[JRAW];
  if (r === undefined) r = v[JRAW] = JSON.parse(`"${v[JV]}"`);
  return r;
}

// ---------------------------------------------------------------- text

const isUniWS = (c) => c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;

/** Whether char code `c` is \s (in byte mode only ASCII can be: the input holds no Unicode whitespace). */
function isWS(c) {
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  return !BYTE && c >= 160 && isUniWS(c);
}

const WS_B = /[\t-\r ]/;
const WS_U = /\s/;

/** Whether `s` holds whitespace (/\s/; in byte mode only ASCII can be). */
const hasWS = (s) => (BYTE ? WS_B : WS_U).test(s);

/** String.prototype.trim, as the UTF-16 text would read it. */
function jsTrim(s) {
  if (!BYTE) return s.trim();
  const n = s.length;
  let a = 0;
  let c;
  while (a < n && ((c = s.charCodeAt(a)) === 32 || (c >= 9 && c <= 13))) a++;
  let e = n;
  while (e > a && ((c = s.charCodeAt(e - 1)) === 32 || (c >= 9 && c <= 13))) e--;
  return a === 0 && e === n ? s : s.slice(a, e);
}

// A word is a run of non-whitespace (index.js's /\S+/g). Counted natively, 32 words a regular-expression call: a
// sticky pattern steps over 32 words, each with the whitespace after it (a word must end at whitespace, so no word is
// ever split), and the last few words are counted by turning each into one "x". Byte mode classes only ASCII as
// whitespace (a UTF-8 byte such as 0xA0 is no space), and the input holds no Unicode whitespace there.
const LEAD_B = /[\t-\r ]*/y;
const WORDS32_B = /(?:[^\t-\r ]+[\t-\r ]+){32}/y;
const WORD_B = /[^\t-\r ]+[\t-\r ]*/g;
const LEAD_U = /\s*/y;
const WORDS32_U = /(?:\S+\s+){32}/y;
const WORD_U = /\S+\s*/g;

/** The number of runs of non-whitespace in `s`. */
function wordCount(s) {
  const lead = BYTE ? LEAD_B : LEAD_U;
  const chunk = BYTE ? WORDS32_B : WORDS32_U;
  lead.lastIndex = 0;
  lead.test(s);
  let p = lead.lastIndex; // the first word's start, or the end
  let words = 0;
  chunk.lastIndex = p;
  while (chunk.test(s)) {
    words += 32;
    p = chunk.lastIndex;
  }
  return p < s.length ? words + s.slice(p).replace(BYTE ? WORD_B : WORD_U, 'x').length : words;
}

/** A byte-mode string's characters (UTF-8 decoded), or `s` itself in UTF-16 mode. */
const chars = (s) => (BYTE ? Buffer.from(s, 'latin1').toString('utf8') : s);
/** A UTF-16 string as byte-mode text (UTF-8 bytes), or `s` itself in UTF-16 mode. */
const bytes = (s) => (BYTE ? Buffer.from(s, 'utf8').toString('latin1') : s);

const SLUG_MAX = 64;
const MARKS = /\p{M}/gu;
let slugCache = new Map();

const NOT_SLUG = /[^a-z0-9]+/g;
const NOT_ASCII = /[^\u0000-\u007f]/;

function slugifyRaw(text) {
  if (!NOT_ASCII.test(text)) {
    // ASCII: lower A-Z, every run of other characters one "-", none at either end, at most 64 characters.
    const r = text.toLowerCase().replace(NOT_SLUG, '-');
    const a = r.charCodeAt(0) === 45 ? 1 : 0;
    let e = r.length;
    if (e - a > SLUG_MAX) e = a + SLUG_MAX;
    while (e > a && r.charCodeAt(e - 1) === 45) e--;
    return e === a ? 'untitled' : a === 0 && e === r.length ? r : r.slice(a, e);
  }
  const plain = chars(text).normalize('NFKD').replace(MARKS, '');
  let out = '';
  let gap = false;
  for (let i = 0, n = plain.length; i < n; i++) {
    let c = plain.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    else if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(c);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** The slug of `text` (README.md, "Text"), memoised within the build. */
function slugify(text) {
  let r = slugCache.get(text);
  if (r === undefined) {
    r = slugifyRaw(text);
    slugCache.set(text, r);
  }
  return r;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  if (taken.has(out)) for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let dateCache = new Map();

function longDate(date) {
  let r = dateCache.get(date);
  if (r === undefined) {
    const [y, m, d] = date.split('-');
    r = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    dateCache.set(date, r);
  }
  return r;
}

// ---------------------------------------------------------------- front matter (lib/frontmatter.js)

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;
const FM_TRAIL = /[ \t]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    const inner = raw.slice(1, -1);
    if (inner.indexOf('\\') === -1) {
      if (inner.indexOf('"') !== -1) return { error: 'a quoted string holds a stray quote' };
      return { value: inner };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (jsTrim(inner) === '') return { value: [] };
      const tags = inner.split(',').map(jsTrim);
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** { data, body } or { error }: lib/frontmatter.js's parseFrontMatter, without splitting the whole body. */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  if ((nl === -1 ? text : text.slice(0, nl)) !== '---') return { error: 'no front matter' };
  if (nl === -1) return { error: 'the front matter is not closed' };
  const fm = [];
  let pos = nl + 1;
  let bodyStart = -1;
  for (;;) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    if (line === '---') {
      bodyStart = e === -1 ? text.length : e + 1;
      break;
    }
    fm.push(line);
    if (e === -1) break;
    pos = e + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const r = parseFmLines(fm);
  if (!('error' in r)) r.body = text.slice(bodyStart);
  return r;
}

/** The front matter's lines (those between its two "---") read: { data }, or { error } with the first reason met. */
function parseFmLines(fm) {
  const data = {};
  for (let j = 0; j < fm.length; j++) {
    const line = fm[j];
    if (line.startsWith('#') || FM_BLANK.test(line)) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(FM_TRAIL, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data };
}

// ---------------------------------------------------------------- Markdown (lib/markdown.js), writing JSON-escaped HTML

// The block rules read each line in place, as the range [a, b) of the body (b at its "\n" or the body's end), the way
// lib/markdown.js reads the lines of src.split('\n'); no line is copied unless its text is needed.

/** Whether s[a, b) is only spaces and tabs. */
function blankR(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether s[a, b) holds a character a regular expression's . does not match. */
function hasLTR(s, a, b) {
  if (BYTE) return false; // byte mode: no \n or \r in a line, and the input holds no U+2028 or U+2029
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x2028 || c === 0x2029 || c === 10 || c === 13) return true;
  }
  return false;
}

/** A fence's language (/^```([A-Za-z0-9_+-]*)[ \t]*$/) on line s[a, b), or null. */
function fenceLangR(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return null;
  let i = a + 3;
  while (i < b) {
    const c = s.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  return blankR(s, i, b) ? s.slice(a + 3, i) : null;
}

const isFenceCloseR = (s, a, b) => b - a >= 3 && s.charCodeAt(a) === 96 && s.charCodeAt(a + 1) === 96 && s.charCodeAt(a + 2) === 96 && blankR(s, a + 3, b);

/** A heading's depth on line s[a, b) (its text left in headingText), or 0. */
let headingText = '';
function headingDepthR(s, a, b) {
  let h = a;
  while (h < b && s.charCodeAt(h) === 35) h++;
  const depth = h - a;
  if (depth === 0 || depth > 6 || h === b) return 0;
  let c = s.charCodeAt(h);
  if (c !== 32 && c !== 9) return 0;
  let i = h;
  while (i < b && ((c = s.charCodeAt(i)) === 32 || c === 9)) i++;
  let e = b;
  while (e > i && ((c = s.charCodeAt(e - 1)) === 32 || c === 9)) e--;
  if (e === i || hasLTR(s, i, b)) return 0;
  headingText = s.slice(i, e);
  return depth;
}

const isHRR = (s, a, b) => {
  const c = s.charCodeAt(a);
  return b - a >= 3 && (c === 45 || c === 42) && s.charCodeAt(a + 1) === c && s.charCodeAt(a + 2) === c && blankR(s, a + 3, b);
};

/** Whether line s[a, b) ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraphR(s, a, b) {
  if (a === b) return true;
  const c = s.charCodeAt(a);
  if (c === 96) return fenceLangR(s, a, b) !== null;
  if (c === 35) return headingDepthR(s, a, b) !== 0;
  if (c === 45 || c === 42) return isHRR(s, a, b);
  if (c === 32 || c === 9) return blankR(s, a, b);
  return false;
}

/** s[a, b) with spaces and tabs at either end dropped. */
function trimR(s, a, b) {
  let c;
  while (a < b && ((c = s.charCodeAt(a)) === 32 || c === 9)) a++;
  while (b > a && ((c = s.charCodeAt(b - 1)) === 32 || c === 9)) b--;
  return s.slice(a, b);
}

/** Where a bullet's text starts on line s[a, b) (/^[-*] (.*)$/), or -1. */
function bulletAt(s, a, b) {
  const c = s.charCodeAt(a);
  if (b - a < 2 || (c !== 45 && c !== 42) || s.charCodeAt(a + 1) !== 32 || hasLTR(s, a + 2, b)) return -1;
  return a + 2;
}

/** An ordered item's number on line s[a, b) (/^(\d{1,9})\. (.*)$/), its text's start left in orderedAt; or -1. */
let orderedAt = 0;
function orderedR(s, a, b) {
  let i = a;
  let c;
  while (i < b && (c = s.charCodeAt(i)) >= 48 && c <= 57) i++;
  if (i === a || i - a > 9 || i + 1 >= b || s.charCodeAt(i) !== 46 || s.charCodeAt(i + 1) !== 32 || hasLTR(s, i + 2, b)) return -1;
  orderedAt = i + 2;
  return Number(s.slice(a, i));
}

/** /^ {2,}\S/ on line s[a, b). */
function continuedR(s, a, b) {
  let i = a;
  while (i < b && s.charCodeAt(i) === 32) i++;
  return i - a >= 2 && i < b && !isWS(s.charCodeAt(i));
}

const ESC_OK = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESC_OK[ch.charCodeAt(0)] = 1;
const escapable = (c) => c < 128 && ESC_OK[c] === 1;

function findDoubleStar(s, from) {
  const n = s.length;
  for (let j = from; j <= n - 2; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < n && escapable(s.charCodeAt(j + 1))) j++;
      continue;
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

function findClose(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < n && escapable(s.charCodeAt(j + 1))) j++;
      continue;
    }
    if (c === 93) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < n && escapable(s.charCodeAt(j + 1))) j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// IT[c] for c < 128: 0 a plain char, 1 a char the answer escapes (& < > " ' and controls), 2 an inline marker
// (\ ` * [). Codes from 128 up are plain.
const IT = new Uint8Array(128);
for (let c = 0; c < 128; c++) IT[c] = HJ_HIT[c];
IT[92] = 2;
IT[96] = 2;
IT[42] = 2;
IT[91] = 2;

/**
 * `s` rendered inline, as JSON-escaped HTML; `link(target)` is a link's href (plain text). One pass: plain runs are
 * copied whole, escaped chars replaced as they are met, markers rendered as lib/markdown.js's inline() renders them.
 */
const SPECIAL = /[\u0000-\u001f"&'<>*[\\`]/g;
function inline(s, link) {
  const n = s.length;
  let out = '';
  let run = 0; // the start of the plain text not yet copied to out
  let i = 0;
  for (;;) {
    SPECIAL.lastIndex = i;
    if (!SPECIAL.test(s)) break;
    i = SPECIAL.lastIndex - 1;
    const c = s.charCodeAt(i);
    const t = IT[c];
    if (t === 1) {
      out += i > run ? s.slice(run, i) + HJ[c] : HJ[c];
      run = ++i;
      continue;
    }
    if (c === 92) {
      if (i > run) out += s.slice(run, i);
      if (i + 1 < n && escapable(s.charCodeAt(i + 1))) {
        const d = s.charCodeAt(i + 1);
        out += d === 62 ? '&gt;' : d === 92 ? '\\\\' : s[i + 1];
        i += 2;
      } else {
        out += '\\\\';
        i++;
      }
      run = i;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > run) out += s.slice(run, i);
        out += `<code>${escHJ(s.slice(i + 1, j))}</code>`;
        run = i = j + 1;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findDoubleStar(s, i + 2);
        if (j > i + 2) {
          if (i > run) out += s.slice(run, i);
          out += `<strong>${inline(s.slice(i + 2, j), link)}</strong>`;
          run = i = j + 2;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          if (i > run) out += s.slice(run, i);
          out += `<em>${inline(s.slice(i + 1, j), link)}</em>`;
          run = i = j + 1;
        } else i++;
      }
      continue;
    }
    // [
    const k = findClose(s, i + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    if (m !== -1) {
      const target = s.slice(k + 2, m);
      if (target !== '' && !hasWS(target)) {
        if (i > run) out += s.slice(run, i);
        out += `<a href=\\"${escHJ(link(target))}\\">${inline(s.slice(i + 1, k), link)}</a>`;
        run = i = m + 1;
        continue;
      }
    }
    i++;
  }
  if (run === 0) return s;
  return run < n ? out + s.slice(run) : out;
}

/** `src` rendered: { html, toc, excerpt }, html and every HTML in them JSON-escaped. */
function renderMarkdown(s, link) {
  const N = s.length;
  let ids = null;
  let html = '';
  const toc = [];
  let excerpt = null;
  // The current line is s[a, b); a past N means the lines are done (src.split('\n') gives N's empty last line too).
  let a = 0;
  let b = s.indexOf('\n');
  if (b === -1) b = N;
  while (a <= N) {
    const c0 = a < b ? s.charCodeAt(a) : -1;
    if (c0 === -1 || ((c0 === 32 || c0 === 9) && blankR(s, a + 1, b))) {
      a = b + 1;
      if (a <= N && (b = s.indexOf('\n', a)) === -1) b = N;
      continue;
    }
    if (c0 === 96) {
      const lang = fenceLangR(s, a, b);
      if (lang !== null) {
        a = b + 1;
        if (a <= N && (b = s.indexOf('\n', a)) === -1) b = N;
        const start = a;
        let end = -1;
        while (a <= N && !isFenceCloseR(s, a, b)) {
          end = b;
          a = b + 1;
          if (a <= N && (b = s.indexOf('\n', a)) === -1) b = N;
        }
        const cls = lang === '' ? '' : ` class=\\"language-${escHJ(lang)}\\"`;
        html += `<pre><code${cls}>${end !== -1 ? `${escHJ(s.slice(start, end))}\\n` : ''}</code></pre>\\n`;
        if (a <= N) {
          a = b + 1;
          if (a <= N && (b = s.indexOf('\n', a)) === -1) b = N;
        }
        continue;
      }
    }
    if (c0 === 35) {
      const depth = headingDepthR(s, a, b);
      if (depth !== 0) {
        const text = headingText;
        if (ids === null) ids = new Set();
        const id = uniqueSlug(slugify(text), ids);
        const h = inline(text, link);
        html += `<h${depth} id=\\"${id}\\">${h}</h${depth}>\\n`;
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html: jv(h) });
        a = b + 1;
        if (a <= N && (b = s.indexOf('\n', a)) === -1) b = N;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && isHRR(s, a, b)) {
      html += '<hr>\\n';
      a = b + 1;
      if (a <= N && (b = s.indexOf('\n', a)) === -1) b = N;
      continue;
    }
    if (c0 === 62) {
      let body = '';
      let any = false;
      while (a <= N && a < b && s.charCodeAt(a) === 62) {
        const t = trimR(s, a + 1 < b && s.charCodeAt(a + 1) === 32 ? a + 2 : a + 1, b);
        if (t !== '') {
          body = any ? `${body}\n${t}` : t;
          any = true;
        }
        a = b + 1;
        if (a <= N && (b = s.indexOf('\n', a)) === -1) b = N;
      }
      html += any ? `<blockquote>\\n<p>${inline(body, link)}</p>\\n</blockquote>\\n` : '<blockquote>\\n</blockquote>\\n';
      continue;
    }
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      const bullet = c0 === 45 || c0 === 42 ? bulletAt(s, a, b) : -1;
      const start = bullet === -1 && c0 >= 48 && c0 <= 57 ? orderedR(s, a, b) : -1;
      if (bullet !== -1 || start !== -1) {
        const ordered = bullet === -1;
        let items = '';
        let item = trimR(s, ordered ? orderedAt : bullet, b);
        a = b + 1;
        if (a <= N && (b = s.indexOf('\n', a)) === -1) b = N;
        while (a <= N) {
          const at = ordered ? (orderedR(s, a, b) !== -1 ? orderedAt : -1) : bulletAt(s, a, b);
          if (at !== -1) {
            items += `<li>${inline(item, link)}</li>\\n`;
            item = trimR(s, at, b);
          } else if (continuedR(s, a, b)) item += `\n${trimR(s, a, b)}`;
          else break;
          a = b + 1;
          if (a <= N && (b = s.indexOf('\n', a)) === -1) b = N;
        }
        items += `<li>${inline(item, link)}</li>\\n`;
        html += ordered ? (start !== 1 ? `<ol start=\\"${start}\\">\\n${items}</ol>\\n` : `<ol>\\n${items}</ol>\\n`) : `<ul>\\n${items}</ul>\\n`;
        continue;
      }
    }
    // A paragraph: its lines trimmed and joined by "\n"; when no line needs trimming that is s itself, sliced once.
    let ta = a;
    let tb = b;
    let c;
    while (ta < tb && ((c = s.charCodeAt(ta)) === 32 || c === 9)) ta++;
    while (tb > ta && ((c = s.charCodeAt(tb - 1)) === 32 || c === 9)) tb--;
    const first = ta;
    let clean = ta === a && tb === b;
    let text = clean ? '' : s.slice(ta, tb);
    let lastEnd = tb;
    a = b + 1;
    if (a <= N && (b = s.indexOf('\n', a)) === -1) b = N;
    while (a <= N) {
      // Only an empty line, or one opening on ` # - * space or tab, can end a paragraph.
      if (a === b) break;
      c = s.charCodeAt(a);
      if ((c === 96 || c === 35 || c === 45 || c === 42 || c === 32 || c === 9) && endsParagraphR(s, a, b)) break;
      ta = a;
      tb = b;
      while (ta < tb && ((c = s.charCodeAt(ta)) === 32 || c === 9)) ta++;
      while (tb > ta && ((c = s.charCodeAt(tb - 1)) === 32 || c === 9)) tb--;
      if (clean) {
        if (ta === a && tb === b) lastEnd = tb;
        else {
          clean = false;
          text = `${s.slice(first, lastEnd)}\n${s.slice(ta, tb)}`;
        }
      } else text += `\n${s.slice(ta, tb)}`;
      a = b + 1;
      if (a <= N && (b = s.indexOf('\n', a)) === -1) b = N;
    }
    if (clean) text = s.slice(first, lastEnd);
    const h = inline(text, link);
    if (excerpt === null) excerpt = h;
    html += `<p>${h}</p>\\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Markdown in the escaped domain (the fast path)
//
// A source's text arrives JSON-escaped (it is a string of cases.json) and leaves JSON-escaped (it is a string of
// answers.json), so the fast path never decodes it. A body is turned, by a few native replaces, into its "escaped
// domain": HTML-escaped (& < > ' and the JSON \" become their entities), every literal backslash (JSON \\) the one
// byte \x01, which no JSON text holds, and every line break still the two characters \n. Plain text is then copied
// from input to output untouched; only the Markdown markers are looked at. A body holding any other JSON escape (a
// tab, say) takes the decoded path above instead.

const PAIR_G = /\\\\/g;
const BS1_G = /\x01/g;
const AMP_G = /&/g;
const LT_G = /</g;
const GT_G = />/g;
const APOS_G = /'/g;
const EQUOT_G = /\\"/g;
const CR_G = /\\r(?:\\n)?/g;
const NL_UNIT_G = /\\n/g;
// A JSON-escaped body into the escaped domain: a literal backslash (\\) first, so that the \" after one is never
// read as its own; then the characters HTML escapes. The search goes left to right over whole JSON escapes: at a
// backslash it takes \\ or \" or, for any other escape, nothing, and moves on.
const TO_E_G = /\\\\|[&<>']|\\"/g;
function toE(m) {
  switch (m.charCodeAt(0)) {
    case 38:
      return '&amp;';
    case 60:
      return '&lt;';
    case 62:
      return '&gt;';
    case 39:
      return '&#39;';
    default:
      return m.charCodeAt(1) === 92 ? '\x01' : '&quot;';
  }
}

/** A JSON escape other than \n left in an escaped-domain body. */
const ODD_UNIT = /\\[^n]/;
const E_MARK = /[`*[\x01]/g;
const E_UNESC = /&(?:amp|lt|gt|quot|#39);|\\n|\x01/g;
const E_NEEDS_UNESC = /[&\\\x01]/;
const FENCE_OPEN_E = /^```([A-Za-z0-9_+-]*) *$/;
const FENCE_CLOSE_E = /^``` *$/;
const HEADING_E = /^(#{1,6}) +(.*?) *$/;
const HR_E = /^(?:---|\*\*\*) *$/;
const ORDERED_E = /^(\d{1,9})\. (.*)$/;

/** Thrown when the input is not shaped as the fast path reads it: the whole answer is then built the decoded way. */
const FALLBACK = { fallback: true };

/** How the last answer was built (for tests): whether it fell back, and how many bodies went each way. */
export const stats = { fallback: 0, fastDocs: 0, slowDocs: 0 };

function unescUnit(m) {
  const c = m.charCodeAt(0);
  if (c === 1) return '\\';
  if (c === 92) return '\n';
  const d = m.charCodeAt(1);
  return d === 97 ? '&' : d === 108 ? '<' : d === 103 ? '>' : d === 113 ? '"' : "'";
}

/** The plain text of an escaped-domain string. */
const unescE = (t) => t.replace(E_UNESC, unescUnit);

/** Whether the JSON string body `j` holds no unescaped quote and no dangling backslash: it is one whole string. */
function cleanJ(j) {
  if (j.indexOf('"') === -1 && j.charCodeAt(j.length - 1) !== 92) return true;
  const p = j.replace(PAIR_G, '').replace(EQUOT_G, '');
  return p.indexOf('"') === -1 && p.charCodeAt(p.length - 1) !== 92;
}

/** The index of the next line break (the JSON escape \n, not a literal backslash before an n) in `j` from `from`, or -1. */
function nextNL(j, from) {
  for (;;) {
    const k = j.indexOf('\\n', from);
    if (k <= 0 || j.charCodeAt(k - 1) !== 92) return k;
    let b = k - 1;
    while (b > 0 && j.charCodeAt(b - 1) === 92) b--;
    if (((k - b) & 1) === 0) return k;
    from = k + 1;
  }
}

/** The characters a backslash escapes, as the escaped domain spells them, but \ (the byte \x01) and > (&gt;). */
const ESC_E = new Uint8Array(128);
for (const ch of '`*_[]()#+-.!') ESC_E[ch.charCodeAt(0)] = 1;

/** The length of the escapable character at `i` of the escaped-domain `s` (4 for &gt;), or 0 when none is there. */
function escLenE(s, i) {
  const c = s.charCodeAt(i);
  if (c === 1) return 1;
  if (c === 38) return s.startsWith('&gt;', i) ? 4 : 0;
  return c < 128 && ESC_E[c] === 1 ? 1 : 0;
}

// The three searches of lib/markdown.js (findUnescaped for "**" and "]", findSingleStar), by native search: the next
// candidate is found with indexOf, and only a literal backslash before it (which may escape it) is stepped over by hand.

/** Whether the body being rendered holds a literal backslash at all (set per body: most hold none). */
let BODY_HAS_BS = true;

function findDoubleStarE(s, from) {
  let j = from;
  for (;;) {
    const q = s.indexOf('**', j);
    if (q === -1) return -1;
    if (BODY_HAS_BS) {
      const b = s.indexOf('\x01', j);
      if (b !== -1 && b < q) {
        j = b + 1 + escLenE(s, b + 1);
        continue;
      }
    }
    return q;
  }
}

function findSingleStarE(s, from) {
  let j = from;
  for (;;) {
    const q = s.indexOf('*', j);
    if (q === -1) return -1;
    if (BODY_HAS_BS) {
      const b = s.indexOf('\x01', j);
      if (b !== -1 && b < q) {
        j = b + 1 + escLenE(s, b + 1);
        continue;
      }
    }
    if (s.charCodeAt(q + 1) === 42) {
      j = q + 2;
      continue;
    }
    return q;
  }
}

function findCloseE(s, from) {
  let j = from;
  for (;;) {
    const q = s.indexOf(']', j);
    if (q === -1) return -1;
    if (BODY_HAS_BS) {
      const b = s.indexOf('\x01', j);
      if (b !== -1 && b < q) {
        j = b + 1 + escLenE(s, b + 1);
        continue;
      }
    }
    return q;
  }
}

/** An escaped-domain string as the answer writes it: each literal backslash (\x01) the JSON escape \\. */
const bsOut = (t) => (BODY_HAS_BS && t.indexOf('\x01') !== -1 ? t.replace(BS1_G, '\\\\') : t);

/** lib/markdown.js's inline() on an escaped-domain string: only the markers are looked at, the rest is copied. */
function inlineE(s, link) {
  E_MARK.lastIndex = 0;
  if (!E_MARK.test(s)) return s;
  const n = s.length;
  let out = '';
  let run = 0;
  let i = E_MARK.lastIndex - 1;
  for (;;) {
    const c = s.charCodeAt(i);
    if (c === 1) {
      if (i > run) out += s.slice(run, i);
      const len = escLenE(s, i + 1);
      if (len === 0) {
        out += '\\\\';
        i++;
      } else if (len === 4) {
        out += '&gt;';
        i += 5;
      } else {
        out += s.charCodeAt(i + 1) === 1 ? '\\\\' : s[i + 1];
        i += 2;
      }
      run = i;
    } else if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > run) out += s.slice(run, i);
        out += `<code>${bsOut(s.slice(i + 1, j))}</code>`;
        run = i = j + 1;
      } else i++;
    } else if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findDoubleStarE(s, i + 2);
        if (j > i + 2) {
          if (i > run) out += s.slice(run, i);
          out += `<strong>${inlineE(s.slice(i + 2, j), link)}</strong>`;
          run = i = j + 2;
        } else i += 2;
      } else {
        const j = findSingleStarE(s, i + 1);
        if (j > i + 1) {
          if (i > run) out += s.slice(run, i);
          out += `<em>${inlineE(s.slice(i + 1, j), link)}</em>`;
          run = i = j + 1;
        } else i++;
      }
    } else {
      // [
      const k = findCloseE(s, i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      let linked = false;
      if (m !== -1) {
        const te = s.slice(k + 2, m);
        const target = E_NEEDS_UNESC.test(te) ? unescE(te) : te;
        if (target !== '' && !hasWS(target)) {
          if (i > run) out += s.slice(run, i);
          const href = link(target);
          out += `<a href=\\"${href === target ? bsOut(te) : escHJ(href)}\\">${inlineE(s.slice(i + 1, k), link)}</a>`;
          run = i = m + 1;
          linked = true;
        }
      }
      if (!linked) i++;
    }
    E_MARK.lastIndex = i;
    if (!E_MARK.test(s)) break;
    i = E_MARK.lastIndex - 1;
  }
  if (run === 0) return s;
  return run < n ? out + s.slice(run) : out;
}

function allSpaces(l) {
  for (let i = 0, n = l.length; i < n; i++) if (l.charCodeAt(i) !== 32) return false;
  return true;
}

/** `l` from `a` on, spaces at either end dropped. */
function trimSp(l, a) {
  let b = l.length;
  while (a < b && l.charCodeAt(a) === 32) a++;
  while (b > a && l.charCodeAt(b - 1) === 32) b--;
  return a === 0 && b === l.length ? l : l.slice(a, b);
}

/** lib/markdown.js's renderMarkdown on an escaped-domain body `E` (no tab in it): { html, toc, excerpt }. */
function renderMarkdownE(E, link) {
  const lines = E.split('\\n');
  const nLines = lines.length;
  let ids = null;
  let html = '';
  const toc = [];
  let excerpt = null;
  let i = 0;
  let off = 0; // where lines[i] starts in E
  while (i < nLines) {
    const line = lines[i];
    const len = line.length;
    const c0 = len === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1 || (c0 === 32 && allSpaces(line))) {
      i++;
      off += len + 2;
      continue;
    }
    if (c0 === 96) {
      const m = FENCE_OPEN_E.exec(line);
      if (m !== null) {
        i++;
        off += len + 2;
        const start = off;
        let end = -1;
        while (i < nLines && !(lines[i].charCodeAt(0) === 96 && FENCE_CLOSE_E.test(lines[i]))) {
          end = off + lines[i].length;
          off = end + 2;
          i++;
        }
        const cls = m[1] === '' ? '' : ` class=\\"language-${m[1]}\\"`;
        html += end === -1 ? `<pre><code${cls}></code></pre>\\n` : `<pre><code${cls}>${bsOut(E.slice(start, end))}\\n</code></pre>\\n`;
        if (i < nLines) {
          off += lines[i].length + 2;
          i++;
        }
        continue;
      }
    }
    if (c0 === 35) {
      const m = HEADING_E.exec(line);
      if (m !== null && m[2] !== '') {
        const text = m[2];
        const depth = m[1].length;
        if (ids === null) ids = new Set();
        // Not remembered in the build's slug cache: its key, cut from this body, would keep the whole body alive.
        const id = uniqueSlug(slugifyRaw(E_NEEDS_UNESC.test(text) ? unescE(text) : text), ids);
        const h = inlineE(text, link);
        html += `<h${depth} id=\\"${id}\\">${h}</h${depth}>\\n`;
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html: jv(h) });
        i++;
        off += len + 2;
        continue;
      }
    }
    if ((c0 === 45 || c0 === 42) && HR_E.test(line)) {
      html += '<hr>\\n';
      i++;
      off += len + 2;
      continue;
    }
    if (c0 === 38 && line.startsWith('&gt;')) {
      let body = '';
      let any = false;
      while (i < nLines && lines[i].startsWith('&gt;')) {
        const l = lines[i];
        const t = trimSp(l, l.charCodeAt(4) === 32 ? 5 : 4);
        if (t !== '') {
          body = any ? `${body}\\n${t}` : t;
          any = true;
        }
        off += l.length + 2;
        i++;
      }
      html += any ? `<blockquote>\\n<p>${inlineE(body, link)}</p>\\n</blockquote>\\n` : '<blockquote>\\n</blockquote>\\n';
      continue;
    }
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      const bullet = (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32;
      const m = !bullet && c0 >= 48 && c0 <= 57 ? ORDERED_E.exec(line) : null;
      if (bullet || m !== null) {
        const ordered = !bullet;
        let items = '';
        let item = ordered ? trimSp(m[2], 0) : trimSp(line, 2);
        i++;
        off += len + 2;
        while (i < nLines) {
          const l = lines[i];
          const d0 = l.charCodeAt(0);
          let t = null;
          if (ordered) {
            if (d0 >= 48 && d0 <= 57) {
              const mm = ORDERED_E.exec(l);
              if (mm !== null) t = trimSp(mm[2], 0);
            }
          } else if ((d0 === 45 || d0 === 42) && l.charCodeAt(1) === 32) t = trimSp(l, 2);
          if (t !== null) {
            items += `<li>${inlineE(item, link)}</li>\\n`;
            item = t;
          } else if (d0 === 32 && l.charCodeAt(1) === 32 && !allSpaces(l)) item += `\\n${trimSp(l, 0)}`;
          else break;
          off += l.length + 2;
          i++;
        }
        items += `<li>${inlineE(item, link)}</li>\\n`;
        const start = ordered ? Number(m[1]) : 1;
        html += ordered ? (start !== 1 ? `<ol start=\\"${start}\\">\\n${items}</ol>\\n` : `<ol>\\n${items}</ol>\\n`) : `<ul>\\n${items}</ul>\\n`;
        continue;
      }
    }
    // A paragraph: its lines trimmed and joined by line breaks. While no line needs trimming where it meets the next,
    // that is one slice of E, its \n escapes already the answer's.
    let a = 0;
    let b = len;
    while (a < b && line.charCodeAt(a) === 32) a++;
    while (b > a && line.charCodeAt(b - 1) === 32) b--;
    const first = off + a;
    let endOff = off + b;
    let prevFull = b === len;
    let text = null;
    i++;
    off += len + 2;
    while (i < nLines) {
      const l = lines[i];
      const ll = l.length;
      if (ll === 0) break;
      const d0 = l.charCodeAt(0);
      if (d0 === 96) {
        if (FENCE_OPEN_E.test(l)) break;
      } else if (d0 === 35) {
        const mm = HEADING_E.exec(l);
        if (mm !== null && mm[2] !== '') break;
      } else if (d0 === 45 || d0 === 42) {
        if (HR_E.test(l)) break;
      } else if (d0 === 32 && allSpaces(l)) break;
      a = 0;
      b = ll;
      while (a < b && l.charCodeAt(a) === 32) a++;
      while (b > a && l.charCodeAt(b - 1) === 32) b--;
      if (text === null) {
        if (prevFull && a === 0) endOff = off + b;
        else text = `${E.slice(first, endOff)}\\n${l.slice(a, b)}`;
      } else text += `\\n${l.slice(a, b)}`;
      prevFull = b === ll;
      off += ll + 2;
      i++;
    }
    if (text === null) text = E.slice(first, endOff);
    const h = inlineE(text, link);
    if (excerpt === null) excerpt = h;
    html += `<p>${h}</p>\\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// A page's reading minutes are max(1, ceil(words / 200)), so the words need not be counted one by one: a sticky
// pattern steps over 200 words at a time, each with the whitespace after it (a space or the escape \n; a word must
// end at whitespace, so none is ever split), and whatever is left after the last full step is one more minute.
const LEAD_E = /(?: |\\n)*/y;
const WORDS200_E = /(?:[^ \\]+(?: |\\n)+){200}/y;

/** The reading minutes of an escaped-domain body `e` (its only whitespace spaces and \n escapes). */
function minutesE(e) {
  LEAD_E.lastIndex = 0;
  LEAD_E.test(e);
  let at = LEAD_E.lastIndex; // the first word's start, or the end
  let minutes = 0;
  WORDS200_E.lastIndex = at;
  while (WORDS200_E.test(e)) {
    minutes++;
    at = WORDS200_E.lastIndex;
  }
  if (at < e.length) minutes++;
  return minutes === 0 ? 1 : minutes;
}

// Where a JSON-escaped source's front matter ends, for the lines of lib/frontmatter.js's parseFrontMatter.
let FM_LINES = null;
let FM_BODY = '';

/**
 * The front matter of the JSON-escaped source `j` (its line ends already \n): null with FM_LINES its lines (decoded)
 * and FM_BODY its body (still escaped), or the reason lib/frontmatter.js refuses it before reading a line.
 */
function fmSplitJ(j) {
  const nl0 = nextNL(j, 0);
  if (!(j.startsWith('---') && (nl0 === 3 || (nl0 === -1 && j.length === 3)))) return 'no front matter';
  if (nl0 === -1) return 'the front matter is not closed';
  let pos = 5;
  for (;;) {
    const nl = nextNL(j, pos);
    const end = nl === -1 ? j.length : nl;
    if (end - pos === 3 && j.startsWith('---', pos)) {
      if (pos === 5) FM_LINES = [];
      else {
        const fm = j.slice(5, pos - 2);
        if (fm.indexOf('\\') === -1) {
          if (fm.indexOf('"') !== -1) throw FALLBACK;
          FM_LINES = fm.split('\n');
        } else {
          let raw;
          try {
            raw = JSON.parse(`"${fm}"`);
          } catch {
            throw FALLBACK;
          }
          FM_LINES = raw.split('\n');
        }
      }
      FM_BODY = nl === -1 ? '' : j.slice(nl + 2);
      return null;
    }
    if (nl === -1) return 'the front matter is not closed';
    pos = nl + 2;
  }
}

// ---------------------------------------------------------------- templates (lib/template.js's dialect)

const INCLUDE_DEPTH = 8;
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
const T_STANDALONE = /^[ \t]*$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = T_STANDALONE.test(src.slice(lineStart, open)) && T_STANDALONE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed (UTF-16 text, as lib/template.js reads it). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A parsed tree's text made byte-mode text (every name and path segment is ASCII by the grammar). */
function bytesTree(nodes) {
  for (const n of nodes) {
    if (n.kind === 'text') n.text = bytes(n.text);
    else if (n.kind === 'for') bytesTree(n.body);
    else if (n.kind === 'if') {
      bytesTree(n.then);
      if (n.else !== null) bytesTree(n.else);
    }
  }
  return nodes;
}

/** A value as text (template.js's textOf); a JSON-escaped value reads as its plain text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null || typeof v !== 'object') return '';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) out += k === 0 ? textOf(v[k]) : `, ${textOf(v[k])}`;
    return out;
  }
  return v[JV] !== undefined ? rawOf(v) : '';
}

/** How {{{ }}} writes a value: its text JSON-escaped (a JSON-escaped value as it is). */
function rawJ(v) {
  if (typeof v === 'string') return escJ(v);
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && v[JV] !== undefined) return v[JV];
  return escJ(textOf(v));
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v !== null && typeof v === 'object' && v[JV] !== undefined) return v[JV] !== '';
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function prop(v, k) {
  return v !== null && typeof v === 'object' && hasOwn(v, k) ? v[k] : undefined;
}

function walk(v, path, from) {
  for (let k = from; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

// A compiled piece is a string (constant, JSON-escaped) or a function (R, F) => string, where R is the render's root
// vars and F the frames of the loops that run at render time (F[slot] = { x, k, n }).

const loopOf = (k, n) => ({ index: k + 1, first: k === 0, last: k === n - 1, length: n });

/** The value `path` names in env: { known: true, value } or { known: false, get: (R, F) => value }. */
function resolve(env, path) {
  const first = path[0];
  for (let f = env.frames.length - 1; f >= 0; f--) {
    const fr = env.frames[f];
    if (first === 'loop') {
      if (fr.known) return { known: true, value: walk(loopOf(fr.k, fr.n), path, 1) };
      const slot = fr.slot;
      // A body that reads where its element stands in the loop is no function of the element alone.
      if (env.pure != null && env.pure.slot === slot) env.pure.ok = false;
      if (path.length === 1) return { known: false, get: (R, F) => loopOf(F[slot].k, F[slot].n) };
      const key = path[1];
      if (path.length > 2 || (key !== 'index' && key !== 'first' && key !== 'last' && key !== 'length')) return { known: true, value: undefined };
      if (key === 'index') return { known: false, get: (R, F) => F[slot].k + 1 };
      if (key === 'first') return { known: false, get: (R, F) => F[slot].k === 0 };
      if (key === 'last') return { known: false, get: (R, F) => F[slot].k === F[slot].n - 1 };
      return { known: false, get: (R, F) => F[slot].n };
    }
    if (first === fr.name) {
      if (fr.known) return { known: true, value: walk(fr.x, path, 1) };
      const slot = fr.slot;
      if (path.length === 1) return { known: false, get: (R, F) => F[slot].x };
      if (path.length === 2) {
        const k1 = path[1];
        return { known: false, get: (R, F) => prop(F[slot].x, k1) };
      }
      return { known: false, get: (R, F) => walk(F[slot].x, path, 1) };
    }
  }
  const root = hasOwn(env.roots, first) ? env.roots[first] : null;
  if (root === null) return { known: true, value: undefined };
  if (root.known) return { known: true, value: walk(root.value, path, 1) };
  if (env.pure != null) env.pure.ok = false;
  if (path.length === 1) return { known: false, get: (R) => R[first] };
  if (path.length === 2) {
    const k1 = path[1];
    return { known: false, get: (R) => prop(R[first], k1) };
  }
  if (path.length === 3) {
    const k1 = path[1];
    const k2 = path[2];
    return { known: false, get: (R) => prop(prop(R[first], k1), k2) };
  }
  return { known: false, get: (R) => walk(R[first], path, 1) };
}

/** Pieces joined into one piece: a string when every piece is one, else a function. */
function seq(pieces) {
  const out = [];
  for (const p of pieces) {
    if (typeof p === 'string') {
      if (p === '') continue;
      if (out.length > 0 && typeof out[out.length - 1] === 'string') out[out.length - 1] += p;
      else out.push(p);
    } else out.push(p);
  }
  if (out.length === 0) return '';
  if (out.length === 1) return out[0];
  if (out.length === 2) {
    const [a, b] = out;
    if (typeof a === 'string') return (R, F) => a + b(R, F);
    if (typeof b === 'string') return (R, F) => a(R, F) + b;
    return (R, F) => a(R, F) + b(R, F);
  }
  if (out.length === 3) {
    const [a, b, c] = out;
    if (typeof a === 'string' && typeof c === 'string') return (R, F) => a + b(R, F) + c;
    if (typeof b === 'string') return (R, F) => a(R, F) + b + c(R, F);
  }
  const n = out.length;
  return (R, F) => {
    let s = '';
    for (let k = 0; k < n; k++) {
      const p = out[k];
      s += typeof p === 'string' ? p : p(R, F);
    }
    return s;
  };
}

/** `nodes` compiled in env at include depth `depth` into one piece. */
function compileNodes(nodes, env, depth, templates) {
  const pieces = [];
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        pieces.push(escJ(n.text));
        break;
      case 'var':
      case 'raw': {
        const r = resolve(env, n.path);
        const raw = n.kind === 'raw';
        if (r.known) pieces.push(raw ? rawJ(r.value) : escHJ(textOf(r.value)));
        else {
          const get = r.get;
          pieces.push(raw ? (R, F) => rawJ(get(R, F)) : (R, F) => escVar(textOf(get(R, F))));
        }
        break;
      }
      case 'if': {
        const r = resolve(env, n.path);
        if (r.known) {
          const branch = truthy(r.value) !== n.not ? n.then : n.else;
          if (branch !== null) pieces.push(compileNodes(branch, env, depth, templates));
        } else {
          const get = r.get;
          const yes = compileNodes(n.then, env, depth, templates);
          const no = n.else === null ? '' : compileNodes(n.else, env, depth, templates);
          const t = n.not ? no : yes;
          const e = n.not ? yes : no;
          if (typeof t === 'string' && typeof e === 'string') pieces.push((R, F) => (truthy(get(R, F)) ? t : e));
          else if (typeof e === 'string') pieces.push((R, F) => (truthy(get(R, F)) ? t(R, F) : e));
          else if (typeof t === 'string') pieces.push((R, F) => (truthy(get(R, F)) ? t : e(R, F)));
          else pieces.push((R, F) => (truthy(get(R, F)) ? t(R, F) : e(R, F)));
        }
        break;
      }
      case 'for': {
        const r = resolve(env, n.path);
        if (r.known) {
          const xs = r.value;
          if (!Array.isArray(xs)) break;
          const len = xs.length;
          for (let k = 0; k < len; k++) {
            const frames = env.frames.concat([{ name: n.name, known: true, x: xs[k], k, n: len }]);
            pieces.push(compileNodes(n.body, { roots: env.roots, frames, memos: env.memos, pure: env.pure }, depth, templates));
          }
        } else {
          const get = r.get;
          const slot = env.frames.length;
          const frames = env.frames.concat([{ name: n.name, known: false, slot }]);
          // An outermost loop's body that reads nothing but its element (not its place in the loop, no value of the
          // page being rendered) writes the same text for the same element wherever it runs: a post's card on the
          // index and on each of its tags' pages. Such a body is rendered once an element and remembered (env.memos,
          // one build's; bodies are told apart by their source, their variable and the include depth).
          const memoable = slot === 0 && env.memos != null;
          const pure = memoable ? { ok: true, slot } : env.pure;
          let body = compileNodes(n.body, { roots: env.roots, frames, memos: env.memos, pure }, depth, templates);
          if (memoable && pure.ok && typeof body !== 'string') {
            const key = `${depth}\u0000${n.name}\u0000${JSON.stringify(n.body)}`;
            let memo = env.memos.get(key);
            if (memo === undefined) env.memos.set(key, (memo = new Map()));
            const fresh = body;
            body = (R, F) => {
              const x = F[0].x;
              let text = memo.get(x);
              if (text === undefined) {
                text = fresh(R, F);
                text.charCodeAt(0); // read once, so the pieces it was joined from are made one flat string
                memo.set(x, text);
              }
              return text;
            };
          }
          if (typeof body === 'string') {
            pieces.push((R, F) => {
              const xs = get(R, F);
              return Array.isArray(xs) ? body.repeat(xs.length) : '';
            });
          } else {
            pieces.push((R, F) => {
              const xs = get(R, F);
              if (!Array.isArray(xs)) return '';
              const len = xs.length;
              let fr = F[slot];
              if (fr === undefined) fr = F[slot] = { x: undefined, k: 0, n: 0 };
              let s = '';
              for (let k = 0; k < len; k++) {
                fr.x = xs[k];
                fr.k = k;
                fr.n = len;
                s += body(R, F);
              }
              return s;
            });
          }
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) pieces.push(compileNodes(t, env, depth + 1, templates));
        break;
      }
    }
  }
  return seq(pieces);
}

// ---------------------------------------------------------------- the build (index.js's pipeline)

const RESERVED = ['posts', 'tags', 'page'];
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const NON_ASCII = /[^\u0000-\u007f]/;

function resolvePath(dir, rel) {
  // The usual shape, without arrays: "../" some number of times, then plain names (none "", "." or "..").
  let p = 0;
  while (rel.charCodeAt(p) === 46 && rel.charCodeAt(p + 1) === 46 && rel.charCodeAt(p + 2) === 47) p += 3;
  const rest = p === 0 ? rel : rel.slice(p);
  const last = rest.charCodeAt(rest.length - 1);
  if (rest !== '' && rest.charCodeAt(0) !== 47 && last !== 47 && last !== 46 && rest.indexOf('//') === -1 && rest.indexOf('./') === -1) {
    let d = dir;
    let has = dir !== ''; // whether a part of dir is left to climb out of
    for (let k = p; k > 0; k -= 3) {
      if (!has) return null;
      const sl = d.lastIndexOf('/');
      if (sl === -1) {
        d = '';
        has = false;
      } else d = d.slice(0, sl);
    }
    return has ? `${d}/${rest}` : rest;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};

function resolveLink(target, dir, bySource, staticPaths, base) {
  if (SCHEME.test(target)) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
  if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
  return null;
}

/**
 * `xs` sorted by key(x) in UTF-16 code-unit order (the reference's order). A byte-mode string's bytes order as its
 * code points do, which is not always its code units' order, so there keys that are not ASCII are decoded to compare.
 */
function sortByKey(xs, key) {
  if (BYTE) {
    for (const x of xs) {
      if (NON_ASCII.test(key(x))) {
        const pairs = xs.map((y) => [chars(key(y)), y]);
        pairs.sort((p, q) => byCodeUnits(p[0], q[0]));
        return pairs.map((p) => p[1]);
      }
    }
  }
  return xs.sort((p, q) => byCodeUnits(key(p), key(q)));
}

const pathOfFile = (f) => f.path;
const itself = (x) => x;

/**
 * One site's output tree written as JSON text (an object of path -> text) through emit, in the current mode's strings.
 * `files` are { path, content } (decoded text), or with `esc` { path, j }: j the content still JSON-escaped, as
 * cases.json spells it (the fast path, byte mode only).
 */
function buildSite(siteIn, templatesIn, files, esc) {
  slugCache = new Map();
  dateCache = new Map();
  escMemo = new Map();

  // Templates, in code-unit order of their names; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(templatesIn).sort(byCodeUnits)) {
    const src = templatesIn[name];
    const decode = BYTE && NON_ASCII.test(src);
    try {
      const tree = parseTemplate(name, decode ? chars(src) : src);
      templates.set(name, decode ? bytesTree(tree) : tree);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(decode ? bytes(err.message) : err.message);
    }
  }
  const base = siteIn.base_url.replace(/\/+$/, '');

  // 1. Sources and statics, in code-unit order of their paths.
  const sorted = sortByKey(files.slice(), pathOfFile);
  const statics = [];
  const mds = [];
  for (const f of sorted) (f.path.endsWith('.md') ? mds : statics).push(f);
  if (esc) for (const f of statics) if (!cleanJ(f.j)) throw FALLBACK;

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const sources = [];
  for (const f of mds) {
    const s = { path: f.path, data: null, post: false, layout: '', slug: '', outDir: '', url: '', bodyJ: null, body: null, done: false, html: null, toc: null, excerpt: '', excerptJV: null, minutes: 0, wsrc: null, wkind: 0, tagRefs: null, newer: null, older: null };
    let fm;
    let j = null;
    if (esc) {
      j = f.j;
      // Line ends made \n (index.js's /\r\n?/g), with literal backslashes set aside so that only real \r escapes go.
      if (j.indexOf('\\r') !== -1) j = j.replace(PAIR_G, '\x01').replace(CR_G, '\\n').replace(BS1_G, '\\\\');
      const refused = fmSplitJ(j);
      fm = refused === null ? parseFmLines(FM_LINES) : { error: refused };
      s.bodyJ = FM_BODY;
    } else {
      const c = f.content;
      fm = parseFrontMatter(c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n'));
      s.body = fm.body;
    }
    let why = null;
    if ('error' in fm) why = `refused ${s.path}: ${fm.error}`;
    else {
      s.data = fm.data;
      s.post = s.path.startsWith('posts/');
      const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (own !== undefined) why = `refused ${s.path}: ${own}/ is the generator's own`;
      else if (s.post && !hasOwn(s.data, 'date')) why = `refused ${s.path}: a post needs a date`;
      else if (!templates.has(layout)) why = `refused ${s.path}: layout "${layout}" is no template that parses`;
      else if (s.data.draft === true) why = `draft ${s.path}`;
      else s.layout = layout;
    }
    if (why !== null) {
      report.push(why);
      // Its body is never rendered, so it is checked here to be one whole JSON string.
      if (esc && !cleanJ(j)) throw FALLBACK;
      continue;
    }
    sources.push(s);
  }

  // 3. Permalinks.
  const bySource = new Map();
  const taken = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) taken.set(dir, (set = new Set(dir === '' ? RESERVED : [])));
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved: each body is rendered when it is first needed, and dropped once its page is written.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  const minutesOf = (s) => {
    if (!s.done) renderSource(s);
    if (s.minutes === 0) {
      s.minutes = s.wkind === 1 ? minutesE(s.wsrc) : Math.max(1, Math.ceil(wordCount(s.wsrc) / 200));
      s.wsrc = null;
    }
    return s.minutes;
  };
  const renderSource = (s) => {
    s.done = true;
    const dir = dirOf(s.path);
    const src = s.path;
    const link = (target) => {
      const c = target.charCodeAt(0);
      if (c === 47 || c === 35) return target;
      const r = resolveLink(target, dir, bySource, staticPaths, base);
      if (r === null) {
        const line = `broken-link ${src} -> ${target}`;
        line.charCodeAt(0); // read once, so it is one flat string of its own and keeps no body alive
        broken.add(line);
        return target;
      }
      return r;
    };
    let md;
    if (esc) {
      const bj = s.bodyJ;
      s.bodyJ = null;
      // The body into the escaped domain, in one pass (one new string, where six replaces would make six).
      const e = bj.replace(TO_E_G, toE);
      if (e.indexOf('"') !== -1 || e.charCodeAt(e.length - 1) === 92) throw FALLBACK;
      if (ODD_UNIT.test(e)) {
        // An escape the fast path does not read (a tab, say): this body goes the decoded way.
        let raw;
        try {
          raw = JSON.parse(`"${bj}"`);
        } catch {
          throw FALLBACK;
        }
        md = renderMarkdown(raw, link);
        s.wsrc = raw;
        stats.slowDocs++;
      } else {
        BODY_HAS_BS = e.indexOf('\x01') !== -1;
        md = renderMarkdownE(e, link);
        s.wsrc = e;
        s.wkind = 1;
        stats.fastDocs++;
      }
    } else {
      md = renderMarkdown(s.body, link);
      s.wsrc = s.body;
      s.body = null;
    }
    s.html = md.html;
    s.toc = md.toc;
    // The excerpt outlives its page (the list pages show it), so it is copied out of the body's text: a string cut
    // from the body would keep the whole body alive with it.
    s.excerpt = md.excerpt === '' ? '' : ` ${md.excerpt}`.slice(1);
    if (s.post) minutesOf(s);
  };

  // 5. Posts, newest first then by slug.
  const posts = [];
  for (const s of sources) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const list = s.data.tags;
    if (list === undefined) return [];
    const seen = new Set();
    const out = [];
    for (const name of list) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) bySlug.set(slug, (tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }));
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const excerptOf = (s) => {
    if (!s.done) renderSource(s);
    return s.excerptJV ?? (s.excerptJV = jv(s.excerpt));
  };
  const cardOf = (s) => {
    const d = s.data;
    return {
      title: d.title,
      url: s.url,
      date: d.date ?? '',
      date_long: d.date === undefined ? '' : longDate(d.date),
      summary: d.summary ?? '',
      get excerpt() {
        return excerptOf(s);
      },
      get reading_minutes() {
        return minutesOf(s);
      },
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: siteIn.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, siteIn.recent).map((p) => cards.get(p));

  const known = (value) => ({ known: true, value });
  const dyn = { known: false };
  const constRoots = { site: known(site), tags: known(allTags), recent: known(recent) };
  const compiled = new Map();
  const memos = new Map();
  const compile = (name, kind) => {
    const key = `${kind}\u0000${name}`;
    let c = compiled.get(key);
    if (c === undefined) {
      const roots = { ...constRoots };
      if (kind === 'page') roots.page = dyn;
      else if (kind === 'index') {
        roots.posts = dyn;
        roots.pager = dyn;
      } else if (kind === 'tag') roots.tag = dyn;
      // The list pages (index, tag) share what their loops write for one post; a page's own loops run once each.
      c = compileNodes(templates.get(name), { roots, frames: [], memos: kind === 'page' ? null : memos, pure: null }, 0, templates);
      compiled.set(key, c);
    }
    return c;
  };
  const F = [];
  const render = (piece, R) => (typeof piece === 'string' ? piece : piece(R, F));

  const outKeys = new Set();
  let entries = 0;
  emit('{');
  const put = (key, jsonText) => {
    emit(entries++ === 0 ? `${JSON.stringify(key)}:"${jsonText}"` : `,${JSON.stringify(key)}:"${jsonText}"`);
    outKeys.add(key);
  };

  for (const s of sources) {
    if (!s.done) renderSource(s);
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: excerptOf(s),
      get reading_minutes() {
        return minutesOf(s);
      },
      tags: card.tags,
      slug: s.slug,
      content: jv(s.html),
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    put(`${s.outDir}/index.html`, render(compile(s.layout, 'page'), { page }));
    // The page is written: what only it reads is let go.
    s.html = null;
    s.toc = null;
    if (!s.post) s.wsrc = null;
  }
  const per = siteIn.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  if (templates.has('index')) {
    const piece = compile('index', 'index');
    for (let k = 1; k <= pages; k++) {
      const R = {
        posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      };
      put(k === 1 ? 'index.html' : `page/${k}/index.html`, render(piece, R));
    }
  }
  if (templates.has('tag')) {
    const piece = compile('tag', 'tag');
    for (const t of tagList) {
      const tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
      put(`tags/${t.slug}/index.html`, render(piece, { tag }));
    }
  }
  if (templates.has('tags')) put('tags/index.html', render(compile('tags', 'tags'), {}));
  for (const f of statics) {
    if (outKeys.has(f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else if (f.path !== 'build-report.txt') put(f.path, esc ? f.j : escJ(f.content));
    else outKeys.add(f.path);
  }

  // 8. The report.
  for (const b of broken) report.push(b);
  const lines = sortByKey(report, itself);
  let nPages = 0;
  for (const s of sources) if (!s.post) nPages++;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  emit(`${entries === 0 ? '' : ','}"build-report.txt":"${escJ(`${lines.join('\n')}\n`)}"}`);
}

/** One site's output tree from its decoded input (the reference's own shape). */
const buildJson = (input) => buildSite(input.site, input.templates, input.files, false);

// ---------------------------------------------------------------- where the answer's text goes

// Byte mode writes the answer through a small buffer, handed on each time it fills (WRITE(buffer, length)), so no
// more of the answer than that is ever held; the UTF-16 mode gathers it in OSTR.
const OCAP = 1 << 20;
let OBUF = null;
let OSIZE = 0;
let OLEN = 0;
let WRITE = null;
let OSTR = '';

function emitBytes(s) {
  const n = s.length;
  if (OLEN + n > OSIZE) {
    if (OLEN > 0) {
      WRITE(OBUF, OLEN);
      OLEN = 0;
    }
    if (n > OSIZE) {
      OSIZE = n + (n >> 1);
      OBUF = Buffer.allocUnsafe(OSIZE);
    }
  }
  OLEN += OBUF.latin1Write(s, OLEN, n);
}

function emitString(s) {
  OSTR += s;
}

let emit = emitString;

const LONE = /[\ud800-\udfff]/;

/**
 * Whether byte-mode text could read differently from the UTF-16 text: a \u escape (which JSON.parse would turn into
 * a real character), or Unicode whitespace or a line separator in UTF-8 (U+0085, U+00A0, U+1680, U+2000-U+200A,
 * U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF), which \s, trim() and . read as characters, not as bytes.
 */
function unsafeBytes(s) {
  if (s.indexOf('\\u') !== -1 || s.indexOf('\xc2\xa0') !== -1 || s.indexOf('\xc2\x85') !== -1 || s.indexOf('\xe1\x9a\x80') !== -1) return true;
  if (s.indexOf('\xe2\x81\x9f') !== -1 || s.indexOf('\xe3\x80\x80') !== -1 || s.indexOf('\xef\xbb\xbf') !== -1) return true;
  for (let k = s.indexOf('\xe2\x80'); k !== -1; k = s.indexOf('\xe2\x80', k + 2)) {
    const c = s.charCodeAt(k + 2);
    if ((c >= 0x80 && c <= 0x8a) || c === 0xa8 || c === 0xa9 || c === 0xaf) return true;
  }
  return false;
}

// The fast path reads cases.json as JSON.stringify writes it, token by token, and never parses the files:
//   [{"id":"…","input":{"site":{…},"templates":{…},"files":[{"path":"…","content":"…"},…]}},…]
// Each of these tokens holds a quote that follows a character other than a backslash, so none can lie inside a JSON
// string: wherever one is found, it is the document's own structure. Every string cut out between them is checked
// to be one whole string (cleanJ), so a document of any other shape is noticed, and built the decoded way instead.
const FILES_KEY = ',"files":[{"path":"';
const FILE_SEP = '"},{"path":"';
const CONTENT_KEY = '","content":"';
const CASE_SEP = '"}]}},{"';
const LAST_END = '"}]}}]';

/** Every case answered from `s`, cases.json as byte-mode text, through emit; FALLBACK when it is not shaped as above. */
function answerFast(s) {
  if (s.charCodeAt(0) !== 91) throw FALLBACK;
  let pos = 1;
  emit('[');
  for (;;) {
    const fk = s.indexOf(FILES_KEY, pos);
    if (fk === -1) throw FALLBACK;
    let input;
    try {
      input = JSON.parse(`${s.slice(pos, fk)}}}`).input;
    } catch {
      throw FALLBACK;
    }
    if (input === null || typeof input !== 'object' || input.site === null || typeof input.site !== 'object' || input.templates === null || typeof input.templates !== 'object') throw FALLBACK;
    const from = fk + FILES_KEY.length;
    let to = s.indexOf(CASE_SEP, from);
    const last = to === -1;
    if (last) {
      to = s.length - LAST_END.length;
      if (to < from || !s.endsWith(LAST_END)) throw FALLBACK;
    }
    const files = [];
    for (const part of s.slice(from, to).split(FILE_SEP)) {
      const c = part.indexOf(CONTENT_KEY);
      if (c === -1) throw FALLBACK;
      const pj = part.slice(0, c);
      let path = pj;
      if (pj.indexOf('\\') !== -1) {
        try {
          path = JSON.parse(`"${pj}"`);
        } catch {
          throw FALLBACK;
        }
      } else if (pj.indexOf('"') !== -1) throw FALLBACK;
      files.push({ path, j: part.slice(c + CONTENT_KEY.length) });
    }
    buildSite(input.site, input.templates, files, true);
    if (last) break;
    emit(',');
    pos = to + 6; // past "}]}}, at the next case's {
  }
  emit(']');
}

/**
 * Every case of cases.json answered. `buf` is the file's bytes; the answer's bytes go to write(buffer, length), a part
 * at a time, and restart() is called first if what was written so far is to be discarded (the output started anew).
 */
export function answerAll(buf, write, restart) {
  const s = buf.latin1Slice(0, buf.length);
  if (!unsafeBytes(s) && isUtf8(buf)) {
    BYTE = true;
    emit = emitBytes;
    WRITE = write;
    OSIZE = OCAP;
    OBUF = Buffer.allocUnsafe(OSIZE);
    OLEN = 0;
    try {
      answerFast(s);
    } catch (err) {
      if (err !== FALLBACK) throw err;
      // Not the shape the fast path reads: start the answer anew, every case parsed and built the decoded way.
      restart();
      stats.fallback++;
      OLEN = 0;
      const cases = JSON.parse(s);
      emit('[');
      for (let k = 0; k < cases.length; k++) {
        if (k > 0) emit(',');
        buildJson(cases[k].input);
      }
      emit(']');
    }
    if (OLEN > 0) write(OBUF, OLEN);
    OBUF = null;
    WRITE = null;
    return;
  }
  BYTE = false;
  emit = emitString;
  OSTR = '[';
  const cases = JSON.parse(buf.toString('utf8'));
  for (let k = 0; k < cases.length; k++) {
    if (k > 0) OSTR += ',';
    buildJson(cases[k].input);
  }
  let out = `${OSTR}]`;
  OSTR = '';
  if (LONE.test(out)) out = JSON.stringify(JSON.parse(out));
  const bytesOut = Buffer.from(out, 'utf8');
  write(bytesOut, bytesOut.length);
}

/** makefun-site 1.0.0's answer for one case's input (the module's contract). */
export function run(input) {
  BYTE = false;
  emit = emitString;
  OSTR = '';
  buildJson(input);
  const out = OSTR;
  OSTR = '';
  return JSON.parse(out);
}

export const build = run;
