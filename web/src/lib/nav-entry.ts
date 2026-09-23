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
import { OPEN_MARKER, parseOpenMessage } from "./notification-open";

// ── 1. The cold deep link ────────────────────────────────────────────────────────────────────────

/** The sessionStorage key naming the URL a seed was last written for. */
export const SEEDED_KEY = "collie.nav.seeded";

/**
 * The sessionStorage key that says this tab has booted the app once already. sessionStorage lives
 * as long as the tab, so it survives what `history.state` may not: iOS can evict an installed app
 * and reload it with the state dropped, and that reload must not read as a cold start.
 */
export const BOOTED_KEY = "collie.nav.booted";

/** A query without the notification marker, and whether the marker was there. */
export interface StrippedSearch {
  search: string;
  marked: boolean;
}

/** `search` without `OPEN_MARKER` (`lib/notification-open.ts`), the pair the service worker adds
 *  to a URL it opens a new window on. It is the one proof a fresh entry came from a notification,
 *  and it is stripped at boot, so a reload never carries it. Other pairs keep their spelling. */
export function stripOpenMarker(search: string): StrippedSearch {
  const pairs = search.replace(/^\?/, "").split("&").filter((pair) => pair !== "");
  const kept = pairs.filter((pair) => pair !== OPEN_MARKER);
  return { search: kept.length > 0 ? `?${kept.join("&")}` : "", marked: kept.length !== pairs.length };
}

/**
 * A key for a seeded entry. React Router's own `createKey` is not exported, so this makes one. The
 * router uses a key to tell entries apart (scroll restoration, `useLocation().key`); two equal keys
 * in one tab would make two entries one. 128 random bits make that as likely as a UUID collision.
 * `getRandomValues`, not `randomUUID`: the second needs a secure context, and the app is also served
 * over plain HTTP on a tailnet.
 */
export function seedKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mark this tab as booted (see {@link BOOTED_KEY}). Called once the router exists. */
export function markBooted(storage: Pick<Storage, "setItem"> | undefined): void {
  try {
    storage?.setItem(BOOTED_KEY, "1");
  } catch {
    // A locked-down sessionStorage: the stamp in `history.state` is then the only guard.
  }
}

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
    replaceState(data: RouterEntry | JsonValue | undefined, unused: string, url: string): void;
    pushState(data: RouterEntry, unused: string, url: string): void;
  };
  readonly sessionStorage?: Pick<Storage, "getItem" | "setItem">;
  /** Whether the app runs installed (display-mode standalone, or iOS's `navigator.standalone`).
   *  Asked only for a fresh deep entry, never on the ordinary boot. */
  standalone(): boolean;
  /** A fresh key per seeded entry. Defaults to {@link seedKey}; a test hands in a counter. */
  key?: () => string;
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
 * Seed a cold deep link once. On a fresh entry (see `isFreshEntry`) deeper than the dashboard,
 * replace this entry with the root of its level chain and push each level down to the target again,
 * every one stamped the way React Router stamps its own. The router then boots on the target at
 * `idx` N with the parents at 0..N-1 behind it.
 *
 * It seeds only where a swipe is the way back and the entry is really a new start:
 *   - a URL carrying `OPEN_MARKER`, which only a notification's `openWindow` makes. The marker
 *     is stripped here whether or not a seed follows, so the router never sees it;
 *   - otherwise only in the installed app, and only in a tab that has not booted before
 *     ({@link BOOTED_KEY}). A plain browser tab never seeds: a desktop deep link opened in a new tab
 *     keeps the browser's own history. A reload after iOS evicted the app finds the tab booted.
 * The older guard stays: the sessionStorage flag names the URL seeded last, and a reload of that URL
 * with the seed still behind it (`history.length > 1`) is not seeded again.
 *
 * Returns whether it seeded. Call it BEFORE `createBrowserRouter`, which reads the entry it sits on.
 */
export function seedColdEntry(win: SeedWindow): boolean {
  const { location, history } = win;
  const { search, marked } = stripOpenMarker(location.search);
  const seeded = seedChain(win, search, marked);
  if (marked && !seeded) history.replaceState(history.state, "", `${location.pathname}${search}${location.hash}`);
  return seeded;
}

function seedChain(win: SeedWindow, search: string, marked: boolean): boolean {
  const { location, history } = win;
  if (!isFreshEntry(history.state)) return false;
  if (!marked && (!win.standalone() || storageRead(win, BOOTED_KEY) !== null)) return false;
  const base = basePath();
  if (base !== "/" && !location.pathname.startsWith(base)) return false;
  const pathname = base === "/" ? location.pathname : `/${location.pathname.slice(base.length)}`;
  const chain = parentChain(pathname, search);
  if (chain.length === 0) return false;
  const target = `${pathname}${search}`;
  if (storageRead(win, SEEDED_KEY) === target && history.length > 1 && !marked) return false;
  try {
    win.sessionStorage?.setItem(SEEDED_KEY, target);
  } catch {
    // sessionStorage can throw in a locked-down context; seeding without the flag is still right.
  }
  const key = win.key ?? seedKey;
  const stops = [...chain, target];
  stops.forEach((href, idx) => {
    const usr = idx === 0 ? null : { from: stops[idx - 1] };
    const data: RouterEntry = { usr, key: key(), idx };
    const url = mounted(href) + (idx === stops.length - 1 ? location.hash : "");
    if (idx === 0) history.replaceState(data, "", url);
    else history.pushState(data, "", url);
  });
  return true;
}

function storageRead(win: SeedWindow, key: string): string | null {
  try {
    return win.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
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
 * The sessionStorage key holding a notification's target while the page cannot take it: update mode
 * holds the reload (`UPDATE_MODE_HOLD`) or a reload is already on its way. The fresh page opens it.
 */
export const PENDING_OPEN_KEY = "collie.nav.pendingOpen";

/** What the listener asks of the page before it moves. Injected, so the test needs no service worker. */
export interface OpenGate {
  /** True while a move now would be lost: update mode holds the reload, or a reload is in flight. */
  busy(): boolean;
  /** Calls back when `busy()` may have changed. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

/** Push `path` as a DOWN move from wherever the router is. Nothing when it is already there. */
function openDown(router: OpenRouter, path: string): void {
  const { pathname, search } = router.state.location;
  const from = `${pathname}${search}`;
  if (path !== from) void router.navigate(path, { state: { from } });
}

/**
 * Open the target a notification left while the page could not move, once, as a DOWN move (ADR
 * 0067). Called at boot, which is the fresh page the held reload brings, and whenever the gate says
 * it is free again, which covers an update that ended without reloading this page.
 */
export function openPendingTarget(router: OpenRouter, gate: OpenGate): boolean {
  if (gate.busy()) return false;
  let path: string | null = null;
  try {
    path = gate.storage?.getItem(PENDING_OPEN_KEY) ?? null;
    if (path !== null) gate.storage?.removeItem(PENDING_OPEN_KEY);
  } catch {
    return false;
  }
  if (path === null) return false;
  openDown(router, path);
  return true;
}

/**
 * Answer the service worker's `collie:open`: push the target as a DOWN move from wherever the app
 * is, and acknowledge on the message's port so the worker knows not to fall back to a navigate.
 * While the gate is busy the target is kept in sessionStorage instead and still acknowledged, since
 * a navigate by the worker would be lost the same way; the fresh page, or the gate coming free,
 * opens it. Returns the unsubscribe.
 */
export function listenForInAppOpen(router: OpenRouter, gate: OpenGate): () => void {
  // Absent over plain HTTP (no secure context) and in jsdom: then no worker can post to us anyway.
  if (!("serviceWorker" in navigator)) return () => {};
  const sw = navigator.serviceWorker;
  const onMessage = (event: MessageEvent) => {
    const port = event.ports[0];
    const path = inAppTarget(event.data);
    if (path === null) {
      if (parseOpenMessage(event.data) !== undefined) port?.postMessage(false, []);
      return;
    }
    port?.postMessage(receiveOpen(router, gate, path), []);
  };
  // A reload's hold clears in the same turn as the reload it releases; one tick later tells an
  // update that ended in place from one that is reloading.
  const stop = gate.subscribe(() => setTimeout(() => openPendingTarget(router, gate), 0));
  sw.addEventListener("message", onMessage);
  return () => {
    stop();
    sw.removeEventListener("message", onMessage);
  };
}

/** The app path a `collie:open` message names, or null for any other message or another origin. */
function inAppTarget(data: JsonValue | undefined): string | null {
  const message = parseOpenMessage(data);
  if (message === undefined) return null;
  return appPathOf(message.url, window.location.origin);
}

/**
 * Take one notification target: open it now, or keep it for later while the gate is busy. Returns
 * whether it was taken, which is the acknowledgement the worker waits for. Exported for the test.
 */
export function receiveOpen(router: OpenRouter, gate: OpenGate, path: string): boolean {
  if (!gate.busy()) {
    openDown(router, path);
    return true;
  }
  try {
    gate.storage?.setItem(PENDING_OPEN_KEY, path);
    return gate.storage !== undefined;
  } catch {
    return false;
  }
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
