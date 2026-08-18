// Find-in-history and jump-to-user-message, as pure functions over the transcript.
//
// Two things a phone reading view needs that a browser can't give it: in a PWA there is no browser
// find, and in a thousand-turn thread the only landmarks are the handful of messages YOU wrote (20
// human turns in 900 is typical), so stepping between them is the fastest way to navigate.
//
// WHAT IS SEARCHED — deliberately, only what is VISIBLE with tool output collapsed: prose text and
// the one-line tool summaries. Tool RESULT bodies are excluded even though we hold them, because
// matching inside a collapsed body would jump you to a turn where nothing on screen matches. Every
// hit this returns is a hit you can actually see.

import type { TranscriptEntry } from "@/lib/types";

/** The text a search runs against for one turn — the visible surface, nothing hidden. */
export function searchableText(entry: TranscriptEntry): string {
  const parts: string[] = [];
  for (const part of entry.parts) {
    if (part.kind === "tool") {
      parts.push(part.name, part.summary);
    } else {
      parts.push(part.text);
    }
  }
  return parts.join(" ");
}

/**
 * Indices of entries matching `query`, oldest-first. Case-insensitive substring — not a regex, since
 * this is a phone find bar and a stray `(` shouldn't throw or silently match nothing.
 */
export function matchingEntries(entries: TranscriptEntry[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const hits: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (searchableText(entries[i]!).toLowerCase().includes(needle)) hits.push(i);
  }
  return hits;
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
