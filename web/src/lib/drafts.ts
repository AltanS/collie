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

import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonValue } from "./json";
import { normalizeScope, type Scope } from "./scope";

const PREFIX = "collie:draft:";

/**
 * Where this build keeps a pane's draft: the store's second version (2026-10-21, PR 560).
 *
 * A draft may now hold a `kind: "paste"` chip, whose text lives only in the chip while the draft
 * carries a `[Pasted #N]` marker. A build from before it (Stable 1.23.x) drops a chip kind it does
 * not know and keeps the text beside it, so it would restore the bare marker and send it literally.
 * It never reads this key, so it never meets such a draft. The version sits under {@link PREFIX}, so
 * that build's prune and its device wipe still reach every entry here.
 *
 * The first version, {@link PREFIX} with the scope right after it, is read once and copied here when
 * it is the newer of the two (one way: nothing here is ever written back to it), so a draft typed
 * before the update survives it. That entry stays where it is for a rollback. A save supersedes it
 * and a clear removes it, so a rollback never restores a draft older than the one this build held.
 */
const PREFIX_V2 = "collie:draft:v2:";

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
  kind: "image" | "file" | "paste";
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
// restored into `w1:p1` on another. The host segment is emitted only when there IS one, so the
// lead's first-version keys are byte-identical to what shipped and every one of them is still found.
// Both tiers key off this one function, so memory and disk can never disagree about which pane is
// which.
function keyFor(scope: Scope | undefined, paneId: string, prefix: string = PREFIX_V2): string {
  const { host, session } = normalizeScope(scope);
  return `${prefix}${host ? `${host}@` : ""}${session ?? "default"}:${paneId}`;
}

/** The pane's key in the store's first version, read only to migrate it ({@link PREFIX_V2}). */
function legacyKeyFor(scope: Scope | undefined, paneId: string): string {
  return keyFor(scope, paneId, PREFIX);
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
    // After the removal, off this call's stack: the first prune runs inside a `loadDraftEntry` that a
    // row's snapshot read made, and a listener must never run in the middle of a render.
    if (stale.length > 0) queueMicrotask(() => changed(null));
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
      if (a.kind !== "image" && a.kind !== "file" && a.kind !== "paste") continue;
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

function draftCharCount(
  text: string,
  attachments: readonly Pick<DraftAttachment, "kind" | "path">[] = [],
): number {
  let total = text.length;
  for (const a of attachments) {
    if (a.kind === "paste") total += a.path.length;
  }
  return total;
}

/** Whether a draft is small enough for the disk tier — i.e. whether it will survive the app closing.
 *  The composer renders a notice from this; it is the only honest warning the user gets. */
export function fitsDraftStore(
  text: string,
  attachments: readonly Pick<DraftAttachment, "kind" | "path">[] = [],
): boolean {
  return draftCharCount(text, attachments) <= MAX_CHARS;
}

/**
 * The disk tier's entry for a pane, expiring (and removing) anything past MAX_AGE_MS. A first-version
 * entry that is newer than this version's, or the only one, is copied over first ({@link PREFIX_V2});
 * the first-version entry itself is left as it is.
 */
function loadStored(scope: Scope | undefined, paneId: string): DraftEntry | null {
  const store = storage();
  if (!store) return null;
  try {
    const key = keyFor(scope, paneId);
    let entry = parse(store.getItem(key));
    const legacy = parse(store.getItem(legacyKeyFor(scope, paneId)));
    if (legacy !== null && Date.now() - legacy.at <= MAX_AGE_MS && (entry === null || legacy.at > entry.at)) {
      entry = legacy;
      store.setItem(key, JSON.stringify(legacy));
    }
    if (entry === null) return null;
    if (Date.now() - entry.at > MAX_AGE_MS) {
      store.removeItem(key);
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

/** The newer of a pane's two tiers' entries, with the moment it was written, or null. */
function newestEntry(scope: Scope | undefined, paneId: string): DraftEntry | null {
  prunedOnce();
  const cached = memory.get(keyFor(scope, paneId)) ?? null;
  const stored = loadStored(scope, paneId);
  return cached === null ? stored : stored === null ? cached : stored.at > cached.at ? stored : cached;
}

/** {@link loadDraft} with the chips: the whole draft, or null when the pane has none. */
export function loadDraftEntry(scope: Scope | undefined, paneId: string): Draft | null {
  const entry = newestEntry(scope, paneId);
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
  persistDraft(scope, paneId, text, attachments, next);
  changed(keyFor(scope, paneId));
}

function persistDraft(
  scope: Scope | undefined,
  paneId: string,
  text: string,
  attachments: readonly DraftAttachment[],
  next: number,
): void {
  prunedOnce();
  if (text.trim() === "" && attachments.length === 0) {
    removeDraft(scope, paneId);
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
  if (!fitsDraftStore(text, attachments)) {
    // CLEAR rather than skip: leaving the previous entry means a remount restores an older, shorter
    // draft, and the user acts on text they never wrote. The memory tier above still has the whole
    // thing, so this only bites when the process actually dies — which fitsDraftStore's notice has
    // been saying on screen the entire time.
    clearStored(store, key);
    clearStored(store, legacyKeyFor(scope, paneId));
    return;
  }
  try {
    store.setItem(key, JSON.stringify(entry));
  } catch {
    // Quota / private mode. The in-memory draft is still on screen; only its persistence is lost.
  }
  // The first-version entry is older than what was just written, so it goes: a rollback that
  // restored it would put text in the box the operator has since changed.
  clearStored(store, legacyKeyFor(scope, paneId));
}

/** Hold the memory tier under {@link MEMORY_MAX_CHARS}, oldest first, never evicting `keep`. */
function evictMemory(keep: string): void {
  let total = 0;
  for (const entry of memory.values()) total += draftCharCount(entry.text, entry.attachments);
  if (total <= MEMORY_MAX_CHARS) return;
  const byAge = [...memory.entries()]
    .filter(([key]) => key !== keep)
    .toSorted((a, b) => a[1].at - b[1].at);
  for (const [key, entry] of byAge) {
    memory.delete(key);
    held.delete(key);
    total -= draftCharCount(entry.text, entry.attachments);
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

/**
 * Put `text` into a pane's reply box, ONLY when the box holds nothing: no words (whitespace counts as none, as
 * {@link saveDraft} reads it) and no chips. True when it was put there, exactly as given. False when the box
 * holds the person's words: then nothing is written, so a draft is never overwritten and never appended to.
 *
 * A trick's `does = "draft"` button is the one caller (routes/trick-session.tsx). It writes through
 * {@link saveDraft}, so the ADR 0017 gates hold: a pane at a password prompt drops the stored draft when its
 * composer recognises the prompt. It never sends: the person reads the text in the box and taps Send.
 */
export function fillEmptyDraft(scope: Scope | undefined, paneId: string, text: string): boolean {
  const held = loadDraftEntry(scope, paneId);
  if (held !== null && (held.text.trim() !== "" || held.attachments.length > 0)) return false;
  saveDraft(scope, paneId, text);
  return true;
}

/** Drop a pane's draft from BOTH tiers. The password-prompt outcome (ADR 0017) calls this, and it is
 *  the reason the memory tier needs no gate of its own — see the note on `memory`. */
export function clearDraft(scope: Scope | undefined, paneId: string): void {
  removeDraft(scope, paneId);
  changed(keyFor(scope, paneId));
}

function removeDraft(scope: Scope | undefined, paneId: string): void {
  const key = keyFor(scope, paneId);
  memory.delete(key);
  const store = storage();
  if (!store) return;
  clearStored(store, key);
  clearStored(store, legacyKeyFor(scope, paneId));
}

/**
 * Drop every draft and every Put back list, both tiers, every pane on every machine. Only the device wipe calls this
 * (lib/wipe.ts): a pairing that ended takes the unsent words typed under it along. Every key under
 * the prefix goes, unparseable ones too, because a key the wipe skips is a key nothing cleans later.
 */
export function clearAllDrafts(): void {
  memory.clear();
  backMemory.clear();
  wipeStored();
  changed(null);
}

function wipeStored(): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null && key.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Enumeration can throw in locked-down storage. The memory tier above is gone either way.
  }
}

// ── WHO HOLDS A DRAFT, LIVE (a row's pencil) ─────────────────────────────────────────────────────────
//
// A list of panes draws a mark on each row whose pane has an unsent draft on this device. A row must not read
// localStorage on every render, so the answer is a cached boolean per pane ({@link hasDraft}), and the cache is
// refreshed by the notifications below. A write, a clear and an eviction drop one pane's answer and tell the
// listeners; the prune, the device wipe and a `storage` event with no readable key drop all of them. A listener
// that finds its pane's boolean unchanged re-renders nothing, so a keystroke in one composer costs the other
// rows one map lookup each. Another tab of this browser writes only to disk: its `storage` event is the way in.

/** One pane's cached answer, and the moment the draft behind it comes of age (the 48-hour rule). */
interface HeldAnswer {
  has: boolean;
  until: number;
}

const held = new Map<string, HeldAnswer>();
const listeners = new Set<() => void>();
let watching = false;

/** A pane's draft changed (its disk key), or any of them may have (null): forget, then tell the listeners. */
function changed(key: string | null): void {
  if (key === null) held.clear();
  else held.delete(key);
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent): void {
  // `key` is null when another tab cleared the whole store. A first-version key is not this version's key
  // for the pane, so it drops every answer. A key outside the drafts' is none of this store's business.
  if (event.key !== null && event.key.startsWith(PREFIX_V2)) {
    changed(event.key);
    return;
  }
  if (event.key !== null && !event.key.startsWith(PREFIX)) return;
  changed(null);
}

/**
 * Listen for a change in which panes hold a draft. The listener runs after every save and clear on this page, and
 * after a write by another tab of this browser (the `storage` event). The returned function stops it.
 */
export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  if (!watching && typeof window !== "undefined") {
    watching = true;
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || !watching) return;
    watching = false;
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Whether this device holds an unsent draft for the pane: text that is not blank, or at least one chip. The
 * Put back list does not count. Cached per pane until a notification or the draft's 48th hour, so it is cheap
 * to ask on every render.
 */
export function hasDraft(scope: Scope | undefined, paneId: string): boolean {
  const key = keyFor(scope, paneId);
  const cached = held.get(key);
  if (cached !== undefined && Date.now() <= cached.until) return cached.has;
  const entry = newestEntry(scope, paneId);
  const has = entry !== null && (entry.text.trim() !== "" || (entry.attachments?.length ?? 0) > 0);
  // A draft in the memory tier never ages (see `memory`), so only a stored one carries a 48-hour end.
  held.set(key, { has, until: entry === null || !has ? Infinity : entry.at + MAX_AGE_MS });
  return has;
}

// ── PUT BACK, STORED WITH THE DRAFT (the M102 review 3) ──────────────────────────────────────────────
//
// A sent text that did not go and found the box holding a draft waits beside the notice with Put back (M104,
// composer.tsx `giveBack`). It is the person's unsent words exactly as a draft is, so it lives where the draft lives:
// the same two tiers, the same (host, session, pane) key, the same 48-hour age, the same prune and the same device
// wipe. Its key sits under {@link PREFIX}, so `pruneDrafts` and `clearAllDrafts` reach it, and its entry parses as a
// draft entry (an empty `text` and an `at`), so the prune keeps it until it is old. The `~` cannot appear in a session
// or a pane id, so the key never meets a draft's.
//
// An ordered list, oldest first, with no cap: Put back never drops a text. A sign-in code never comes here; the
// composer's give-back road is never taken by a code (composer-calm.test.tsx pins it).

const PREFIX_BACK = "collie:draft:back~";

/** One text waiting on Put back: what the box held (text and chips), the line it was, and its request id if any. */
export interface PutBackItem {
  draft: string;
  chips: DraftAttachment[];
  line: string;
  intent?: { key: string; requestId: string };
}

/** The memory tier of Put back, as {@link memory} is the drafts': it holds what the disk tier refused. */
const backMemory = new Map<string, { at: number; items: PutBackItem[] }>();

function backKeyFor(scope: Scope | undefined, paneId: string): string {
  return keyFor(scope, paneId, PREFIX_BACK);
}

/** A stored chip, copied field by field, or null when it is not a well-formed one. */
function parseBackChip(value: JsonValue): DraftAttachment | null {
  const chip = asJsonObject(value);
  const n = asJsonNumber(chip?.n);
  const path = asJsonString(chip?.path);
  const name = asJsonString(chip?.name);
  const kind = asJsonString(chip?.kind);
  if (n === undefined || !isChipNumber(n) || path === undefined || path === "" || name === undefined) return null;
  if (kind !== "image" && kind !== "file" && kind !== "paste") return null;
  return { n, path, name, kind };
}

/** A stored Put back item, copied field by field, or null when it is not one. */
function parseBackItem(value: JsonValue): PutBackItem | null {
  const item = asJsonObject(value);
  const draft = asJsonString(item?.draft);
  const line = asJsonString(item?.line);
  if (item === undefined || draft === undefined || line === undefined) return null;
  const chips = Array.isArray(item.chips) ? item.chips.flatMap((chip) => parseBackChip(chip) ?? []) : [];
  const out: PutBackItem = { draft, chips, line };
  const intent = asJsonObject(item.intent);
  const key = asJsonString(intent?.key);
  const requestId = asJsonString(intent?.requestId);
  if (key !== undefined && requestId !== undefined) out.intent = { key, requestId };
  return out;
}

function loadBackStored(key: string): { at: number; items: PutBackItem[] } | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;
    const entry = asJsonObject(parseJson(raw));
    const at = asJsonNumber(entry?.at);
    const back = entry?.back;
    if (at === undefined || !Array.isArray(back)) return null;
    if (Date.now() - at > MAX_AGE_MS) {
      store.removeItem(key);
      return null;
    }
    return { at, items: back.flatMap((item) => parseBackItem(item) ?? []) };
  } catch {
    return null;
  }
}

/** A Put back item copied field by field: no caller's object, and no richer chip (a preview URL, an id), is kept. */
function copyBackItem({ draft, chips, line, intent }: PutBackItem): PutBackItem {
  const item: PutBackItem = { draft, chips: chips.map(({ n, path, name, kind }) => ({ n, path, name, kind })), line };
  if (intent !== undefined) item.intent = { key: intent.key, requestId: intent.requestId };
  return item;
}

/** The texts waiting on Put back for a pane, oldest first; empty when none. The newer tier wins, as for a draft. */
export function loadPutBack(scope: Scope | undefined, paneId: string): PutBackItem[] {
  prunedOnce();
  const key = backKeyFor(scope, paneId);
  const cached = backMemory.get(key) ?? null;
  const stored = loadBackStored(key);
  const entry = cached === null ? stored : stored === null ? cached : stored.at > cached.at ? stored : cached;
  // Copies, so a caller that changes its list never changes the memory tier's.
  return entry === null ? [] : entry.items.map((item) => copyBackItem(item));
}

/** Store the pane's Put back list, oldest first. An empty list removes it from both tiers. */
export function savePutBack(scope: Scope | undefined, paneId: string, items: readonly PutBackItem[]): void {
  prunedOnce();
  if (items.length === 0) {
    clearPutBack(scope, paneId);
    return;
  }
  const key = backKeyFor(scope, paneId);
  const at = Date.now();
  // Copied field by field, so a caller's richer chip (a preview URL, an id) never reaches storage.
  const copy = items.map((item) => copyBackItem(item));
  backMemory.set(key, { at, items: copy });
  const store = storage();
  if (!store) return;
  const size = copy.reduce((n, item) => n + draftCharCount(item.draft, item.chips) + item.line.length, 0);
  // Too big for the disk tier: cleared rather than left stale, as a draft is; the memory tier holds it.
  if (size > MAX_CHARS) {
    clearStored(store, key);
    return;
  }
  try {
    store.setItem(key, JSON.stringify({ text: "", at, back: copy }));
  } catch {
    // Quota / private mode: the memory tier still holds the list.
  }
}

/** Drop a pane's Put back list from both tiers. The password-prompt wipe calls this with `clearDraft`. */
export function clearPutBack(scope: Scope | undefined, paneId: string): void {
  const key = backKeyFor(scope, paneId);
  backMemory.delete(key);
  const store = storage();
  if (store) clearStored(store, key);
}

/** Test seam — forgets the once-per-load prune so a case can control when pruning happens, and
 *  empties the memory tier, which `localStorage.clear()` in a test's setup cannot reach. */
export function __resetDraftPrune(): void {
  pruned = false;
  memory.clear();
  backMemory.clear();
  held.clear();
}
