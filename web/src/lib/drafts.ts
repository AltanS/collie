// Per-pane composer drafts, persisted so a reply survives leaving the pane.
//
// The composer's input is phone-owned local state, and the pane view is keyed by paneId — so
// walking over to another tab to check something (the exact reason you're composing a reply in the
// first place) unmounted the composer and ate the draft. This is the tiny store that keeps it.
//
// **localStorage, not sessionStorage.** A phone PWA gets killed mid-composition by the OS all the
// time — backgrounded, memory pressure, screen off long enough — and sessionStorage dies with the
// page. The draft has to outlive the process, not just the navigation.
//
// Same storage-guard style as lib/haptics.ts: every access is behind a `typeof localStorage` check
// AND a try/catch, because Safari private mode throws on setItem rather than reporting quota. A
// draft is never important enough to break a render or a send.

import { normalizeScope, type Scope } from "./scope";

const PREFIX = "collie:draft:";

/** Drafts older than this are pruned on first use — an ancient half-thought must never resurface. */
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** Upper bound per stored draft. Nobody types 8 KiB on a phone; a value that big is a paste gone
 *  wrong or a bug. Oversize is SKIPPED, never truncated — a silently half-saved message that you
 *  then send is worse than no draft at all. */
const MAX_CHARS = 8 * 1024;

interface DraftEntry {
  text: string;
  at: number;
}

// A pane id is unique only within one session on one machine, so a draft is keyed by the whole
// (host, session, paneId) triple — otherwise the draft you typed for `w1:p1` on one machine would be
// restored into `w1:p1` on another. The lead's keys are byte-identical to what shipped: the host
// segment is emitted only when there IS one, so every existing stored draft is still found.
function keyFor(scope: Scope | undefined, paneId: string): string {
  const { host, session } = normalizeScope(scope);
  return `${PREFIX}${host ? `${host}@` : ""}${session ?? "default"}:${paneId}`;
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null; // SSR / blocked storage
  }
}

let pruned = false;

/** Drop expired entries. Runs once per page load, lazily on the first draft access. */
export function pruneDrafts(now: number = Date.now()): void {
  const store = storage();
  if (!store) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key === null || !key.startsWith(PREFIX)) continue;
      const raw = store.getItem(key);
      const entry = parse(raw);
      // Unparseable entries go too — a key we can't read is a key we can never clean up later.
      if (entry === null || now - entry.at > MAX_AGE_MS) stale.push(key);
    }
    for (const key of stale) store.removeItem(key);
  } catch {
    // Enumeration can throw in locked-down storage — nothing to do but leave the drafts be.
  }
}

function prunedOnce(): void {
  if (pruned) return;
  pruned = true;
  pruneDrafts();
}

function parse(raw: string | null): DraftEntry | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const entry = value as Partial<DraftEntry>;
    if (typeof entry.text !== "string" || typeof entry.at !== "number") return null;
    return { text: entry.text, at: entry.at };
  } catch {
    return null;
  }
}

/** The stored draft for a pane, or null if there is none (or it's expired/unreadable). */
export function loadDraft(scope: Scope | undefined, paneId: string): string | null {
  prunedOnce();
  const store = storage();
  if (!store) return null;
  try {
    const entry = parse(store.getItem(keyFor(scope, paneId)));
    if (entry === null) return null;
    if (Date.now() - entry.at > MAX_AGE_MS) {
      store.removeItem(keyFor(scope, paneId));
      return null;
    }
    return entry.text;
  } catch {
    return null;
  }
}

/**
 * Persist a pane's draft. Empty/whitespace-only text REMOVES the key — that's what "the user
 * deliberately emptied the box" looks like, and it means the clear-on-send path needs no special
 * case beyond saving the now-empty input.
 */
export function saveDraft(scope: Scope | undefined, paneId: string, text: string): void {
  prunedOnce();
  const store = storage();
  if (!store) return;
  if (text.trim() === "") {
    clearDraft(scope, paneId);
    return;
  }
  if (text.length > MAX_CHARS) return; // see MAX_CHARS — skip, don't truncate
  try {
    const entry: DraftEntry = { text, at: Date.now() };
    store.setItem(keyFor(scope, paneId), JSON.stringify(entry));
  } catch {
    // Quota / private mode. The in-memory draft is still on screen; only its persistence is lost.
  }
}

export function clearDraft(scope: Scope | undefined, paneId: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(keyFor(scope, paneId));
  } catch {
    // ignore
  }
}

/** Test seam — forgets the once-per-load prune so a case can control when pruning happens. */
export function __resetDraftPrune(): void {
  pruned = false;
}
