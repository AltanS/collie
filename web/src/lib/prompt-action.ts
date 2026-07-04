// The prompt-select race guard, factored out of AgentChat so it's directly testable (and reused by
// the component's integration test). Tapping a menu button can type into a REAL terminal, and the
// pane may have moved on between render and tap — so before sending we re-fetch the pane and confirm
// nothing changed underfoot:
//
//   1. A FRESH pane read for the same window. If the bridge answers 304 Not Modified the content is
//      unchanged by definition — that PASSES the guard.
//   2. Otherwise the fresh read's `revision` must equal the one the menu was detected against AND
//      the fresh buffer must still re-derive to the same {question, options} (family + labels).
//
// Only then do we send the option's keys through the existing sendKeys write path. A failed guard
// discards the tap and reports "changed" so the caller can surface a "menu changed" notice.

import { fetchPane, sendKeys } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type PromptModel, type PromptOption } from "./blocks";
import { detectPromptSelect } from "./grammar/prompt-select";

/** Whether two detected dialogs resolve to the same choice: family, question, and option labels.
 *  (Descriptions/keys are derived, so they can't differ without a label or family change first.) */
export function promptsEqual(a: PromptModel, b: PromptModel): boolean {
  return (
    a.family === b.family &&
    a.question === b.question &&
    a.options.length === b.options.length &&
    a.options.every((o, i) => o.label === b.options[i]!.label)
  );
}

export type PromptActionResult =
  | { status: "sent" }
  | { status: "changed" }
  | { status: "error"; error: string };

/**
 * Run the race guard and, if it passes, send `option.keys`. Pure of any UI — the caller maps the
 * result to a status message and a revalidation.
 */
export async function submitPromptOption(args: {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered menu was detected against. */
  detectedRevision: number;
  prompt: PromptModel;
  option: PromptOption;
}): Promise<PromptActionResult> {
  const { paneId, requestedLines, detectedRevision, prompt, option } = args;

  let fresh;
  try {
    fresh = await fetchPane(paneId, requestedLines);
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  // A 304 means the buffer is byte-for-byte what we rendered — the guard passes without re-deriving.
  if (fresh.notModified !== true) {
    if (fresh.revision !== detectedRevision) return { status: "changed" };
    const freshModel = detectPromptSelect(splitLines(parseAnsi(fresh.text)));
    if (!freshModel || !promptsEqual(freshModel, prompt)) return { status: "changed" };
  }

  try {
    const res = await sendKeys(paneId, option.keys);
    if (!res.ok) return { status: "error", error: res.error };
    return { status: "sent" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
