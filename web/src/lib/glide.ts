// THE GLIDE: named parts of one screen fly into their twins on the next (lib/glide.ts, index.css).
//
// A GLIDE PAIR is two screens that show the same thing at two sizes: a dashboard row and the header
// of the screen it opens. A tap on the row moves its named parts (the label, the count line) into
// the arriving header; the in-app back arrow moves them back down into the row. 250ms, ease-out,
// transform and opacity only, all of it in the browser's own view-transition layer. Everything else
// that changes crossfades: the header row and the screen wrapper carry a name for the transition's
// life (`glide-header`, `glide-screen`), and `:root` stays unnamed, as index.css requires.
//
// OURS, NOT REACT ROUTER'S. The app keeps React Router's `viewTransition` flag off for good
// (screen-transition.tsx, router.tsx): the router remembers every path it once animated and replays
// a phantom transition on every revalidation of it. This calls `document.startViewTransition` once,
// by hand, around one navigation, and the router never learns a transition happened, so nothing is
// remembered and a poll can never replay it.
//
// THE RULES.
//   1. Forward is a tap on the origin row: `glideForward`. Reverse is the in-app back arrow and
//      nothing else: `glideBack`. The arrow's step back and a phone's edge swipe both end as a POP;
//      only the arrow comes through here, so a swipe or a browser back gets no transition at all and
//      the phone's own animation plays alone (ADR 0067).
//   2. The navigation runs INSIDE the transition's update callback. The "before" picture is taken
//      when `startViewTransition` is called, so the move must not reach the DOM before then; a mark
//      set before `navigate(-1)` and read on the next location change would come too late, since the
//      POP can commit before the browser's next frame. That is why both calls wrap the move itself.
//   3. The landing must be real. On the way back the origin row is looked up by its key in the
//      arrived screen, AFTER scroll memory has put the scroller back (use-scroll-memory.ts restores
//      in a layout effect, before the observer below wakes). No row, or a row not wholly on screen
//      (the viewport and every clipping ancestor), and the move is a plain crossfade: the arriving
//      side gets no names and `<html>` carries `glide-crossfade`. The leaving side was named before
//      the landing could be known (rule 2); an old part with no new twin fades out in place, with
//      the header around it, which is the crossfade.
//   4. Reduced motion, or no `startViewTransition` (Safari before 18): no transition, the move runs
//      as a plain navigation, and ScreenTransition's slide stays what it was.
//   5. A glide owns its move: while one runs, `glideOwnsMove` is true for the pathname it lands on,
//      and ScreenTransition's slide stays off for that navigation, both ways. Other moves keep it.
//   6. Never in the way. The new screen waits at most ARRIVE_TIMEOUT_MS for its parts; the overlay
//      takes no pointer events (index.css); and a glide in flight is SKIPPED, not queued, when another
//      navigation starts: a second glide call, or any location change that is not the glide's own
//      landing (`noteGlideLocation`, fed by ScreenTransition).
//   7. Names live for one transition. Each part gets its `view-transition-name` inline on exactly one
//      element at a time (the leaving one until the "before" picture is taken, then the arriving
//      one), and every name and class comes off when the transition finishes or is skipped.
//   8. No frozen screen. The browser paints nothing while the update callback runs, so a destination
//      whose loader awaits the network must have its data in BEFORE the transition starts. Its tap
//      goes through `glideForwardWhenReady`, which waits at most READY_WAIT_MS for the data and
//      otherwise navigates the plain way, with the slide. The pane pair's data is started on the
//      row's `pointerdown` (lib/pane-prefetch.ts), so it is usually in by the `click`.
//
// ADDING A PAIR.
//   · An entry in GLIDE_PAIRS: the parts that fly, and the two pathname matchers.
//   · The origin element (the row's button): `data-glide-origin="<id>"` and `data-glide-key="<key>"`.
//     The key is the destination's href from its path helper (`spaceChangesPath`, `panePath`), so
//     both screens can spell it without sharing state.
//   · The destination container (the header's text column): `data-glide-destination="<id>"`.
//   · Each part, on both sides: `data-glide="<part>"` inside those two elements.
//   · The tap: `glideForward(id, key, go, from)`, or `glideForwardWhenReady` when the destination's
//     loader awaits the network (rule 8). The back arrow, only when its up target is the origin
//     screen: `glideBack(id, key, go)`. The way back needs no wait: the origin screens read the
//     snapshot the root loader already holds.
//   · Pair-specific CSS, if any (the snapshot shape of text that changes size), under
//     `html.glide-<id>` in index.css. Timing is shared and needs nothing.

/** One pair of screens whose parts glide. */
export interface GlidePair {
  /** The `data-glide` values that fly, found inside the origin element and the destination. */
  readonly parts: readonly string[];
  /** Whether a pathname is the origin screen (the one with the rows). */
  readonly origin: (pathname: string) => boolean;
  /** Whether a pathname is the destination screen (the one with the header). */
  readonly destination: (pathname: string) => boolean;
}

/**
 * Every glide in the app.
 *
 * `changes`: a dashboard Changes tab row (workspace-changes-list.tsx) and the list screen of
 * `/space/:id/changes` (routes/changes.tsx), keyed by `spaceChangesPath`.
 *
 * `pane`: a pane row (agent-card.tsx), on the dashboard's Panes and Focus lists and in a space's
 * list, and the pane screen's header identity (agent-chat.tsx), keyed by `panePath`. The status dot,
 * the agent's tile and the name fly; a space row draws its status as a word at the row's end, so it
 * has no dot to send, and the header's dot fades in on its own. The machine chip stays: the row's
 * meta cluster (machine, session, cache) and the header's (machine, cache) are not one shape, and a
 * chip that flew alone would split its cluster. The pane loader awaits a read, so the tap waits for
 * it, briefly, before it glides (`glideForwardWhenReady`).
 */
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

/** Which way a glide runs: row into header, or header back into row. */
export type GlideMove = "forward" | "back";

/** On `<html>` for the life of any glide; index.css hangs the shared names and timing on it. */
export const GLIDE_CLASS = "glide";
/** On `<html>` beside {@link GLIDE_CLASS} while the move is a reverse. */
export const GLIDE_BACK_CLASS = "glide-back";
/** On `<html>` when the landing was not found or not on screen: the move is a plain crossfade. */
export const GLIDE_CROSSFADE_CLASS = "glide-crossfade";

/** The pair's own class on `<html>`, for its pair-specific rules in index.css. */
export function glidePairClass(id: GlidePairId): string {
  return `glide-${id}`;
}

/** The `view-transition-name` one part carries for one transition. */
export function glidePartName(id: GlidePairId, part: string): string {
  return `glide-${id}-${part}`;
}

/** How long the new screen may take to put its parts up before the transition goes without them. */
export const ARRIVE_TIMEOUT_MS = 400;

/** Whether a move would glide here: the API exists and the reader has not asked for less motion. */
export function canGlide(): boolean {
  if (!("startViewTransition" in document)) return false;
  return !(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

// ── Finding the two sides ────────────────────────────────────────────────────────────────────────

/** Every origin element of the pair carrying `key`, in document order. Compared as a string, so a
 *  key needs no CSS escaping. */
function origins(id: GlidePairId, key: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-glide-origin="${id}"]`)].filter(
    (el) => el.dataset.glideKey === key,
  );
}

function destination(id: GlidePairId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-glide-destination="${id}"]`);
}

/**
 * Whether `el` is wholly visible: inside the viewport and inside every ancestor that clips (any
 * `overflow` other than `visible`, which is how the dashboard's scroller hides a row). A snapshot is
 * not clipped by the scroller it came from, so a half-hidden row would fly from under the header.
 */
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

function name(parts: readonly NamedPart[]): void {
  for (const { el, name: n } of parts) el.style.viewTransitionName = n;
}

function unname(parts: readonly NamedPart[]): void {
  for (const { el } of parts) el.style.viewTransitionName = "";
}

/**
 * Resolves once `selector` matches, or after {@link ARRIVE_TIMEOUT_MS}. The router commits the new
 * screen a task or two after `navigate()`, and the transition must not take its "after" picture
 * before that. A MutationObserver rather than a frame wait, because the browser renders no frames
 * while a transition's update callback is pending. Its callback is a microtask after React's commit,
 * so the commit's layout effects (scroll memory among them) have run by the time it resolves.
 */
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

// ── The one glide in flight ──────────────────────────────────────────────────────────────────────

interface Active {
  id: GlidePairId;
  move: GlideMove;
  /** The glide's own navigation has been seen (`noteGlideLocation`). */
  landed: boolean;
  /** Another navigation took over: the move no longer runs, the transition ends at once. */
  superseded: boolean;
  transition?: ViewTransition;
}

let active: Active | null = null;

/** Bumped by every data wait and every navigation: a wait whose number is no longer current is
 *  dropped (`glideForwardWhenReady`). */
let waiting = 0;

/** Whether `pathname` is where this glide lands. */
function landsOn(a: Active, pathname: string): boolean {
  const pair: GlidePair = GLIDE_PAIRS[a.id];
  return a.move === "forward" ? pair.destination(pathname) : pair.origin(pathname);
}

/** End the glide in flight at once, never queued behind the move that replaced it. */
function supersede(a: Active): void {
  a.superseded = true;
  if (active === a) active = null;
  a.transition?.skipTransition();
}

/**
 * Whether a glide owns the navigation onto `pathname`, so ScreenTransition's slide stays off for it.
 * Read during render, so it only reads: true from the glide's start until its own landing is seen.
 */
export function glideOwnsMove(pathname: string): boolean {
  return active !== null && !active.landed && !active.superseded && landsOn(active, pathname);
}

/**
 * Tell the engine the router's location changed (ScreenTransition calls this once per location
 * key). The glide's own landing is noted; any other navigation skips the glide in flight.
 */
export function noteGlideLocation(pathname: string): void {
  // A tap still waiting on its data (`glideForwardWhenReady`) loses to any navigation that lands
  // first: the operator has moved on, and a late open would pull them back.
  waiting++;
  const a = active;
  if (a === null) return;
  if (!a.landed && landsOn(a, pathname)) {
    a.landed = true;
    return;
  }
  supersede(a);
}

/** Whether a glide is in flight. For tests and for a caller that must not start a second. */
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
  const clean = () => {
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
      // Superseded before the "before" picture was even taken: the newer move already ran.
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
  // A skipped transition (a duplicate name, a hidden page) still ran `go`; only the motion is lost.
  me.transition.ready.catch(() => {});
  void me.transition.finished.then(clean, clean);
}

/**
 * The tap on an origin row: navigate with `go`, gliding the row's parts into the destination's
 * header. `key` is the row's `data-glide-key`; `from` is the tapped element, when the caller has it
 * (a key may sit on more than one row, and the tapped one is the one that flies).
 */
export function glideForward(id: GlidePairId, key: string, go: () => void, from?: HTMLElement): void {
  run(id, "forward", key, go, from);
}

/**
 * The in-app back arrow, and only it: navigate with `go` (the arrow's `nav.up`), gliding the
 * header's parts back down into the origin row keyed `key`, or crossfading when that row is not on
 * screen once the origin has arrived. Call it only when the arrow's up target is the pair's origin.
 */
export function glideBack(id: GlidePairId, key: string, go: () => void): void {
  run(id, "back", key, go);
}

// ── A destination that needs data first ──────────────────────────────────────────────────────────

/**
 * How long a tap waits for its destination's data before it gives up the glide. The navigation runs
 * inside the transition's update callback, and the browser paints nothing until that callback ends,
 * so a destination whose loader awaits a network read would hold the old screen frozen for the
 * read's whole length. Waiting BEFORE the transition starts keeps the screen live instead. 120 ms is
 * the most a tap may cost on top of what it cost before the glide existed; a read not in by then
 * opens the plain way, with the slide, and the loader waits for the same read it would have.
 */
export const READY_WAIT_MS = 120;

/**
 * The tap on an origin row whose destination loads data first: `glideForward` once `ready` has
 * settled, if it settles within {@link READY_WAIT_MS}; otherwise `go` at that deadline, with no
 * glide. Where no glide can run (`canGlide`), `go` runs at once. A second tap, or any navigation
 * that lands while this one waits, drops it, so one tap moves the screen at most once.
 *
 * `ready` should settle, never reject, when the data is in (or has failed: either way the loader
 * will not wait on the network again). `from` is dropped if React replaced the row while it waited.
 */
export function glideForwardWhenReady(
  id: GlidePairId,
  key: string,
  ready: Promise<unknown>,
  go: () => void,
  from?: HTMLElement,
): void {
  const mine = ++waiting;
  if (!canGlide()) {
    go();
    return;
  }
  let decided = false;
  const decide = (glide: boolean) => {
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
