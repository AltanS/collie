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
 */
export function findLinks(text: string): LinkMatch[] {
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
