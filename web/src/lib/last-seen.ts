// The write-through "last seen" cache — what the app re-renders after a COLD boot with no network.
//
// The in-session story was already right: a failed poll keeps the last good data on screen, flagged
// (see lib/loaders.ts). The hole is the one a phone falls into constantly. Switch to the Tailscale
// app, come back, and the mobile browser has DISCARDED the hidden page: the PWA boots from zero, its
// module caches are empty, its first loader fetch fails because the tunnel is not up yet — and the
// screen the operator left behind is simply gone, replaced by an empty herd. Nothing about that is a
// connection state the in-memory cache can help with, because the process that held it is dead.
//
// So every successful loader fetch also writes its payload here, and a failed fetch with an empty
// module cache reads it back. The router renders it immediately, flagged stale; the ordinary polling
// loop keeps running and swaps in live data the moment the network returns. No new fetch, no new
// state machine — the loaders already have both branches, this only gives the cache a longer life.
//
// **sessionStorage, not localStorage** — deliberately the opposite choice from lib/drafts.ts. A draft
// is the operator's own unsent words and must survive an OS kill, so it earns the longer-lived store.
// This is a MIRROR of someone else's terminal: worth keeping for the seconds it takes a tunnel to come
// back, misleading a day later, and a snapshot of screens the operator may not want left on disk.
// Dying with the tab is exactly the scope we want — and a tab the browser DISCARDED and then restored
// keeps its sessionStorage, which is the one case this module exists for.
//
// ADR 0017 rider: a pane sitting at a password prompt is never written here, and any text already
// written for it is dropped. The call site (and the reasoning) is in lib/loaders.ts.
//
// Every entry carries the wall-clock of the fetch that produced it, because a stale render must be
// able to say WHEN — "Disconnected — last seen 14:32" is honest, an undated old screen is not.

import type { SnapshotResponse } from "@/lib/types";

const SNAPSHOT_PREFIX = "collie:last-snapshot:";
const PANE_PREFIX = "collie:last-pane:";

/**
 * How many panes keep a cached mirror. A phone views one pane at a time, and sessionStorage is a
 * small shared quota that a 600-line mirror eats fast — so this is far tighter than the module
 * cache's PANE_TEXT_MAX. Past it the oldest entry (by its own stamp) is evicted.
 */
const PANE_MAX = 4;

/** A cached payload and the wall-clock of the successful fetch that produced it. */
export interface Cached<T> {
  at: number;
  value: T;
}

// `globalThis.sessionStorage` rather than a bare `sessionStorage`: the property read is undefined
// where the API doesn't exist (the service worker, a non-DOM test) instead of throwing a
// ReferenceError, and the try/catch covers the browsers that throw on ACCESS when storage is blocked.
function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // blocked / partitioned storage
  }
}

function snapshotKey(session: string | undefined): string {
  return `${SNAPSHOT_PREFIX}${session ?? ""}`;
}

// A space, not NUL: the same (session, paneId) pairing the loaders key their module caches with,
// spelled for a store whose keys are visible in devtools. Session names can't contain a space
// (lib/session.ts normalises them), so the pair stays unambiguous.
function paneKey(session: string | undefined, paneId: string): string {
  return `${PANE_PREFIX}${session ?? ""} ${paneId}`;
}

// Writes are best-effort. Storage can be full (quota), disabled, or in private-mode weirdness — none
// of which is a reason to fail a poll that otherwise succeeded, so a failed write just means this
// boot has no safety net.
function write(key: string, payload: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, payload);
  } catch {
    // Most likely a quota rejection. Drop the pane mirrors (the bulky half) and try once more, so a
    // full store degrades to "the newest thing still fits" rather than "nothing is ever cached again".
    try {
      clearPanes();
      store.setItem(key, payload);
    } catch {
      // Still no. Leave the store alone; the loaders then behave exactly as they did before this module.
    }
  }
}

function readRaw(key: string): string | null {
  const store = storage();
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function remove(key: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    // Nothing to do — the entry simply stays until the tab closes.
  }
}

// ── The two on-disk formats ───────────────────────────────────────────────────
//
// A pane entry is `<stamp>\n<text>` — a plain string, never JSON. That is not thrift: the value is
// rendered as terminal text, so "did this parse to a STRING?" has to be answered without trusting the
// store, and a split-at-the-first-newline parse answers it by construction. JSON would hand back an
// arbitrary value that only a schema could vouch for.

function encodePane(at: number, text: string): string {
  return `${at}\n${text}`;
}

function decodePane(raw: string | null): Cached<string> | null {
  if (raw === null) return null;
  const cut = raw.indexOf("\n");
  if (cut < 0) return null;
  const at = Number.parseInt(raw.slice(0, cut), 10);
  if (!Number.isFinite(at)) return null;
  return { at, value: raw.slice(cut + 1) };
}

// A snapshot entry is JSON, because it is a whole response body. It gets the structural checks a
// parse boundary owes — parsed at all, an object, carrying a numeric stamp — and no more; see the
// SAFETY note at the assertion for why a field-by-field schema would buy nothing here.

function decodeSnapshot(raw: string | null): Cached<SnapshotResponse> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!(parsed instanceof Object)) return null;
    // SAFETY: the only writer of this key is saveLastSnapshot below, in this tab, with the body a
    // successful `/api/snapshot` returned — the same unvalidated shape lib/api.ts hands the loaders
    // live. The assertion therefore claims no more than the live path already does, and `at` is
    // re-checked below rather than assumed, so a hand-edited or format-drifted entry reads as a miss.
    const entry = parsed as Partial<Cached<SnapshotResponse>>;
    const at = entry.at;
    if (at === undefined || !Number.isFinite(at) || entry.value === undefined) return null;
    return { at, value: entry.value };
  } catch {
    return null;
  }
}

/** Every pane key currently in the store, paired with its stamp (0 when unreadable). */
function paneKeys(store: Storage): { key: string; at: number }[] {
  const out: { key: string; at: number }[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key === null || !key.startsWith(PANE_PREFIX)) continue;
    out.push({ key, at: decodePane(readRaw(key))?.at ?? 0 });
  }
  return out;
}

function clearPanes(): void {
  const store = storage();
  if (!store) return;
  try {
    for (const { key } of paneKeys(store)) store.removeItem(key);
  } catch {
    // Enumeration can throw in locked-down storage — leave them be.
  }
}

/** Keep only the PANE_MAX newest pane mirrors. */
function prunePanes(): void {
  const store = storage();
  if (!store) return;
  try {
    const keys = paneKeys(store);
    if (keys.length <= PANE_MAX) return;
    keys.sort((a, b) => b.at - a.at);
    for (const { key } of keys.slice(PANE_MAX)) store.removeItem(key);
  } catch {
    // As above — a store we can't enumerate simply doesn't get pruned.
  }
}

/** Write through the snapshot a successful `/api/snapshot` just returned. */
export function saveLastSnapshot(
  session: string | undefined,
  snap: SnapshotResponse,
  at: number = Date.now(),
): void {
  write(snapshotKey(session), JSON.stringify({ at, value: snap }));
}

/** The last snapshot this tab saw for a session, with the time it was fetched. */
export function loadLastSnapshot(session: string | undefined): Cached<SnapshotResponse> | null {
  return decodeSnapshot(readRaw(snapshotKey(session)));
}

/** Write through the mirror a successful `/api/pane/:id` just returned. */
export function saveLastPaneText(
  session: string | undefined,
  paneId: string,
  text: string,
  at: number = Date.now(),
): void {
  write(paneKey(session, paneId), encodePane(at, text));
  prunePanes();
}

/** The last mirror this tab saw for a pane, with the time it was fetched. */
export function loadLastPaneText(
  session: string | undefined,
  paneId: string,
): Cached<string> | null {
  return decodePane(readRaw(paneKey(session, paneId)));
}

/** Forget a pane's mirror — the ADR 0017 path, and the only reason to delete a single entry. */
export function dropLastPaneText(session: string | undefined, paneId: string): void {
  remove(paneKey(session, paneId));
}

/** Test helper — empty the whole cache between cases. */
export function __clearLastSeen(): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key === null) continue;
      if (key.startsWith(PANE_PREFIX) || key.startsWith(SNAPSHOT_PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}
