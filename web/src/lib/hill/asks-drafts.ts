import { useSyncExternalStore } from "react";

import { asJsonNumber, asJsonObject, asJsonString, parseJson } from "@/lib/json";

// THE ANSWERS MARKED ON THIS PHONE, NOT SENT YET (Asks, 2026-11-23). A tap on an option on an ask's page marks it; nothing
// leaves the phone until the review page's Send. So the marks must outlive a closed tab and a killed PWA: they sit in
// localStorage under ONE key, a map from ask id to the mark and the note. An entry is dropped when its ask is no longer
// open (`pruneAskDrafts`), when its Send went, and after MAX_AGE_MS in any case. Unsent words of this pairing, so the
// unpair wipe clears them (lib/wipe.ts, "ask-drafts").

/** What the phone keeps of one answer marked on it and not sent yet (lib/hill/asks-drafts.ts). */
export interface AskDraft {
  /** An option's intent, `more-context`, or null: nothing marked. A `--words` ask marks nothing, its words are the answer. */
  intent: string | null;
  /** The note, or on a `--words` ask the answer itself. */
  text: string;
}

export const NO_DRAFT: AskDraft = { intent: null, text: "" };

const KEY = "collie:ask-drafts:v1";
/** An ancient half-answer must never resurface: the ask it answered has long been closed by its poster. */
export const ASK_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Per note. A phone answer is short; a paste past this is cut at the field (`maxLength`), never here. */
export const ASK_NOTE_MAX = 2000;

interface Stored extends AskDraft {
  at: number;
}

const listeners = new Set<() => void>();
let held: ReadonlyMap<string, Stored> | null = null;

function parse(stored: string | null, now: number): Map<string, Stored> {
  const out = new Map<string, Stored>();
  const root = stored === null ? undefined : asJsonObject(parseJson(stored));
  if (root === undefined) return out;
  for (const [id, value] of Object.entries(root)) {
    const o = asJsonObject(value);
    const at = asJsonNumber(o?.at);
    const intent = o?.intent === null ? null : asJsonString(o?.intent);
    const text = asJsonString(o?.text);
    if (o === undefined || at === undefined || intent === undefined || text === undefined || now - at > ASK_DRAFT_MAX_AGE_MS) continue;
    out.set(id, { intent, text, at });
  }
  return out;
}

function read(): ReadonlyMap<string, Stored> {
  if (held !== null) return held;
  let text: string | null = null;
  try {
    text = localStorage.getItem(KEY);
  } catch {
    // Blocked storage: the marks last for this page only.
  }
  held = parse(text, Date.now());
  return held;
}

function commit(next: Map<string, Stored>): void {
  held = next;
  try {
    if (next.size === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(next)));
  } catch {
    // A full or blocked storage keeps the marks for this page only.
  }
  for (const listener of listeners) listener();
}

/** Set one ask's mark and note. A draft with no mark and no note is no draft: the entry goes. */
export function setAskDraft(id: string, draft: AskDraft, now: number = Date.now()): void {
  const next = new Map(read());
  if (draft.intent === null && draft.text === "") next.delete(id);
  else next.set(id, { intent: draft.intent, text: draft.text.slice(0, ASK_NOTE_MAX), at: now });
  commit(next);
}

/** Forget these asks' drafts: their Send went, or their ask closed. */
export function clearAskDrafts(ids: readonly string[]): void {
  const now = read();
  if (!ids.some((id) => now.has(id))) return;
  const next = new Map(now);
  for (const id of ids) next.delete(id);
  commit(next);
}

/** Keep the drafts of the asks in `open` and drop the rest: an ask the poster took back leaves no mark behind. */
export function pruneAskDrafts(open: ReadonlySet<string>): void {
  const now = read();
  const gone = [...now.keys()].filter((id) => !open.has(id));
  if (gone.length > 0) clearAskDrafts(gone);
}

/** For the unpair wipe and for a test: forget every draft, in memory and in storage. */
export function forgetAskDrafts(): void {
  commit(new Map());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const NONE: ReadonlyMap<string, Stored> = new Map();

/** Every draft on this phone, by ask id. The map is replaced on a change, so it can be a dependency. */
export function useAskDrafts(): ReadonlyMap<string, AskDraft> {
  return useSyncExternalStore(subscribe, read, () => NONE);
}

/** One ask's draft, or the empty one. */
export function useAskDraft(id: string): AskDraft {
  const all = useAskDrafts();
  return all.get(id) ?? NO_DRAFT;
}
