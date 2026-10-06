// The write-through "last seen" cache — what the app re-renders after a COLD boot with no network.
//
// The in-session story was already right: a failed poll keeps the last good data on screen, flagged
// (see lib/loaders.ts). The hole is the one a phone falls into constantly. Switch to the Tailscale
// app, come back, and the mobile browser has DISCARDED the hidden page, or the OS has killed the PWA
// outright: the app boots from zero, its module caches are empty, its first loader fetch fails
// because the tunnel is not up yet, and the screen the operator left behind is simply gone.
//
// So every successful loader fetch also writes its payload here, and a failed fetch with an empty
// module cache reads it back. The router renders it immediately, flagged stale; the ordinary polling
// loop keeps running and swaps in live data the moment the network returns.
//
// **The on-device store, not sessionStorage** (ADR 0087, M46 spec 08). Until 1.18.0 this module
// wrote to sessionStorage, which survives a discarded tab and dies with the process, and a phone
// kills the process all the time. The pane-list snapshot and the pane text now live in the one
// IndexedDB store (lib/store.ts), under its lifetime, its size caps and its one wipe. This module
// stays as the narrow, typed door to those two record kinds, so the loaders keep one place to ask.
//
// ADR 0017 rider: a pane sitting at a password prompt is never written here, and any text already
// written for it is dropped. The call site (and the reasoning) is in lib/loaders.ts; the drop runs
// through the wipe (lib/wipe.ts `wipeDevice("password", …)`), which reaches the store's cleaner.
//
// Every entry carries the wall-clock of the fetch that produced it, because a stale render must be
// able to say WHEN — "Disconnected — last seen 14:32" is honest, an undated old screen is not.

import { paneScopeKey, type Scope, snapshotKey } from "@/lib/scope";
import { getRecord, PANE_CAP_BYTES, putRecord, utf8Bytes } from "@/lib/store";
import type { SnapshotResponse } from "@/lib/types";

/** A cached payload and the wall-clock of the successful fetch that produced it. */
export interface Cached<T> {
  at: number;
  value: T;
}

/**
 * The newest lines of `text` whose JSON fits the store's per-pane cap. A mirror past the cap keeps its
 * tail, cut at a line start, because the tail is what the pane view opens on. Exported for the tests.
 */
export function fitPaneText(text: string): string {
  let fitted = text;
  let size = utf8Bytes(JSON.stringify(fitted));
  while (size > PANE_CAP_BYTES && fitted.length > 0) {
    // Keep a share of the characters in proportion to the overshoot, with a margin, then start at
    // the next whole line. Converges in a step or two; the loop guards a text of wide characters.
    const keep = Math.floor((fitted.length * PANE_CAP_BYTES * 0.9) / size);
    const tail = fitted.slice(fitted.length - keep);
    const cut = tail.indexOf("\n");
    fitted = cut < 0 ? tail : tail.slice(cut + 1);
    size = utf8Bytes(JSON.stringify(fitted));
  }
  return fitted;
}

/** Write through the snapshot a successful `/api/snapshot` just returned. */
export function saveLastSnapshot(
  scope: Scope | undefined,
  snap: SnapshotResponse,
  at: number = Date.now(),
  all = false,
): void {
  void putRecord("snapshot", snapshotKey(scope, all), snap, { fetchedAt: at });
}

/** The last snapshot this phone saw for a scope at this breadth, with the time it was fetched. */
export async function loadLastSnapshot(
  scope: Scope | undefined,
  all = false,
): Promise<Cached<SnapshotResponse> | null> {
  const record = await getRecord("snapshot", snapshotKey(scope, all));
  if (record === null || !(record.value instanceof Object)) return null;
  // SAFETY: the only writer of this kind is saveLastSnapshot above, with the body a successful
  // `/api/snapshot` returned — the same unvalidated shape lib/api.ts hands the loaders live. The
  // store gives back the JSON it was handed, so the assertion claims no more than the live path does.
  return { at: record.fetchedAt, value: record.value as SnapshotResponse };
}

/** Write through the mirror a successful `/api/pane/:id` just returned. */
export function saveLastPaneText(
  scope: Scope | undefined,
  paneId: string,
  text: string,
  at: number = Date.now(),
): void {
  void putRecord("pane-text", paneScopeKey(scope, paneId), fitPaneText(text), {
    fetchedAt: at,
    pane: { scope, paneId },
  });
}

/** The last mirror this phone saw for a pane, with the time it was fetched. */
export async function loadLastPaneText(scope: Scope | undefined, paneId: string): Promise<Cached<string> | null> {
  const record = await getRecord("pane-text", paneScopeKey(scope, paneId));
  if (record === null) return null;
  // The value is rendered as terminal text, so it is made a string by construction. The only writer
  // of this kind is saveLastPaneText above, with a string, so this is the identity in practice.
  return { at: record.fetchedAt, value: String(record.value) };
}

// ── The 1.17 sessionStorage entries ───────────────────────────────────────────
//
// A tab that updated from 1.17 can still hold the old mirror in sessionStorage: it survives a reload
// and dies only with the tab. Nothing reads it any more, and the wipe does not know it, so the first
// boot of this build deletes it.

const LEGACY_PREFIXES = ["collie:last-snapshot:", "collie:last-pane:"] as const;

/** Delete the 1.17 sessionStorage mirror. Runs once when this module loads. */
export function dropLegacyLastSeen(): void {
  try {
    const session = globalThis.sessionStorage;
    if (session === undefined) return;
    const doomed: string[] = [];
    for (let i = 0; i < session.length; i++) {
      const key = session.key(i);
      if (key !== null && LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix))) doomed.push(key);
    }
    for (const key of doomed) session.removeItem(key);
  } catch {
    // Blocked storage: nothing could have been written there either.
  }
}

dropLegacyLastSeen();
