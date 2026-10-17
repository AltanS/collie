import type { SentEntry } from "./types";

// THE SUGGESTION STRIP'S RANKING (M61 spec 02), as pure functions. The strip above a shell pane's
// box offers lines from Sent while the person types, the way a phone keyboard offers words. The
// composer reads the pane's folder and machine once (hooks/use-sent-suggestions.ts) and calls
// `suggest` on every keystroke; nothing here touches the network, the document or storage.

/** How many chips the strip offers at most. The row scrolls, and a longer tail is the sheet's job. */
export const SUGGEST_LIMIT = 12;

/** One line the strip may offer, with the three facts that rank it. */
export interface SuggestionLine {
  line: string;
  /** The line was sent from this pane's folder. */
  inFolder: boolean;
  /** How many times it was sent on this machine (the folder's count when the machine's page lacks it). */
  count: number;
  /** Epoch ms of the newest run. */
  at: number;
}

/** A line to offer, and the character ranges of it that the typed text matched (for bold). */
export interface Suggestion {
  line: string;
  /** Sorted, non-overlapping `[start, end)` pairs into `line`. Empty for an empty box. */
  marks: readonly (readonly [number, number])[];
}

/**
 * The lines to rank, from the two reads: this folder's and this machine's. A line the folder read has
 * is `inFolder`. The machine's count and time win where it has the line, because the folder's page
 * only counts the runs from that folder.
 */
export function suggestionLines(folder: readonly SentEntry[], machine: readonly SentEntry[]): SuggestionLine[] {
  const byLine = new Map<string, SuggestionLine>();
  for (const entry of machine) {
    byLine.set(entry.line, { line: entry.line, inFolder: false, count: entry.count, at: entry.at });
  }
  for (const entry of folder) {
    const known = byLine.get(entry.line);
    byLine.set(entry.line, {
      line: entry.line,
      inFolder: true,
      count: known?.count ?? entry.count,
      at: Math.max(known?.at ?? 0, entry.at),
    });
  }
  return [...byLine.values()];
}

/**
 * What the strip offers for the text in the box.
 *
 * EMPTY BOX: the newest lines of this folder; a folder with none (or a pane that named none) falls
 * back to the machine's newest.
 *
 * TYPING: first the lines that START with the typed text, then the lines that hold EVERY typed word
 * somewhere (a substring of the line, any order), both without regard to case. Within each of the two
 * groups: this folder's lines first, then the most often sent, then the newest.
 *
 * NEVER OFFERED: the line that already is the box, and anything when the box starts with a space or a
 * tab. That leading space is how a person keeps a line out of Sent, and a suggestion would swap it for
 * a line that has none.
 */
export function suggest(lines: readonly SuggestionLine[], typed: string, limit: number = SUGGEST_LIMIT): Suggestion[] {
  if (/^[ \t]/.test(typed) && typed.trim() !== "") return [];
  const words = typed.trim().toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) {
    const inFolder = lines.filter((line) => line.inFolder);
    const pool = inFolder.length > 0 ? inFolder : lines;
    return pool
      .toSorted((a, b) => b.at - a.at || a.line.localeCompare(b.line))
      .slice(0, limit)
      .map((line) => ({ line: line.line, marks: [] }));
  }
  const prefix = typed.toLowerCase();
  const own = typed.trimEnd();
  const ranked: { line: SuggestionLine; group: 0 | 1; marks: readonly (readonly [number, number])[] }[] = [];
  for (const candidate of lines) {
    if (candidate.line === typed || candidate.line === own) continue;
    const lower = candidate.line.toLowerCase();
    if (lower.startsWith(prefix)) {
      ranked.push({ line: candidate, group: 0, marks: [[0, prefix.length]] });
    } else if (words.every((word) => lower.includes(word))) {
      ranked.push({ line: candidate, group: 1, marks: wordMarks(lower, words) });
    }
  }
  const order = ranked.toSorted(
    (a, b) =>
      a.group - b.group ||
      Number(b.line.inFolder) - Number(a.line.inFolder) ||
      b.line.count - a.line.count ||
      b.line.at - a.line.at ||
      a.line.line.localeCompare(b.line.line),
  );
  return order.slice(0, limit).map(({ line, marks }) => ({ line: line.line, marks }));
}

/** Where each word first appears in a lowercased line, merged where the places touch or overlap. */
function wordMarks(lower: string, words: readonly string[]): [number, number][] {
  const spans = words
    .map((word): [number, number] => {
      const start = lower.indexOf(word);
      return [start, start + word.length];
    })
    .toSorted((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push(span);
  }
  return merged;
}

/** A run of a line, and whether it is the matched part. */
export interface Segment {
  text: string;
  matched: boolean;
}

/** A line cut into its matched and unmatched runs, in order, for the strip to draw. */
export function segmentsOf(suggestion: Suggestion): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [start, end] of suggestion.marks) {
    if (start > at) out.push({ text: suggestion.line.slice(at, start), matched: false });
    out.push({ text: suggestion.line.slice(start, end), matched: true });
    at = end;
  }
  if (at < suggestion.line.length) out.push({ text: suggestion.line.slice(at), matched: false });
  return out;
}
