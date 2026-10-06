// The app's data, as stores the polling scheduler writes and components read (lib/store.ts).
//
// Each store keeps the last good body beside the last error, so a failed poll shows stale data
// flagged, never an empty screen: the keep-previous-data rule web/src/lib/loaders.ts follows.
import { markLive } from "@web/lib/connection-health";
import { loadLastSnapshot, saveLastSnapshot } from "@web/lib/last-seen";
import { internScope, scopeFromUrl, viewAllFromUrl, type Scope } from "@web/lib/scope";
import type { BridgeConfig, PaneReadResponse, SnapshotResponse } from "@web/lib/types";

import { ApiError, fetchConfig, fetchSnapshot, isAbort } from "./api";
import { busy } from "./busy";
import { createStore, type Store } from "./store";

export interface Loaded<T> {
  /** The last good body, kept through a failed poll. */
  data: T | undefined;
  /** What the last poll failed with, or undefined when it succeeded. */
  error: string | undefined;
  /** The HTTP status of that failure, when the bridge answered one (401 and 403 matter). */
  status: number | undefined;
  /** When `data` was fetched (epoch ms); 0 before the first answer. */
  at: number;
}

const EMPTY = { data: undefined, error: undefined, status: undefined, at: 0 } as const;

function empty<T>(): Loaded<T> {
  return { ...EMPTY };
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

export const snapshot = createStore<Loaded<SnapshotResponse>>(empty());
export const config = createStore<Loaded<BridgeConfig>>(empty());

const paneStores = new Map<string, Store<Loaded<PaneReadResponse>>>();

/** The store for one pane's mirror, created on first ask and kept for the page's lifetime. */
export function paneStore(key: string): Store<Loaded<PaneReadResponse>> {
  let store = paneStores.get(key);
  if (!store) {
    store = createStore<Loaded<PaneReadResponse>>(empty());
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
  if (cached) snapshot.set({ data: cached.value, error: undefined, status: undefined, at: cached.at });
}

/**
 * One poll of the snapshot. Resolves true when the body changed. It counts as a POLL load for the bar
 * and the stalled check (lib/busy.ts): one hung past 6 s shows the bar, past 2.5 s the app looks
 * stalled. A live answer stamps the shared connection clock (`markLive`, web's own).
 */
export async function loadSnapshot(signal: AbortSignal): Promise<boolean> {
  const { scope, all } = address.get();
  const release = busy.beginLoad("poll");
  try {
    const got = await fetchSnapshot(scope, signal, all);
    snapshot.set({ data: got.body, error: undefined, status: undefined, at: Date.now() });
    if (got.body.bridge !== "disconnected") markLive();
    if (!got.notModified || Date.now() - lastSavedAt >= SAVE_EVERY_MS) {
      lastSavedAt = Date.now();
      saveLastSnapshot(scope, got.body, undefined, all);
    }
    return !got.notModified;
  } catch (error) {
    if (error instanceof Error && !isAbort(error)) restoreLastSeen(scope, all);
    if (error instanceof Error) failed(snapshot, error);
    return false;
  } finally {
    release();
  }
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
    config.set({ data: body, error: undefined, status: undefined, at: Date.now() });
    return true;
  } catch (error) {
    if (error instanceof Error) failed(config, error);
    return false;
  }
}
