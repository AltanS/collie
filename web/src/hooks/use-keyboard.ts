import { useEffect, useState } from "react";

// Detect whether the on-screen keyboard is open by watching the visual viewport height.
//
// The viewport meta uses `interactive-widget=resizes-content`, so when the soft keyboard opens BOTH
// the layout and visual viewport shrink together — which means the usual trick of comparing
// `window.innerHeight` to `visualViewport.height` reads ~0 and can't see the keyboard. What DOES
// still change is the absolute height: it drops by the keyboard's height. So we remember the tallest
// height seen while closed (the baseline) and call the keyboard "open" once the current height falls
// well below it.
//
// Why this exists: a textarea keeps DOM focus when Android collapses the keyboard (no `blur` fires),
// so focus alone can't tell us the keyboard closed — but the viewport resize always does.
//
// ── AND WHY IT IS FOCUS-BLIND, DELIBERATELY ──────────────────────────────────
// "Composer focused" is the wrong question for anything that spends SPACE. Focus takes no pixels: a
// hardware keyboard, or a desktop browser, gives focus with the whole viewport still there, and
// unpainting a row in that state is theft with no compensation. The keyboard is what took the
// pixels, so the keyboard is what may spend them. The two also genuinely disagree — the header
// paragraph above is that exact case, focus true and keyboard false — and in it the space is BACK,
// so the chrome must come back with it.

// Threshold (px) for the height drop that OPENS the mode: large enough to ignore the URL bar
// showing/hiding (~60–100px), smaller than any soft keyboard (~250px+).
const KEYBOARD_MIN_PX = 150;

// …and the smaller drop at which it CLOSES again. The two differ on purpose, and the gap between
// them is the whole point.
//
// This used to be one number, which is correct for gating a strip and wrong the moment layout hangs
// off the answer. With a single threshold a viewport hovering at the boundary — a split-screen
// resize, a floating or split keyboard, a predictive-text bar collapsing, a keyboard animating shut
// in steps — flips the boolean repeatedly, and each flip now moves a third of the screen. Hysteresis
// is the standard repair: once open, the height must come back most of the way before we believe the
// keyboard is gone, so the boundary can be crossed but not oscillated across.
//
// 100 rather than 150 also fixes the other half. `baseline` only ever ratchets UP, so a URL bar
// hiding raises it ~60–100px for the rest of the session; with the close test at the same 150 as the
// open test, a genuinely-closed keyboard could sit inside the dead band and strand the operator in a
// composing layout with no keyboard on screen. A closer threshold cannot: the ratchet's own error is
// bounded by the URL bar's height, which is under 100.
const KEYBOARD_CLOSE_PX = 100;

/** Pure predicate (testable): the keyboard is likely open when the height dropped past the threshold. */
export function keyboardLikelyOpen(
  baselineHeight: number,
  currentHeight: number,
  threshold = KEYBOARD_MIN_PX,
): boolean {
  return baselineHeight - currentHeight > threshold;
}

/**
 * The state machine, as a pure function of (where we were, how far down we are). Exported so the
 * hysteresis is testable without a browser — it is the half of this file most likely to be "tidied"
 * back into one threshold by someone who reads only the open edge.
 */
export function nextKeyboardOpen(
  wasOpen: boolean,
  baselineHeight: number,
  currentHeight: number,
): boolean {
  return wasOpen
    ? keyboardLikelyOpen(baselineHeight, currentHeight, KEYBOARD_CLOSE_PX)
    : keyboardLikelyOpen(baselineHeight, currentHeight, KEYBOARD_MIN_PX);
}

export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let baseline = vv.height;
    let baselineWidth = vv.width;
    // The previous ANSWER, kept here rather than read back out of React state: `update` is a stable
    // closure registered once, so it would capture the first `open` forever. This is the input the
    // hysteresis above needs, and it must be the value the last event produced, not the value the
    // last render saw.
    let wasOpen = false;
    const update = () => {
      // A width change is an orientation/layout change, not the keyboard — re-baseline so a portrait
      // baseline doesn't read as "open" in landscape.
      if (vv.width !== baselineWidth) {
        baselineWidth = vv.width;
        baseline = vv.height;
        wasOpen = false;
        setOpen(false);
        return;
      }
      baseline = Math.max(baseline, vv.height);
      wasOpen = nextKeyboardOpen(wasOpen, baseline, vv.height);
      setOpen(wasOpen);
    };
    update();
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, []);
  return open;
}
