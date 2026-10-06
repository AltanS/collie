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
// The bridge also sends `Clear-Site-Data: "storage"` on the same two refusals (bridge/server.ts
// `pairingRefusal`). That header is a backstop: browsers honour it only over HTTPS, and the bridge is
// often reached over plain HTTP behind `tailscale serve`. This routine is the primary path.

import { clearAllDrafts, clearDraft } from "@/lib/drafts";
import { clearDeviceToken, getDeviceToken, markExpired, markNotPaired } from "@/lib/pairing";
import { rememberEndpoint } from "@/lib/push-endpoint";
import type { Scope } from "@/lib/scope";

/** Why a wipe runs. See the header for who calls each one. */
export type WipeReason = "unpair" | "revoked" | "expired" | "password";

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
  | { reason: "unpair" | "revoked" | "expired" }
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

/**
 * Remove what Collie stored about this pairing. Synchronous cleaners (token, drafts) have
 * run by the time this returns; the promise settles when the asynchronous ones have too. A cleaner
 * that throws does not stop the others, and the report names it. The promise never rejects.
 */
export function wipeDevice(reason: "unpair" | "revoked" | "expired"): Promise<WipeReport>;
export function wipeDevice(reason: "password", pane: WipePane): Promise<WipeReport>;
export function wipeDevice(reason: WipeReason, pane?: WipePane): Promise<WipeReport> {
  let context: WipeContext;
  if (reason !== "password") context = { reason };
  else if (pane !== undefined) context = { reason, pane };
  else throw new Error("wipeDevice: a password wipe names its pane");
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
  return Promise.all(pending).then(() => ({ reason, failed }));
}

/**
 * The bridge refused this device's pairing with one of its two exact refusal texts. Latch the
 * refusal for the read-only strip and the pair form, and wipe when this phone held a token: only then
 * did a pairing end here. With no token the refusal is the ordinary state of an unpaired phone, and
 * there is nothing of a pairing to clear.
 *
 * Callers pass a refusal they matched EXACTLY. A crew member's longer body, the proxy allowlist's
 * `device not authorised` and every other 403 must never reach this.
 */
export function pairingRefused(refusal: "not-paired" | "expired"): void {
  const held = getDeviceToken() !== null;
  if (refusal === "expired") markExpired();
  else markNotPaired();
  if (held) void wipeDevice(refusal === "expired" ? "expired" : "revoked");
}

/** Test seam: drop every registered cleaner. */
export function __resetWipe(): void {
  registered.clear();
}
