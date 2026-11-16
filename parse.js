// parse.js — a dependency-free Markdown renderer whose parse(markdown) returns,
// byte for byte, the HTML that marked 18.1.3 produces with default options
// (gfm: true, breaks: false, pedantic: false).
//
// Structure: a line-oriented block lexer (containers — block quotes and list
// items — are collected as line ranges and lexed recursively, sharing one
// link-definition table), then an inline scanner per block whose emphasis is
// resolved with a delimiter-stack pass.

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
const isPunct = (ch) => ch !== undefined && PUNCT.has(ch);

// escape for text nodes: & < > " ' — bare & only (entity-shaped &..; sequences
// are split out by the scanner as raw nodes before this is applied).
function escapeText(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// escape for code spans / code blocks: everything, no entity pass-through.
const escapeCode = escapeText;

// escape for attribute values (href/title/alt): like text, but an & that
// already introduces an entity-shaped sequence is left alone.
function escapeAttr(s) {
  return s
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#[0-9]+;|#[xX][0-9a-fA-F]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// resolve backslash escapes: \ before ASCII punctuation yields that char.
function unescapeStr(s) {
  return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

// href post-processing: percent-encode like encodeURI, but never double-encode
// an existing %XX sequence.
function cleanHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return href;
  }
}

// decode a numeric character reference body; returns the string or null when
// the digit count is out of range (then it is not an entity at all).
function decodeNumeric(digits, hex) {
  if (hex ? digits.length > 6 : digits.length > 7) return null;
  const cp = parseInt(digits, hex ? 16 : 10);
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  return String.fromCodePoint(cp);
}

// ---------------------------------------------------------------------------
// column arithmetic (tab stops of 4)
// ---------------------------------------------------------------------------

function colAdvance(col, ch) {
  return ch === '\t' ? col + (4 - (col % 4)) : col + 1;
}

// visual column of the first non-blank character; -1 for blank lines.
function indentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col = colAdvance(col, ch);
    else return col;
  }
  return -1;
}

const isBlankLine = (line) => /^[ \t]*$/.test(line);

// remove up to n columns of leading indentation. The leading whitespace is
// first expanded to spaces in the line's own frame (tab stops shift when the
// frame origin moves, so tabs must not survive an indentation cut). Used
// for structural stripping (list items, lazy lines), where later column
// math must stay in the original frame.
function stripCols(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    col = colAdvance(col, line[i]);
    i++;
  }
  const expanded = ' '.repeat(col) + line.slice(i);
  let k = 0;
  while (k < expanded.length && k < n && expanded[k] === ' ') k++;
  return expanded.slice(k);
}

// fenced code content dedent: marked removes up to n leading whitespace
// CHARACTERS (a tab counts as one character and is removed whole), which
// differs from the column-based strip used for indented code (probed)
function stripFenceIndent(line, n) {
  let k = 0;
  while (k < line.length && k < n && (line[k] === ' ' || line[k] === '\t')) k++;
  return line.slice(k);
}

// like stripCols, but for code block content: whitespace lying wholly
// beyond the cut is preserved verbatim (marked keeps a tab there); only a
// tab straddling the cut leaves its remaining width as spaces.
function stripColsVerbatim(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n && (line[i] === ' ' || line[i] === '\t')) {
    const next = colAdvance(col, line[i]);
    if (next <= n) { col = next; i++; }
    else return ' '.repeat(next - n) + line.slice(i + 1);
  }
  return line.slice(i);
}

// track an open fenced code block across gathered container lines: given
// the current fence state (null or { ch, len }) and a stored content line,
// returns the new state.
function fenceTransition(fence, line) {
  const m = RE_FENCE.exec(line);
  if (!fence) {
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) return { ch: m[1][0], len: m[1].length };
    return null;
  }
  if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') return null;
  return fence;
}

// slice a line at a visual column: advances over ALL characters (each counts
// its tab-stop width); once the cut is reached, any following whitespace run
// is expanded to spaces in the original frame (its width would otherwise
// change in the new frame).
function sliceAtCol(line, target) {
  let col = 0;
  let i = 0;
  let out = '';
  while (i < line.length && col < target) {
    const next = colAdvance(col, line[i]);
    if (next <= target) { col = next; i++; }
    else { out += ' '.repeat(next - target); col = next; i++; }
  }
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    const next = colAdvance(col, line[i]);
    out += ' '.repeat(next - col);
    col = next;
    i++;
  }
  return out + line.slice(i);
}

// expand a leading tab partially: used when a fixed prefix (e.g. "> ") was
// removed and the next char is a tab — the tab's remaining width becomes
// spaces. widthBefore = columns the removed prefix occupied on screen.
function expandTabAfter(line, widthBefore) {
  if (line[0] !== '\t') return line;
  const next = colAdvance(widthBefore, '\t');
  return ' '.repeat(next - widthBefore) + line.slice(1);
}

// ---------------------------------------------------------------------------
// shared patterns
// ---------------------------------------------------------------------------

const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const RE_QUOTE = /^ {0,3}>/;
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// returns the HTML block type 1..7 a line starts, or 0.
function htmlBlockStart(line) {
  const m = /^ {0,3}<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(line);
  if (/^ {0,3}<!--/.test(line)) return 2;
  if (/^ {0,3}<\?/.test(line)) return 3;
  if (/^ {0,3}<![A-Z]/.test(line)) return 4;
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return 5;
  if (m) {
    const name = m[2].toLowerCase();
    const after = line.slice(m[0].length);
    if ((name === 'script' || name === 'pre' || name === 'style' || name === 'textarea') && m[1] === '') {
      if (/^[ \t>]/.test(after) || after === '') return 1;
    }
    if (BLOCK_TAGS.has(name)) {
      if (/^[ \t>]/.test(after) || after === '' || after.startsWith('/>')) return 6;
    }
    // type 7: a complete (strictly valid) tag alone on the line, not a block tag
    const t7 = matchTagStrict(line.replace(/^ {0,3}/, ''));
    if (t7 && /^[ \t]*$/.test(line.replace(/^ {0,3}/, '').slice(t7.raw.length))) return 7;
  }
  return 0;
}

// does this line interrupt a paragraph? (setext and table handled by caller)
// Inside list item content, marked lets an ordered marker with ANY start
// number interrupt the item's paragraph (at the top level and in quotes
// only "1" does).
function interruptsParagraph(line, inList) {
  if (RE_FENCE.test(line)) {
    const fm = RE_FENCE.exec(line);
    if (!(fm[1][0] === '`' && fm[2].includes('`'))) return true;
  }
  if (RE_ATX.test(line)) return true;
  if (RE_HR.test(line)) return true;
  if (RE_QUOTE.test(line)) return true;
  const ht = htmlBlockStart(line);
  if (ht >= 1 && ht <= 6) return true;
  const li = matchListItem(line);
  if (li && !li.blankContent) {
    if (!li.ordered || li.num === 1 || inList) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// list item marker recognition
// ---------------------------------------------------------------------------

// Returns null or { ordered, bullet, delim, num, markerCol, contentCol,
// contentText, blankContent }.
function matchListItem(line) {
  let i = 0;
  let col = 0;
  // up to 3 columns of indentation
  while (i < line.length && col < 3) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const next = colAdvance(col, ch);
      if (next > 3) return null;
      col = next; i++;
    } else break;
  }
  if (i >= line.length) return null;
  const ch = line[i];
  let ordered = false;
  let bullet = '';
  let delim = '';
  let num = 0;
  let markerWidth = 0;
  if (ch === '-' || ch === '+' || ch === '*') {
    bullet = ch;
    markerWidth = 1;
  } else if (ch >= '0' && ch <= '9') {
    let j = i;
    while (j < line.length && line[j] >= '0' && line[j] <= '9' && j - i < 9) j++;
    if (j === i || j >= line.length || (line[j] !== '.' && line[j] !== ')')) return null;
    if (j + 1 < line.length && line[j + 1] !== ' ' && line[j + 1] !== '\t') return null;
    ordered = true;
    delim = line[j];
    num = parseInt(line.slice(i, j), 10);
    markerWidth = j - i + 1;
    i = j;
  } else return null;
  i += ordered ? 1 : 1; // move past marker char(s): for bullet i was at marker
  // NOTE: for bullets i pointed at the marker; for ordered i pointed at delim.
  const markerEndCol = col + markerWidth;
  // scan whitespace after the marker (in columns)
  let ccol = markerEndCol;
  let k = i;
  let sawWs = false;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) {
    sawWs = true;
    ccol = colAdvance(ccol, line[k]);
    k++;
  }
  if (k >= line.length) {
    // blank item content
    return { ordered, bullet, delim, num, contentCol: markerEndCol + 1, contentText: '', blankContent: true };
  }
  if (!sawWs) return null;
  const wsCols = ccol - markerEndCol;
  const contentCol = wsCols >= 1 && wsCols <= 4 ? ccol : markerEndCol + 1;
  return { ordered, bullet, delim, num, contentCol, contentText: sliceAtCol(line, contentCol), blankContent: false };
}

function sameListType(a, b) {
  if (a.ordered !== b.ordered) return false;
  return a.ordered ? a.delim === b.delim : a.bullet === b.bullet;
}

// ---------------------------------------------------------------------------
// link reference definitions
// ---------------------------------------------------------------------------

function normalizeLabel(s) {
  // marked matches labels on their raw text (backslash escapes are NOT
  // resolved for matching), whitespace-collapsed and case-folded with
  // full folding for ß -> ss and final sigma -> sigma
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

// parse a title at the start of s; returns { title, rest } or null.
function parseTitleStr(s) {
  const open = s[0];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let i = 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === close) return { title: unescapeStr(s.slice(1, i)), rest: s.slice(i + 1) };
    if (open === '(' && ch === '(') return null;
    i++;
  }
  return null;
}

// Try to parse a link reference definition starting at lines[i].
// Works on a window of joined lines because titles (and the destination)
// may continue on the next line, and a quoted title may span lines.
// Returns { next, key, href, title } or null.
function parseDef(lines, i) {
  if (!/^ {0,3}\[/.test(lines[i])) return null;
  let end = i;
  while (end < lines.length && end < i + 40 && !isBlankLine(lines[end])) end++;
  const s = lines.slice(i, end).join('\n');
  const m = /^ {0,3}\[((?:\\.|[^\[\]\\])+)\]:/.exec(s);
  if (!m) return null;
  if (normalizeLabel(m[1]) === '') return null; // label must be non-empty once normalized
  let pos = m[0].length;
  // whitespace after the colon: spaces/tabs plus at most one newline
  while (s[pos] === ' ' || s[pos] === '\t') pos++;
  if (s[pos] === '\n') {
    pos++;
    while (s[pos] === ' ' || s[pos] === '\t') pos++;
    if (s[pos] === '\n') return null;
  }
  // destination
  let dest;
  if (s[pos] === '<') {
    let r = pos + 1;
    let found = -1;
    while (r < s.length) {
      if (s[r] === '\\') { r += 2; continue; }
      if (s[r] === '>') { found = r; break; }
      if (s[r] === '\n') return null;
      r++;
    }
    if (found < 0) return null;
    dest = s.slice(pos + 1, found);
    pos = found + 1;
  } else {
    const dm = /^[^\s]+/.exec(s.slice(pos));
    if (!dm) return null;
    dest = dm[0];
    pos += dm[0].length;
  }
  const afterDest = pos;
  // optional title: must be preceded by whitespace (spaces/tabs on the same
  // line, or a single newline); after it, only spaces/tabs to the line end.
  let p2 = pos;
  let sawNl = false;
  while (s[p2] === ' ' || s[p2] === '\t') p2++;
  if (s[p2] === '\n') {
    sawNl = true;
    p2++;
    while (s[p2] === ' ' || s[p2] === '\t') p2++;
  }
  let title = null;
  let endPos = -1;
  if (p2 > afterDest && (s[p2] === '"' || s[p2] === "'" || s[p2] === '(')) {
    const t = parseTitleStr(s.slice(p2));
    if (t) {
      let p3 = p2 + (s.slice(p2).length - t.rest.length);
      let p4 = p3;
      while (s[p4] === ' ' || s[p4] === '\t') p4++;
      if (p4 >= s.length || s[p4] === '\n') {
        title = t.title;
        endPos = p4;
      }
    }
    if (endPos < 0 && !sawNl) return null; // junk after dest on its own line
  }
  if (endPos < 0) {
    // no title: the rest of the destination's line must be blank
    let p4 = afterDest;
    while (s[p4] === ' ' || s[p4] === '\t') p4++;
    if (p4 < s.length && s[p4] !== '\n') return null;
    endPos = afterDest;
  }
  const consumed = s.slice(0, endPos).split('\n').length;
  return { next: i + consumed, key: normalizeLabel(m[1]), href: unescapeStr(dest), title };
}

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------

// split a table row into raw cells on unescaped pipes (escapes preserved).
function splitRow(line) {
  let s = line.replace(/^[ \t]+|[ \t]+$/g, '');
  if (s[0] === '|') s = s.slice(1);
  if (s[s.length - 1] === '|' && s[s.length - 2] !== '\\') s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; } // \| is a literal pipe in the cell text
    if (ch === '\\' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

const splitCells = (line) => splitRow(line).map((c) => c.trim());

function isDelimRow(line) {
  if (!line.includes('-')) return false;
  const cells = splitCells(line);
  return cells.length >= 1 && cells.every((c) => /^:?-+:?$/.test(c));
}

function tableStartAt(lines, i) {
  if (i + 1 >= lines.length) return false;
  const header = lines[i];
  const delim = lines[i + 1];
  if (!header.includes('|') && !delim.includes('|')) return false;
  if (isBlankLine(header) || !isDelimRow(delim)) return false;
  const hc = splitCells(header);
  const dc = splitCells(delim);
  return hc.length === dc.length && hc.length >= 1;
}

function buildTable(lines, headerIdx, state, eofNl) {
  const header = splitCells(lines[headerIdx]);
  const delim = splitCells(lines[headerIdx + 1]);
  const align = delim.map((c) => {
    const l = c[0] === ':';
    const r = c[c.length - 1] === ':';
    return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
  });
  const rows = [];
  let j = headerIdx + 2;
  while (j < lines.length) {
    const L = lines[j];
    // a whitespace-only line that contains a tab is an empty row in
    // marked, not the end of the table — unless it is the last line of
    // the block (no trailing newline in the source)
    if (isBlankLine(L) && (!L.includes('\t') || (j === lines.length - 1 && !eofNl))) break;
    // a list item line always ends the table in marked, pipes or not
    if (RE_ATX.test(L) || RE_FENCE.test(L) || RE_HR.test(L) || RE_QUOTE.test(L) || htmlBlockStart(L) > 0 || matchListItem(L)) break;
    let cells = splitCells(L);
    if (cells.length > header.length) cells = cells.slice(0, header.length);
    while (cells.length < header.length) cells.push('');
    rows.push(cells);
    j++;
  }
  return { node: { t: 'table', header, align, rows }, next: j };
}

// ---------------------------------------------------------------------------
// block lexer
// ---------------------------------------------------------------------------

// does a block list end inside an open paragraph (for laziness checks)?
function endsInPara(blocks) {
  if (!blocks.length) return false;
  const last = blocks[blocks.length - 1];
  if (last.t === 'para') return true;
  if (last.t === 'quote') return endsInPara(last.blocks);
  if (last.t === 'list' && last.items.length) return endsInPara(last.items[last.items.length - 1].blocks);
  return false;
}

// Can L continue a paragraph that is open inside a container? (lazy line)
function isLazyLine(innerLines, L, state) {
  if (isBlankLine(L)) return false;
  if (!innerLines.length) return false;
  if (isBlankLine(innerLines[innerLines.length - 1])) return false;
  if (interruptsParagraph(L)) return false;
  return endsInPara(lexBlocks(innerLines, state, false));
}

function lexQuote(lines, i, state, eofNl) {
  const qlines = [];
  const lazyForce = new Set(); // qlines indices that must continue the open paragraph
  let fence = null; // open fenced code block inside the quote content
  let j = i;
  let lazyRun = 0; // consecutive lazy lines since the last marker line
  while (j < lines.length) {
    const L = lines[j];
    const qm = /^ {0,3}>/.exec(L);
    if (qm) {
      // marker width in columns: leading spaces + '>' + one optional space
      // (or one column of a following tab).
      let width = qm[0].length;
      const rest = L.slice(qm[0].length);
      if (rest[0] === ' ' || rest[0] === '\t') width += 1;
      const content = sliceAtCol(L, width);
      qlines.push(content);
      fence = fenceTransition(fence, content);
      lazyRun = 0;
      j++;
    } else if (isBlankLine(L)) break;
    else if (isLazyLine(qlines, L, state)) {
      let lazy = L;
      if (lazyRun === 0) {
        if (indentCols(lazy) >= 4) {
          // an indented lazy line continues the paragraph as plain text,
          // even though its stripped form might look like a new block
          lazy = stripCols(lazy, 4);
          lazyForce.add(qlines.length);
        }
      } else if (RE_SETEXT.test(lazy)) {
        lazy = '    ' + lazy;
      }
      qlines.push(lazy);
      lazyRun++;
      j++;
    }
    else break;
  }
  return { node: { t: 'quote', blocks: lexBlocks(qlines, state, false, lazyForce) }, next: j };
}

function lexList(lines, i, state, eofNl) {
  const first = matchListItem(lines[i]);
  // a line that is a thematic break is never a list item (breaks win ties)
  const itemAt = (line) => (RE_HR.test(line) ? null : matchListItem(line));
  const items = [];
  let loose = false;
  let j = i;
  let listDone = false;
  while (j < lines.length && !listDone) {
    const m = j === i ? first : itemAt(lines[j]);
    if (!m || !sameListType(m, first)) break;
    const contentCol = m.contentCol;
    const itemLines = [m.contentText];
    j++;
    let fence = fenceTransition(null, m.contentText); // open fence inside this item
    // marked absorbs under-indented fence content only when the fence's
    // first content line was captured at full item indentation ("anchored");
    // if the first content line is under-indented the item ends instead
    let fenceAnchor = false;
    let itemDone = false;
    while (j < lines.length && !itemDone) {
      const L = lines[j];
      if (isBlankLine(L)) {
        let k = j;
        while (k < lines.length && isBlankLine(lines[k])) k++;
        const blanks = k - j;
        if (fence && k < lines.length && indentCols(lines[k]) >= contentCol) {
          // blank lines inside an open fence are fence content when the
          // item resumes at full indentation after them; an
          // under-indented next line ends the item instead, leaving the
          // fence unterminated inside it (probed, extra-cases)
          for (let b = 0; b < blanks; b++) itemLines.push('');
          j = k;
          continue;
        }
        if (k >= lines.length) { j = k; itemDone = true; listDone = true; break; }
        const NL = lines[k];
        const nm = itemAt(NL);
        if (nm && sameListType(nm, first) && indentCols(NL) < contentCol) {
          // a blank line before the next item separates the items:
          // the list is loose but continues, however many blanks came
          loose = true; j = k; itemDone = true;
          break;
        }
        // an item whose content so far is entirely blank ends here,
        // together with the list; following content belongs outside.
        // (leave j on the first blank line so the caller can see the
        // blank separator between this list and what follows)
        if (itemLines.every((x) => isBlankLine(x))) { itemDone = true; listDone = true; break; }
        if (indentCols(NL) >= contentCol) {
          // indented content continues the item across any number of
          // blank lines; keep every blank so indented code blocks see
          // the true gap
          for (let b = 0; b < blanks; b++) itemLines.push('');
          j = k;
          continue;
        }
        itemDone = true; listDone = true; break;
      }
      if (indentCols(L) >= contentCol) {
        const stored = stripCols(L, contentCol);
        itemLines.push(stored);
        if (fence) fenceAnchor = true; // full-indent content line anchors the fence
        fence = fenceTransition(fence, stored);
        if (!fence) fenceAnchor = false;
        j++; continue;
      }
      const nm = itemAt(L);
      if (nm) {
        itemDone = true;
        if (!sameListType(nm, first)) listDone = true;
        break;
      }
      if (fence && fenceAnchor) {
        // an anchored open fence absorbs lines that lack the item indentation
        const stored = stripCols(L, Math.min(indentCols(L), contentCol));
        itemLines.push(stored);
        fence = fenceTransition(fence, stored);
        if (!fence) fenceAnchor = false;
        j++; continue;
      }
      if (isLazyLine(itemLines, L, state)) { itemLines.push(L); j++; continue; }
      itemDone = true; listDone = true; break;
    }
    while (itemLines.length && itemLines[itemLines.length - 1] === '') itemLines.pop();
    const itemMeta = {};
    const blocks = lexBlocks(itemLines, state, false, null, { listCtx: true, meta: itemMeta });
    // an item whose own top-level blocks are blank-separated loosens the list
    if (itemMeta.blankBetween) loose = true;
    let task = null;
    if (blocks.length && blocks[0].t === 'para') {
      const tm = /^\[([ xX])\] /.exec(blocks[0].text);
      if (tm) {
        task = { checked: tm[1] !== ' ' };
        blocks[0] = { ...blocks[0], text: blocks[0].text.slice(tm[0].length) };
      }
    }
    items.push({ blocks, task });
  }
  return { node: { t: 'list', ordered: first.ordered, start: first.num, loose, items }, next: j };
}

function lexBlocks(lines, state, eofNl, lazyForce, opts) {
  const nodes = [];
  const listCtx = !!(opts && opts.listCtx);
  const meta = opts && opts.meta;
  let pendingBlank = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { if (nodes.length) pendingBlank = true; i++; continue; }
    if (pendingBlank) {
      // a blank line sits between two blocks at this level
      if (meta) meta.blankBetween = true;
      pendingBlank = false;
    }
    // fenced code
    const fm = RE_FENCE.exec(line);
    if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) {
      const ch = fm[1][0];
      const len = fm[1].length;
      // marked dedents backtick-fence content by the opener's indent,
      // but tilde-fence content is kept verbatim (probed)
      const indent = ch === '`' ? line.indexOf(fm[1]) : 0;
      const info = fm[2].trim();
      const content = [];
      let j = i + 1;
      while (j < lines.length) {
        const cm = RE_FENCE.exec(lines[j]);
        if (cm && cm[1][0] === ch && cm[1].length >= len && cm[2].trim() === '') { j++; break; }
        content.push(stripFenceIndent(lines[j], indent));
        j++;
      }
      // marked drops exactly one trailing newline from fenced content,
      // then the text still ends with a newline whenever it is non-empty
      const ftext = content.length ? content.join('\n') : '';
      nodes.push({ t: 'code', text: ftext === '' || ftext.endsWith('\n') ? ftext : ftext + '\n', lang: info ? unescapeStr(info.split(/\s+/)[0]) : null });
      i = j;
      continue;
    }
    // ATX heading
    const am = RE_ATX.exec(line);
    if (am) {
      let text = am[2] ?? '';
      if (/^#+[ \t]*$/.test(text)) text = '';
      else text = text.replace(/[ \t]+#+[ \t]*$/, '').replace(/^[ \t]+|[ \t]+$/g, '');
      nodes.push({ t: 'heading', level: am[1].length, text });
      i++;
      continue;
    }
    // thematic break
    if (RE_HR.test(line)) { nodes.push({ t: 'hr' }); i++; continue; }
    // block quote
    if (RE_QUOTE.test(line)) {
      const r = lexQuote(lines, i, state, eofNl);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    // list
    if (matchListItem(line)) {
      const r = lexList(lines, i, state, eofNl);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    // HTML block
    const ht = htmlBlockStart(line);
    if (ht > 0) {
      const consumed = [];
      let j = i;
      if (ht >= 6) {
        while (j < lines.length && !isBlankLine(lines[j])) { consumed.push(lines[j]); j++; }
      } else {
        const name = (/<(script|pre|style|textarea)/i.exec(line) || [])[1];
        const term = ht === 1 ? new RegExp('</' + name + '(?=[\\s>]|$)', 'i')
          : ht === 2 ? /-->/ : ht === 3 ? /\?>/ : ht === 4 ? />/ : /\]\]>/;
        while (j < lines.length) {
          consumed.push(lines[j]);
          j++;
          if (term.test(consumed[consumed.length - 1])) break;
        }
      }
      // trailing newline: kinds 1-5 (terminator-ended) keep it whenever a
      // further line exists in this context, even a whitespace-only one;
      // kinds 6-7 (blank-ended) keep it only at a newline-terminated end
      const keepNl = ht <= 5
        ? (j < lines.length && lines[j] !== '') || (j >= lines.length && eofNl)
        : j >= lines.length && eofNl;
      const text = consumed.join('\n') + (keepNl ? '\n' : '');
      nodes.push({ t: 'html', text });
      i = j;
      continue;
    }
    // link reference definitions (one or more)
    let d = parseDef(lines, i);
    if (d) {
      while (d) {
        if (!state.defs.has(d.key)) state.defs.set(d.key, { href: d.href, title: d.title });
        i = d.next;
        d = i < lines.length ? parseDef(lines, i) : null;
      }
      continue;
    }
    // table
    if (tableStartAt(lines, i)) {
      const r = buildTable(lines, i, state, eofNl);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    // indented code
    if (indentCols(line) >= 4) {
      const content = [];
      let j = i;
      while (j < lines.length) {
        const L = lines[j];
        if (isBlankLine(L)) {
          let k = j;
          while (k < lines.length && isBlankLine(lines[k])) k++;
          if (k < lines.length && indentCols(lines[k]) >= 4) {
            for (let b = j; b < k; b++) content.push(stripColsVerbatim(lines[b], 4));
            j = k;
            continue;
          }
          break;
        }
        if (indentCols(L) >= 4) { content.push(stripColsVerbatim(L, 4)); j++; continue; }
        break;
      }
      nodes.push({ t: 'code', text: content.join('\n') + '\n', lang: null });
      i = j;
      continue;
    }
    // paragraph / setext heading
    const plines = [line];
    let j = i + 1;
    let headingLevel = 0;
    let tableNode = null;
    while (j < lines.length) {
      const L = lines[j];
      if (isBlankLine(L)) {
        // a whitespace-only final line of a context without a trailing
        // newline is absorbed into the paragraph text (only when it
        // actually contains spaces/tabs; a truly empty line is not)
        if (j === lines.length - 1 && !eofNl && /^[ \t]+$/.test(L)) { plines.push(L); j++; }
        break;
      }
      if (RE_SETEXT.test(L)) { headingLevel = L.trim()[0] === '=' ? 1 : 2; j++; break; }
      if (tableStartAt(lines, j)) break;
      if (isDelimRow(L)) {
        const last = plines[plines.length - 1];
        if (splitCells(last).length === splitCells(L).length && (last.includes('|') || L.includes('|'))) {
          const headerLine = plines.pop();
          const saved = lines[j - 1];
          lines[j - 1] = headerLine;
          const r = buildTable(lines, j - 1, state, eofNl);
          lines[j - 1] = saved;
          tableNode = r.node;
          j = r.next;
          break;
        }
      }
      if (interruptsParagraph(L, listCtx) && !(lazyForce && lazyForce.has(j))) break;
      if (listCtx) {
        // marked folds a list item's paragraph continuation lines back
        // by whole tab stops: the leading indent is taken mod 4
        const ind = indentCols(L);
        if (ind >= 4) { plines.push(' '.repeat(ind % 4) + stripCols(L, ind)); j++; continue; }
      }
      plines.push(L);
      j++;
    }
    if (headingLevel) {
      nodes.push({ t: 'heading', level: headingLevel, text: plines.join('\n').replace(/^[ \t]+|[ \t]+$/g, '') });
    } else {
      if (plines.length) nodes.push({ t: 'para', text: plines.join('\n') });
      if (tableNode) nodes.push(tableNode);
    }
    i = j;
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// inline parsing
// ---------------------------------------------------------------------------

const WS_CHAR = /\s/;

// Strict CommonMark tag grammar starting at s[0] === '<' (s is the rest of
// the text). Returns { raw, name } or null. Closing tags take no attributes;
// attribute values are quoted (no escape processing) or unquoted.
function matchTagStrict(s) {
  let i = 1;
  let closing = false;
  if (s[1] === '/') { closing = true; i = 2; }
  const nm = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(s.slice(i));
  if (!nm) return null;
  const name = nm[0].toLowerCase();
  i += nm[0].length;
  if (closing) {
    const tail = /^[ \t\n]*>/.exec(s.slice(i));
    return tail ? { raw: s.slice(0, i + tail[0].length), name } : null;
  }
  while (i < s.length) {
    const ws = /^[ \t\n]+/.exec(s.slice(i));
    if (!ws) break;
    const save = i;
    i += ws[0].length;
    const am = /^[a-zA-Z_:][a-zA-Z0-9_.:-]*/.exec(s.slice(i));
    if (!am) { i = save; break; }
    i += am[0].length;
    const eq = /^[ \t\n]*=[ \t\n]*/.exec(s.slice(i));
    if (eq) {
      i += eq[0].length;
      const q = s[i];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, i + 1);
        if (close < 0) return null;
        i = close + 1;
      } else {
        const vm = /^[^ \t\n"'=<>`]+/.exec(s.slice(i));
        if (!vm) return null;
        i += vm[0].length;
      }
    }
  }
  const tail = /^[ \t\n]*\/?>/.exec(s.slice(i));
  return tail ? { raw: s.slice(0, i + tail[0].length), name } : null;
}

// match an inline HTML tag/comment/etc. at text[i] === '<'.
// returns { raw, name } (name '' for comments/declarations) or null.
function matchInlineTag(text, i) {
  const s = text.slice(i);
  if (s.startsWith('<!--')) {
    // abrupt closings are complete comments in marked
    if (s.startsWith('<!-->')) return { raw: '<!-->', name: '' };
    if (s.startsWith('<!--->')) return { raw: '<!--->', name: '' };
    const e = s.indexOf('-->', 4);
    return e >= 0 ? { raw: s.slice(0, e + 3), name: '' } : null;
  }
  if (s.startsWith('<![CDATA[')) {
    const e = s.indexOf(']]>', 9);
    return e >= 0 ? { raw: s.slice(0, e + 3), name: '' } : null;
  }
  if (s.startsWith('<?')) {
    const e = s.indexOf('?>', 2);
    return e >= 0 ? { raw: s.slice(0, e + 2), name: '' } : null;
  }
  if (/^<![A-Z]/.test(s)) {
    const e = s.indexOf('>', 2);
    return e >= 0 ? { raw: s.slice(0, e + 1), name: '' } : null;
  }
  return matchTagStrict(s);
}

function flanking(ch, prev, next) {
  const isWs = (c) => c === '' || WS_CHAR.test(c);
  // CommonMark "Unicode punctuation" = general categories P and S.
  const isP = (c) => c !== '' && /[\p{P}\p{S}]/u.test(c);
  const left = !isWs(next) && (!isP(next) || isWs(prev) || isP(prev));
  const right = !isWs(prev) && (!isP(prev) || isWs(next) || isP(next));
  if (ch === '*') return { canOpen: left, canClose: right };
  return {
    canOpen: left && (!right || isP(prev)),
    canClose: right && (!left || isP(next)),
  };
}

// find the end of a bracketed label starting at text[i] === '[' (bracket
// counting with backslash escapes). Backtick runs toggle a simplified
// code-span state: brackets seen while inside a span do not count, and an
// unclosed span swallows the rest (no label end).
// returns the index of the matching ']' or -1.
function findLabelEnd(text, i) {
  let depth = 0;
  let j = i;
  let inSpan = false;
  let lastRunLen = 0; // length of the backtick run just consumed (0 if none)
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') { lastRunLen = 0; j += 2; continue; }
    if (ch === '`') {
      let run = 1;
      while (text[j + run] === '`') run++;
      inSpan = !inSpan;
      lastRunLen = run;
      j += run;
      continue;
    }
    if (inSpan && ch === ']' && depth === 1 && lastRunLen >= 2) {
      // fitted to marked: a ']' immediately after a backtick run of
      // length >= 2 ends the label even when the toggle state is "in span"
      return j;
    }
    lastRunLen = 0;
    if (!inSpan) {
      if (ch === '<') {
        // skip over a tag / comment / autolink construct: brackets in
        // its interior (including quoted attribute values) do not count
        const rest = text.slice(j);
        const tag = matchInlineTag(text, j);
        if (tag) { j += tag.raw.length; continue; }
        const au = /^<[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*>/.exec(rest) ||
          /^<[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+>/.exec(rest);
        if (au) { j += au[0].length; continue; }
      }
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) return j; }
    }
    j++;
  }
  return -1;
}

// skip whitespace inside ( ... ) of an inline link; -1 if a blank line is met.
function skipLinkWs(text, q) {
  while (q < text.length && WS_CHAR.test(text[q])) {
    if (text[q] === '\n') {
      let r = q + 1;
      while (r < text.length && (text[r] === ' ' || text[r] === '\t')) r++;
      if (text[r] === '\n') return -1;
    }
    q++;
  }
  return q;
}

// parse "(dest "title")" starting at text[p] === '('. returns { href, title, end }.
function parseInlineDest(text, p) {
  let q = skipLinkWs(text, p + 1);
  if (q < 0) return null;
  let dest;
  let angleDest = false;
  if (text[q] === '<') {
    angleDest = true;
    let r = q + 1;
    let found = -1;
    while (r < text.length) {
      const ch = text[r];
      if (ch === '\\') { r += 2; continue; }
      if (ch === '>') { found = r; break; }
      if (ch === '\n') return null;
      r++;
    }
    if (found < 0) return null;
    dest = text.slice(q + 1, found);
    q = found + 1;
  } else {
    let depth = 0;
    let r = q;
    while (r < text.length) {
      const ch = text[r];
      if (ch === '\\') { r += 2; continue; }
      if (ch === '(') { depth++; r++; continue; }
      if (ch === ')') { if (depth === 0) break; depth--; r++; continue; }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch < ' ') break;
      r++;
    }
    dest = text.slice(q, r);
    q = r;
  }
  const preTitleQ = q;
  q = skipLinkWs(text, q);
  if (q < 0) return null;
  let title = null;
  const tc = text[q];
  if (tc === '"' || tc === "'" || tc === '(') {
    // after an angle destination, a title must be separated by whitespace
    if (angleDest && q === preTitleQ) return null;
    const t = parseTitleStr(text.slice(q));
    if (!t) return null;
    title = t.title;
    q += text.slice(q).length - t.rest.length;
    q = skipLinkWs(text, q);
    if (q < 0) return null;
  }
  if (text[q] !== ')') return null;
  return { href: unescapeStr(dest), title, end: q + 1 };
}

// Try to parse a link (isImage=false) or image (isImage=true) whose '[' is at
// index i of text. Returns { node, end } or null.
function tryLink(text, i, state, isImage) {
  const labelEnd = findLabelEnd(text, i);
  if (labelEnd < 0) return null;
  const label = text.slice(i + 1, labelEnd);
  const p = labelEnd + 1;
  const makeNode = (href, title, end) => {
    const kids = tokenizeInline(label, state, false, true);
    if (!isImage && kids.sawLink) return null;
    processEmphasis(kids.nodes, label);
    const node = isImage
      ? { k: 'image', href, title, kids: kids.nodes }
      : { k: 'link', href, title, kids: kids.nodes };
    return { node, end };
  };
  if (text[p] === '(') {
    const inl = parseInlineDest(text, p);
    if (inl) {
      const r = makeNode(inl.href, inl.title, inl.end);
      if (r) return r;
    }
  }
  if (text[p] === '[') {
    let q = p + 1;
    let end2 = -1;
    while (q < text.length) {
      const ch = text[q];
      if (ch === '\\') { q += 2; continue; }
      if (ch === '[') break;
      if (ch === ']') { end2 = q; break; }
      q++;
    }
    if (end2 >= 0) {
      const refLabel = text.slice(p + 1, end2);
      const rkey = normalizeLabel(refLabel === '' ? label : refLabel);
      const def = rkey === '' ? undefined : state.defs.get(rkey);
      if (def) return makeNode(def.href, def.title, end2 + 1);
      return null;
    }
  }
  if (label !== '') {
    const lkey = normalizeLabel(label);
    const def = lkey === '' ? undefined : state.defs.get(lkey);
    if (def) return makeNode(def.href, def.title, labelEnd + 1);
  }
  return null;
}

const URL_BOUNDARY = (text, i) => i === 0 || !/[A-Za-z0-9]/.test(text[i - 1]);

function matchUrl(text, i, isWww) {
  // marked consumes a '(' only as a balanced, whitespace-free group; an
  // unbalanced or space-containing group ends the URL just before the '('
  let j = i;
  const groups = []; // [start, end) spans of consumed paren groups, url-relative
  while (j < text.length) {
    const ch = text[j];
    if (/[\s<]/.test(ch)) break;
    if (ch === '(') {
      let depth = 0;
      let k = j;
      let ok = false;
      while (k < text.length) {
        const c2 = text[k];
        if (/[\s<]/.test(c2)) break;
        if (c2 === '(') depth++;
        else if (c2 === ')') { depth--; if (depth === 0) { ok = true; k++; break; } }
        k++;
      }
      if (!ok) break;
      groups.push([j - i, k - i]);
      j = k;
      continue;
    }
    j++;
  }
  let url = text.slice(i, j);
  // the part after the scheme / www. must contain a dot in the domain portion
  const rest = isWww ? url.slice(4) : url.replace(/^https?:\/\//i, '');
  const domain = rest.split(/[/?#]/)[0];
  if (!domain.includes('.')) return null;
  let changed = true;
  while (changed && url.length) {
    changed = false;
    const last = url[url.length - 1];
    if (last === ';') {
      // a trailing &entity; is shaved whole; any other trailing ';' is
      // shaved as punctuation
      const em = /&[a-zA-Z][a-zA-Z0-9]*;$/.exec(url);
      if (em) { url = url.slice(0, url.length - em[0].length); changed = true; continue; }
      url = url.slice(0, -1); changed = true; continue;
    }
    if ('?!.,:*_~'.includes(last)) { url = url.slice(0, -1); changed = true; continue; }
    if (last === ')') {
      // a trailing ')' that belongs to a consumed balanced group is never
      // shaved; any other trailing ')' is shaved while parens are unbalanced
      const inGroup = groups.some(([s, e]) => url.length - 1 >= s && url.length - 1 < e);
      if (!inGroup) {
        const opens = (url.match(/\(/g) || []).length;
        const closes = (url.match(/\)/g) || []).length;
        if (closes > opens) { url = url.slice(0, -1); changed = true; continue; }
      }
    }
  }
  if (url === (isWww ? 'www' : '') || url.length <= (isWww ? 4 : 7)) return null;
  return { node: { k: 'url', href: isWww ? 'http://' + url : url, text: url }, end: i + url.length };
}

// Extended-autolink email at text[i]: local part, '@', dot-separated domain
// labels (letters/digits/'-'/'_'), at least one dot. The final label must
// end in a letter or digit: trailing labels that end in '-' or '_' are
// dropped, and if that removes the last dot the address is invalid.
function matchEmailAt(text, i, hasUndOpener) {
  const m = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+/.exec(text.slice(i));
  if (!m) return null;
  let s = m[0];
  let end = i + s.length;
  // a trailing run of underscores that closes an earlier emphasis span is
  // a delimiter, not part of the domain: the address ends before it
  if (hasUndOpener) {
    const um = /_+$/.exec(s);
    if (um && um.index > s.indexOf('@')) {
      const cand = s.slice(0, um.index);
      if (/[A-Za-z0-9]$/.test(cand) && cand.slice(cand.indexOf('@') + 1).includes('.')) {
        return { text: cand, end: end - um[0].length };
      }
    }
  }
  while (s.endsWith('-') || s.endsWith('_')) {
    const dom = s.slice(s.indexOf('@') + 1);
    const cut = dom.lastIndexOf('.');
    if (cut < 0) return null;
    const drop = dom.length - cut;
    s = s.slice(0, s.length - drop);
    end -= drop;
  }
  if (!s.slice(s.indexOf('@') + 1).includes('.')) return null;
  const nx = text[end];
  if (nx !== undefined && /[A-Za-z0-9_-]/.test(nx)) return null;
  return { text: s, end };
}

// mailto:/xmpp: scheme autolinks (lowercase schemes only). xmpp allows one
// optional /resource made of letters, digits, '@' and '.', trailing dots
// trimmed; an empty resource drops the slash too.
function matchSchemeEmail(text, i) {
  let scheme = null;
  if (text.startsWith('mailto:', i)) scheme = 'mailto:';
  else if (text.startsWith('xmpp:', i)) scheme = 'xmpp:';
  if (!scheme) return null;
  const em = matchEmailAt(text, i + scheme.length);
  if (!em) return null;
  let end = em.end;
  if (scheme === 'xmpp:' && text[end] === '/') {
    const rm = /^[A-Za-z0-9@.]+/.exec(text.slice(end + 1));
    if (rm) {
      const res = rm[0].replace(/\.+$/, '');
      if (res) end = end + 1 + res.length;
    }
  }
  return { text: text.slice(i, end), end };
}

// Loose label end for the broken-span check: plain bracket-depth scan
// (findLabelEnd's code-span rules reject labels this check still needs).
function findLabelEndLoose(text, i) {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return j; }
    j++;
  }
  return -1;
}

// A "broken span" in a failed link's label: a code span of run length >= 2
// whose content itself contains a backtick run, with label text after it.
// marked suppresses all emphasis inside such a label (probed).
function labelBrokenSpan(label) {
  for (const r of maskRegions(label)) {
    if (r.ol < 2) continue;
    if (r.e >= label.length) continue;
    if (label.slice(r.s + r.ol, r.e - r.cl).includes('`')) return true;
  }
  return false;
}

function tokenizeInline(text, state, inLink, suppressAutolink) {
  const nodes = [];
  let sawLink = false;
  const suppRegions = [];
  let buf = '';
  const flush = () => { if (buf) { nodes.push({ k: 'text', v: buf }); buf = ''; } };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        flush(); nodes.push({ k: 'br' }); i += 2;
        while (text[i] === ' ' || text[i] === '\t') i++; // marked drops the next line's indent after a hard break
        continue;
      }
      if (nx !== undefined && isPunct(nx)) { buf += nx; i += 2; continue; }
      buf += '\\'; i++; continue;
    }
    if (c === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      let j = i + run;
      let found = -1;
      while (j < n) {
        if (text[j] === '`') {
          let r2 = 1;
          while (text[j + r2] === '`') r2++;
          if (r2 === run) { found = j; break; }
          j += r2;
        } else j++;
      }
      if (found >= 0) {
        let content = text.slice(i + run, found).replace(/\n/g, ' ');
        if (content.length > 1 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        flush();
        nodes.push({ k: 'code', v: content });
        i = found + run;
        continue;
      }
      buf += '`'.repeat(run);
      i += run;
      continue;
    }
    if (c === '<') {
      let m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/.exec(text.slice(i));
      if (m) { flush(); nodes.push({ k: 'autolink', href: m[1], text: m[1] }); i += m[0].length; continue; }
      m = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)>/.exec(text.slice(i));
      if (m) { flush(); nodes.push({ k: 'autolink', href: 'mailto:' + m[1], text: m[1] }); i += m[0].length; continue; }
      const tag = matchInlineTag(text, i);
      if (tag) {
        flush(); nodes.push({ k: 'html', v: tag.raw });
        // marked keeps a document-level inLink flag in its inline lexer:
        // an opening <a> tag token sets it, </a> clears it, and while set
        // no extended autolinks are produced anywhere later in the document
        if (/^<a(?=[\s>])/i.test(tag.raw)) state.inLinkDoc = true;
        else if (/^<\/a\s*>$/i.test(tag.raw)) state.inLinkDoc = false;
        i += tag.raw.length;
        continue;
      }
      buf += '<'; i++; continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      const img = tryLink(text, i + 1, state, true);
      if (img) { flush(); nodes.push(img.node); i = img.end; continue; }
      buf += '!'; i++; continue;
    }
    if (c === '[') {
      if (!inLink) {
        const lnk = tryLink(text, i, state, false);
        if (lnk) { flush(); nodes.push(lnk.node); sawLink = true; i = lnk.end; continue; }
        // failed [...](...) whose label holds a broken span: marked
        // suppresses emphasis throughout that label
        const le = findLabelEndLoose(text, i);
        if (le > 0 && text[le + 1] === '(' && labelBrokenSpan(text.slice(i + 1, le))) {
          suppRegions.push([i + 1, le]);
        }
      }
      buf += '['; i++; continue;
    }
    if (c === '*' || c === '_') {
      let run = 1;
      while (text[i + run] === c) run++;
      const prev = i === 0 ? '' : text[i - 1];
      const next = i + run >= n ? '' : text[i + run];
      const f = flanking(c, prev, next);
      // marked deviation from CommonMark: a delimiter run cannot close
      // when the character before it is a non-word character and the
      // character after it is a word character (letters/digits)
      const isWord = (ch) => ch !== '' && /[\p{L}\p{N}]/u.test(ch);
      const canClose = f.canClose && (isWord(prev) || !isWord(next));
      flush();
      nodes.push({
        k: 'delim', ch: c, len: run, origLen: run, pos: i, canOpen: f.canOpen, canClose, dead: false,
        supp: suppRegions.some(([s, e]) => i >= s && i < e),
      });
      i += run;
      continue;
    }
    if (c === '~') {
      let run = 1;
      while (text[i + run] === '~') run++;
      if (run > 2) { buf += '~'.repeat(run); i += run; continue; }
      const prev = i === 0 ? '' : text[i - 1];
      const next = i + run >= n ? '' : text[i + run];
      flush();
      nodes.push({
        k: 'delim', ch: '~', len: run, origLen: run, pos: i,
        canOpen: next !== '' && !WS_CHAR.test(next),
        canClose: prev !== '' && !WS_CHAR.test(prev),
        dead: false,
      });
      i += run;
      continue;
    }
    if (c === '&') {
      let m = /^&#([0-9]+);/.exec(text.slice(i));
      if (m) { const d = decodeNumeric(m[1], false); if (d !== null) { buf += d; i += m[0].length; continue; } }
      m = /^&#[xX]([0-9a-fA-F]+);/.exec(text.slice(i));
      if (m) { const d = decodeNumeric(m[1], true); if (d !== null) { buf += d; i += m[0].length; continue; } }
      m = /^&[a-zA-Z][a-zA-Z0-9]*;/.exec(text.slice(i));
      if (m) { flush(); nodes.push({ k: 'raw', v: m[0] }); i += m[0].length; continue; }
      buf += '&'; i++; continue;
    }
    if (c === '\n') {
      if (buf.endsWith('  ')) {
        buf = buf.replace(/ +$/, '');
        flush();
        nodes.push({ k: 'br' });
        i++;
        while (text[i] === ' ' || text[i] === '\t') i++; // next line's indent is dropped after a hard break
        continue;
      }
      buf += '\n'; i++; continue;
    }
    // extended autolinks in plain text (suppressed inside link text and
    // while the document-level inLink flag is set by an unclosed <a> tag)
    const noAuto = suppressAutolink || state.inLinkDoc;
    if (!noAuto && (c === 'h' || c === 'H') && URL_BOUNDARY(text, i) && /^https?:\/\//i.test(text.slice(i, i + 8))) {
      const u = matchUrl(text, i, false);
      if (u) { flush(); nodes.push(u.node); i = u.end; continue; }
    }
    if (!noAuto && c === 'w' && URL_BOUNDARY(text, i) && text.startsWith('www.', i)) {
      const u = matchUrl(text, i, true);
      if (u) { flush(); nodes.push(u.node); i = u.end; continue; }
    }
    if (!noAuto && (c === 'm' || c === 'x') && (i === 0 || !/[A-Za-z0-9]/.test(text[i - 1]))) {
      const sm = matchSchemeEmail(text, i);
      if (sm) { flush(); nodes.push({ k: 'url', href: sm.text, text: sm.text }); i = sm.end; continue; }
    }
    if (!noAuto && /[A-Za-z0-9]/.test(c) && (i === 0 || !/[A-Za-z0-9._%+\-]/.test(text[i - 1]))) {
      const hasUndOpener = nodes.some((nd) => nd.k === 'delim' && nd.ch === '_' && nd.canOpen);
      const em = matchEmailAt(text, i, hasUndOpener);
      if (em) { flush(); nodes.push({ k: 'url', href: 'mailto:' + em.text, text: em.text }); i = em.end; continue; }
    }
    buf += c;
    i++;
  }
  flush();
  return { nodes, sawLink };
}

// marked's emphasis matching works on a masked copy of the text where code
// spans are blanked out. The mask pairs backtick runs by matching length
// over the raw text (ignoring link structure), so a run inside a link label
// can pair with a run much later in the block, forming a phantom region.
// An emphasis whose closing delimiter falls inside such a region cannot
// match in marked. Returns [{s, e, ol, cl}] (region start/end and the
// opening/closing run lengths).
function maskRegions(text) {
  // Mirror the tokenizer's own scan: in normal text a backslash escape
  // consumes the next char (an escaped backtick never opens a span), but
  // the search for a span's closing run is purely textual, so an escaped
  // backtick can still close a span.
  const regions = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      let j = i + run;
      let closeEnd = -1;
      while (j < n) {
        if (text[j] === '`') {
          let r2 = 1;
          while (text[j + r2] === '`') r2++;
          if (r2 === run) { closeEnd = j + r2; break; }
          j += r2;
        } else j++;
      }
      if (closeEnd >= 0) {
        regions.push({ s: i, e: closeEnd, ol: run, cl: run });
        i = closeEnd;
      } else {
        i += run;
      }
      continue;
    }
    i++;
  }
  return regions;
}

// marked emphasis poisoning (asterisk family only; probed against marked):
// a candidate pairing is vetoed when the span between opener and closer
// contains an already-formed emphasis unit U of the same '*' family such
// that U's closing delimiter is a standalone run of exactly U's use length
// and the character right after that run is a word character (letter or
// digit). Opposite-kind units (em inside strong, strong inside em) always
// veto; same-kind units veto only when the opener run is longer than the
// use being consumed. A veto is lifted for U when U's "stretch" can reach
// a valid end: either a fully unconsumed '*' run of exactly U's use length
// later inside the span and followed by a non-word character, or the
// pairing's own closer run supplying U's use length worth of stars (those
// stars then render literally at the end of the formed content, which the
// caller performs via the returned take count).
const WORD_CHAR = /[\p{L}\p{N}]/u;
function poisonVeto(nodes, opener, closer, use, text) {
  const oIdx = nodes.indexOf(opener);
  const cIdx = nodes.indexOf(closer);
  const pairKind = use === 2 ? 'strong' : 'em';
  let take = 0;
  for (let j = oIdx + 1; j < cIdx; j++) {
    const u = nodes[j];
    if (u.k !== 'em' && u.k !== 'strong') continue;
    if (u.uCh !== '*') continue;
    if (u.uCloseRunLen !== u.uUse) continue;
    const after = text[u.uCloseRunEnd];
    if (after === undefined || !WORD_CHAR.test(after)) continue;
    // a unit whose opener run is glued to a preceding word character
    // (intraword, e.g. *foo**bar**baz*) never poisons
    const before = text[u.uOpenPos - 1];
    if (before !== undefined && WORD_CHAR.test(before)) continue;
    // u is poisoned; does it veto this pairing?
    if (u.k === pairKind && opener.len <= use) continue;
    // the closer run itself can end the stretch (preferred end)
    if (closer.len - use - take >= u.uUse) { if (take === 0) take = u.uUse; continue; }
    // look for a rescue run after u inside the span
    let rescued = false;
    for (let m = j + 1; m < cIdx; m++) {
      const d = nodes[m];
      if (d.k !== 'delim' || d.ch !== '*') continue;
      if (d.len !== d.origLen || d.origLen !== u.uUse) continue;
      const da = text[d.pos + d.origLen];
      if (da === undefined || !WORD_CHAR.test(da)) { rescued = true; break; }
    }
    if (!rescued) return { veto: true, take: 0 };
  }
  return { veto: false, take };
}

// CommonMark delimiter-stack emphasis resolution, extended with marked's
// strikethrough: '~' runs (length 1 or 2) pair opener/closer of exactly the
// same length, in the same document-order pass so del and emphasis nest
// inside each other correctly.
function processEmphasis(nodes, text) {
  const delims = nodes.filter((nd) => nd.k === 'delim');
  const regions = text.includes('`') ? maskRegions(text) : null;
  const inMask = (pos) => regions !== null &&
    regions.some((r) => pos > r.s && pos < r.e);
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (closer.dead || !closer.canClose) continue;
    if (closer.supp) continue;
    // a closer inside a masked code region cannot match in marked
    if (closer.ch !== '~' && inMask(closer.pos)) continue;
    if (closer.ch === '~') {
      if (closer.len === 0) continue;
      let oi = -1;
      for (let k = ci - 1; k >= 0; k--) {
        const op = delims[k];
        if (op.dead || op.len === 0 || !op.canOpen || op.ch !== '~') continue;
        if (op.len !== closer.len) continue;
        oi = k;
        break;
      }
      if (oi < 0) continue;
      const opener = delims[oi];
      opener.len = 0;
      closer.len = 0;
      const oIdx = nodes.indexOf(opener);
      const cIdx = nodes.indexOf(closer);
      const inner = nodes.splice(oIdx + 1, cIdx - oIdx - 1);
      nodes.splice(oIdx + 1, 0, { k: 'del', kids: inner });
      for (let d = oi + 1; d < ci; d++) delims[d].dead = true;
      continue;
    }
    while (closer.len > 0) {
      let oi = -1;
      let use = 0;
      let take = 0;
      for (let k = ci - 1; k >= 0; k--) {
        const op = delims[k];
        if (op.dead || op.supp || op.len === 0 || !op.canOpen || op.ch !== closer.ch) continue;
        if ((op.canClose || closer.canOpen) &&
            (op.len + closer.len) % 3 === 0 &&
            !(op.len % 3 === 0 && closer.len % 3 === 0)) continue;
        const u = op.len >= 2 && closer.len >= 2 ? 2 : 1;
        if (closer.ch === '*') {
          const pv = poisonVeto(nodes, op, closer, u, text);
          if (pv.veto) continue;
          take = pv.take;
        }
        oi = k;
        use = u;
        break;
      }
      if (oi < 0) break;
      const opener = delims[oi];
      opener.len -= use;
      closer.len -= use;
      const oIdx = nodes.indexOf(opener);
      const cIdx = nodes.indexOf(closer);
      const inner = nodes.splice(oIdx + 1, cIdx - oIdx - 1);
      if (take > 0) {
        // stars the closer run lent to a poisoned unit's stretch render
        // literally at the end of the formed content
        inner.push({ k: 'text', v: '*'.repeat(take) });
        closer.len -= take;
      }
      nodes.splice(oIdx + 1, 0, {
        k: use === 2 ? 'strong' : 'em', kids: inner,
        uCh: closer.ch, uUse: use, uOpenPos: opener.pos,
        uCloseRunEnd: closer.pos + closer.origLen, uCloseRunLen: closer.origLen,
      });
      for (let d = oi + 1; d < ci; d++) delims[d].dead = true;
    }
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text': case 'raw': case 'code': out += nd.v; break;
      case 'delim': out += nd.ch.repeat(nd.len); break;
      case 'autolink': case 'url': out += nd.text; break;
      case 'em': case 'strong': case 'del': case 'link': case 'image': out += plainText(nd.kids); break;
      default: break;
    }
  }
  return out;
}

function renderNodes(nodes, state) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text': out += escapeText(nd.v); break;
      case 'raw': out += nd.v; break;
      case 'code': out += '<code>' + escapeCode(nd.v) + '</code>'; break;
      case 'html': out += nd.v; break;
      case 'br': out += '<br>'; break;
      case 'delim': out += nd.ch.repeat(nd.len); break;
      case 'em': out += '<em>' + renderNodes(nd.kids, state) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(nd.kids, state) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(nd.kids, state) + '</del>'; break;
      case 'link':
        out += '<a href="' + escapeAttr(cleanHref(nd.href)) + '"' +
          (nd.title !== null ? ' title="' + escapeAttr(nd.title) + '"' : '') + '>' +
          renderNodes(nd.kids, state) + '</a>';
        break;
      case 'image':
        out += '<img src="' + escapeAttr(cleanHref(nd.href)) + '" alt="' + escapeAttr(plainText(nd.kids)) + '"' +
          (nd.title !== null ? ' title="' + escapeAttr(nd.title) + '"' : '') + '>';
        break;
      case 'autolink':
        out += '<a href="' + escapeAttr(cleanHref(nd.href)) + '">' + escapeText(nd.text) + '</a>';
        break;
      case 'url':
        out += '<a href="' + escapeAttr(cleanHref(nd.href)) + '">' + escapeText(nd.text) + '</a>';
        break;
    }
  }
  return out;
}

function renderInline(text, state) {
  const { nodes } = tokenizeInline(text, state, false);
  processEmphasis(nodes, text);
  return renderNodes(nodes, state);
}

function renderBlock(b, state) {
  switch (b.t) {
    case 'heading': return `<h${b.level}>${renderInline(b.text, state)}</h${b.level}>\n`;
    case 'para': return `<p>${renderInline(b.text, state)}</p>\n`;
    case 'code':
      return '<pre><code' + (b.lang ? ` class="language-${escapeAttr(b.lang)}"` : '') + '>' +
        escapeCode(b.text) + '</code></pre>\n';
    case 'html': return b.text;
    case 'hr': return '<hr>\n';
    case 'quote': return '<blockquote>\n' + renderBlocks(b.blocks, state) + '</blockquote>\n';
    case 'list': {
      let out = b.ordered
        ? (b.start !== 1 ? `<ol start="${b.start}">\n` : '<ol>\n')
        : '<ul>\n';
      for (const item of b.items) {
        out += '<li>';
        item.blocks.forEach((blk, bi) => {
          if (blk.t === 'para' && !b.loose) {
            if (bi === 0 && item.task) {
              out += (item.task.checked
                ? '<input checked="" disabled="" type="checkbox"> '
                : '<input disabled="" type="checkbox"> ');
            }
            out += renderInline(blk.text, state);
          } else if (blk.t === 'para' && item.task && bi === 0) {
            out += '<p>' + (item.task.checked
              ? '<input checked="" disabled="" type="checkbox"> '
              : '<input disabled="" type="checkbox"> ') +
              renderInline(blk.text, state) + '</p>\n';
          } else {
            out += renderBlock(blk, state);
          }
        });
        out += '</li>\n';
      }
      out += b.ordered ? '</ol>\n' : '</ul>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      b.header.forEach((cell, ci) => {
        out += '<th' + (b.align[ci] ? ` align="${b.align[ci]}"` : '') + '>' + renderInline(cell, state) + '</th>\n';
      });
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          row.forEach((cell, ci) => {
            out += '<td' + (b.align[ci] ? ` align="${b.align[ci]}"` : '') + '>' + renderInline(cell, state) + '</td>\n';
          });
          out += '</tr>\n';
        }
        out += '</tbody></table>\n';
      } else {
        out += '</table>\n';
      }
      return out;
    }
  }
  return '';
}

function renderBlocks(blocks, state) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, state);
  return out;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function parse(src) {
  src = src.replace(/\r\n?/g, '\n');
  const state = { defs: new Map(), inLinkDoc: false };
  const eofNl = src.endsWith('\n');
  const lines = src.split('\n');
  if (eofNl) lines.pop();
  const blocks = lexBlocks(lines, state, eofNl);
  return renderBlocks(blocks, state);
}
