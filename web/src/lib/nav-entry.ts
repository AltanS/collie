// How Collie's history begins and how it is entered from outside (ADR 0067). Three pieces, each
// small, all about the history stack rather than about any one route:
//
//   1. `seedColdEntry` puts a deep link's parents BEHIND it on a cold start, so the first edge
//      swipe goes up one level instead of doing nothing (a notification tap that opens the app on a
//      pane, an installed app relaunched on a deep page).
//   2. `listenForInAppOpen` lets the service worker open a notification's pane inside a running app
//      as an in-app DOWN move, instead of a full-document navigate that stacks a second document.
//   3. `markInAppBack` / `isInAppBack` tell the screen transition that a POP was the app's own back
//      arrow, which keeps its slide, and not the phone's swipe, which brings its own animation.

import { mounted, basePath } from "./base-path";
import { asJsonNumber, asJsonObject, type JsonValue } from "./json";
import { parentChain, type NavState } from "./nav";
import { parseOpenMessage } from "./notification-open";

// ── 1. The cold deep link ────────────────────────────────────────────────────────────────────────

/** The sessionStorage key naming the URL a seed was last written for. */
export const SEEDED_KEY = "collie.nav.seeded";

/** One history entry as React Router stamps it: its own state under `usr`, a key, an index. */
export interface RouterEntry {
  usr: NavState | null;
  key: string;
  idx: number;
}

/** The slice of `window` the seed reads and writes, injected so a test can hand in a fake. */
export interface SeedWindow {
  readonly location: { pathname: string; search: string; hash: string };
  readonly history: {
    readonly length: number;
    readonly state: JsonValue | undefined;
    replaceState(data: RouterEntry, unused: string, url: string): void;
    pushState(data: RouterEntry, unused: string, url: string): void;
  };
  readonly sessionStorage?: Pick<Storage, "getItem" | "setItem">;
  /** Whether the app runs installed (display-mode standalone, or iOS's `navigator.standalone`).
   *  Asked only for a fresh deep entry, never on the ordinary boot. */
  standalone(): boolean;
}

/**
 * Whether this entry is one the router has never written. React Router stamps every entry it
 * creates or adopts with `{ usr, key, idx }` in `history.state`; a reload and a back-forward return
 * keep that stamp, so an entry without a numeric `idx` is a document the browser just opened at
 * this URL. That is the robust half of "cold". `history.length === 1` alone is not: iOS can open a
 * notification's URL inside the installed app's existing window, where the length is already more.
 */
export function isFreshEntry(state: JsonValue | undefined): boolean {
  return asJsonNumber(asJsonObject(state)?.idx) === undefined;
}

/**
 * Seed a cold deep link once. On a fresh entry (see `isFreshEntry`) deeper than the dashboard, and
 * only where a swipe is the way back (the installed app, or a window with nothing behind it, which
 * is what a notification's `openWindow` makes), replace this entry with the root of its level chain
 * and push each level down to the target again, every one stamped the way React Router stamps its
 * own. The router then boots on the target at `idx` N with the parents at 0..N-1 behind it.
 *
 * The sessionStorage flag names the URL seeded last. A reload of that URL with the seeded entries
 * still behind it (`history.length > 1`) is not seeded again, should a browser ever drop the state
 * across the reload; any other fresh entry is, because its history is new.
 *
 * Returns whether it seeded. Call it BEFORE `createBrowserRouter`, which reads the entry it sits on.
 */
export function seedColdEntry(win: SeedWindow): boolean {
  const { location, history } = win;
  if (!isFreshEntry(history.state)) return false;
  if (history.length !== 1 && !win.standalone()) return false;
  const base = basePath();
  if (base !== "/" && !location.pathname.startsWith(base)) return false;
  const pathname = base === "/" ? location.pathname : `/${location.pathname.slice(base.length)}`;
  const chain = parentChain(pathname, location.search);
  if (chain.length === 0) return false;
  const target = `${pathname}${location.search}`;
  try {
    if (win.sessionStorage?.getItem(SEEDED_KEY) === target && history.length > 1) return false;
    win.sessionStorage?.setItem(SEEDED_KEY, target);
  } catch {
    // sessionStorage can throw in a locked-down context; seeding without the flag is still right.
  }
  const stops = [...chain, target];
  stops.forEach((href, idx) => {
    const usr = idx === 0 ? null : { from: stops[idx - 1] };
    const data: RouterEntry = { usr, key: `seed${idx}`, idx };
    const url = mounted(href) + (idx === stops.length - 1 ? location.hash : "");
    if (idx === 0) history.replaceState(data, "", url);
    else history.pushState(data, "", url);
  });
  return true;
}

/** The browser's own answer to "is this the installed app". */
export function probeStandalone(): boolean {
  // Optional calls: a test environment may stub matchMedia away, and only WebKit has
  // `navigator.standalone`.
  const media = window.matchMedia?.("(display-mode: standalone)")?.matches === true;
  const ios = "standalone" in navigator && navigator.standalone === true;
  return media || ios;
}

// ── 2. A notification opened inside the running app ──────────────────────────────────────────────

/**
 * The app path (mount stripped) an origin-absolute URL names, or null when it is not this app's.
 */
export function appPathOf(url: string, origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== origin) return null;
  const base = basePath();
  if (base !== "/" && !parsed.pathname.startsWith(base)) return null;
  const pathname = base === "/" ? parsed.pathname : `/${parsed.pathname.slice(base.length)}`;
  return `${pathname}${parsed.search}${parsed.hash}`;
}

/** The slice of the router this listener drives. */
export interface OpenRouter {
  readonly state: { location: { pathname: string; search: string } };
  navigate(to: string, opts: { state: { from: string } }): Promise<void> | void;
}

/**
 * Answer the service worker's `collie:open`: push the target as a DOWN move from wherever the app
 * is, and acknowledge on the message's port so the worker knows not to fall back to a navigate.
 * Returns the unsubscribe.
 */
export function listenForInAppOpen(router: OpenRouter): () => void {
  // Absent over plain HTTP (no secure context) and in jsdom: then no worker can post to us anyway.
  if (!("serviceWorker" in navigator)) return () => {};
  const sw = navigator.serviceWorker;
  const onMessage = (event: MessageEvent) => {
    const message = parseOpenMessage(event.data);
    if (message === undefined) return;
    const path = appPathOf(message.url, window.location.origin);
    const port = event.ports[0];
    if (path === null) {
      port?.postMessage(false, []);
      return;
    }
    const { pathname, search } = router.state.location;
    const from = `${pathname}${search}`;
    if (path !== from) void router.navigate(path, { state: { from } });
    port?.postMessage(true, []);
  };
  sw.addEventListener("message", onMessage);
  return () => sw.removeEventListener("message", onMessage);
}

// ── 3. Which POP was the app's own ───────────────────────────────────────────────────────────────

/** How long a mark stays good. A step back commits within a frame or two; a swipe takes longer. */
const IN_APP_BACK_MS = 1000;

let inAppBack: { pathname: string; at: number } | null = null;

/** Called right before an in-app `navigate(-1)`, with the pathname it lands on. */
export function markInAppBack(pathname: string, now = Date.now()): void {
  inAppBack = { pathname, at: now };
}

/**
 * Whether a POP onto `pathname` is the one the app just asked for. Read-only (never consumed), so
 * a render that runs twice under StrictMode answers the same both times; the time bound retires it.
 */
export function isInAppBack(pathname: string, now = Date.now()): boolean {
  return inAppBack !== null && inAppBack.pathname === pathname && now - inAppBack.at < IN_APP_BACK_MS;
}
