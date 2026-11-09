// Room windows: one GBrain page holding several messages of one scope.
//
// S3 found that GBrain's durable write path costs about 0.3 s a page whatever its size,
// so one page per message backfilled three messages a second, and compaction rewrote
// every message at the same rate. A window is one page for up to 32 messages of one
// scope (a room, or the owner's private scope), written together:
//
//  - It carries its scope's page type, so a room's audience is still fenced inside
//    GBrain's own query by the `types` filter.
//  - Every message in it is a segment, introduced by a marker line that names the object
//    and its revision. A message is found again by its marker, never by its position, so
//    a page and Atum's state that disagree (after a crash or a restore) can't attribute
//    one message's text to another.
//  - It stays small enough to be one chunk of GBrain's index (the chunker keeps a body
//    of up to 300 words, 6,000 characters and 2,000 tokens whole), so a search hit on a
//    window carries all of it, and the messages that match the question are picked out
//    of it here. A message too long for any window gets a window of its own, which may be
//    several chunks, as every message was in S3.
//
// Message text is escaped so that nothing in it is read as a marker or as GBrain page
// structure (escapeText). Nothing here touches GBrain or the ledger: these are pure
// functions of text.

import { createHash } from 'node:crypto';

export const MARK = '⁣'; // INVISIBLE SEPARATOR: a line starting with it is a marker
export const ESCAPE = '⁠'; // WORD JOINER: the escape character (see escapeText)

export const WINDOW_MAX_MEMBERS = 32;
// UTF-8 bytes of the body: a token is at least a byte, so this keeps a window under
// GBrain's 2,000-token and 6,000-character chunk caps with room to spare.
export const WINDOW_MAX_BYTES = 1_800;
// GBrain's chunker keeps a body of up to 300 words (counted as it counts them) as one chunk.
export const WINDOW_MAX_WORDS = 280;

const SEGMENT_ID = /^[0-9a-f]{20}$/;
// Lines GBrain reads as page structure (checked on each line of the message as sent):
//  - the timeline sentinels and headings (parseMarkdown's splitBody), which would move the
//    rest of the page into its timeline;
//  - code fences (fence-scan and the markdown chunker), which add chunks of their own.
// `\s` and `trim()` agree in JavaScript, so a line GBrain trims to one of these matches
// here too. `<!-- timeline -->` is also broken by the inline escape of `<!`.
// Legacy structure prefixes must not begin with the current e/m/s escape tokens;
// preserve this decoding invariant if expanding the recognized structure forms.
const STRUCTURE_LINE = /^\s*(<!--\s*timeline\s*-->|---\s+timeline\s+---|##\s+(timeline|history)\b.*)\s*$|^[ \t]{0,3}(```|~~~)/i;
// GBrain splits lines on any of these (its fence scanner does), so every one of them
// starts a line for the structure check.
const LINE_BREAK = /(\r\n|\r|\n)/;
// GBrain's chunker counts characters, not words, when CJK script dominates (cjk.ts).
const CJK = /[一-鿿぀-ゟ゠-ヿ가-힯]/g;
const CJK_DENSITY = 0.3;

/** The marker of one object's revision: 80 bits of SHA-256, never reused for another. */
export function segmentId(objectKey, revision) {
  return createHash('sha256').update(`segment\u0000${objectKey}\u0000${revision}`).digest('hex').slice(0, 20);
}

/**
 * Escape a message's text for a window. A complete encoded segment is exactly
 * reversible with unescapeText. A search-result fragment can split an escape token, so
 * fragment decoding is not promised lossless; the boundary guarantee is that it cannot
 * expose user text as a segment marker:
 *  - the escape character and marker each use a safe escape token. In particular, an
 *    encoded message contains no marker character at all: if GBrain splits an oversized
 *    page immediately after an escape prefix, the following chunk cannot turn user text
 *    into a segment marker;
 *  - `<!` becomes `<`, escape, `!`: GBrain's facts and takes fences
 *    (`<!--- gbrain:facts:begin -->`, which fail the whole page when they don't parse) and
 *    its timeline sentinel are HTML comments, and none can appear;
 *  - a line GBrain would read as structure (STRUCTURE_LINE) is prefixed with the escape.
 * NUL becomes U+FFFD (PostgreSQL text can't hold it; GBrain strips it anyway).
 */
export function escapeText(text) {
  const parts = String(text).replace(/\u0000/g, '�').split(LINE_BREAK);
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const escaped = line
      .replaceAll(ESCAPE, `${ESCAPE}e`)
      .replaceAll(MARK, `${ESCAPE}m`)
      .replace(/<!/g, `<${ESCAPE}!`);
    parts[i] = STRUCTURE_LINE.test(line) ? `${ESCAPE}s${escaped}` : escaped;
  }
  return parts.join('');
}

/**
 * Decode the current safe tokens, while accepting the older prefix encoding so a page
 * written before this repair remains readable. The legacy form is not emitted again.
 */
export function unescapeText(text) {
  return String(text).replace(/⁠([\s\S]?)/g, (_match, next) => {
    if (next === 'e') return ESCAPE;
    if (next === 'm') return MARK;
    if (next === 's') return '';
    return next;
  });
}

/**
 * A window's page: frontmatter with its scope's type, then each segment as a marker line
 * and the escaped text, then a bare marker that ends the last segment (so trimming the
 * body never trims a message).
 */
export function windowPage({ slug, type, segments }) {
  const body = segments.map(({ id, text }) => `${MARK}${id}\n${escapeText(text)}`).join('\n');
  return `---\ntitle: ${slug.slice(slug.lastIndexOf('/') + 1)}\ntype: ${type}\n---\n${body}\n${MARK}\n`;
}

/**
 * The segments in a window's body or in one chunk of it: [{ id, text, complete }]. A
 * segment is complete when its end is in the text (the next marker, or the closing
 * one); lines before the first marker (a chunk that starts inside a segment) belong to
 * no segment.
 */
export function parseWindow(body) {
  const segments = [];
  let current = null;
  const close = (complete) => {
    if (current) segments.push({ id: current.id, text: unescapeText(current.lines.join('\n')), complete });
    current = null;
  };
  for (const line of String(body).split('\n')) {
    if (line.startsWith(MARK)) {
      close(true);
      const id = line.slice(MARK.length);
      if (SEGMENT_ID.test(id)) current = { id, lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  close(false);
  return segments;
}

/**
 * The text of a chunk that has no marker at all: a later chunk of a window made for one
 * long message. Marker lines (the closing one) are dropped, and the rest unescaped.
 */
export function unmarkedText(chunk) {
  return unescapeText(String(chunk).split('\n').filter((line) => !line.startsWith(MARK)).join('\n'));
}

// ------------------------------------------------------------------------- measuring

/**
 * What one segment adds to its window's body, as GBrain measures a chunk: UTF-8 bytes,
 * whitespace-separated words, non-whitespace characters and CJK characters. Counts only;
 * the ledger keeps these, never the text.
 */
export function measureSegment(text) {
  const line = `${MARK}${'0'.repeat(20)}\n${escapeText(text)}\n`;
  return {
    bytes: Buffer.byteLength(line, 'utf8'),
    words: (line.match(/\S+/g) ?? []).length,
    chars: line.replace(/\s/g, '').length,
    cjk: (line.match(CJK) ?? []).length,
  };
}

const CLOSING = { bytes: Buffer.byteLength(`${MARK}\n`, 'utf8'), words: 1, chars: 1, cjk: 0 };

/** The sum of segment measures, plus the closing marker. */
export function windowMeasure(sizes) {
  const total = { ...CLOSING, members: 0 };
  for (const size of sizes) {
    total.bytes += size.bytes;
    total.words += size.words;
    total.chars += size.chars;
    total.cjk += size.cjk;
    total.members += 1;
  }
  return total;
}

/** GBrain's word count of a body (cjk.ts countCJKAwareWords), from its measures. */
export function chunkWords(measure) {
  return measure.chars > 0 && measure.cjk / measure.chars >= CJK_DENSITY ? measure.chars : measure.words;
}

/** Whether a window with these measures stays one chunk. */
export function fitsWindow(measure) {
  return measure.members <= WINDOW_MAX_MEMBERS && measure.bytes <= WINDOW_MAX_BYTES && chunkWords(measure) <= WINDOW_MAX_WORDS;
}

/** A message too long for any window: it gets a window of its own. */
export function oversized(size) {
  return !fitsWindow(windowMeasure([size]));
}

// -------------------------------------------------------------------------- matching

// PostgreSQL's English stop words (snowball english.stop), which GBrain's keyword search
// drops from a question: they never count as a match.
const STOP_WORDS = new Set(`i me my myself we our ours ourselves you your yours yourself yourselves he him his himself
she her hers herself it its itself they them their theirs themselves what which who whom this that these those am is
are was were be been being have has had having do does did doing a an the and but if or because as until while of at
by for with about against between into through during before after above below to from up down in out on off over
under again further then once here there when where why how all any both each few more most other some such no nor
not only own same so than too very s t can will just don should now`.split(/\s+/));

const words = (text) => String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const hasCjk = (text) => /[一-鿿぀-ゟ゠-ヿ가-힯]/.test(text);

/** The words of a question that can match: distinct, without stop words (unless that is all it has). */
export function queryTerms(query) {
  const all = [...new Set(words(query))];
  const meaningful = all.filter((word) => !STOP_WORDS.has(word));
  return meaningful.length > 0 ? meaningful : all;
}

/**
 * The same word, give or take an English ending: GBrain's keyword search stems (it uses
 * PostgreSQL's English configuration), so "launches" matches "launch". Deliberately
 * lenient: it only chooses among messages of a window GBrain already matched.
 */
function sameWord(a, b) {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length < 3) return false;
  let common = 0;
  while (common < shorter.length && shorter[common] === longer[common]) common += 1;
  return common >= 3 && common >= shorter.length - 1 && longer.length - common <= 4;
}

/** How many of the question's terms one message has. */
export function matchScore(terms, text) {
  const present = new Set(words(text));
  let score = 0;
  for (const term of terms) {
    if (hasCjk(term)) {
      if (String(text).normalize('NFKC').toLowerCase().includes(term)) score += 1;
      continue;
    }
    for (const word of present) {
      if (sameWord(term, word)) {
        score += 1;
        break;
      }
    }
  }
  return score;
}
