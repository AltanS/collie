import { lastViewportPinAction } from "./viewport-pin";

// WHEN THE REPLY BOX SITS BELOW THE SCREEN, THE PHONE SAYS SO, ONCE, WITH HEIGHTS AND NO CONTENT.
//
// The owner's report (2026-11-07, again 2026-11-18): an installed Android app, opened after a break,
// sometimes draws the reply box (the composer, the bottom row of a session's Chat) below the visible
// screen. The likely cause is a page Android froze: the layout height and the visible height disagree
// and nothing lays the page out again. lib/viewport-pin.ts is a guess at the repair, and it only logs
// to the console, so nobody could tell what a device really measured. This is the measurement.
//
// WHEN IT LOOKS. On a return to the foreground (`visibilitychange` to visible, `pageshow`), after a
// `resize` of the window or the visual viewport has settled for {@link RESIZE_SETTLE_MS}, and again
// {@link DELAYED_CHECKS_MS} after each of those, because a stale reading can arrive a moment late.
//
// WHAT COUNTS. The pane view is mounted, it is not in zen, the composer exists, and its bottom edge is
// more than {@link OFFSCREEN_SLACK_PX} below the visual viewport's bottom, or its top is at or below
// that bottom. A pinch zoom shrinks the visual viewport on purpose, so no record while zoomed.
//
// WHAT IT SENDS. One record of whole numbers, three booleans and three small enums: the heights that tell
// the cases apart. Nothing a person typed or can read: no text, no pane id, no session name, no URL, no
// user agent. The record's key set is pinned by the test. At most one record per pane view per
// {@link MIN_GAP_MS}, and {@link MAX_PER_PAGE} per page life. The bridge keeps it in one local file
// (bridge/diag-composer.ts); a failure to send is ignored.

/** The composer may hang this far below the glass before it counts: sub-pixel rounding and a hairline. */
export const OFFSCREEN_SLACK_PX = 8;
/** A resize must be quiet this long before it is looked at. */
export const RESIZE_SETTLE_MS = 300;
/** After each trigger the box is looked at again at these delays. */
export const DELAYED_CHECKS_MS: readonly number[] = [1000, 4000];
/** One record per pane view in this many milliseconds. */
export const MIN_GAP_MS = 60_000;
/** The most records one page life sends. */
export const MAX_PER_PAGE = 20;
/** `viewport-pin` counts as having acted if it did so within this many milliseconds. */
export const PIN_RECENT_MS = 10_000;
/** The longest `msSinceForeground` a record states: seven days, the bridge's own limit. */
const MAX_SINCE_MS = 7 * 24 * 60 * 60 * 1000;

export type ComposerTrigger = "foreground" | "pageshow" | "resize" | "delayed";
export type ComposerPaneKind = "agent" | "shell" | "screenless";
export type ComposerPinAction = "none" | "pinned" | "released";

/** What one look reads before it decides. Pure data, so the predicate is testable without a browser. */
export interface OffscreenReading {
  readonly zen: boolean;
  /** The composer's bounding rect edges, or null when no composer is in the page. */
  readonly composer: { readonly top: number; readonly bottom: number } | null;
  /** `visualViewport.offsetTop + visualViewport.height`, in the same coordinates as the rect. */
  readonly visualBottom: number;
  /** `visualViewport.scale`. */
  readonly scale: number;
}

/** Whether the composer sits below the visible screen. Pure. */
export function composerOffscreen(r: OffscreenReading): boolean {
  if (r.zen || r.composer === null) return false;
  if (!(r.visualBottom > 0)) return false;
  if (Math.abs(r.scale - 1) > 0.01) return false;
  return r.composer.bottom > r.visualBottom + OFFSCREEN_SLACK_PX || r.composer.top >= r.visualBottom;
}

/** One record, exactly as it goes on the wire. Whole numbers, booleans and enums only. */
export interface ComposerDiagRecord {
  readonly innerHeight: number;
  readonly visualHeight: number;
  readonly visualOffsetTop: number;
  readonly visualScalePct: number;
  readonly screenHeight: number;
  readonly clientHeight: number;
  readonly scrollTop: number;
  readonly composerTop: number;
  readonly composerBottom: number;
  readonly scrollerHeight: number;
  readonly scrollerTop: number;
  readonly msSinceForeground: number;
  readonly standalone: boolean;
  readonly pinRecent: boolean;
  readonly keyboardOpen: boolean;
  readonly trigger: ComposerTrigger;
  readonly pinAction: ComposerPinAction;
  readonly paneKind: ComposerPaneKind;
}

/** The raw numbers a look gathered, before they are rounded into a record. */
export interface RecordInput {
  readonly innerHeight: number;
  readonly visualHeight: number;
  readonly visualOffsetTop: number;
  readonly visualScale: number;
  readonly screenHeight: number;
  readonly clientHeight: number;
  readonly scrollTop: number;
  readonly composerTop: number;
  readonly composerBottom: number;
  readonly scrollerHeight: number;
  readonly scrollerTop: number;
  readonly msSinceForeground: number;
  readonly standalone: boolean;
  readonly pinRecent: boolean;
  readonly keyboardOpen: boolean;
  readonly trigger: ComposerTrigger;
  readonly pinAction: ComposerPinAction;
  readonly paneKind: ComposerPaneKind;
}

/** A finite number as a whole number between `lo` and `hi`; a reading the browser could not give is `lo`. */
function whole(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return Math.max(lo, Math.min(hi, 0));
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

const PX = 20_000;
const SIGNED = 1_000_000;

/**
 * The record a look becomes: every number rounded to a whole number inside the range the bridge
 * accepts, so a stray reading is clamped here and never refused there. Built key by key, so a field
 * added to the input cannot reach the wire by accident.
 */
export function buildComposerRecord(r: RecordInput): ComposerDiagRecord {
  return {
    innerHeight: whole(r.innerHeight, 0, PX),
    visualHeight: whole(r.visualHeight, 0, PX),
    visualOffsetTop: whole(r.visualOffsetTop, -SIGNED, SIGNED),
    visualScalePct: whole(r.visualScale * 100, 1, 2000),
    screenHeight: whole(r.screenHeight, 0, PX),
    clientHeight: whole(r.clientHeight, 0, PX),
    scrollTop: whole(r.scrollTop, -SIGNED, SIGNED),
    composerTop: whole(r.composerTop, -SIGNED, SIGNED),
    composerBottom: whole(r.composerBottom, -SIGNED, SIGNED),
    scrollerHeight: whole(r.scrollerHeight, 0, PX),
    scrollerTop: whole(r.scrollerTop, -SIGNED, SIGNED),
    msSinceForeground: whole(r.msSinceForeground, 0, MAX_SINCE_MS),
    standalone: r.standalone,
    pinRecent: r.pinRecent,
    keyboardOpen: r.keyboardOpen,
    trigger: r.trigger,
    pinAction: r.pinAction,
    paneKind: r.paneKind,
  };
}

// ── THE BUDGET ───────────────────────────────────────────────────────────────────────────────────
// One page life sends at most MAX_PER_PAGE records, whichever pane views asked, and one pane view at most
// one per MIN_GAP_MS. The first number is module state on purpose: it is the page's, not a view's.
let sentThisPage = 0;

/** Test seam: a new page life. */
export function resetComposerOffscreenBudget(): void {
  sentThisPage = 0;
}

/** The page's last return to the foreground, as `Date.now()`; the page's load counts as one. */
let foregroundAt = Date.now();

/** Test seam: pretend the page last came to the foreground at `at`. */
export function setForegroundAtForTest(at: number): void {
  foregroundAt = at;
}

/** What the watch reads from the pane view each time it looks. */
export interface OffscreenViewState {
  readonly zen: boolean;
  readonly keyboardOpen: boolean;
  readonly paneKind: ComposerPaneKind;
}

export interface OffscreenWatchOptions {
  readonly getState: () => OffscreenViewState;
  /** Fire and forget. Called at most {@link MAX_PER_PAGE} times a page life. */
  readonly send: (record: ComposerDiagRecord) => void;
  readonly win?: Window;
  readonly now?: () => number;
}

/** The composer: the chrome block that holds the box, in either composer, or null when none is mounted. */
function findComposer(doc: Document): HTMLElement | null {
  return doc.querySelector<HTMLElement>('[data-slot="pane-bottom"] [data-slot="chrome-block"]');
}

/**
 * The nearest ancestor that could hide the composer by scrolling or clipping: its overflow is not
 * `visible` and it holds more than it shows. The document's own scroller when there is none.
 */
interface Scroller {
  readonly height: number;
  readonly top: number;
}

function scrollerOf(el: HTMLElement, win: Window): Scroller {
  for (let p = el.parentElement; p !== null && p !== win.document.body; p = p.parentElement) {
    const overflowY = win.getComputedStyle(p).overflowY;
    if (overflowY === "visible") continue;
    if (p.scrollHeight > p.clientHeight) return { height: p.clientHeight, top: p.scrollTop };
  }
  const root = win.document.scrollingElement;
  return { height: root?.clientHeight ?? 0, top: root?.scrollTop ?? 0 };
}

function standaloneOf(win: Window): boolean {
  return win.matchMedia?.("(display-mode: standalone)").matches === true;
}

interface PinLook {
  readonly recent: boolean;
  readonly action: ComposerPinAction;
}

function pinOf(now: number): PinLook {
  const last = lastViewportPinAction();
  if (last === null) return { recent: false, action: "none" };
  return { recent: now - last.at <= PIN_RECENT_MS, action: last.kind };
}

/**
 * Starts watching for the composer to be off screen. Returns the stop function, which also cancels the
 * timers still waiting. Call it once per mounted pane view. A browser with no `visualViewport` has
 * nothing to measure against, so the watch does nothing there.
 */
export function startComposerOffscreenWatch(opts: OffscreenWatchOptions): () => void {
  const win = opts.win ?? window;
  const now = opts.now ?? (() => Date.now());
  const vv = win.visualViewport;
  if (!vv) return () => {};
  const doc = win.document;
  let lastSentAt: number | null = null;
  const timers = new Map<string, ReturnType<typeof setTimeout>[]>();

  const check = (trigger: ComposerTrigger) => {
    if (doc.visibilityState !== "visible") return;
    if (sentThisPage >= MAX_PER_PAGE) return;
    const at = now();
    if (lastSentAt !== null && at - lastSentAt < MIN_GAP_MS) return;
    const state = opts.getState();
    if (state.zen) return;
    const el = findComposer(doc);
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const visualBottom = vv.offsetTop + vv.height;
    if (!composerOffscreen({ zen: state.zen, composer: rect, visualBottom, scale: vv.scale })) return;
    const scroller = scrollerOf(el, win);
    const pin = pinOf(at);
    lastSentAt = at;
    sentThisPage++;
    opts.send(
      buildComposerRecord({
        innerHeight: win.innerHeight,
        visualHeight: vv.height,
        visualOffsetTop: vv.offsetTop,
        visualScale: vv.scale,
        screenHeight: win.screen?.height ?? 0,
        clientHeight: doc.documentElement.clientHeight,
        scrollTop: doc.scrollingElement?.scrollTop ?? 0,
        composerTop: rect.top,
        composerBottom: rect.bottom,
        scrollerHeight: scroller.height,
        scrollerTop: scroller.top,
        msSinceForeground: at - foregroundAt,
        standalone: standaloneOf(win),
        pinRecent: pin.recent,
        keyboardOpen: state.keyboardOpen,
        trigger,
        pinAction: pin.action,
        paneKind: state.paneKind,
      }),
    );
  };

  /** One trigger: the first look after `firstDelay`, then the delayed ones after that. A newer one of the same kind replaces it. */
  const arm = (kind: "foreground" | "pageshow" | "resize", firstDelay: number) => {
    for (const t of timers.get(kind) ?? []) clearTimeout(t);
    const pending: ReturnType<typeof setTimeout>[] = [];
    timers.set(kind, pending);
    const first = () => check(kind);
    if (firstDelay === 0) first();
    else pending.push(setTimeout(first, firstDelay));
    for (const d of DELAYED_CHECKS_MS) pending.push(setTimeout(() => check("delayed"), firstDelay + d));
  };

  const onVisibility = () => {
    if (doc.visibilityState !== "visible") return;
    foregroundAt = now();
    arm("foreground", 0);
  };
  const onPageShow = () => {
    foregroundAt = now();
    arm("pageshow", 0);
  };
  const onResize = () => arm("resize", RESIZE_SETTLE_MS);

  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("pageshow", onPageShow);
  win.addEventListener("resize", onResize);
  vv.addEventListener("resize", onResize);
  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("pageshow", onPageShow);
    win.removeEventListener("resize", onResize);
    vv.removeEventListener("resize", onResize);
    for (const list of timers.values()) for (const t of list) clearTimeout(t);
    timers.clear();
  };
}
