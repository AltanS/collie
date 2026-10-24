import { useCallback, useEffect, useRef, useState } from "react";

import type { PaneNav } from "@/hooks/use-display-prefs";
import { buzz } from "@/lib/haptics";
import {
  CLICK_SWALLOW_MS,
  DEFAULT_TUNING,
  idleGesture,
  isArmed,
  isTerminal,
  reduceGesture,
  swallowsClick,
  type GestureEvent,
  type GestureKind,
  type GestureState,
  type Lift,
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
// NOTHING IS HELD OFF AT REST, NOR DURING A HOLD. Text selection stays on in the chat (Altan's
// decision, 2026-10-24), and that includes the long press that starts a selection and the long-press
// menu. So a lone hold of the first finger, however long, arms nothing: no overlay, no buzz, nothing
// prevented (release counsel, 2026-10-25). The mode ARMS only when a second finger lands while the
// first has been down and still for 300 ms. Only then does the page lose its own handling: the buzz,
// the overlay, the selection cleared, the root's `user-select: none`, and `contextmenu`, `selectstart`
// and every `touchmove` prevented, with non-passive listeners. Commit, cancel and unmount give that
// back.
//
// AN ARMED TOUCH NEVER CLICKS. Once a touch sequence armed, the lift of each of its fingers is
// prevented (no tap on what is under it: a belt pill, an Allow button, a link), a click that still
// arrives within 400 ms where a finger lifted is swallowed in the capture phase, and its long-press
// menu stays refused until every finger is up. That holds after a cancel too. The lifts and the one
// `click` listener that swallows live at module scope (below), because a commit remounts the view.
//
// A SECOND FINGER INSIDE THE HOLD IS A PINCH. It lands before 300 ms, so the machine cancels and the
// rest of that touch sequence is left to the browser: nothing arms until every finger has lifted. A
// third finger, a drift past 24 px, a scroll the browser took, a hold that starts in a system
// back-gesture edge zone and the browser's own cancel end the gesture the same way.
//
// The Joystick handle is `touch-none` and holds no text, so it holds the page off at its own arm.
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
 * Hold the page's own touch handling off, and return the way back. Both methods call it at the arm:
 * Two fingers when the second finger lands after the hold, the Joystick when its hold ends. The
 * root's `user-select` is put back exactly as it was, inline value and all.
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

// ── THE CLICK SWALLOW OUTLIVES THE PANE VIEW ────────────────────────────────────────────────────────
// A commit moves to another pane, and routes/detail.tsx keys AgentChat by the pane's address, so the
// view whose hook heard the lift unmounts before the browser's click of that lift can arrive. So the
// lifts of an armed sequence, and the one capture `click` listener that swallows them, are the page's,
// not the view's: installed at the first Two fingers mount and kept for the life of the page. At rest
// the listener returns at once.

/** Where the fingers of an armed sequence lifted, for the click that may still follow. */
let armedLifts: Lift[] = [];
let swallowInstalled = false;

/** The click a browser still makes of an armed lift, swallowed before anything hears it. */
function swallowArmedClick(e: MouseEvent): void {
  if (armedLifts.length === 0) return;
  const ms = now();
  armedLifts = armedLifts.filter((l) => ms - l.ms <= CLICK_SWALLOW_MS);
  if (!swallowsClick(armedLifts, { x: e.clientX, y: e.clientY }, ms)) return;
  veto(e);
  e.stopImmediatePropagation();
}

function installClickSwallow(): void {
  if (swallowInstalled) return;
  swallowInstalled = true;
  document.addEventListener("click", swallowArmedClick, { capture: true, passive: false });
}

/** The fingers of an armed sequence lifted here, now. */
function noteArmedLifts(changed: readonly TouchLike[]): void {
  const ms = now();
  armedLifts = [...armedLifts.filter((l) => ms - l.ms <= CLICK_SWALLOW_MS), ...changed.map((t) => ({ x: t.clientX, y: t.clientY, ms }))];
}

/** Test seam: forget the lifts, as a fresh page would. */
export function __resetPaneNavClickSwallow(): void {
  armedLifts = [];
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
  /** The mode armed, after the buzz (the first-arm hint listens here). */
  onArm?: ((kind: GestureKind) => void) | undefined;
}

/**
 * Pane navigation by gesture, for the pane screen. Returns the machine's state, which the overlay
 * draws (components/pane-nav-overlay.tsx). Off, or with no map, attaches nothing at all.
 */
export function usePaneNavGesture({ method, reading, handle, layout, onCommit, onSwitcher, onArm }: PaneNavGestureOptions): GestureState {
  const kind: GestureKind = method === "joystick" ? "stick" : "chord";
  const [state, setState] = useState(() => idleGesture(kind));
  const machine = useRef(state);
  /** The way back from {@link holdOffPage}, while the page is held off. */
  const restore = useRef<(() => void) | null>(null);
  const live = useRef({ layout, onCommit, onSwitcher, onArm, kind });
  live.current = { layout, onCommit, onSwitcher, onArm, kind };

  const release = useCallback(() => {
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
        restore.current ??= holdOffPage();
        live.current.onArm?.(next.kind);
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

  // A method change starts the machine afresh.
  useEffect(() => {
    machine.current = idleGesture(kind);
    setState(machine.current);
  }, [kind]);

  const enabled = method !== "off" && layout !== null;

  // ── Two fingers: the reading area's hold, then a second finger anywhere ─────────────────────────
  useEffect(() => {
    if (!enabled || method !== "twoFingers" || reading === null) return;
    let first: number | null = null;
    let second: number | null = null;
    /** A touch sequence that is not ours (a pinch, a cancelled hold): nothing arms until all fingers lift. */
    let blocked = false;
    /** This touch sequence armed the mode: its lifts never click and its long press shows no menu,
     *  until every finger is up, even after a cancel. */
    let guarded = false;
    installClickSwallow();
    let unlift: (() => void) | null = null;
    const reset = () => {
      unlift?.();
      unlift = null;
      first = null;
      second = null;
    };
    /** The machine ended this sequence without a commit while a finger is still down: block the rest. */
    const ended = () => {
      if (first === null) return;
      if (machine.current.phase === "idle") {
        reset();
        blocked = true;
      }
    };
    /** Every finger is up: the next touch is a fresh sequence. */
    const allUp = () => {
      blocked = false;
      guarded = false;
    };
    /** The first finger is down by our count but not in the live list: its lift was lost. Cancel. */
    const lost = (e: TouchEvent): boolean => {
      if (first === null || find(e.touches, first) !== undefined) return false;
      if (find(e.changedTouches, first) !== undefined && (e.type === "touchend" || e.type === "touchcancel")) return false;
      send({ t: "cancel", why: "the first finger's lift was lost" });
      reset();
      blocked = list(e.touches).length > 0;
      if (!blocked) guarded = false;
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
      // One finger down is a fresh sequence: no earlier finger can still be down.
      if (touches.length === 1) allUp();
      // A finger that lands on an armed sequence is part of the gesture, never a tap or a pinch.
      if (guarded && e.cancelable) e.preventDefault();
      if (first === null) {
        if (blocked || touches.length !== 1) {
          blocked = touches.length > 0;
          return;
        }
        const t = touches[0];
        const layoutNow = live.current.layout;
        if (t === undefined || layoutNow === null || !startsOnReading(e.target, reading)) return;
        first = t.identifier;
        unlift = watchLift(e.target, onEnd);
        // No timer: a lone hold arms nothing. The machine reads the hold from the second finger's time.
        send({ t: "down", at: at(t), layout: layoutNow, ms: now(), width: window.innerWidth });
        ended();
        return;
      }
      lostSecond(e);
      for (const t of list(e.changedTouches)) {
        if (t.identifier === first || t.identifier === second || first === null) continue;
        const wasSecond = second;
        if (wasSecond === null) second = t.identifier;
        // The second finger arms (or is a pinch); with one already down it is a third, and cancels.
        send({ t: "second-down", at: at(t), ms: now() });
        if (isArmed(machine.current.phase)) guarded = true;
        ended();
      }
      if (guarded && e.cancelable) e.preventDefault();
    };

    const onMove = (e: TouchEvent) => {
      if (lost(e) || first === null) return;
      lostSecond(e);
      // The browser has begun a scroll with this finger: its moves can no longer be refused, so it
      // was moving, not holding. Armed, every move is refused, so this cannot happen there.
      if (machine.current.phase === "holding" && !e.cancelable) send({ t: "cancel", why: "the browser took the touch for a scroll" });
      const f = find(e.touches, first);
      if (f !== undefined) send({ t: "move", at: at(f), ms: now() });
      const s = second === null ? undefined : find(e.touches, second);
      if (s !== undefined) send({ t: "second-move", at: at(s), ms: now() });
      ended();
    };

    function onEnd(e: TouchEvent) {
      lost(e);
      const changed = list(e.changedTouches);
      if (guarded) {
        // The lift of an armed touch must not become a tap on what is under the finger.
        if (e.cancelable) e.preventDefault();
        noteArmedLifts(changed);
      }
      const gone = new Set(changed.map((t) => t.identifier));
      if (first !== null && e.type === "touchcancel") {
        send({ t: "cancel", why: "the browser cancelled the touch" });
        reset();
        blocked = list(e.touches).length > 0;
      }
      if (first !== null && second !== null && gone.has(second)) {
        second = null;
        send({ t: "second-up" });
      }
      if (first !== null && gone.has(first)) {
        const t = changed.find((x) => x.identifier === first);
        if (t !== undefined) send({ t: "up", at: at(t), ms: now() });
        reset();
        // The second finger may still be down (a cancel): the rest of the sequence is not ours.
        blocked = list(e.touches).length > 0;
      }
      if (list(e.touches).length === 0) allUp();
    }

    /** The browser took a touch pointer away (a pan, a system gesture): the same as a touchcancel. */
    const onPointerCancel = (e: PointerEvent) => {
      if (first === null || e.pointerType !== "touch") return;
      send({ t: "cancel", why: "the browser cancelled the pointer" });
      reset();
      blocked = true;
    };
    /** The long-press menu of an armed sequence, refused for that sequence only. */
    const onContextMenu = (e: Event) => {
      if (guarded) veto(e);
    };
    const opts = { capture: true, passive: false } as const;
    document.addEventListener("touchstart", onStart, opts);
    document.addEventListener("touchmove", onMove, opts);
    document.addEventListener("touchend", onEnd, opts);
    document.addEventListener("touchcancel", onEnd, opts);
    document.addEventListener("pointercancel", onPointerCancel, opts);
    document.addEventListener("contextmenu", onContextMenu, opts);
    return () => {
      document.removeEventListener("touchstart", onStart, opts);
      document.removeEventListener("touchmove", onMove, opts);
      document.removeEventListener("touchend", onEnd, opts);
      document.removeEventListener("touchcancel", onEnd, opts);
      document.removeEventListener("pointercancel", onPointerCancel, opts);
      document.removeEventListener("contextmenu", onContextMenu, opts);
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
