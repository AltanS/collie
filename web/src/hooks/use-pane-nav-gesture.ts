import { useCallback, useEffect, useRef, useState } from "react";

import type { PaneNav } from "@/hooks/use-display-prefs";
import { buzz } from "@/lib/haptics";
import {
  DEFAULT_TUNING,
  idleGesture,
  isArmed,
  isTerminal,
  reduceGesture,
  type GestureEvent,
  type GestureKind,
  type GestureState,
  type NavLayout,
  type Point,
} from "@/lib/pane-nav-gesture";

// The touch half of pane navigation by gesture (M70 spec 03, ADR 0121). This file turns touches into
// the events of lib/pane-nav-gesture.ts and acts on the phases the machine reaches; it decides nothing
// itself.
//
// TOUCH EVENTS, NOT POINTER EVENTS. While armed the mode must refuse the browser's own pan, pinch zoom,
// text selection and context menu, and a non-passive `touchmove` that calls preventDefault is the one
// switch that holds all of them off. Pointer events cannot veto a pan. Both methods are touch only.
//
// NOTHING IS HELD OFF AT REST, NOR AT THE ARM. Text selection stays on in the chat (Altan's decision,
// 2026-10-24, restated after review), and that includes the long press that starts a selection. The
// 300 ms arm comes before the browser's own long press (about 400 to 500 ms), so the Two fingers arm
// happens in two steps:
//   1. READY. The hold ends: a buzz and the overlay, and nothing else. The page keeps every gesture of
//      its own. If the browser now starts a selection or its long-press menu (`selectstart`,
//      `contextmenu`), or takes the finger for a scroll (a `touchmove` that can no longer be
//      cancelled), the gesture cancels and the browser wins.
//   2. HELD OFF. A second finger lands. Only now does the page lose its own handling: the selection
//      is cleared, the root takes `user-select: none`, `contextmenu` and `selectstart` are prevented,
//      and so is every `touchmove`, with non-passive listeners. Commit, cancel and unmount give all
//      of it back.
// The Joystick handle is `touch-none` and holds no text, so it holds the page off at its arm.
//
// A SECOND FINGER INSIDE THE HOLD IS A PINCH. It lands before the mode arms, so the machine cancels and
// the rest of that touch sequence is left to the browser: nothing arms until every finger has lifted.
//
// A LOST LIFT IS RECONCILED. The touch events of a finger go to the node it landed on. When React
// removes that node mid-touch, its touchend no longer reaches the document. So the node itself is
// watched for the lift, and every touch event checks the live touch list for the finger it follows: a
// finger that is gone cancels the gesture, and it never stays armed with no finger down.

/** What the reading area's first finger must not start on: the controls inside it. */
const NOT_READING =
  'button, a, input, textarea, select, label, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="slider"], [role="menuitem"], [data-pane-nav-ignore]';

/** Whether a touch on `target` may start the two-finger hold: inside the reading area, on no control. */
export function startsOnReading(target: EventTarget | null, reading: HTMLElement): boolean {
  if (!(target instanceof Element) || !reading.contains(target)) return false;
  const control = target.closest(NOT_READING);
  return control === null || !reading.contains(control);
}

interface TouchLike {
  readonly identifier: number;
  readonly clientX: number;
  readonly clientY: number;
}

function list(touches: TouchList | readonly TouchLike[] | undefined): TouchLike[] {
  return touches === undefined ? [] : Array.from<TouchLike>(touches);
}

function find(touches: TouchList | readonly TouchLike[] | undefined, id: number): TouchLike | undefined {
  return list(touches).find((t) => t.identifier === id);
}

/** The hold look starts this long after the finger lands, as hooks/use-long-press.ts does. */
const HOLD_SHOWN_MS = 150;

const at = (t: TouchLike): Point => ({ x: t.clientX, y: t.clientY });
const now = () => performance.now();

/** The page's own handling of an event, refused. */
function veto(e: Event): void {
  if (e.cancelable) e.preventDefault();
}

/**
 * Hold the page's own touch handling off, and return the way back. Two fingers calls it once the
 * second finger lands, the Joystick at its arm. The root's `user-select` is put back exactly as it
 * was, inline value and all.
 */
export function holdOffPage(): () => void {
  const root = document.documentElement;
  const before = { userSelect: root.style.getPropertyValue("user-select"), webkit: root.style.getPropertyValue("-webkit-user-select") };
  window.getSelection()?.removeAllRanges();
  root.style.setProperty("user-select", "none");
  root.style.setProperty("-webkit-user-select", "none");
  const opts = { capture: true, passive: false } as const;
  document.addEventListener("contextmenu", veto, opts);
  document.addEventListener("selectstart", veto, opts);
  document.addEventListener("touchmove", veto, opts);
  return () => {
    document.removeEventListener("contextmenu", veto, opts);
    document.removeEventListener("selectstart", veto, opts);
    document.removeEventListener("touchmove", veto, opts);
    const put = (prop: string, value: string) => (value === "" ? root.style.removeProperty(prop) : root.style.setProperty(prop, value));
    put("user-select", before.userSelect);
    put("-webkit-user-select", before.webkit);
  };
}

/**
 * While ready (armed, no second finger yet), let the browser's own selection and long-press menu win:
 * either one calls `onYield`, and neither is prevented. Returns the way to stop watching.
 */
export function yieldToSelection(onYield: () => void): () => void {
  const opts = { capture: true, passive: true } as const;
  const fire = () => onYield();
  document.addEventListener("selectstart", fire, opts);
  document.addEventListener("contextmenu", fire, opts);
  return () => {
    document.removeEventListener("selectstart", fire, opts);
    document.removeEventListener("contextmenu", fire, opts);
  };
}

/**
 * The lift of a finger whose node left the document mid-touch. Its touchend and touchcancel go to the
 * detached node and never reach a document listener, so they are heard on the node itself. While the
 * node is still connected the document listener has already handled the event, and this one stays out.
 */
function watchLift(target: EventTarget | null, onLift: (e: TouchEvent) => void): () => void {
  if (!(target instanceof Node)) return () => {};
  const lift = (e: Event) => {
    if (!target.isConnected && e instanceof TouchEvent) onLift(e);
  };
  target.addEventListener("touchend", lift);
  target.addEventListener("touchcancel", lift);
  return () => {
    target.removeEventListener("touchend", lift);
    target.removeEventListener("touchcancel", lift);
  };
}

export interface PaneNavGestureOptions {
  method: PaneNav;
  /** The pane screen's reading area: the Chat stream or the terminal mirror. Two fingers. */
  reading: HTMLElement | null;
  /** The joystick handle above the belt. Joystick. */
  handle: HTMLElement | null;
  /** The map a gesture starts from, or null when there is nowhere to move (no gesture then). */
  layout: NavLayout | null;
  /** The finger lifted on a target: move there. The caller skips a target that is the pane on screen. */
  onCommit: (target: NavLayout) => void;
  /** A quick drag up on the joystick handle: the switcher sheet. */
  onSwitcher?: (() => void) | undefined;
}

/**
 * Pane navigation by gesture, for the pane screen. Returns the machine's state, which the overlay
 * draws (components/pane-nav-overlay.tsx). Off, or with no map, attaches nothing at all.
 */
export function usePaneNavGesture({ method, reading, handle, layout, onCommit, onSwitcher }: PaneNavGestureOptions): GestureState {
  const kind: GestureKind = method === "joystick" ? "stick" : "chord";
  const [state, setState] = useState(() => idleGesture(kind));
  const machine = useRef(state);
  /** The way back from {@link holdOffPage}, while the page is held off. */
  const restore = useRef<(() => void) | null>(null);
  /** The way to stop {@link yieldToSelection}, while Two fingers is ready and not yet held off. */
  const unwatch = useRef<(() => void) | null>(null);
  const live = useRef({ layout, onCommit, onSwitcher, kind });
  live.current = { layout, onCommit, onSwitcher, kind };

  const release = useCallback(() => {
    unwatch.current?.();
    unwatch.current = null;
    restore.current?.();
    restore.current = null;
  }, []);

  /** Reduce synchronously, so a burst of touches in one frame never merges two transitions, then act. */
  const send = useCallback(
    (e: GestureEvent) => {
      const prev = machine.current;
      const next = reduceGesture(prev, e, DEFAULT_TUNING[prev.kind]);
      if (next === prev) return;
      machine.current = next;
      if (!isArmed(prev.phase) && isArmed(next.phase)) {
        buzz();
        // Two fingers is READY: the browser's selection may still take the touch (see the top).
        if (next.kind === "chord") unwatch.current ??= yieldToSelection(() => sendRef.current({ t: "cancel", why: "the browser started a selection" }));
        else restore.current ??= holdOffPage();
      }
      // The second finger landed: now the page is held off.
      if (isArmed(next.phase) && next.second !== null && restore.current === null) {
        unwatch.current?.();
        unwatch.current = null;
        restore.current = holdOffPage();
      }
      if (isTerminal(next.phase)) {
        release();
        if (next.phase === "commit" && next.target !== null) live.current.onCommit(next.target);
        if (next.phase === "flick") live.current.onSwitcher?.();
        machine.current = reduceGesture(next, { t: "settle" }, DEFAULT_TUNING[next.kind]);
      }
      setState(machine.current);
    },
    [release],
  );
  const sendRef = useRef(send);
  sendRef.current = send;

  // A method change starts the machine afresh.
  useEffect(() => {
    machine.current = idleGesture(kind);
    setState(machine.current);
  }, [kind]);

  const enabled = method !== "off" && layout !== null;

  // ── Two fingers: the reading area's hold, then a second finger anywhere ─────────────────────────
  useEffect(() => {
    if (!enabled || method !== "twoFingers" || reading === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let first: number | null = null;
    let second: number | null = null;
    /** A touch sequence that is not ours (a pinch, a cancelled hold): nothing arms until all fingers lift. */
    let blocked = false;
    let unlift: (() => void) | null = null;
    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const reset = () => {
      clear();
      unlift?.();
      unlift = null;
      first = null;
      second = null;
    };
    const ended = () => {
      if (first === null) return;
      if (machine.current.phase === "idle") {
        reset();
        blocked = true;
      }
    };
    /** The first finger is down by our count but not in the live list: its lift was lost. Cancel. */
    const lost = (e: TouchEvent): boolean => {
      if (first === null || find(e.touches, first) !== undefined) return false;
      if (find(e.changedTouches, first) !== undefined && (e.type === "touchend" || e.type === "touchcancel")) return false;
      send({ t: "cancel", why: "the first finger's lift was lost" });
      reset();
      blocked = list(e.touches).length > 0;
      return true;
    };
    /** The same for the second finger: its lift was lost, so a new second finger may swipe. */
    const lostSecond = (e: TouchEvent) => {
      if (first === null || second === null || find(e.touches, second) !== undefined) return;
      second = null;
      send({ t: "second-up" });
    };

    const onStart = (e: TouchEvent) => {
      const touches = list(e.touches);
      lost(e);
      if (first === null) {
        // One finger down is a fresh sequence: no earlier finger can still be down.
        if (touches.length === 1) blocked = false;
        if (blocked || touches.length !== 1) {
          blocked = touches.length > 0;
          return;
        }
        const t = touches[0];
        const layoutNow = live.current.layout;
        if (t === undefined || layoutNow === null || !startsOnReading(e.target, reading)) return;
        first = t.identifier;
        unlift = watchLift(e.target, onEnd);
        send({ t: "down", at: at(t), layout: layoutNow, ms: now() });
        timer = setTimeout(() => {
          timer = null;
          send({ t: "hold-done" });
        }, DEFAULT_TUNING.chord.holdMs);
        return;
      }
      lostSecond(e);
      const wasArmed = isArmed(machine.current.phase);
      for (const t of list(e.changedTouches)) {
        if (t.identifier === first || second !== null) continue;
        second = t.identifier;
        send({ t: "second-down", at: at(t), ms: now() });
      }
      // Armed: a finger that lands is a move, never a pinch or a tap. Holding: the machine took it as a pinch.
      if (wasArmed && e.cancelable) e.preventDefault();
      ended();
    };

    const onMove = (e: TouchEvent) => {
      if (lost(e) || first === null) return;
      lostSecond(e);
      // Ready, and the browser has begun a scroll with this finger: its moves can no longer be refused.
      if (isArmed(machine.current.phase) && restore.current === null && !e.cancelable) send({ t: "cancel", why: "the browser took the touch for a scroll" });
      const f = find(e.touches, first);
      if (f !== undefined) send({ t: "move", at: at(f), ms: now() });
      const s = second === null ? undefined : find(e.touches, second);
      if (s !== undefined) send({ t: "second-move", at: at(s), ms: now() });
      ended();
    };

    function onEnd(e: TouchEvent) {
      lost(e);
      const gone = new Set(list(e.changedTouches).map((t) => t.identifier));
      if (first !== null && e.type === "touchcancel") {
        send({ t: "cancel", why: "the browser cancelled the touch" });
        reset();
      }
      if (first !== null && second !== null && gone.has(second)) {
        second = null;
        send({ t: "second-up" });
      }
      if (first !== null && gone.has(first)) {
        // The lift of an armed touch must not become a tap on the reading area.
        if (isArmed(machine.current.phase) && e.cancelable) e.preventDefault();
        const t = list(e.changedTouches).find((x) => x.identifier === first);
        if (t !== undefined) send({ t: "up", at: at(t), ms: now() });
        reset();
      }
      if (list(e.touches).length === 0) blocked = false;
    }

    const opts = { capture: true, passive: false } as const;
    document.addEventListener("touchstart", onStart, opts);
    document.addEventListener("touchmove", onMove, opts);
    document.addEventListener("touchend", onEnd, opts);
    document.addEventListener("touchcancel", onEnd, opts);
    return () => {
      document.removeEventListener("touchstart", onStart, opts);
      document.removeEventListener("touchmove", onMove, opts);
      document.removeEventListener("touchend", onEnd, opts);
      document.removeEventListener("touchcancel", onEnd, opts);
      const was = first;
      reset();
      if (was !== null) send({ t: "cancel", why: "the view went away" });
    };
  }, [enabled, method, reading, send]);

  // ── Joystick: hold the handle, then the same finger steers ──────────────────────────────────────
  useEffect(() => {
    const node = handle;
    if (!enabled || method !== "joystick" || node === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let look: ReturnType<typeof setTimeout> | null = null;
    let finger: number | null = null;
    // THE HOLD, SHOWN (DESIGN.md §2): the shared `data-holding` look, from 150ms after the finger lands
    // to the arm, over exactly the time left, so a tap never flashes and nothing but paint changes.
    const unlook = () => {
      if (look !== null) clearTimeout(look);
      look = null;
      delete node.dataset.holding;
      node.style.removeProperty("animation-duration");
    };
    const clear = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      unlook();
    };

    /** The finger is ours by our count but not in the live list: its lift was lost. Cancel. */
    const lost = (e: TouchEvent): boolean => {
      if (finger === null || find(e.touches, finger) !== undefined) return false;
      clear();
      finger = null;
      send({ t: "cancel", why: "the finger's lift was lost" });
      return true;
    };
    const onStart = (e: TouchEvent) => {
      lost(e);
      const t = list(e.changedTouches)[0];
      const layoutNow = live.current.layout;
      if (finger !== null || t === undefined || layoutNow === null || list(e.touches).length !== 1) return;
      finger = t.identifier;
      send({ t: "down", at: at(t), layout: layoutNow, ms: now() });
      const holdMs = DEFAULT_TUNING.stick.holdMs;
      look = setTimeout(() => {
        look = null;
        node.style.setProperty("animation-duration", `${holdMs - HOLD_SHOWN_MS}ms`);
        node.dataset.holding = "";
      }, HOLD_SHOWN_MS);
      timer = setTimeout(() => {
        timer = null;
        unlook();
        send({ t: "hold-done" });
      }, holdMs);
    };
    const onMove = (e: TouchEvent) => {
      if (lost(e) || finger === null) return;
      const t = find(e.touches, finger);
      if (t !== undefined) send({ t: "move", at: at(t), ms: now() });
      // A finger that moved before the hold will not arm: the hold look goes at once.
      if (machine.current.moved) unlook();
      // The handle is `touch-none`; this is for the browsers that read the listener, not the class.
      if (e.cancelable) e.preventDefault();
    };
    const onEnd = (e: TouchEvent) => {
      if (finger === null) return;
      const t = list(e.changedTouches).find((x) => x.identifier === finger);
      if (t === undefined) return;
      clear();
      finger = null;
      if (e.type === "touchcancel") send({ t: "cancel", why: "the browser cancelled the touch" });
      else send({ t: "up", at: at(t), ms: now() });
      if (e.cancelable) e.preventDefault();
    };

    const opts = { passive: false } as const;
    node.addEventListener("touchstart", onStart, opts);
    node.addEventListener("touchmove", onMove, opts);
    node.addEventListener("touchend", onEnd, opts);
    node.addEventListener("touchcancel", onEnd, opts);
    return () => {
      node.removeEventListener("touchstart", onStart);
      node.removeEventListener("touchmove", onMove);
      node.removeEventListener("touchend", onEnd);
      node.removeEventListener("touchcancel", onEnd);
      clear();
      if (finger !== null) send({ t: "cancel", why: "the view went away" });
    };
  }, [enabled, method, handle, send]);

  // Unmount (a commit moves to another pane, which remounts the view) gives the page back.
  useEffect(() => release, [release]);

  return state;
}
