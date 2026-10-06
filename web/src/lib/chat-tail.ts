// ── THE CHAT TAIL IS CACHED AS RENDERED BLOCKS ONLY (M46 spec 09, ADR 0087) ─────────────────────
//
// What a cold open with no bridge can still read in Chat: the newest turns of each pane, as the
// bridge last sent them to be drawn. This module is the narrow, typed door to the store's
// `chat-tail` kind, the way lib/last-seen.ts is the door to `snapshot` and `pane-text`. It holds no
// state of its own and no second store.
//
// WHAT GOES IN. The entries of the held window (`ChatWindow.entries`, lib/chat-window.ts): the turns
// the Chat body renders from, already masked by the bridge (spec 07). Never the raw mirror, never a
// journal line, never the queue of unsent text, and never a cursor: a saved copy reads back with no
// `gen`, so the first live answer replaces it whole rather than being merged into it.
//
// HOW MUCH. The newest whole entries whose JSON fits this kind's share of the per-pane cap
// (`PANE_KIND_SHARE_BYTES`, half of 256 KiB; the pane's last-seen text takes the other half). Cut
// from the top, a whole entry at a time: a half turn would read as a reply the agent never gave.
//
// HOW LONG. The operator's setting, "Keep chat on this phone" (hooks/use-display-prefs.ts
// `keepChat`): off, 1 day (the default) or 7 days. The lifetime is taken at each write, so a change
// applies from the next write on. Off writes nothing and deletes every stored tail.
//
// NOT WHILE A PASSWORD IS ASKED FOR. ADR 0017 and ADR 0087 rule 7: a pane at a password prompt keeps
// nothing on the phone. The loaders recognise the prompt on the mirror and run the password wipe for
// that pane on every poll it stays up (lib/loaders.ts). This module listens to the same wipe and
// refuses to write that pane's tail for a short while after each one, so a Chat poll landing between
// two mirror polls cannot put back what the wipe just took.

import { paneScopeKey, type Scope } from "@/lib/scope";
import { deleteKind, getRecord, PANE_KIND_SHARE_BYTES, putRecord, utf8Bytes } from "@/lib/store";
import { asJsonNumber, asJsonObject, asJsonString, type JsonValue } from "@/lib/json";
import type { ChatEntry } from "@/lib/types";
import { onWipe, type WipeContext } from "@/lib/wipe";

/** The three values of "Keep chat on this phone". */
export const KEEP_CHAT_VALUES = ["off", "1d", "7d"] as const;

export type KeepChat = (typeof KEEP_CHAT_VALUES)[number];

/** The default, decided by Altan on 2026-10-06. The code and the tests do not depend on it. */
export const KEEP_CHAT_DEFAULT: KeepChat = "1d";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Narrow a stored pref's text to a {@link KeepChat}. */
export function isKeepChat(value: string | undefined): value is KeepChat {
  return KEEP_CHAT_VALUES.some((keep) => keep === value);
}

/** The record lifetime a setting asks for. Off is 0: nothing is written. */
export function keepChatTtl(keep: KeepChat): number {
  switch (keep) {
    case "off":
      return 0;
    case "1d":
      return DAY_MS;
    case "7d":
      return 7 * DAY_MS;
  }
}

/** What one stored tail holds. A version field, so a later shape can be told apart and dropped. */
interface StoredTail {
  v: 1;
  entries: ChatEntry[];
}

/** A tail as a reader gets it: the entries, oldest first, and when the bridge answered with them. */
export interface SavedTail {
  entries: readonly ChatEntry[];
  at: number;
}

/**
 * The newest whole entries whose stored record fits this kind's share of the per-pane cap. Turns the
 * agent rewound past are dropped first: the Chat body never draws them (components/session-stream.tsx),
 * so keeping them would spend the budget on text nobody sees. Exported for the tests.
 */
export function fitChatTail(entries: readonly ChatEntry[]): ChatEntry[] {
  const drawn = entries.filter((entry) => entry.abandoned !== true);
  // The envelope `{"v":1,"entries":[]}` and one comma between each pair of entries.
  let size = utf8Bytes(JSON.stringify({ v: 1, entries: [] }));
  let start = drawn.length;
  for (let i = drawn.length - 1; i >= 0; i--) {
    const cost = utf8Bytes(JSON.stringify(drawn[i])) + (i < drawn.length - 1 ? 1 : 0);
    if (size + cost > PANE_KIND_SHARE_BYTES) break;
    size += cost;
    start = i;
  }
  return drawn.slice(start);
}

// ── The password hold ────────────────────────────────────────────────────────

/**
 * How long a password wipe holds a pane's tail back. The wipe recurs on every mirror poll while the
 * prompt is up, so this only has to outlast the gap between two polls, with room for a slow one.
 */
const PASSWORD_HOLD_MS = 30_000;

/** Pane key → the time its last password wipe ran. */
const passwordHeld = new Map<string, number>();

function tailCleaner(context: WipeContext): void {
  if (context.reason === "password") {
    passwordHeld.set(paneScopeKey(context.pane.scope, context.pane.paneId), Date.now());
    return;
  }
  // A pairing that ended: the store's own cleaner deletes the database. Nothing is held here.
  passwordHeld.clear();
}

/** Register the hold with the wipe. Runs at load and on every save, as the store's own hook does. */
function registerTailWipe(): void {
  onWipe("chat-tail", tailCleaner);
}

registerTailWipe();

function heldForPassword(key: string, at: number): boolean {
  const since = passwordHeld.get(key);
  if (since === undefined) return false;
  if (at - since < PASSWORD_HOLD_MS) return true;
  passwordHeld.delete(key);
  return false;
}

// ── The door ─────────────────────────────────────────────────────────────────

/**
 * Write through the newest turns of a pane's window, under the lifetime `keep` asks for. Resolves
 * true when a record was written. Off, an empty window and a pane at a password prompt write nothing.
 */
export function saveChatTail(
  scope: Scope | undefined,
  paneId: string,
  entries: readonly ChatEntry[],
  keep: KeepChat,
  at: number = Date.now(),
): Promise<boolean> {
  registerTailWipe();
  const ttlMs = keepChatTtl(keep);
  const key = paneScopeKey(scope, paneId);
  if (ttlMs <= 0 || heldForPassword(key, at)) return Promise.resolve(false);
  const fitted = fitChatTail(entries);
  if (fitted.length === 0) return Promise.resolve(false);
  const value: StoredTail = { v: 1, entries: fitted };
  return putRecord("chat-tail", key, value, { fetchedAt: at, ttlMs, pane: { scope, paneId } });
}

/** Whether one parsed entry has the three fields the Chat body places and draws it by. */
function isDrawableEntry(value: JsonValue): boolean {
  const entry = asJsonObject(value);
  return (
    entry !== undefined &&
    asJsonString(entry.uuid) !== undefined &&
    asJsonNumber(entry.seq) !== undefined &&
    Array.isArray(entry.parts)
  );
}

/** The last tail this phone kept for a pane, or null: a miss, an expired record, or another shape. */
export async function loadChatTail(scope: Scope | undefined, paneId: string): Promise<SavedTail | null> {
  const record = await getRecord("chat-tail", paneScopeKey(scope, paneId));
  if (record === null) return null;
  // SAFETY: the store hands back `JSON.parse` of the text it stored (lib/store.ts `toRecord`), and
  // `JSON.parse` output IS a JsonValue by construction. The checks below narrow it from there.
  const stored = asJsonObject(record.value as JsonValue);
  if (stored === undefined || asJsonNumber(stored.v) !== 1) return null;
  const entries = stored.entries;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  // Every entry or none: a tail with a hole in it would draw a conversation that never happened.
  if (!entries.every(isDrawableEntry)) return null;
  // SAFETY: the only writer of this kind is `saveChatTail` above, with entries the bridge's own
  // `/api/pane/:id/chat` returned, the same unvalidated shape lib/api.ts hands the Chat body live.
  // The envelope and every entry were just checked for the fields the body places an entry by.
  const tail = record.value as StoredTail;
  return { entries: tail.entries, at: record.fetchedAt };
}

/** Delete every stored tail on this phone. "Keep chat on this phone: off" calls it. */
export function dropChatTails(): Promise<void> {
  return deleteKind("chat-tail");
}

/** Test seam: forget the password holds. */
export function __resetChatTail(): void {
  passwordHeld.clear();
}
