// Find-in-history and jump-to-user-message, as pure functions over the transcript.
//
// Two things a phone reading view needs that a browser can't give it: in a PWA there is no browser
// find, and in a thousand-turn thread the only landmarks are the handful of messages YOU wrote (20
// human turns in 900 is typical), so stepping between them is the fastest way to navigate.
//
// WHAT IS SEARCHED — by default, only what is VISIBLE with tool output collapsed: prose text and the
// one-line tool summaries. Matching inside a collapsed body would jump you to a turn where nothing on
// screen matches, so every hit the default returns is a hit you can actually see.
//
// `{ includeToolResults: true }` adds the tool RESULT bodies. Only a view that unfolds a tool call
// whose output matches may ask for it: History does (components/transcript-view.tsx, `ToolPart`
// opens on a hit and marks it), so the turn a jump lands on still shows the match (#618).

import type { TranscriptEntry } from "@/lib/types";

/** What a search covers beyond the visible surface. */
export interface SearchOptions {
  /** Tool result bodies too. Only for a view that unfolds a call whose output matches. */
  readonly includeToolResults?: boolean;
}

/** The text a search runs against for one turn: the visible surface, and tool output when asked. */
export function searchableText(entry: TranscriptEntry, opts: SearchOptions = {}): string {
  const parts: string[] = [];
  for (const part of entry.parts) {
    if (part.kind === "tool") {
      parts.push(part.name, part.summary);
      if (opts.includeToolResults === true && part.result !== undefined) parts.push(part.result.text);
    } else if (part.kind === "image") {
      // Deliberately skipped: an image part carries a URL and a mime type, and neither is text the
      // operator typed or the agent said. Indexing the URL would make a find hit on a sha-256.
      continue;
    } else {
      parts.push(part.text);
    }
  }
  return parts.join(" ");
}

/**
 * Each entry's search text, lowercased once. A view that searches on every keystroke builds this
 * when the entries change (a `useMemo` keyed on them) and matches against it with
 * {@link matchingIndexed}, so a tool output is not lowercased again for each letter typed.
 */
export function searchIndex(entries: readonly TranscriptEntry[], opts: SearchOptions = {}): string[] {
  return entries.map((entry) => searchableText(entry, opts).toLowerCase());
}

/** Indices into a {@link searchIndex} whose text holds `query`, oldest-first. */
export function matchingIndexed(index: readonly string[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const hits: number[] = [];
  for (let i = 0; i < index.length; i++) {
    if (index[i]!.includes(needle)) hits.push(i);
  }
  return hits;
}

/**
 * Indices of entries matching `query`, oldest-first. Case-insensitive substring — not a regex, since
 * this is a phone find bar and a stray `(` shouldn't throw or silently match nothing.
 */
export function matchingEntries(entries: readonly TranscriptEntry[], query: string, opts: SearchOptions = {}): number[] {
  if (query.trim() === "") return [];
  return matchingIndexed(searchIndex(entries, opts), query);
}

/** Indices of the turns the user typed — the thread's landmarks. */
export function userTurnIndices(entries: TranscriptEntry[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < entries.length; i++) if (entries[i]!.role === "user") out.push(i);
  return out;
}

/**
 * The next index in `stops` strictly after/before `from`, wrapping at the ends.
 *
 * Wrapping matters on a phone: reaching the last match and having the button go dead reads as broken,
 * whereas cycling back is how every find bar behaves. `from` may be -1 ("nowhere yet").
 */
export function step(stops: number[], from: number, dir: 1 | -1): number | null {
  if (stops.length === 0) return null;
  if (dir === 1) {
    const next = stops.find((i) => i > from);
    return next ?? stops[0]!;
  }
  const prev = stops.toReversed().find((i) => i < from);
  return prev ?? stops[stops.length - 1]!;
}

/** One piece of a highlighted string. `hit` segments render as marks. */
export interface HighlightPiece {
  text: string;
  hit: boolean;
}

/**
 * Split `text` on every case-insensitive occurrence of `query`. Returns a single non-hit piece when
 * the query is empty or absent, so callers can render the result unconditionally.
 */
export function splitHighlight(text: string, query: string): HighlightPiece[] {
  const needle = query.trim().toLowerCase();
  if (needle === "" || text === "") return [{ text, hit: false }];
  const hay = text.toLowerCase();
  const pieces: HighlightPiece[] = [];
  let at = 0;
  for (;;) {
    const found = hay.indexOf(needle, at);
    if (found === -1) break;
    if (found > at) pieces.push({ text: text.slice(at, found), hit: false });
    pieces.push({ text: text.slice(found, found + needle.length), hit: true });
    at = found + needle.length;
  }
  if (pieces.length === 0) return [{ text, hit: false }];
  if (at < text.length) pieces.push({ text: text.slice(at), hit: false });
  return pieces;
}
