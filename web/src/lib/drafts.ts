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

/** Upper bound per PERSISTED draft. Nobody types 8 KiB on a phone; a value that big is a paste gone
 *  wrong or a bug. Oversize is never truncated — a silently half-saved message that you then send is
 *  worse than no draft at all — and, since the memory tier below took over the job of surviving a
 *  remount, it is no longer merely skipped either: skipping LEFT THE PREVIOUS, SHORTER DRAFT in
 *  place, so pasting a long file over a short note and coming back showed the note. Wrong text is
 *  worse than no text, one tier up. See {@link fitsDraftStore} for the notice that narrates it. */
const MAX_CHARS = 8 * 1024;

/**
 * Ceiling on everything the memory tier holds at once, in characters. Bounded by TOTAL rather than
 * entry count because the count is operator-scale (the panes in a herd) while a single entry is
 * whatever got pasted — so the pathological session is a few huge files across a few panes, not many
 * small drafts. Oldest-first eviction, and never the entry being written.
 */
const MEMORY_MAX_CHARS = 4 * 1024 * 1024;

/**
 * An attachment waiting in the composer as a chip (ADR 0060): its number (the `#N` its marker in
 * the text carries), the host path the bridge saved it under, the name the operator picked, and
 * whether it is drawn as a photo or a file. The preview blob URL is deliberately NOT here — it dies
 * with the page, so a restored chip draws the icon tile.
 */
export interface DraftAttachment {
  n: number;
  path: string;
  name: string;
  kind: "image" | "file";
}

/** A pane's whole draft: the typed text (markers included), the chips, and the next chip number. */
export interface Draft {
  text: string;
  attachments: DraftAttachment[];
  /** The number the next chip gets. Numbers are never reused within a draft, so this outlives a
   *  removed chip and is stored rather than re-derived from the chips that are left. */
  next: number;
}

/**
 * The stored shape. `attachments` and `next` are written only once the draft has spent a chip
 * number, so a text-only draft is stored byte for byte as it was before chips existed, and an entry
 * written before them (neither field) still loads as a draft with no chips.
 */
interface DraftEntry {
  text: string;
  at: number;
  attachments?: DraftAttachment[];
  next?: number;
}

/**
 * The memory tier: this page-session's drafts, uncapped per entry, gone on reload.
 *
 * It exists because the disk tier refuses anything over {@link MAX_CHARS}, and "too big to persist"
 * should not also mean "lost when you glance at another pane". The pane view is keyed by paneId, so
 * a pane switch remounts the composer — this is what it remounts from.
 *
 * IT IS COVERED BY ADR 0017 ONLY BECAUSE EVERY WRITE AND CLEAR GOES THROUGH `saveDraft` /
 * `clearDraft`. The password-prompt gates live upstream of both (composer.tsx's `noEchoRef` guards
 * the keystroke write-through and the pane-leave save; the recognising outcome calls `clearDraft`),
 * so a recognised prompt reaches neither tier and purges both in the same tick. A cache written from
 * anywhere else — component state, a second module — would re-open #103 in RAM, where nothing is
 * gating it. Don't add one.
 *
 * No age prune, deliberately: `MAX_AGE_MS` exists because localStorage outlives the process and an
 * ancient half-thought resurfacing is jarring. A entry here cannot be older than this page session,
 * which is exactly how long the composer would have held it had it never unmounted.
 */
const memory = new Map<string, DraftEntry>();

// A pane id is unique only within one session on one machine, so a draft is keyed by the whole
// (host, session, paneId) triple — otherwise the draft you typed for `w1:p1` on one machine would be
// restored into `w1:p1` on another. The lead's keys are byte-identical to what shipped: the host
// segment is emitted only when there IS one, so every existing stored draft is still found. Both
// tiers key off this one function, so memory and disk can never disagree about which pane is which.
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
    // SAFETY: `value` was just checked to be a non-null object, so reading `text`/`at` off it is
    // defined behaviour; both are validated as the right primitive on the very next line before any
    // of them is used. `Partial` is what makes those two checks mandatory rather than assumed.
    const entry = value as Partial<DraftEntry>;
    if (typeof entry.text !== "string" || typeof entry.at !== "number") return null;
    // The chips, keeping only well-formed ones. Absent (an entry from before chips) is an empty
    // list, never a reason to drop the text beside it.
    const attachments: DraftAttachment[] = [];
    // SAFETY: `Partial<DraftAttachment>` is the shape each item is CHECKED against, field by field,
    // before any of it is copied out; nothing is trusted from the cast alone.
    const items: Partial<DraftAttachment>[] = Array.isArray(entry.attachments) ? entry.attachments : [];
    for (const a of items) {
      if (typeof a !== "object" || a === null) continue;
      if (typeof a.n !== "number" || !isChipNumber(a.n)) continue;
      if (typeof a.path !== "string" || a.path === "" || typeof a.name !== "string") continue;
      if (a.kind !== "image" && a.kind !== "file") continue;
      attachments.push({ n: a.n, path: a.path, name: a.name, kind: a.kind });
    }
    const next = typeof entry.next === "number" && isChipNumber(entry.next) ? entry.next : undefined;
    if (attachments.length === 0 && next === undefined) return { text: entry.text, at: entry.at };
    return { text: entry.text, at: entry.at, attachments, next: nextNumber(attachments, next) };
  } catch {
    return null;
  }
}

function isChipNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/** The next free chip number: the stored one, never below one past the highest chip still held. */
function nextNumber(attachments: readonly DraftAttachment[], stored: number | undefined): number {
  const floor = attachments.reduce((max, a) => Math.max(max, a.n + 1), 1);
  return stored === undefined ? floor : Math.max(stored, floor);
}

/** Whether a draft is small enough for the disk tier — i.e. whether it will survive the app closing.
 *  The composer renders a notice from this; it is the only honest warning the user gets. */
export function fitsDraftStore(text: string): boolean {
  return text.length <= MAX_CHARS;
}

/** The disk tier's entry for a pane, expiring (and removing) anything past MAX_AGE_MS. */
function loadStored(scope: Scope | undefined, paneId: string): DraftEntry | null {
  const store = storage();
  if (!store) return null;
  try {
    const entry = parse(store.getItem(keyFor(scope, paneId)));
    if (entry === null) return null;
    if (Date.now() - entry.at > MAX_AGE_MS) {
      store.removeItem(keyFor(scope, paneId));
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

/**
 * The stored draft for a pane, or null if there is none (or it's expired/unreadable).
 *
 * The NEWER of the two tiers wins rather than memory unconditionally: another tab or a second app
 * instance writes only to disk, and this tier has never seen it. Memory wins every ordinary tie
 * because it is written first and holds what the disk tier refused.
 */
export function loadDraft(scope: Scope | undefined, paneId: string): string | null {
  return loadDraftEntry(scope, paneId)?.text ?? null;
}

/** {@link loadDraft} with the chips: the whole draft, or null when the pane has none. */
export function loadDraftEntry(scope: Scope | undefined, paneId: string): Draft | null {
  prunedOnce();
  const cached = memory.get(keyFor(scope, paneId)) ?? null;
  const stored = loadStored(scope, paneId);
  const entry = cached === null ? stored : stored === null ? cached : stored.at > cached.at ? stored : cached;
  if (entry === null) return null;
  const attachments = entry.attachments ? [...entry.attachments] : [];
  return { text: entry.text, attachments, next: nextNumber(attachments, entry.next) };
}

/**
 * Persist a pane's draft. Empty/whitespace-only text with no chips REMOVES the key — that's what
 * "the user deliberately emptied the box" looks like, and it means the clear-on-send path needs no
 * special case beyond saving the now-empty input. A draft that is only chips is still a draft. An
 * empty one also forgets its chip numbering: there is no marker left for a new number to clash with.
 */
export function saveDraft(
  scope: Scope | undefined,
  paneId: string,
  text: string,
  attachments: readonly DraftAttachment[] = [],
  next = 1,
): void {
  prunedOnce();
  if (text.trim() === "" && attachments.length === 0) {
    clearDraft(scope, paneId);
    return;
  }
  const key = keyFor(scope, paneId);
  const at = Date.now();
  // Copied field by field, so a caller's richer object (the composer's chips carry a preview URL
  // and an id) never leaks into storage.
  const chips = attachments.map(({ n, path, name, kind }) => ({ n, path, name, kind }));
  const entry: DraftEntry =
    chips.length > 0 || next > 1
      ? { text, at, attachments: chips, next: nextNumber(chips, next) }
      : { text, at };

  // Memory first, and unconditionally: it is the tier that has to hold what the disk tier won't, and
  // it must be written even where there is no storage at all (SSR, Safari private mode).
  memory.set(key, entry);
  evictMemory(key);

  const store = storage();
  if (!store) return;
  if (!fitsDraftStore(text)) {
    // CLEAR rather than skip: leaving the previous entry means a remount restores an older, shorter
    // draft, and the user acts on text they never wrote. The memory tier above still has the whole
    // thing, so this only bites when the process actually dies — which fitsDraftStore's notice has
    // been saying on screen the entire time.
    clearStored(store, key);
    return;
  }
  try {
    store.setItem(key, JSON.stringify(entry));
  } catch {
    // Quota / private mode. The in-memory draft is still on screen; only its persistence is lost.
  }
}

/** Hold the memory tier under {@link MEMORY_MAX_CHARS}, oldest first, never evicting `keep`. */
function evictMemory(keep: string): void {
  let total = 0;
  for (const entry of memory.values()) total += entry.text.length;
  if (total <= MEMORY_MAX_CHARS) return;
  const byAge = [...memory.entries()]
    .filter(([key]) => key !== keep)
    .toSorted((a, b) => a[1].at - b[1].at);
  for (const [key, entry] of byAge) {
    memory.delete(key);
    total -= entry.text.length;
    if (total <= MEMORY_MAX_CHARS) return;
  }
}

function clearStored(store: Storage, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    // ignore
  }
}

/** Drop a pane's draft from BOTH tiers. The password-prompt outcome (ADR 0017) calls this, and it is
 *  the reason the memory tier needs no gate of its own — see the note on `memory`. */
export function clearDraft(scope: Scope | undefined, paneId: string): void {
  const key = keyFor(scope, paneId);
  memory.delete(key);
  const store = storage();
  if (!store) return;
  clearStored(store, key);
}

/** Test seam — forgets the once-per-load prune so a case can control when pruning happens, and
 *  empties the memory tier, which `localStorage.clear()` in a test's setup cannot reach. */
export function __resetDraftPrune(): void {
  pruned = false;
  memory.clear();
}
