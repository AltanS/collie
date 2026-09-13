// URL autolinking for the pane mirror. Terminal output has no markup — a URL is just characters —
// so "clickable links" means *finding* them in the visible text and wrapping those ranges in
// anchors. This module only computes offsets and hrefs; no HTML is built here and the renderer
// still puts every character into a React text node (CLAUDE.md → "Security posture").
//
// Offsets index the same visible string `find.ts` searches (segments' text concatenated, "\n"
// between lines), so the renderer can thread ONE running offset through blocks → lines → segments
// and split by both link ranges and find matches in the same coordinate space.

export interface LinkMatch {
  /** Start offset into the visible text. */
  start: number;
  /** End offset (exclusive). */
  end: number;
  /** The href to navigate to — always `http(s)://…`, by construction of the scanner. */
  href: string;
}

// Explicit schemes only. `www.foo.com`-style bare hosts are deliberately NOT matched: terminal
// output is dense with dotted tokens (file names, module paths, versions, IPs) and a host-shaped
// heuristic turns them into links you can't select as text. A scheme is an unambiguous signal, and
// it is also the whole XSS story — `javascript:` and `data:` are unmatchable, not filtered.
//
// The character class is a stop-set rather than an allow-set (RFC 3986 permits a lot): whitespace,
// the quote/bracket characters that conventionally *delimit* a URL in prose, and the backslash.
// Control bytes are cut afterwards (`cutControls`), trailing prose punctuation too (`trimTrailing`).
const URL_SCAN = /https?:\/\/[^\s<>"'`\\{}|^[\]]+/gi;

// Sentence punctuation that is almost never the last character of a real URL.
const TRAILING_PUNCT = ".,;:!?*_~'\"’”";

// A Map, not an object literal: `ch` comes from arbitrary page text, and an object lookup would
// answer for inherited names ("constructor", "toString") that are not closers at all.
const CLOSERS = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** Truncate at the first control byte — one can survive the SGR parse and must not enter an href. */
function cutControls(url: string): string {
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return url.slice(0, i);
  }
  return url;
}

/**
 * Trim punctuation that belongs to the surrounding prose, not the URL.
 *
 * `See https://x.dev/a.` → drop the full stop. `(https://x.dev/a)` → drop the paren, because the
 * URL contains no matching `(`. But `https://x.dev/a_(b)` keeps its `)`, since the closer is
 * balanced inside the URL itself — Wikipedia-shaped links stay whole.
 */
function trimTrailing(url: string): string {
  let end = url.length;
  for (;;) {
    const ch = url[end - 1];
    if (ch === undefined) break;
    if (TRAILING_PUNCT.includes(ch)) {
      end--;
      continue;
    }
    const opener = CLOSERS.get(ch);
    if (opener) {
      const slice = url.slice(0, end);
      if (count(slice, opener) < count(slice, ch)) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

// After trimming there must still be a plausible host: at least one alphanumeric right after the
// `//`. Guards against `https://` on its own, and against a match that trimmed back to bare scheme.
const HAS_HOST = /^https?:\/\/[a-z0-9]/i;

/**
 * Find every http(s) URL in `text`, as sorted, non-overlapping [start, end) ranges.
 *
 * A URL the terminal hard-wrapped across two lines is found only as its first fragment: the scan
 * stops at the newline, and stitching wrapped lines back together would mean knowing the pane's
 * column width and guessing which breaks were soft. A half-URL that opens the right host beats a
 * wrong URL assembled from two unrelated lines.
 *
 * `logicalText` — the same pane read with soft wraps undone (`herdr`'s `recent_unwrapped`) — turns
 * that guess into a check, and the caller that has it should pass it. See `repairWrapped`.
 */
export function findLinks(text: string, logicalText?: string): LinkMatch[] {
  const found = scanLinks(text);
  if (logicalText === undefined || logicalText === "") return found;
  return repairWrapped(found, text, scanLinks(logicalText));
}

/** The scan itself: every http(s) URL one string of text carries, per the rules above. */
function scanLinks(text: string): LinkMatch[] {
  const links: LinkMatch[] = [];
  URL_SCAN.lastIndex = 0;
  for (;;) {
    const m = URL_SCAN.exec(text);
    if (!m) break;
    const href = trimTrailing(cutControls(m[0]));
    if (!HAS_HOST.test(href)) continue;
    links.push({ start: m.index, end: m.index + href.length, href });
  }
  return links;
}

/**
 * Does the line this fragment sits on end right here? Herdr's own reads terminate a row with `\r\n`;
 * a bare `\n` is what a joined-lines fixture looks like anywhere else.
 */
function atLineEnd(text: string, at: number): boolean {
  return text[at] === "\n" || (text[at] === "\r" && text[at + 1] === "\n");
}

/**
 * Pair the grid's URL fragments with the URLs the pane's logical text carries.
 *
 * The mirror renders the *grid*, so a URL longer than the pane is cut at the column edge and the
 * scan finds a fragment whose href is a prefix of the real one — an anchor that opens a truncated
 * URL, with the rest of the URL as inert text. The logical read has the URL whole, which makes the
 * pairing exact rather than a guess:
 *
 *   · a fragment is considered only when it runs to the END OF ITS LINE — nothing but the row
 *     terminator after it (`\n`, or Herdr's own `\r\n`). A fragment the scan stopped at a delimiter
 *     for ended there for real, and nothing continues it;
 *   · the fragment must be a prefix of exactly ONE URL in the logical text (duplicates of the same
 *     URL — a typed command and its output — count as one), so two DIFFERENT candidates leave the
 *     link alone instead of picking one;
 *   · and the URL is adopted only when its remainder is FOUND in the following lines, compared
 *     character by character from column 0. A complete URL that merely happens to prefix a longer
 *     one elsewhere in the scrollback has no continuation to show, so it keeps its own href.
 *
 * The continuation fragments become ranges of their own with the same href, so the whole URL is one
 * tap target across however many rows it occupies. Fragments keep their own characters — this
 * changes hrefs and adds ranges, never the text.
 */
function repairWrapped(found: LinkMatch[], text: string, logical: LinkMatch[]): LinkMatch[] {
  if (logical.length === 0) return found;
  // A Set, because the same URL is commonly on screen twice (a typed command and its output): that is
  // one URL to adopt, not an ambiguity to refuse.
  const candidates = [...new Set(logical.map((l) => l.href))];
  const repaired: LinkMatch[] = [];

  for (const link of found) {
    if (!atLineEnd(text, link.end)) {
      repaired.push(link);
      continue;
    }
    const full = candidates.filter((href) => href.length > link.href.length && href.startsWith(link.href));
    if (full.length !== 1) {
      repaired.push(link);
      continue;
    }
    const href = full[0]!;

    const rest: LinkMatch[] = [];
    let consumed = link.href.length;
    let cursor = link.end;
    while (consumed < href.length) {
      if (text[cursor] === "\r") cursor += 1; // Herdr terminates a row with CR before the LF
      if (text[cursor] !== "\n") break;
      const lineStart = cursor + 1;
      const lineEnd = text.indexOf("\n", lineStart);
      const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
      const want = href.slice(consumed, consumed + line.length);
      if (want.length === 0 || !line.startsWith(want)) break;
      rest.push({ start: lineStart, end: lineStart + want.length, href });
      consumed += want.length;
      cursor = lineStart + want.length;
    }
    if (rest.length === 0) {
      repaired.push(link);
      continue;
    }
    repaired.push({ ...link, href }, ...rest);
  }

  return repaired.toSorted((a, b) => a.start - b.start);
}
