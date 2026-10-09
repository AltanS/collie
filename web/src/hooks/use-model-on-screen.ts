import { useState } from "react";

import { rowsNameModel } from "@/lib/model-label";

// Hide the label above the belt while the screen already names the model, and do it STEADILY.
//
// The rows come from the same poll as everything else on the pane, and a poll is one frame of a
// screen that redraws: a dialog takes the statusline away for a moment, a redraw can catch it half
// painted. A label that followed one frame would blink in and out beside a footer that has not
// changed. So the answer is held:
//   * a row that names the model hides the label at once, and a frame with no rows at all (nothing
//     to judge) changes nothing;
//   * the label comes back only after MISSES_TO_SHOW frames in a row showed rows that did NOT name
//     it, which is what a `/model` the footer has not caught up with, or a footer configured to
//     leave the model out, both look like for good;
//   * a different pane or model starts the question over.
// Hiding fast and showing slow is deliberate: the label is a convenience, the doubled name is the
// fault.

/** Frames of rows that lack the name before the label is drawn again. */
export const MISSES_TO_SHOW = 3;

export interface ModelOnScreen {
  key: string;
  /** The rows of the frame last counted, by identity, so a re-render of the same frame counts once. */
  rows: readonly string[];
  named: boolean;
  misses: number;
}

/** One frame in. Pure, so the rule is testable without a render. */
export function stepModelOnScreen(
  prev: ModelOnScreen,
  rows: readonly string[],
  seen: boolean | null,
): ModelOnScreen {
  if (prev.rows === rows) return prev;
  if (seen === null) return { ...prev, rows };
  if (seen) return { ...prev, rows, named: true, misses: 0 };
  const misses = prev.misses + 1;
  return { ...prev, rows, named: misses < MISSES_TO_SHOW ? prev.named : false, misses };
}

/**
 * Whether the screen names the model, held steadily. `shown` is false when the phone draws none of
 * the pane's footer (the Chat body of a harness whose footer is not lifted): then nothing names the
 * model, at once. `key` identifies the question (pane and model).
 */
export function useModelOnScreen(
  key: string,
  shown: boolean,
  rows: readonly string[],
  label: string | null,
): boolean {
  const seen = shown ? rowsNameModel(rows, label) : null;
  const questionKey = `${key}|${shown}`;
  const [held, setHeld] = useState<ModelOnScreen>(() => ({
    key: questionKey,
    rows,
    named: seen === true,
    misses: 0,
  }));
  if (held.key !== questionKey) {
    // Adjusting state while rendering, the documented way to reset on a changed input: React
    // re-renders this component at once, before anything is painted.
    setHeld({ key: questionKey, rows, named: seen === true, misses: 0 });
    return seen === true;
  }
  const next = stepModelOnScreen(held, rows, seen);
  if (next !== held) setHeld(next);
  return next.named;
}
