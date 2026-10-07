// The app's data, as stores the polling scheduler writes and components read (lib/store.ts).
//
// Each store keeps the last good body beside the last error, so a failed poll shows stale data
// flagged, never an empty screen: the keep-previous-data rule web/src/lib/loaders.ts follows.
//
// QUIET POLLS (REMIX3.md, "A module store is right when"). A store publishes only on a real change:
// a poll that brings the same body keeps the HELD object (lib/same.ts decides "same"), and the
// stores compare by field, so every subscriber sleeps through it. WHEN the bridge last answered is
// not part of any body: it is `snapshotAt`, its own store, which moves on every answer. Only the
// readers that show or act on freshness subscribe to it (the connection strip, the stale-app watch,
// the pane's "gone from a fresh snapshot" proof); a 6 s beat no longer re-renders every screen.
import { markLive } from "@web/lib/connection-health";
import { loadLastSnapshot, saveLastSnapshot } from "@web/lib/last-seen";
import { internScope, scopeFromUrl, viewAllFromUrl, type Scope } from "@web/lib/scope";
import type { BridgeConfig, SnapshotResponse } from "@web/lib/types";

import { ApiError, fetchConfig, fetchSnapshot, isAbort } from "./api";
import { busy } from "./busy";
import type { PaneRead } from "./pane-read";
import { samePaneRead, sameSnapshot } from "./same";
import { createStore, type Store } from "./store";

export interface Loaded<T> {
  /** The last good body, kept through a failed poll. */
  data: T | undefined;
  /** What the last poll failed with, or undefined when it succeeded. */
  error: string | undefined;
  /** The HTTP status of that failure, when the bridge answered one (401 and 403 matter). */
  status: number | undefined;
}

const EMPTY = { data: undefined, error: undefined, status: undefined } as const;

function empty<T>(): Loaded<T> {
  return { ...EMPTY };
}

/** The stores' gate: the same body object (a quiet poll keeps the held one), error and status. */
export function sameLoaded<T>(a: Loaded<T>, b: Loaded<T>): boolean {
  return a.data === b.data && a.error === b.error && a.status === b.status;
}

/** The mirror's gate: the same screen by value, since web's `fetchPane` hands back a new object per read. */
function samePaneLoaded(a: Loaded<PaneRead>, b: Loaded<PaneRead>): boolean {
  return samePaneRead(a.data, b.data) && a.error === b.error && a.status === b.status;
}

/** Where the open screen points: the `?h=` / `?s=` scope and the `?all=1` breadth of its URL. */
export interface Address {
  scope: Scope;
  all: boolean;
}

/** Set by the router on every navigation (router.tsx); the polling sources read it at fire time. */
export const address = createStore<Address>(
  { scope: internScope({}), all: false },
  (a, b) => a.scope === b.scope && a.all === b.all,
);

export function noteAddress(url: URL): void {
  address.set({ scope: internScope(scopeFromUrl(url.href)), all: viewAllFromUrl(url.href) });
}

export const snapshot = createStore<Loaded<SnapshotResponse>>(empty(), sameLoaded);
export const config = createStore<Loaded<BridgeConfig>>(empty(), sameLoaded);
/**
 * When the held snapshot was last confirmed by the bridge (epoch ms), 0 before the first answer. It
 * moves on EVERY answer, a quiet one included, so subscribe only where freshness is drawn or acted
 * on. A cold boot drawn from the last-seen cache carries that cache's own date. It never compares:
 * two answers in one millisecond are still two answers (the stale-app watch counts them).
 */
export const snapshotAt = createStore<number>(0, () => false);

const paneStores = new Map<string, Store<Loaded<PaneRead>>>();

/** The store for one pane's mirror, created on first ask and kept for the page's lifetime. */
export function paneStore(key: string): Store<Loaded<PaneRead>> {
  let store = paneStores.get(key);
  if (!store) {
    store = createStore<Loaded<PaneRead>>(empty(), samePaneLoaded);
    paneStores.set(key, store);
  }
  return store;
}

function failed<T>(store: Store<Loaded<T>>, error: Error): void {
  if (isAbort(error)) throw error;
  store.update((prev) => ({
    ...prev,
    error: error.message,
    status: error instanceof ApiError ? error.status : undefined,
  }));
}

/** How often an unchanged snapshot is written through to the last-seen cache (a changed one always is). */
const SAVE_EVERY_MS = 15_000;
let lastSavedAt = 0;

/**
 * A cold boot with no network has an empty store and a failing first read. The write-through cache
 * (web's lib/last-seen.ts, sessionStorage) holds the herd the operator left, dated, so it is drawn
 * flagged stale instead of an empty herd; the next live poll replaces it.
 */
function restoreLastSeen(scope: Scope, all: boolean): void {
  if (snapshot.get().data !== undefined) return;
  const cached = loadLastSnapshot(scope, all);
  if (!cached) return;
  snapshot.set({ data: cached.value, error: undefined, status: undefined });
  snapshotAt.set(cached.at);
}

/**
 * One poll of the snapshot. Resolves true when the body changed (a 304, or a body `sameSnapshot`
 * calls the same, keeps the held object and wakes nobody). It counts as a POLL load for the bar
 * and the stalled check (lib/busy.ts): one hung past 6 s shows the bar, past 2.5 s the app looks
 * stalled. A live answer stamps the shared connection clock (`markLive`, web's own).
 */
export function loadSnapshot(signal: AbortSignal): Promise<boolean> {
  return loadSnapshotWith(async (scope, all) => (await fetchSnapshot(scope, signal, all)).body);
}

/**
 * One snapshot read through `read` (the JSON route, or an islands page's snapshot beat,
 * islands/snapshot-frames.ts), taken into the store as `loadSnapshot` takes it. Resolves true when
 * the herd changed.
 */
export async function loadSnapshotWith(read: (scope: Address["scope"], all: boolean) => Promise<SnapshotResponse>): Promise<boolean> {
  const { scope, all } = address.get();
  const release = busy.beginLoad("poll");
  try {
    return takeSnapshot(await read(scope, all));
  } catch (error) {
    if (error instanceof Error && !isAbort(error)) restoreLastSeen(scope, all);
    if (error instanceof Error) failed(snapshot, error);
    return false;
  } finally {
    release();
  }
}

/** A snapshot body that answered: into the store (the held object while equal), stamped, saved. */
export function takeSnapshot(body: SnapshotResponse): boolean {
  const { scope, all } = address.get();
  const held = snapshot.get().data;
  const same = held !== undefined && sameSnapshot(held, body);
  snapshot.set({ data: same ? held : body, error: undefined, status: undefined });
  snapshotAt.set(Date.now());
  if (body.bridge !== "disconnected") markLive();
  if (!same || Date.now() - lastSavedAt >= SAVE_EVERY_MS) {
    lastSavedAt = Date.now();
    saveLastSnapshot(scope, body, undefined, all);
  }
  return !same;
}

/**
 * The config, read ONCE per page load (web/src/lib/operator-config.ts, "THE CONTRACT"): it is
 * startup config on the bridge side, so it cannot change without a bridge restart, and re-reading it
 * on the beat only spent a request per tick. It sits on the beat until one read succeeds; after that
 * this fetches nothing. A failed read is not kept, so the next beat tries again (web retries on the
 * next mount). Unscoped, as web reads it: `/api/config` describes THIS bridge, whatever scope the
 * screen views (web/src/components/app-header.tsx). Resolves true when the store took a body.
 */
export async function loadConfig(signal: AbortSignal): Promise<boolean> {
  const held = config.get();
  if (held.data !== undefined && held.error === undefined) return false;
  try {
    const body = await fetchConfig(undefined, signal);
    config.set({ data: body, error: undefined, status: undefined });
    return true;
  } catch (error) {
    if (error instanceof Error) failed(config, error);
    return false;
  }
}
