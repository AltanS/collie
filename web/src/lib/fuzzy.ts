// A pure matcher for the session filter (M97). No React, no DOM, no dependency.
//
// One term against one text, at one of two levels:
//
//   anchored (level A, the default). The term is a substring of the text, or an abbreviation whose
//   every letter either continues a run (the unit right after the previous match) or starts a word.
//   `cw` finds `collie-workspace`, `f7` finds `fix-748`.
//   loose (level B). Anchored first, and when that finds nothing, the term's letters in order
//   anywhere in the text (a subsequence), with the fewest runs.
//
// So loose never matches less than anchored, and a row that anchored finds keeps the same ranges and
// the same score at both levels.
//
// ── Folding ─────────────────────────────────────────────────────────────────────────────────────
// Comparison is case and diacritic blind. `fold` keeps one folded unit per original UTF-16 unit.
// Inside a match, a combining mark (a decomposed `ü` is `u` + U+0308) belongs to the unit before it
// and is skipped, so `prufung` finds both spellings of `Prüfung`. Ranges always index the ORIGINAL
// text, in UTF-16 units, and never cut a surrogate pair. No letter expands (`ß` stays `ß`).
//
// ── Words ───────────────────────────────────────────────────────────────────────────────────────
// A word starts at index 0, after one of ` -_/.#:›`, at a lower-to-upper change (`fooBar`), and at a
// letter-digit or digit-letter change (`fix748`).
//
// ── Score ───────────────────────────────────────────────────────────────────────────────────────
// Higher is better, an integer, built as five digit groups from the most to the least important:
//
//   class        4 substring at a word start, 3 substring, 2 abbreviation, 1 loose
//   fewer runs   99 - runs (a run is a stretch of matched units with no gap)
//   longer run   the longest run
//   earlier      999 - the index of the first matched unit
//   shorter      9999 - the text length
//
//   score = (((class * 100 + (99 - runs)) * 100 + longest) * 1000 + (999 - first)) * 10000 + (9999 - length)
//
// Each group is capped at its width. Callers compare scores; the numbers carry no other meaning.
//
// ── Cost ────────────────────────────────────────────────────────────────────────────────────────
// The abbreviation walk backtracks over a failure table, so it is O(term * text) and runs only for
// texts up to ABBREVIATION_CAP units (longer: no abbreviation, a substring still matches). The loose
// search is a dynamic program over the same grid; above LOOSE_CELL_CAP cells it takes the leftmost
// subsequence instead of the best one.

export type MatchLevel = "anchored" | "loose";
/** [start, end) in the ORIGINAL string, UTF-16 units. */
export type Range = readonly [start: number, end: number];
export interface TermMatch {
  readonly ranges: readonly Range[];
  readonly score: number;
}

const MAX_TERMS = 8;
const ABBREVIATION_CAP = 256;
const LOOSE_CELL_CAP = 1 << 20;
const SEPARATORS = " -_/.#:›";
const NO_FIT = 0x3fffffff;

const CLASS_LOOSE = 1;
const CLASS_ABBREVIATION = 2;
const CLASS_SUBSTRING = 3;
const CLASS_SUBSTRING_AT_WORD = 4;

const MARK = /^\p{M}$/u;
const MARKS = /\p{M}/gu;
const LETTER = /^\p{L}$/u;

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return false;
  }
  return true;
}

const unitCache = new Map<string, string>();

function foldUnit(unit: string): string {
  const cached = unitCache.get(unit);
  if (cached !== undefined) return cached;
  const lower = unit.toLowerCase();
  const stripped = lower.normalize("NFD").replace(MARKS, "");
  const folded = stripped.length === 1 ? stripped : lower.length === 1 ? lower : unit;
  unitCache.set(unit, folded);
  return folded;
}

/** Fold for comparison: lower case, NFD with combining marks removed. One folded unit per original unit. */
export function fold(text: string): string {
  if (isAscii(text)) return text.toLowerCase();
  let out = "";
  for (let i = 0; i < text.length; i++) out += foldUnit(text[i] ?? "");
  return out;
}

/** Split a query at whitespace, fold it, drop empties. At most 8 terms; the rest are ignored. */
export function queryTerms(query: string): readonly string[] {
  return fold(query).split(/\s+/u).filter(Boolean).slice(0, MAX_TERMS);
}

// A text as the matcher sees it: the folded units without combining marks, and for each of them the
// span it covers in the original. `starts` and `ends` are null when that span is the unit itself.
interface Prepared {
  readonly text: string;
  readonly folded: string;
  readonly starts: readonly number[] | null;
  readonly ends: readonly number[] | null;
}

function prepare(text: string): Prepared {
  if (isAscii(text)) return { text, folded: text.toLowerCase(), starts: null, ends: null };
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text[i] ?? "";
    const attaches = i > 0 && MARK.test(unit);
    if (attaches) {
      ends[ends.length - 1] = i + 1;
      continue;
    }
    folded += foldUnit(unit);
    starts.push(i);
    ends.push(i + 1);
  }
  return { text, folded, starts, ends };
}

function startOf(p: Prepared, i: number): number {
  return p.starts === null ? i : (p.starts[i] ?? i);
}

function endOf(p: Prepared, i: number): number {
  return p.ends === null ? i + 1 : (p.ends[i] ?? i + 1);
}

// 0 other, 1 lower case, 2 upper case, 3 digit, 4 caseless letter.
function kindOf(unit: string): number {
  if (unit >= "0" && unit <= "9") return 3;
  if (!LETTER.test(unit)) return 0;
  const lower = unit.toLowerCase();
  const upper = unit.toUpperCase();
  if (lower === upper) return 4;
  return unit === lower ? 1 : 2;
}

function startsWord(p: Prepared, i: number): boolean {
  if (i === 0) return true;
  const prev = p.text[startOf(p, i - 1)] ?? "";
  if (SEPARATORS.includes(prev)) return true;
  const was = kindOf(prev);
  const is = kindOf(p.text[startOf(p, i)] ?? "");
  if (was === 1 && is === 2) return true;
  const wasDigit = was === 3;
  const isDigit = is === 3;
  const wasLetter = was === 1 || was === 2 || was === 4;
  const isLetter = is === 1 || is === 2 || is === 4;
  return (wasDigit && isLetter) || (wasLetter && isDigit);
}

function wordStarts(p: Prepared): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < p.folded.length; i++) out.push(startsWord(p, i));
  return out;
}

// Anchored, rule 1: the first occurrence that starts a word, else the first occurrence.
function substringAt(p: Prepared, q: string): number {
  let first = -1;
  let at = p.folded.indexOf(q);
  while (at >= 0) {
    if (first < 0) first = at;
    if (startsWord(p, at)) return at;
    at = p.folded.indexOf(q, at + 1);
  }
  return first;
}

// Anchored, rule 2: the earliest assignment in which every letter continues a run or starts a word.
function abbreviation(p: Prepared, q: string): number[] | null {
  const n = p.folded.length;
  const m = q.length;
  if (n > ABBREVIATION_CAP || m > n) return null;
  const starts = wordStarts(p);
  const dead = new Uint8Array((m + 1) * (n + 1));
  const picked: number[] = Array.from<number>({ length: m }).fill(0);
  const place = (j: number, last: number): boolean => {
    if (j === m) return true;
    const key = j * (n + 1) + last + 1;
    if (dead[key] === 1) return false;
    const letter = q[j];
    for (let i = last + 1; i <= n - (m - j); i++) {
      if (p.folded[i] !== letter) continue;
      if (i !== last + 1 && !starts[i]) continue;
      picked[j] = i;
      if (place(j + 1, i)) return true;
    }
    dead[key] = 1;
    return false;
  };
  return place(0, -1) ? picked : null;
}

function leftmostSubsequence(folded: string, q: string): number[] | null {
  const picked: number[] = [];
  let at = 0;
  for (let j = 0; j < q.length; j++) {
    at = folded.indexOf(q[j] ?? "", at);
    if (at < 0) return null;
    picked.push(at);
    at += 1;
  }
  return picked;
}

// Loose: the subsequence with the fewest runs, and among those the earliest start. One grid cell is
// "term letter j sits on text unit i"; it keeps the best (runs, first) of the ways to get there.
function looseAssignment(folded: string, q: string): number[] | null {
  const n = folded.length;
  const m = q.length;
  const leftmost = leftmostSubsequence(folded, q);
  if (leftmost === null) return null;
  if (n * m > LOOSE_CELL_CAP) return leftmost;
  const runs = new Int32Array(n * m).fill(NO_FIT);
  const first = new Int32Array(n * m);
  const from = new Int32Array(n * m).fill(-1);
  for (let i = 0; i < n; i++) {
    if (folded[i] !== q[0]) continue;
    runs[i] = 1;
    first[i] = i;
  }
  for (let j = 1; j < m; j++) {
    const base = j * n;
    const above = (j - 1) * n;
    let gapRuns = NO_FIT;
    let gapFirst = 0;
    let gapAt = -1;
    for (let i = j; i < n; i++) {
      const k = i - 2;
      const kRuns = k >= 0 ? (runs[above + k] ?? NO_FIT) : NO_FIT;
      const kFirst = k >= 0 ? (first[above + k] ?? 0) : 0;
      if (kRuns < gapRuns || (kRuns === gapRuns && kRuns < NO_FIT && kFirst < gapFirst)) {
        gapRuns = kRuns;
        gapFirst = kFirst;
        gapAt = k;
      }
      if (folded[i] !== q[j]) continue;
      let bestRuns = runs[above + i - 1] ?? NO_FIT;
      let bestFirst = first[above + i - 1] ?? 0;
      let bestFrom = bestRuns < NO_FIT ? i - 1 : -1;
      const viaGap = gapRuns + 1;
      if (gapAt >= 0 && (viaGap < bestRuns || (viaGap === bestRuns && gapFirst < bestFirst))) {
        bestRuns = viaGap;
        bestFirst = gapFirst;
        bestFrom = gapAt;
      }
      if (bestFrom < 0) continue;
      runs[base + i] = bestRuns;
      first[base + i] = bestFirst;
      from[base + i] = bestFrom;
    }
  }
  const last = (m - 1) * n;
  let end = -1;
  for (let i = 0; i < n; i++) {
    const r = runs[last + i] ?? NO_FIT;
    if (r === NO_FIT) continue;
    if (end < 0 || r < (runs[last + end] ?? NO_FIT)) end = i;
    else if (r === runs[last + end] && (first[last + i] ?? 0) < (first[last + end] ?? 0)) end = i;
  }
  if (end < 0) return leftmost;
  const picked: number[] = Array.from<number>({ length: m }).fill(0);
  let at = end;
  for (let j = m - 1; j >= 0; j--) {
    picked[j] = at;
    at = from[j * n + at] ?? -1;
  }
  return picked;
}

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

// Compact positions (sorted) to ranges in the original: one per run, widened so none cuts a
// surrogate pair, merged where widening made two touch.
function rangesOf(p: Prepared, positions: readonly number[]): Range[] {
  const out: Range[] = [];
  let runStart = 0;
  for (let k = 1; k <= positions.length; k++) {
    const continues = k < positions.length && positions[k] === (positions[k - 1] ?? 0) + 1;
    if (continues) continue;
    let start = startOf(p, positions[runStart] ?? 0);
    let end = endOf(p, positions[k - 1] ?? 0);
    if (start > 0 && isLow(p.text.charCodeAt(start)) && isHigh(p.text.charCodeAt(start - 1))) start -= 1;
    if (end < p.text.length && isHigh(p.text.charCodeAt(end - 1)) && isLow(p.text.charCodeAt(end))) end += 1;
    const prev = out[out.length - 1];
    if (prev !== undefined && start <= prev[1]) out[out.length - 1] = [prev[0], Math.max(prev[1], end)];
    else out.push([start, end]);
    runStart = k;
  }
  return out;
}

function scoreOf(matchClass: number, positions: readonly number[], length: number): number {
  let runs = 1;
  let longest = 1;
  let current = 1;
  for (let k = 1; k < positions.length; k++) {
    const continues = positions[k] === (positions[k - 1] ?? 0) + 1;
    current = continues ? current + 1 : 1;
    runs += continues ? 0 : 1;
    longest = Math.max(longest, current);
  }
  const first = positions[0] ?? 0;
  const near = (matchClass * 100 + (99 - Math.min(runs, 99))) * 100 + Math.min(longest, 99);
  return (near * 1000 + (999 - Math.min(first, 999))) * 10000 + (9999 - Math.min(length, 9999));
}

function matched(p: Prepared, positions: readonly number[], matchClass: number): TermMatch {
  return { ranges: rangesOf(p, positions), score: scoreOf(matchClass, positions, p.text.length) };
}

function anchoredMatch(p: Prepared, q: string): TermMatch | null {
  const at = substringAt(p, q);
  if (at >= 0) {
    const positions = Array.from({ length: q.length }, (_, k) => at + k);
    return matched(p, positions, startsWord(p, at) ? CLASS_SUBSTRING_AT_WORD : CLASS_SUBSTRING);
  }
  const picked = abbreviation(p, q);
  if (picked === null) return null;
  return matched(p, picked, CLASS_ABBREVIATION);
}

/** One term against one text. null = no match. Ranges are sorted, merged, never overlapping. */
export function matchTerm(text: string, term: string, level: MatchLevel): TermMatch | null {
  const p = prepare(text);
  const q = prepare(term).folded;
  if (q.length === 0 || q.length > p.folded.length) return null;
  const found = anchoredMatch(p, q);
  if (found !== null || level === "anchored") return found;
  const picked = looseAssignment(p.folded, q);
  if (picked === null) return null;
  return matched(p, picked, CLASS_LOOSE);
}
