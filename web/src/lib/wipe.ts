// ── ONE WIPE ROUTINE FOR THE PHONE (M46 spec 02) ─────────────────────────────────────────────────
//
// Every event that ends a pairing calls `wipeDevice`, and nothing else clears pairing state. Before
// this module each path cleared what it remembered: unpair dropped the token and left the drafts, the
// last-seen pane text, the push subscription and the caches behind. One routine means a new kind of
// stored data gets one cleaner here (or registers one with `onWipe`), and every path picks it up.
//
// The reasons, and who calls them:
//
//   - `unpair`   the operator revoked THIS device from Settings (components/paired-devices.tsx).
//   - `revoked`  the bridge answered 403 `device not paired` while this phone held a token: someone
//                revoked it from another device, or the registry it was minted in is gone.
//   - `expired`  the bridge answered 403 `device expired` (M46 spec 01).
//   - `password` a pane sits at a password prompt (ADR 0017). Not the end of a pairing, so it takes a
//                scope: the session text of that one pane, its draft and its stored records, and
//                never the token. ADR 0017 decides that scope; this routine only carries it.
//
// The first three clear, in this order: the device token, every draft, the push subscription (with
// the remembered endpoint), Cache Storage except the app shell, and then whatever registered itself
// with `onWipe`. The on-device store (lib/store.ts, ADR 0087) is one of those: it holds the last-seen
// snapshot and pane text, and its cleaner deletes the whole database. It registers itself rather
// than being listed here because it imports this module, and a cycle would leave one of the two
// half-loaded.
//
// WHAT STAYS, ON PURPOSE. Preferences: theme, design, display and dash prefs, pins, hidden machines,
// haptics, zen, the tour flag, the push-disabled choice, per-pane mirror inversion. They hold no
// session content, only how this phone likes to look, and a re-paired phone should look the same.
// The workbox precache stays too, because the app shell must still open offline to show the pair
// form. lib/storage-keys.test.ts holds the full list and fails on a key that is in neither.
//
// ONE REFUSAL IS NOT ENOUGH TO WIPE. A 403 with one of the two exact bodies, while a token is held,
// first asks the bridge once more: one GET of `/api/devices` with the same token. Only when that
// answer is ALSO a 403 with one of the two exact bodies does the wipe run. Any other answer (a 200,
// the 503 `pairing unavailable` a corrupt registry gives, a network error, another 403 text) latches
// the refusal for the pair affordances and wipes nothing: a bridge that answered oddly once must not
// cost the operator their drafts.
//
// A WIPE IS RESUMABLE. It writes `collie:wipe-pending` (the reason) first, runs the cleaners, and
// clears the flag last. A page killed half way leaves the flag, and the next boot runs the wipe again
// before anything reads storage (lib/wipe-resume.ts, the first import of main.tsx). It also writes
// `collie:wipe-last`, the reason the pair screen names once and then clears. Before the cleaners run
// it posts on the `collie-wipe` BroadcastChannel, so another open tab closes its store connection
// and the database delete is not blocked by it (lib/store.ts listens).

import { mounted } from "@/lib/base-path";
import { clearAllDrafts, clearDraft } from "@/lib/drafts";
import { forgetAgain } from "@/lib/new-sheet";
import {
  clearDeviceToken,
  EXPIRED_BODY,
  getDeviceToken,
  markExpired,
  markNotPaired,
  NOT_PAIRED_BODY,
} from "@/lib/pairing";
import { rememberEndpoint } from "@/lib/push-endpoint";
import type { Scope } from "@/lib/scope";

/** Why a wipe runs. See the header for who calls each one. */
export type WipeReason = "unpair" | "revoked" | "expired" | "password";

/** The reasons that end a pairing, as opposed to a password prompt's one-pane wipe. */
export type PairingEndReason = "unpair" | "revoked" | "expired";

/** localStorage key: the reason of a wipe that started and has not finished. Written first, cleared last. */
export const WIPE_PENDING_KEY = "collie:wipe-pending";

/** localStorage key: the reason of the last finished or started wipe, for the pair screen's one line. */
export const WIPE_LAST_KEY = "collie:wipe-last";

/** The BroadcastChannel a wipe announces itself on, so other tabs let go of the store. */
export const WIPE_CHANNEL = "collie-wipe";

/**
 * This page's id on that channel. A BroadcastChannel delivers to every other object of the same name
 * in the same page too, so a listener tells its own page's announcement apart by this.
 */
export const WIPE_TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** The message a wipe posts on {@link WIPE_CHANNEL}. */
export interface WipeAnnouncement {
  type: "wipe";
  reason: PairingEndReason;
  from: string;
}

/** The one pane a password-prompt wipe is about. */
export interface WipePane {
  scope: Scope | undefined;
  paneId: string;
}

/**
 * What a cleaner is told. A pairing that ended clears everything; a password prompt names its pane,
 * and a cleaner that holds session text for panes drops that pane's share.
 */
export type WipeContext =
  | { reason: PairingEndReason }
  | { reason: "password"; pane: WipePane };

/** A cleaner may be synchronous or not. A synchronous one has finished when `wipeDevice` returns. */
export type WipeCleaner = (context: WipeContext) => void | Promise<void>;

/** What a wipe did: the names of the cleaners that threw or timed out. Empty is a clean wipe. */
export interface WipeReport {
  reason: WipeReason;
  failed: string[];
}

/**
 * How long an asynchronous cleaner may take. A PushManager call cannot be aborted and has been seen
 * to hang (lib/push.ts `pushOperation`), and a wipe must still settle and report.
 */
const CLEANER_TIMEOUT_MS = 10_000;

/** The workbox precache: the app shell. Every other cache goes. */
const PRECACHE_PREFIX = "workbox-precache";

async function forgetPushSubscription(): Promise<void> {
  rememberEndpoint(null);
  // Optional at each step: no service worker over plain HTTP, no PushManager on some browsers. The
  // browser unsubscribe makes the endpoint answer 410 on the next send, and the bridge drops it then
  // (lib/push.ts `disablePush` relies on the same thing). There is no unsubscribe endpoint to call.
  const registration = await globalThis.navigator?.serviceWorker?.getRegistration();
  const subscription = await registration?.pushManager?.getSubscription();
  await subscription?.unsubscribe();
}

async function clearCaches(): Promise<void> {
  // Absent outside a secure context and in tests. TypeScript types it as always present.
  const storage: CacheStorage | undefined = globalThis.caches;
  if (storage === undefined) return;
  const names = await storage.keys();
  // `collie-fonts` and `collie-push-titles` (each per mount) go: fonts re-fill on first use, and the
  // push titles are written again on the next boot. Sibling mounts on the same origin lose theirs
  // too, which costs them the same refill and nothing more.
  await Promise.all(names.filter((name) => !name.startsWith(PRECACHE_PREFIX)).map((name) => storage.delete(name)));
}

/** The built-in cleaners, in the order they run. The password reason touches only session text. */
const BUILT_IN: readonly (readonly [string, WipeCleaner])[] = [
  [
    "token",
    (context) => {
      if (context.reason !== "password") clearDeviceToken();
    },
  ],
  [
    "drafts",
    (context) => {
      if (context.reason === "password") clearDraft(context.pane.scope, context.pane.paneId);
      else clearAllDrafts();
    },
  ],
  [
    "new-sheet",
    (context) => {
      if (context.reason !== "password") forgetAgain();
    },
  ],
  [
    "push",
    (context) => (context.reason === "password" ? undefined : forgetPushSubscription()),
  ],
  [
    "caches",
    (context) => (context.reason === "password" ? undefined : clearCaches()),
  ],
];

const registered = new Map<string, WipeCleaner>();

/**
 * Register a cleaner every wipe runs after the built-in ones. For stores that come later (spec 08's
 * on-device store), so no caller of `wipeDevice` has to change. Re-registering a name replaces it.
 * Returns the unregister function.
 */
export function onWipe(name: string, cleaner: WipeCleaner): () => void {
  registered.set(name, cleaner);
  return () => {
    if (registered.get(name) === cleaner) registered.delete(name);
  };
}

function withTimeout(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("wipe cleaner timed out")), CLEANER_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function isPairingEndReason(value: string | null): value is PairingEndReason {
  return value === "unpair" || value === "revoked" || value === "expired";
}

function writeFlag(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Locked-down storage: the wipe still runs, it only cannot be resumed or named.
  }
}

function readFlag(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Tell other tabs a wipe is starting, so they close their store connection. Best effort. */
function announceWipe(reason: PairingEndReason): void {
  try {
    const channel = new BroadcastChannel(WIPE_CHANNEL);
    const message: WipeAnnouncement = { type: "wipe", reason, from: WIPE_TAB_ID };
    // Bound, not called as `channel.postMessage(message)`: the lint rule for `window.postMessage`
    // asks for a `targetOrigin`, and `BroadcastChannel.postMessage` has none to give. A channel is
    // same-origin by construction, so there is no origin to name.
    const post: (data: WipeAnnouncement) => void = channel.postMessage.bind(channel);
    post(message);
    channel.close();
  } catch {
    // No BroadcastChannel (an old browser, a worker without it): the delete may then be blocked by
    // another tab, and the store's own blocked handling covers that.
  }
}

/**
 * Remove what Collie stored about this pairing. Synchronous cleaners (token, drafts) have
 * run by the time this returns; the promise settles when the asynchronous ones have too. A cleaner
 * that throws does not stop the others, and the report names it. The promise never rejects.
 *
 * A pairing that ends marks the wipe pending before any cleaner runs and clears the mark after the
 * last one settled, so a page that dies in between finishes the wipe on its next boot.
 */
export function wipeDevice(reason: PairingEndReason): Promise<WipeReport>;
export function wipeDevice(reason: "password", pane: WipePane): Promise<WipeReport>;
export function wipeDevice(reason: WipeReason, pane?: WipePane): Promise<WipeReport> {
  let context: WipeContext;
  if (reason !== "password") context = { reason };
  else if (pane !== undefined) context = { reason, pane };
  else throw new Error("wipeDevice: a password wipe names its pane");
  const ending = context.reason !== "password";
  if (context.reason !== "password") {
    writeFlag(WIPE_PENDING_KEY, context.reason);
    writeFlag(WIPE_LAST_KEY, context.reason);
    announceWipe(context.reason);
  }
  const failed: string[] = [];
  const pending: Promise<void>[] = [];
  for (const [name, cleaner] of [...BUILT_IN, ...registered]) {
    try {
      const result = cleaner(context);
      if (result instanceof Promise) {
        pending.push(
          withTimeout(result).catch(() => {
            failed.push(name);
          }),
        );
      }
    } catch {
      failed.push(name);
    }
  }
  return Promise.all(pending).then(() => {
    // Cleared whatever failed: a cleaner that fails every time must not wipe a re-paired phone on
    // every boot. The report names it; the store records a delete it could not finish.
    if (ending) writeFlag(WIPE_PENDING_KEY, null);
    return { reason, failed };
  });
}

/**
 * At boot, before anything reads storage: finish a wipe a killed page left half done. Returns the
 * wipe's promise, or null when none was pending. A flag holding an unknown value is dropped.
 */
export function resumePendingWipe(): Promise<WipeReport> | null {
  const reason = readFlag(WIPE_PENDING_KEY);
  if (reason === null) return null;
  if (!isPairingEndReason(reason)) {
    writeFlag(WIPE_PENDING_KEY, null);
    return null;
  }
  return wipeDevice(reason);
}

/**
 * The reason of the last wipe, for the pair screen's one line. Read once: the line is shown on the
 * pair screen's mount and then {@link clearLastWipe} takes it.
 */
export function lastWipeReason(): PairingEndReason | null {
  const reason = readFlag(WIPE_LAST_KEY);
  return isPairingEndReason(reason) ? reason : null;
}

/** The pair screen has shown the cause; it is not shown again. */
export function clearLastWipe(): void {
  writeFlag(WIPE_LAST_KEY, null);
}

// ── THE CONFIRMING READ ──────────────────────────────────────────────────────

/** How long the confirming read may take. Past it, the answer counts as "not a refusal". */
const CONFIRM_TIMEOUT_MS = 10_000;

/**
 * The bridge's verdict on `token`, asked once more: the refusal it names when the answer is a 403
 * with one of the two exact bodies, else null. A plain fetch rather than lib/api.ts, which reads every
 * refusal back into this module and imports it.
 */
async function confirmRefusal(token: string): Promise<"not-paired" | "expired" | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
  try {
    const res = await fetch(mounted("/api/devices"), {
      // The same two headers lib/api.ts sends on every read: the same-origin marker and the token.
      headers: { "x-requested-with": "XMLHttpRequest", authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: controller.signal,
    });
    if (res.status !== 403) return null;
    const body = (await res.text()).trim();
    if (body === NOT_PAIRED_BODY) return "not-paired";
    if (body === EXPIRED_BODY) return "expired";
    return null;
  } catch {
    return null; // a network error says nothing about the pairing
  } finally {
    clearTimeout(timer);
  }
}

/** The confirmation in flight, so a burst of refused polls asks the bridge once. */
let confirming: Promise<void> | null = null;

async function confirmAndWipe(token: string): Promise<void> {
  const verdict = await confirmRefusal(token);
  if (verdict === null) return;
  // A fresh pairing landed while the bridge was asked: the refusal was about a token that is gone.
  if (getDeviceToken() !== token) return;
  if (verdict === "expired") markExpired();
  await wipeDevice(verdict === "expired" ? "expired" : "revoked");
}

/**
 * The bridge refused this device's pairing with one of its two exact refusal texts. Latch the
 * refusal for the read-only strip and the pair form at once. When this phone held a token, ask the
 * bridge once more (see the header) and wipe only on a second exact refusal: only then did a pairing
 * end here. With no token the refusal is the ordinary state of an unpaired phone, and there is
 * nothing of a pairing to clear.
 *
 * Callers pass a refusal they matched EXACTLY. A crew member's longer body, the proxy allowlist's
 * `device not authorised` and every other 403 must never reach this.
 */
export function pairingRefused(refusal: "not-paired" | "expired"): void {
  const token = getDeviceToken();
  if (refusal === "expired") markExpired();
  else markNotPaired();
  if (token === null || confirming !== null) return;
  confirming = confirmAndWipe(token).finally(() => {
    confirming = null;
  });
}

/** Test seam: resolves once the confirmation in flight (and the wipe it started) has settled. */
export function __refusalSettled(): Promise<void> {
  return confirming ?? Promise.resolve();
}

/** Test seam: drop every registered cleaner. */
export function __resetWipe(): void {
  registered.clear();
  confirming = null;
}
