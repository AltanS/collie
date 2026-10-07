// The glide: a row IS the next screen's header (D §12, ADR 0069). Port of web/src/lib/glide.ts, the
// rules unchanged: 250 ms ease-out (web/src/index.css `--glide-duration`/`--glide-ease`, imported by
// app.css), the parts that fly are the dot, the tile and the name, forward is the tap on the row,
// reverse is the in-app back arrow only (never the edge swipe), at most 120 ms of waiting for the
// next screen's data (`glideForwardWhenReady`, prefetch on `pointerdown`), else a plain slide.
// Skipped under reduced motion and where `document.startViewTransition` is missing.
//
// THE SEAM: probe 5's gated seam (spike/remix/probe5-motion/README.md, Q4). A navigation under
// `remix/spa` commits in microtasks when its route is instant, so a transition that WAITS for
// `reloadComplete` inside its update callback captures the new page as the "old" one, misses the event,
// and freezes Chromium's frames for 4 s (P5 Q4, "naive"). So, in this order:
//   1. listen for the top frame's `reloadComplete` FIRST;
//   2. `document.startViewTransition(cb)`, and only then navigate;
//   3. the router's first middleware (router.tsx) awaits `glideGate()`, which resolves when `cb`
//      runs, that is, once the old snapshot exists; only then does the route render;
//   4. `cb` waits for that `reloadComplete`, then names the arriving parts.
// A skipped transition never leaves the router waiting: the gate also opens after GATE_MAX_MS.
// Measured in Chromium for links, `navigate()` and back; WebKit's old snapshot is right, its morph is
// confirmed by the pseudo-element pairs only, not by eye (P5 Q4).
//
// Only the parts that fly carry a `view-transition-name`, and only for one transition: a name on every
// row draws the rows below a scroller's clip outside it (P5 Q4, side finding).
//
// ON BY DEFAULT since probe 5. `setGlideEnabled(false)` is the kill switch; tests can set
// `globalThis.__collieGlide = false` before boot. The Shell binds the top frame (`bindGlideFrame`);
// without one, nothing glides.
//
// FRAMES: Chromium runs no animation frames while the update callback is pending, and every store
// and model update waits for one (`scheduleUpdate`). So the glide holds frames (`holdFrames`, in
// lib/store.ts) from `startViewTransition` to the end of the callback: updates run on timers, the
// arriving header draws inside the callback, and the parts morph (REMIX3.md, "Frames during a view
// transition"). Without it the callback waited the full ARRIVE_TIMEOUT_MS and crossfaded.
//
// THE SCREEN FRAME (S2). With the pane's server frames on, the Terminal's rows are the `pane-screen`
// frame, and a beat that brought new rows reloads it: the runtime dispatches `reloadStart`, diffs the
// rows in, then `reloadComplete` (C/src/runtime/frame.ts). Those are the real events the seam named in
// research note 01 §4. The Terminal binds the frame (`bindGlideScreenFrame`); the update callback,
// once the landing element is there, waits for a reload in flight to complete (at most
// ARRIVE_TIMEOUT_MS), so the new snapshot never holds half-diffed rows. A frame's FIRST content in the
// browser is not a reload (reconcile.ts `resolveClientFrame` dispatches nothing): it lands in the
// microtasks after the route's commit, from rows the prefetch already holds, before any paint.
//
// A route marks its parts with `data-glide="dot" | "tile" | "name"` (pane) or `"label" | "count"`
// (changes), the origin row with `data-glide-origin` + `data-glide-key`, and the destination with
// `data-glide-destination`. The pane's identity block (routes/pane/identity.tsx) is the pane
// destination; the override row of a space's Files root (shell/header.tsx) is the changes one.
import { reducedMotion } from "./motion";
import { holdFrames } from "./store";

declare global {
  var __collieGlide: boolean | undefined;
}

let enabled: boolean | null = null;

/** The flag. On by default since probe 5 measured the gated seam (see the file header). */
export function glideEnabled(): boolean {
  return enabled ?? globalThis.__collieGlide !== false;
}

export function setGlideEnabled(on: boolean): void {
  enabled = on;
}

export interface GlidePair {
  readonly parts: readonly string[];
  readonly origin: (pathname: string) => boolean;
  readonly destination: (pathname: string) => boolean;
}

export const GLIDE_PAIRS = {
  changes: {
    parts: ["label", "count"],
    origin: (pathname) => pathname === "/",
    destination: (pathname) => /^\/space\/[^/]+\/changes$/u.test(pathname),
  },
  pane: {
    parts: ["dot", "tile", "name"],
    origin: (pathname) => pathname === "/" || /^\/space\/[^/]+$/u.test(pathname),
    destination: (pathname) => /^\/pane\/[^/]+$/u.test(pathname),
  },
} as const satisfies Record<string, GlidePair>;

export type GlidePairId = keyof typeof GLIDE_PAIRS;
export type GlideMove = "forward" | "back";

export const GLIDE_CLASS = "glide";
export const GLIDE_BACK_CLASS = "glide-back";
export const GLIDE_CROSSFADE_CLASS = "glide-crossfade";

export const glidePairClass = (id: GlidePairId): string => `glide-${id}`;
export const glidePartName = (id: GlidePairId, part: string): string => `glide-${id}-${part}`;

/** How long the update callback waits for the landing element before it shows what there is. */
export const ARRIVE_TIMEOUT_MS = 400;
/** How long a forward tap waits for the next screen's data before it plain-slides instead. */
export const READY_WAIT_MS = 120;

/** The longest the router waits for the old snapshot, even if the transition never calls back. */
export const GATE_MAX_MS = 500;

let frame: EventTarget | null = null;
let gate: Promise<void> | null = null;

/** The pane's screen frame, its reload in flight, and the runtime events seen (read by e2e). */
let screenFrame: EventTarget | null = null;
let screenBinding: AbortController | null = null;
let screenReload: PromiseWithResolvers<void> | null = null;
export const screenFrameEvents = { start: 0, complete: 0 };
// Read by e2e/pane-frames.spec.ts: the runtime's own events, counted where the glide hears them.
if ("document" in globalThis) Object.assign(globalThis, { __collieScreenFrameEvents: screenFrameEvents });

/**
 * The Terminal hands over its `pane-screen` frame after each commit (routes/pane/terminal.tsx), with
 * its own lifetime signal. A new frame replaces the old binding; the same frame again is a no-op.
 */
export function bindGlideScreenFrame(next: EventTarget | undefined, signal: AbortSignal): void {
  if (next === undefined || next === screenFrame || signal.aborted) return;
  screenBinding?.abort();
  const binding = new AbortController();
  screenBinding = binding;
  screenFrame = next;
  screenReload?.resolve();
  screenReload = null;
  const end = (): void => binding.abort();
  signal.addEventListener("abort", end, { once: true, signal: binding.signal });
  next.addEventListener(
    "reloadStart",
    () => {
      screenFrameEvents.start++;
      screenReload ??= Promise.withResolvers<void>();
    },
    { signal: binding.signal },
  );
  next.addEventListener(
    "reloadComplete",
    () => {
      screenFrameEvents.complete++;
      screenReload?.resolve();
      screenReload = null;
    },
    { signal: binding.signal },
  );
  binding.signal.addEventListener(
    "abort",
    () => {
      if (screenBinding !== binding) return;
      screenBinding = null;
      screenFrame = null;
      screenReload?.resolve();
      screenReload = null;
    },
    { once: true },
  );
}

/** Resolves when the screen frame has no reload in flight, or after ARRIVE_TIMEOUT_MS. */
function screenSettled(): Promise<void> {
  const pending = screenReload;
  if (pending === null) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ARRIVE_TIMEOUT_MS);
  });
  return Promise.race([pending.promise, late]).finally(() => clearTimeout(timer));
}

/** The Shell hands over `handle.frames.top`, whose `reloadComplete` ends each navigation. */
export function bindGlideFrame(top: EventTarget, signal: AbortSignal): void {
  frame = top;
  signal.addEventListener("abort", () => {
    if (frame === top) frame = null;
  });
}

/** What the router's first middleware awaits: the old snapshot of a glide in flight, or null. */
export function glideGate(): Promise<void> | null {
  return gate;
}

/** The glide can run here and now: flag on, frame bound, API present, no reduced motion (rule 10). */
export function canGlide(): boolean {
  if (!glideEnabled() || frame === null) return false;
  if (!("startViewTransition" in document)) return false;
  return !reducedMotion();
}

function origins(id: GlidePairId, key: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-glide-origin="${id}"]`)].filter((el) => el.dataset.glideKey === key);
}

function destination(id: GlidePairId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-glide-destination="${id}"]`);
}

/** Fully inside the viewport and every clipping ancestor (web/'s `isOnScreen`). */
export function isOnScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  let top = 0;
  let left = 0;
  let bottom = window.innerHeight;
  let right = window.innerWidth;
  for (let p = el.parentElement; p !== null && p !== document.documentElement; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const c = p.getBoundingClientRect();
    top = Math.max(top, c.top);
    left = Math.max(left, c.left);
    bottom = Math.min(bottom, c.bottom);
    right = Math.min(right, c.right);
  }
  const slack = 0.5;
  return r.top >= top - slack && r.bottom <= bottom + slack && r.left >= left - slack && r.right <= right + slack;
}

interface NamedPart {
  el: HTMLElement;
  name: string;
}

function partsOf(id: GlidePairId, container: HTMLElement): NamedPart[] {
  return GLIDE_PAIRS[id].parts.flatMap((part) => {
    const el = container.querySelector<HTMLElement>(`[data-glide="${part}"]`);
    return el ? [{ el, name: glidePartName(id, part) }] : [];
  });
}

/** Names live for ONE transition only, set by hand and cleared by hand. */
const name = (parts: readonly NamedPart[]): void => parts.forEach(({ el, name: n }) => (el.style.viewTransitionName = n));
const unname = (parts: readonly NamedPart[]): void => parts.forEach(({ el }) => (el.style.viewTransitionName = ""));

function arrived(selector: string): Promise<void> {
  if (document.querySelector(selector) !== null) return Promise.resolve();
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const seen = new Promise<void>((resolve) => {
    observer = new MutationObserver(() => {
      if (document.querySelector(selector) !== null) resolve();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ARRIVE_TIMEOUT_MS);
  });
  return Promise.race([seen, late]).finally(() => {
    observer?.disconnect();
    clearTimeout(timer);
  });
}

interface Active {
  id: GlidePairId;
  move: GlideMove;
  landed: boolean;
  superseded: boolean;
  transition?: ViewTransition;
}

let active: Active | null = null;
/** Bumped on every location change, so a forward tap still waiting for data loses to a later move. */
let waiting = 0;

function landsOn(a: Active, pathname: string): boolean {
  const pair: GlidePair = GLIDE_PAIRS[a.id];
  return a.move === "forward" ? pair.destination(pathname) : pair.origin(pathname);
}

function supersede(a: Active): void {
  a.superseded = true;
  if (active === a) active = null;
  a.transition?.skipTransition();
}

/** A glide is carrying the move to `pathname`; the screen slide stands down for it. */
export function glideOwnsMove(pathname: string): boolean {
  return active !== null && !active.landed && !active.superseded && landsOn(active, pathname);
}

/** Every location change reports here (`shell/screen-transition.tsx`). */
export function noteGlideLocation(pathname: string): void {
  waiting++;
  const a = active;
  if (a === null) return;
  if (!a.landed && landsOn(a, pathname)) {
    a.landed = true;
    return;
  }
  supersede(a);
}

export function glideInFlight(): boolean {
  return active !== null;
}

function run(id: GlidePairId, move: GlideMove, key: string, go: () => void, from?: HTMLElement): void {
  if (!canGlide()) {
    go();
    return;
  }
  if (active !== null) {
    supersede(active);
    go();
    return;
  }
  const leaving = move === "forward" ? (from ?? origins(id, key)[0] ?? null) : destination(id);
  const before = leaving ? partsOf(id, leaving) : [];
  let after: NamedPart[] = [];
  const root = document.documentElement;
  const classes = [GLIDE_CLASS, glidePairClass(id), ...(move === "back" ? [GLIDE_BACK_CLASS] : [])];
  const me: Active = { id, move, landed: false, superseded: false };
  const clean = (): void => {
    releaseFrames();
    root.classList.remove(...classes, GLIDE_CROSSFADE_CLASS);
    unname(before);
    unname(after);
    if (active === me) active = null;
  };
  name(before);
  root.classList.add(...classes);
  active = me;
  const landing = move === "forward" ? `[data-glide-destination="${id}"]` : `[data-glide-origin="${id}"]`;
  // 1. The end of the navigation, listened for BEFORE anything starts (P5 Q4).
  const done = Promise.withResolvers<void>();
  frame?.addEventListener("reloadComplete", () => done.resolve(), { once: true });
  // 3. The router holds the route until the callback runs.
  const captured = Promise.withResolvers<void>();
  const opened = captured.promise;
  gate = opened;
  const openGate = (): void => {
    captured.resolve();
    if (gate === opened) gate = null;
  };
  const gateTimer = setTimeout(openGate, GATE_MAX_MS);
  // Updates run on timers while the callback is pending (see the file header). Released when the
  // callback settles; `clean` and the catch release too, so no path leaves frames held.
  const releaseFrames = holdFrames();
  try {
    // 2. The transition first; the navigation right after it.
    me.transition = document.startViewTransition(async () => {
      clearTimeout(gateTimer);
      openGate();
      if (me.superseded) return;
      // 4. The new route has committed.
      await Promise.race([done.promise, arrived(landing)]);
      await arrived(landing);
      // A screen-frame reload in flight lands before the new snapshot is taken (see the file header).
      await screenSettled();
      unname(before);
      const arriving = move === "forward" ? destination(id) : (origins(id, key).find(isOnScreen) ?? null);
      if (arriving === null || me.superseded) {
        root.classList.add(GLIDE_CROSSFADE_CLASS);
        return;
      }
      after = partsOf(id, arriving);
      name(after);
    });
  } catch {
    clearTimeout(gateTimer);
    openGate();
    clean();
    go();
    return;
  }
  go();
  me.transition.ready.catch(() => {});
  void me.transition.finished.then(clean, clean);
  void me.transition.updateCallbackDone.then(releaseFrames, () => {
    releaseFrames();
    openGate();
  });
}

export function glideForward(id: GlidePairId, key: string, go: () => void, from?: HTMLElement): void {
  run(id, "forward", key, go, from);
}

/** Reverse: ONLY from the in-app back arrow (the header's mark on a pane). */
export function glideBack(id: GlidePairId, key: string, go: () => void): void {
  run(id, "back", key, go);
}

/**
 * Forward, once the next screen can draw: glide if `ready` settles within READY_WAIT_MS, else go at
 * once with the plain slide. Start the prefetch that makes `ready` on `pointerdown`.
 */
export function glideForwardWhenReady(id: GlidePairId, key: string, ready: Promise<unknown>, go: () => void, from?: HTMLElement): void {
  const mine = ++waiting;
  if (!canGlide()) {
    go();
    return;
  }
  let decided = false;
  const decide = (glide: boolean): void => {
    if (decided) return;
    decided = true;
    clearTimeout(timer);
    if (mine !== waiting) return;
    if (glide) glideForward(id, key, go, from?.isConnected === true ? from : undefined);
    else go();
  };
  const timer = setTimeout(() => decide(false), READY_WAIT_MS);
  void ready.then(
    () => decide(true),
    () => decide(true),
  );
}
