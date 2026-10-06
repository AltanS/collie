// The glide: a row IS the next screen's header (D §12, ADR 0069). Port of web/src/lib/glide.ts, the
// rules unchanged: 250 ms ease-out (web/src/index.css `--glide-duration`/`--glide-ease`, imported by
// app.css), the parts that fly are the dot, the tile and the name, forward is the tap on the row,
// reverse is the in-app back arrow only (never the edge swipe), at most 120 ms of waiting for the
// next screen's data (`glideForwardWhenReady`, prefetch on `pointerdown`), else a plain slide.
// Skipped under reduced motion and where `document.startViewTransition` is missing.
//
// THE SEAM. No Remix package has view transitions (research note 01, section 4). This uses the one
// seam that does not depend on the router's timing: `document.startViewTransition` FIRST (the old
// screen is captured), then the navigation INSIDE the update callback, which waits until the
// destination element is in the DOM (a MutationObserver, capped at ARRIVE_TIMEOUT_MS). It is web/'s
// own seam, and it needs nothing from the router. The other seam, a transition started from
// `frames.top` `reloadStart`, is what probe 5 is measuring (its "naive" and "gated" Q4 runs).
//
// BEHIND A FLAG. `spike/remix/probe5-motion/README.md` had not landed when this was written, so the
// glide is OFF by default (`glideEnabled()`), and every caller falls through to the plain slide.
// Turn it on with `setGlideEnabled(true)`, or `globalThis.__collieGlide = true` before boot (tests).
// When probe 5 confirms the seam in both engines, flip the default here.
//
// A route marks its parts with `data-glide="dot" | "tile" | "name"`, the origin row with
// `data-glide-origin="pane"` + `data-glide-key`, and the destination with
// `data-glide-destination="pane"`. `shell/header.tsx` marks the pane header.
import { reducedMotion } from "./motion";

declare global {
  var __collieGlide: boolean | undefined;
}

let enabled: boolean | null = null;

/** The flag. Default off until probe 5 confirms the seam (see the file header). */
export function glideEnabled(): boolean {
  return enabled ?? globalThis.__collieGlide === true;
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

/** The glide can run here and now: flag on, API present, no reduced motion (rule 10). */
export function canGlide(): boolean {
  if (!glideEnabled()) return false;
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
    root.classList.remove(...classes, GLIDE_CROSSFADE_CLASS);
    unname(before);
    unname(after);
    if (active === me) active = null;
  };
  name(before);
  root.classList.add(...classes);
  active = me;
  const landing = move === "forward" ? `[data-glide-destination="${id}"]` : `[data-glide-origin="${id}"]`;
  try {
    me.transition = document.startViewTransition(async () => {
      if (me.superseded) return;
      go();
      await arrived(landing);
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
    clean();
    go();
    return;
  }
  me.transition.ready.catch(() => {});
  void me.transition.finished.then(clean, clean);
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
