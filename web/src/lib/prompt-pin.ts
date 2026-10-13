// Which prompt the Chat body pins above the thread, given where the reader is.
//
// A long run of tool calls scrolls the question it answers off screen, and a first paint of 40 turns
// often does not hold that question at all. The pin says which prompt the turns on screen belong to.
// This file decides WHICH one; `components/prompt-pin.tsx` draws it and the stream measures where the
// reader is. Nothing here touches the DOM, so every rule is table-testable.
//
// Three sources, in this order:
//  1. A prompt the client HOLDS, above the reader: the run of user blocks the visible turns follow.
//  2. The bridge's `lastPrompt`, when the client does not hold it: every held turn then comes after
//     it, because it is the newest prompt there is.
//  3. Neither: the turns on screen answer a prompt further back than anything held, and the pin can
//     only offer to load older turns.

import type { ChatItem } from "./chat-items";
import type { ChatPrompt } from "./types";

/** One prompt as the stream holds it: where its first block sits, and its words. */
export interface PromptRun {
  /** Index into the blocks of the prompt's first user block. */
  start: number;
  text: string;
}

/** The prompts in a stream, and for each block the prompt it follows (`-1`: none held above it). */
export interface PromptMap {
  runs: PromptRun[];
  owner: number[];
}

/** What the pin shows. `null` draws nothing. */
export type Pin =
  | { kind: "held"; text: string; start: number }
  | { kind: "reported"; text: string; truncated: boolean }
  | { kind: "earlier" }
  | null;

/** The words of a block that is a prompt, or null. `groupRuns` never folds a user item into a run. */
function promptText(group: readonly ChatItem[]): string | null {
  const item = group[0];
  return group.length === 1 && item?.kind === "user" ? item.text : null;
}

/**
 * Every prompt in the stream, and which one each block follows.
 *
 * Consecutive user blocks are ONE prompt: a turn with two text parts becomes two blocks, and pinning
 * only the second would cut the question in half.
 */
export function promptMap(blocks: readonly (readonly ChatItem[])[]): PromptMap {
  const runs: PromptRun[] = [];
  const owner: number[] = [];
  let open = false;
  blocks.forEach((group, i) => {
    const text = promptText(group);
    if (text !== null) {
      if (open) runs[runs.length - 1]!.text += `\n\n${text}`;
      else runs.push({ start: i, text });
      open = true;
    } else {
      open = false;
    }
    owner.push(runs.length - 1);
  });
  return { runs, owner };
}

/**
 * The pin for a reader whose topmost visible block is `top`.
 *
 * `top` is `-1` while the stream's top edge ("Load older", "Start of the conversation") is on screen,
 * and reads as the first block. A held prompt there is on screen, so nothing is pinned and the edge
 * stays readable. A prompt that is NOT held still pins, over "Load older": the one thing that row
 * offers is the pin's own tap, which loads older turns until the prompt arrives. Measured on
 * 2026-10-10, a forty-call run folds into one card that fits a phone screen, so a pin that waited
 * for the edge to scroll away would never appear in exactly the case it exists for.
 *
 * A prompt that is itself the top block is on screen, so it is not pinned twice. With no prompt held
 * above and nothing reported, the pin offers older turns only where older turns exist; at the start
 * of a conversation the turns on screen simply have no prompt (a compaction recap, a resumed session).
 */
export function pinAt(
  map: PromptMap,
  top: number,
  lastPrompt: ChatPrompt | null,
  holdsLastPrompt: boolean,
  hasOlder: boolean,
): Pin {
  const visible = Math.max(top, 0);
  if (visible >= map.owner.length) return null;
  const at = map.owner[visible]!;
  if (at >= 0) {
    const run = map.runs[at]!;
    return run.start < visible ? { kind: "held", text: run.text, start: run.start } : null;
  }
  if (lastPrompt !== null && !holdsLastPrompt) {
    return { kind: "reported", text: lastPrompt.text, truncated: lastPrompt.truncated === true };
  }
  return hasOlder ? { kind: "earlier" } : null;
}
