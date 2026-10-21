// How many rows a Chat page holds, counted in TURNS (ADR 0073, amended 2026-10-19).
//
// A Claude Code turn with many tool calls is many assistant rows, so a page of forty rows was often
// one or two prompts. A page now reaches back over the last few prompts and everything the agent did
// after each, with a floor and a ceiling on the rows so neither a quiet thread nor a long run sets
// the size of the answer on its own.

import type { TranscriptEntry } from "./types.ts";

/** Prompts a live page, and each older page, reaches back over. */
export const LIVE_TURNS = 6;

/** The most rows one page carries, whatever the turns weigh. A run of tool calls can be thousands. */
export const MAX_PAGE_ROWS = 400;

/**
 * Whether this row starts a turn: a `user` row a person sent (a typed prompt or a walky talky
 * message), with something to read in it.
 *
 * Not a `note` (a prompt the agent sent itself), not a row the agent rewound past, and not a `user`
 * row that holds only tool output: Claude files an orphan `tool_result` under `user`, and a window
 * that opens mid-run starts with exactly such rows. Counting them would end a page in the middle of
 * one prompt's tool calls.
 */
export function startsTurn(entry: TranscriptEntry): boolean {
  if (entry.role !== "user" || entry.abandoned === true) return false;
  return entry.parts.some((part) => part.kind === "text" || part.kind === "image");
}

/**
 * Where a page starts, in a list of `end` rows read through `at`: the first index to send, the page
 * running to `end` (exclusive).
 *
 * The sixth-newest turn start before `end` is the first row. A list with fewer than six answers
 * everything up to `end`. The result is then held to at least `floor` rows and at most
 * {@link MAX_PAGE_ROWS}, and never more than `end`. The cap wins over the turn rule, and the walk
 * stops at the cap, so a page costs at most {@link MAX_PAGE_ROWS} reads however long the list is.
 */
export function pageStart(end: number, floor: number, at: (index: number) => TranscriptEntry): number {
  const reach = Math.min(end, MAX_PAGE_ROWS);
  let seen = 0;
  let start = end - reach;
  for (let i = end - 1; i >= end - reach; i--) {
    if (!startsTurn(at(i))) continue;
    seen++;
    if (seen === LIVE_TURNS) {
      start = i;
      break;
    }
  }
  // Fewer than LIVE_TURNS starts inside the reach: the whole reach, which is the whole list when it
  // holds fewer than MAX_PAGE_ROWS rows and the cap otherwise.
  const rows = Math.min(Math.max(end - start, floor), MAX_PAGE_ROWS, end);
  return end - rows;
}
