import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

import { hasResizeObserver } from "@/lib/env";

/**
 * The visual line count at which the composer stacks its two buttons, measured at the UNSTACKED
 * width: three lines is clearly past two, and the one-line default box never reaches it.
 */
export const STACK_AT_LINES = 3;

/**
 * The visual line count at which a three-button composer (attach, draft mic, send) stacks its
 * buttons: three 36px faces with `gap-2` stand 124px tall, whereas a three-line textarea is 84px
 * tall, so stacking at three lines would jump the box taller by +40px. At five lines (132px) the
 * field already clears the column, so stacking adds zero height.
 */
export const STACK_THREE_AT_LINES = 5;

/**
 * The line count at or under which a stacked composer lets its buttons back into the row, measured
 * at the STACKED width. It is lower than {@link STACK_AT_LINES} minus one on purpose, and that gap is
 * the whole of the hysteresis: stacking frees a button's width, so the same draft wraps to fewer
 * lines. If the box un-stacked at two lines it would narrow the field, wrap the draft to three, and
 * stack again, for ever. A draft of one line at the stacked width wraps to at most two at the
 * unstacked one (the width the row gives back is under one line's worth), so it can never meet
 * {@link STACK_AT_LINES}; the two states cannot chase each other.
 */
export const UNSTACK_AT_LINES = 1;

/**
 * Whether the rendered textarea box (`clientHeight`) is tall enough for the stacked button column
 * not to grow the composer: two 36px faces with `gap-2` stand 80px tall, three stand 124px tall. In
 * a short viewport where `max-h-[min(10rem,30dvh)]` caps `clientHeight` below the column,
 * `scrollHeight` can pass five lines while the visible field is only 72px tall, and stacking would
 * jump the composer taller. `clientHeight === 0` is an unlaid-out node (jsdom).
 */
function clearsColumnHeight(stackAt: number, clientHeight: number): boolean {
  const minHeight = stackAt >= STACK_THREE_AT_LINES ? 124 : 80;
  return clientHeight === 0 || clientHeight >= minHeight;
}

/** The next state from the last one and the visual line count the field reads at its current width. */
export function nextStacked(
  stacked: boolean,
  lines: number,
  stackAt = STACK_AT_LINES,
  clientHeight = 0,
  scrollHeight = clientHeight,
): boolean {
  if (!stacked) {
    return lines >= stackAt && clearsColumnHeight(stackAt, clientHeight);
  }
  if (lines <= UNSTACK_AT_LINES) return false;
  // When the viewport shrinks (rotation, keyboard, split view) so `max-h` caps `clientHeight` below
  // the button column (`scrollHeight > clientHeight`), un-stack so the column does not prop the
  // composer taller than the cap. When `scrollHeight <= clientHeight`, the field is not capped by
  // the viewport — any height below 80/124px is just the draft unwrapping by a line in the wider
  // stacked layout (such as 4 lines = 96px in row unwrapping to 3 lines = 75px at 14px font), where
  // un-stacking would wrap it back to 96px and oscillate.
  if (scrollHeight > clientHeight && !clearsColumnHeight(stackAt, clientHeight)) {
    return false;
  }
  return true;
}

// What a `line-height: normal` field measures when the engine hands back the keyword instead of a
// length: the font's own metrics are not readable from script, 1.2 is what the fonts this app
// names resolve to. Only ever the fallback; the stylesheet sets a numeric line height.
const NORMAL_LINE_HEIGHT = 1.2;

/**
 * The visual lines a textarea's draft occupies now: its content height (scroll height less the
 * field's own vertical padding) over its computed line height, so the operator's draft font size
 * and face are already in the answer. Scroll height, not client height, so a field at its cap, which
 * scrolls inside itself, still reports every line it holds. Never under one.
 */
export function draftLines(field: HTMLTextAreaElement): number {
  const style = getComputedStyle(field);
  const fontPx = Number.parseFloat(style.fontSize);
  const declared = Number.parseFloat(style.lineHeight);
  const lineHeight = Number.isFinite(declared) ? declared : fontPx * NORMAL_LINE_HEIGHT;
  const padTop = Number.parseFloat(style.paddingTop);
  const padBottom = Number.parseFloat(style.paddingBottom);
  const padding = (Number.isFinite(padTop) ? padTop : 0) + (Number.isFinite(padBottom) ? padBottom : 0);
  if (!(lineHeight > 0)) return 1;
  return Math.max(1, Math.round((field.scrollHeight - padding) / lineHeight));
}

/**
 * Whether the composer's attach and primary buttons stand in a column beside a tall draft instead
 * of in the row. Measured after layout on every draft change, and again whenever the field's own box
 * changes size (a rotation, a keyboard, a draft-size setting), so the state is settled before paint.
 * It only ever drives a class: nothing remounts, so the field keeps its caret.
 */
export function useStackedActions(
  field: RefObject<HTMLTextAreaElement | null>,
  draft: string,
  stackAt = STACK_AT_LINES,
): boolean {
  const [state, setState] = useState({ stacked: false, stackAt });
  const measure = useCallback(() => {
    const el = field.current;
    if (el === null) return;
    const lines = draftLines(el);
    setState((prev) => {
      // When `stackAt` rises (e.g. the draft microphone appears after `/api/config` loads, raising
      // the threshold from 3 to 5 lines), a column that entered under the lower 2-button threshold
      // must re-qualify against the taller 3-button threshold so a 124px column never props a 3-line
      // draft taller.
      const base = stackAt > prev.stackAt ? false : prev.stacked;
      const next = nextStacked(base, lines, stackAt, el.clientHeight, el.scrollHeight);
      return next === prev.stacked && stackAt === prev.stackAt ? prev : { stacked: next, stackAt };
    });
  }, [field, stackAt]);
  useLayoutEffect(measure, [measure, draft]);
  useEffect(() => {
    const el = field.current;
    if (el === null || !hasResizeObserver()) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [field, measure]);
  return state.stacked;
}
