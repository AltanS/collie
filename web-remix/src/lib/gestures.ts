// The three gestures, as `createMixin` mixins that dispatch ONE bubbling, namespaced, typed event
// (REMIX3.md, "Events and gestures"; Remix `docs/interactions.md`, "Drag Release Mixin"):
//
//   longPress()  `app:longpress`  web/src/hooks/use-long-press.ts: 450 ms, 16 px tolerance,
//                                 `data-holding` from 150 ms, `contextmenu` as the second trigger,
//                                 the following click swallowed, a 10 ms haptic on fire.
//   pull()       `app:pull`       web/src/hooks/use-sheet-pull.ts: a vertical drag opens at 120 px
//                                 or 0.6 px/ms; a sideways start abandons it. `app:pullmove` carries
//                                 the live distance for a peeking sheet.
//   swipeUp()    `app:swipeup`    web/src/hooks/use-swipe.ts: a dominant upward move past 36 px.
//
// Each mixin only binds a controller to its host node on `insert` and aborts it on `remove`. The
// controllers are plain functions over the node with injectable timers, so `gestures.test.ts` drives
// them with a fake clock and no browser. They never call `update()`: a gesture writes the DOM it owns
// (`data-holding`, an inline animation duration) and dispatches events; the owner re-renders itself.
//
// POINTER EVENTS, NOT TOUCH EVENTS. web/ wrote pull and swipe over touch events. Here both use
// pointer events with pointer capture once the drag engages, which needs the browser to leave the
// vertical axis alone: the host gets `touch-action: pan-x` when its computed value is `auto` (the belt
// wears `touch-pan-x` in web/ for this exact reason, web/src/components/actions-row.tsx). Long-press
// sets no `touch-action`, as web/ does not: the row stays scrollable and a scroll cancels the hold.
import { createMixin } from "remix/component";

import { maxPullForAnchor, shouldOpen, SLOP } from "@web/hooks/use-sheet-pull";
import { isSwipeUp } from "@web/hooks/use-swipe";

import { buzz } from "./prefs";

// ── Events ─────────────────────────────────────────────────────────────────────────────────────────

export const LONG_PRESS_EVENT = "app:longpress" as const;
export const LONG_PRESS_RELEASE_EVENT = "app:longpressrelease" as const;
export const PULL_MOVE_EVENT = "app:pullmove" as const;
export const PULL_EVENT = "app:pull" as const;
export const SWIPE_UP_EVENT = "app:swipeup" as const;

/** The hold counted. Fired by the timer or by `contextmenu`, once per gesture. */
export class LongPressEvent extends Event {
  constructor() {
    super(LONG_PRESS_EVENT, { bubbles: true, cancelable: true });
  }
}

/**
 * The finger lifted after a hold that counted, from the trusted pointer or contextmenu event. For the
 * browser APIs that refuse a call made from a timer (focusing a field to raise the phone keyboard),
 * which is web/'s `onReleaseAfterLongPress`.
 */
export class LongPressReleaseEvent extends Event {
  constructor() {
    super(LONG_PRESS_RELEASE_EVENT, { bubbles: true });
  }
}

/** A pull in progress: the upward distance now, and the host's distance from the viewport bottom. */
export class PullMoveEvent extends Event {
  readonly pull: number;
  readonly anchor: number;
  constructor(distance: number, anchor: number) {
    super(PULL_MOVE_EVENT, { bubbles: true });
    this.pull = distance;
    this.anchor = anchor;
  }
}

/** A pull ended. `open` is web/'s `shouldOpen(pull, velocity)`; false is a cancel. */
export class PullEvent extends Event {
  readonly pull: number;
  readonly velocity: number;
  readonly open: boolean;
  constructor(distance: number, velocity: number) {
    super(PULL_EVENT, { bubbles: true, cancelable: true });
    this.pull = distance;
    this.velocity = velocity;
    this.open = shouldOpen(distance, velocity);
  }
}

export class SwipeUpEvent extends Event {
  constructor() {
    super(SWIPE_UP_EVENT, { bubbles: true, cancelable: true });
  }
}

declare global {
  interface HTMLElementEventMap {
    [LONG_PRESS_EVENT]: LongPressEvent;
    [LONG_PRESS_RELEASE_EVENT]: LongPressReleaseEvent;
    [PULL_MOVE_EVENT]: PullMoveEvent;
    [PULL_EVENT]: PullEvent;
    [SWIPE_UP_EVENT]: SwipeUpEvent;
  }
}

// ── The node and the timers, as narrow as the controllers need ─────────────────────────────────────

/** What a controller touches on its host. An `HTMLElement` satisfies it; a test fake can too. */
export interface GestureNode extends EventTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  readonly style: { animationDuration: string; touchAction: string; setProperty(name: string, value: string): void };
  setPointerCapture?(pointerId: number): void;
  hasPointerCapture?(pointerId: number): boolean;
  releasePointerCapture?(pointerId: number): void;
  getBoundingClientRect?(): { top: number };
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

/** The fields of a pointer event the controllers read. */
type Pointer = Event & { clientX: number; clientY: number; button?: number; isPrimary?: boolean; pointerId?: number };

function listen(node: EventTarget, type: string, fn: (event: Pointer) => void, signal: AbortSignal, capture = false): void {
  // SAFETY: `listen` is only called with pointer, mouse and click event types, whose events all
  // carry the coordinates and the button `Pointer` names.
  node.addEventListener(type, (event) => fn(event as Pointer), { signal, capture });
}

// ── Long-press ─────────────────────────────────────────────────────────────────────────────────────

export const LONG_PRESS_MS = 450;
export const MOVE_CANCEL_PX = 16;
export const HOLD_FEEDBACK_DELAY_MS = 150;

export interface LongPressOptions {
  /** Off: the host takes plain taps only, and nothing about it changes. */
  disabled?: boolean;
  delayMs?: number;
  moveTolerance?: number;
}

/**
 * Bind web/'s long-press to `node` until `signal` aborts. `options` is read at each gesture's start,
 * so a mixin re-render that changes them takes effect on the next press.
 */
export function attachLongPress(
  node: GestureNode,
  options: () => LongPressOptions,
  signal: AbortSignal,
  timers: Timers = realTimers,
): void {
  let timer: number | null = null;
  let feedback: number | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  let released = false;
  let tolerance = MOVE_CANCEL_PX;

  const clear = (): void => {
    if (timer !== null) timers.clearTimeout(timer);
    if (feedback !== null) timers.clearTimeout(feedback);
    timer = null;
    feedback = null;
    start = null;
    node.removeAttribute("data-holding");
    node.style.animationDuration = "";
  };
  const fire = (): void => {
    if (options().disabled || fired) return;
    fired = true;
    clear(); // the look ends the moment the hold counts, not when the finger lifts
    buzz();
    node.dispatchEvent(new LongPressEvent());
  };
  const release = (): void => {
    if (!fired || released) return;
    released = true;
    node.dispatchEvent(new LongPressReleaseEvent());
  };
  const end = (event: Pointer): void => {
    clear();
    if (!fired) return;
    // Keep the button's pointer-up default from taking focus back after the owner moved it.
    event.preventDefault();
    release();
  };

  listen(node, "pointerdown", (event) => {
    const opts = options();
    if (opts.disabled) return;
    // A fresh press is a fresh gesture, even a right-click that reaches us through `contextmenu`.
    fired = false;
    released = false;
    if ((event.button ?? 0) !== 0) return;
    const delay = opts.delayMs ?? LONG_PRESS_MS;
    tolerance = opts.moveTolerance ?? MOVE_CANCEL_PX;
    start = { x: event.clientX, y: event.clientY };
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(fire, delay);
    if (feedback !== null) timers.clearTimeout(feedback);
    feedback =
      delay > HOLD_FEEDBACK_DELAY_MS
        ? timers.setTimeout(() => {
            feedback = null;
            node.setAttribute("data-holding", "");
            // The fill runs over the time LEFT to the hold's mark (web/src/index.css, THE HOLD, SHOWN).
            node.style.animationDuration = `${String(delay - HOLD_FEEDBACK_DELAY_MS)}ms`;
          }, HOLD_FEEDBACK_DELAY_MS)
        : null;
  }, signal);
  listen(node, "pointermove", (event) => {
    if (start === null) return;
    if (Math.abs(event.clientX - start.x) > tolerance || Math.abs(event.clientY - start.y) > tolerance) clear();
  }, signal);
  listen(node, "pointerup", end, signal);
  listen(node, "pointerleave", end, signal);
  listen(node, "pointercancel", end, signal);
  listen(node, "contextmenu", (event) => {
    if (options().disabled) return;
    event.preventDefault(); // the native menu never takes the gesture
    fire();
    release();
  }, signal);
  // Capture: runs before the host's own click handlers, so a hold opens its sheet WITHOUT also tapping.
  listen(
    node,
    "click",
    (event) => {
      if (!fired) return;
      release();
      fired = false;
      released = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    signal,
    true,
  );
  signal.addEventListener("abort", clear, { once: true });
}

function noCallout(node: GestureNode): void {
  // web/ asks every caller for these two: they stop the iOS loupe and callout that cancel a hold.
  node.style.setProperty("-webkit-touch-callout", "none");
  node.style.setProperty("user-select", "none");
  node.style.setProperty("-webkit-user-select", "none");
}

const longPressMixin = createMixin<HTMLElement, [options: LongPressOptions]>((handle) => {
  let current: LongPressOptions = {};
  let bound: AbortController | null = null;
  handle.addEventListener("insert", (event) => {
    bound?.abort();
    bound = new AbortController();
    noCallout(event.node);
    attachLongPress(event.node, () => current, bound.signal);
  });
  handle.addEventListener("remove", () => {
    bound?.abort();
    bound = null;
  });
  return (options) => {
    current = options;
  };
});

/** Long-press on the host. Listen with `on(LONG_PRESS_EVENT, ...)`. */
export function longPress(options: LongPressOptions = {}) {
  return longPressMixin(options);
}

// ── Pull ───────────────────────────────────────────────────────────────────────────────────────────

/** Trailing window the release velocity is measured over (web/src/hooks/use-sheet-pull.ts). */
const VELOCITY_WINDOW_MS = 80;

export interface PullOptions {
  disabled?: boolean;
  /** Hard clamp on the reported pull. Defaults to the sheet's own 82dvh ceiling less the anchor. */
  max?: number;
}

function keepVerticalForUs(node: HTMLElement): void {
  if (getComputedStyle(node).touchAction === "auto") node.style.touchAction = "pan-x";
}

export function attachPull(
  node: GestureNode,
  options: () => PullOptions,
  signal: AbortSignal,
  viewportHeight: () => number = () => window.innerHeight,
): void {
  let startX = 0;
  let startY = 0;
  let tracking = false;
  let engaged = false;
  let abandoned = false;
  let anchor = 0;
  let pointerId = -1;
  let samples: { t: number; y: number }[] = [];

  const clamp = (px: number): number => {
    const cap = options().max ?? maxPullForAnchor(anchor, viewportHeight() * 0.82);
    return Math.min(Math.max(px, 0), cap);
  };

  listen(node, "pointerdown", (event) => {
    if (options().disabled || event.isPrimary === false || (event.button ?? 0) !== 0) return;
    tracking = true;
    engaged = false;
    abandoned = false;
    startX = event.clientX;
    startY = event.clientY;
    pointerId = event.pointerId ?? -1;
    samples = [{ t: event.timeStamp, y: event.clientY }];
    anchor = viewportHeight() - (node.getBoundingClientRect?.().top ?? viewportHeight());
  }, signal);
  listen(node, "pointermove", (event) => {
    if (!tracking || abandoned) return;
    const dy = startY - event.clientY; // positive = up
    const dx = event.clientX - startX;
    if (!engaged) {
      const ay = Math.abs(dy);
      const ax = Math.abs(dx);
      if (ax > SLOP && ax > ay) {
        abandoned = true;
        return;
      }
      if (ay > SLOP && ay >= ax) {
        engaged = true;
        // Captured only once it is a drag, so a tap on a pill still clicks the pill.
        if (pointerId >= 0) node.setPointerCapture?.(pointerId);
      }
    }
    if (!engaged) return;
    event.preventDefault();
    samples.push({ t: event.timeStamp, y: event.clientY });
    const cutoff = event.timeStamp - VELOCITY_WINDOW_MS;
    samples = samples.filter((s) => s.t >= cutoff);
    node.dispatchEvent(new PullMoveEvent(clamp(dy), anchor));
  }, signal);
  const end = (): void => {
    const was = engaged;
    tracking = false;
    engaged = false;
    if (!was) return;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const distance = clamp(last ? startY - last.y : 0);
    const velocity = first && last && last.t > first.t ? (first.y - last.y) / (last.t - first.t) : 0;
    if (pointerId >= 0 && node.hasPointerCapture?.(pointerId) === true) node.releasePointerCapture?.(pointerId);
    node.dispatchEvent(new PullEvent(distance, velocity));
  };
  listen(node, "pointerup", end, signal);
  listen(node, "pointercancel", end, signal);
}

const pullMixin = createMixin<HTMLElement, [options: PullOptions]>((handle) => {
  let current: PullOptions = {};
  let bound: AbortController | null = null;
  handle.addEventListener("insert", (event) => {
    bound?.abort();
    bound = new AbortController();
    keepVerticalForUs(event.node);
    attachPull(event.node, () => current, bound.signal);
  });
  handle.addEventListener("remove", () => {
    bound?.abort();
    bound = null;
  });
  return (options) => {
    current = options;
  };
});

/** A vertical pull on the host. Listen with `on(PULL_EVENT, ...)` and read `event.open`. */
export function pull(options: PullOptions = {}) {
  return pullMixin(options);
}

export interface SwipeUpOptions {
  disabled?: boolean;
}

// ── Swipe up ───────────────────────────────────────────────────────────────────────────────────────

export function attachSwipeUp(node: GestureNode, options: () => SwipeUpOptions, signal: AbortSignal): void {
  let start: { x: number; y: number } | null = null;
  listen(node, "pointerdown", (event) => {
    if (options().disabled || event.isPrimary === false) return;
    start = { x: event.clientX, y: event.clientY };
  }, signal);
  listen(node, "pointerup", (event) => {
    const s = start;
    start = null;
    if (s === null) return;
    if (isSwipeUp(event.clientX - s.x, event.clientY - s.y)) node.dispatchEvent(new SwipeUpEvent());
  }, signal);
  listen(node, "pointercancel", () => {
    start = null;
  }, signal);
}

const swipeUpMixin = createMixin<HTMLElement, [options: SwipeUpOptions]>((handle) => {
  let current: SwipeUpOptions = {};
  let bound: AbortController | null = null;
  handle.addEventListener("insert", (event) => {
    bound?.abort();
    bound = new AbortController();
    keepVerticalForUs(event.node);
    attachSwipeUp(event.node, () => current, bound.signal);
  });
  handle.addEventListener("remove", () => {
    bound?.abort();
    bound = null;
  });
  return (options) => {
    current = options;
  };
});

/** An upward swipe on the host. Listen with `on(SWIPE_UP_EVENT, ...)`. */
export function swipeUp(options: SwipeUpOptions = {}) {
  return swipeUpMixin(options);
}
