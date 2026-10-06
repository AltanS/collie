// What the phone HOLDS of one live session, and the single pure function that moves it.
//
// ── WHY A REDUCER, AND WHY IT IS NOT A HOOK ──────────────────────────────────
// The hard part of reading `GET /api/pane/:id/chat` is not the fetch. It is the merge: an answer is
// a delta over a numbering, and getting it wrong draws one turn twice or moves a turn that never
// moved. A merge with no DOM, no fetch and no clock can be tested a hundred ways, so this module is
// exactly that, and the cadence stays where it already lives (hooks/use-polling.ts). Nothing here
// imports React and nothing here reads a clock — that is a rule, not an accident.
//
// ── THE THREE RULES, AND THEY ARE THE WHOLE MODULE (ADR 0073) ────────────────
//  1. A `gen` different from the one held REPLACES everything. Two numberings cannot be merged, and
//     pretending otherwise is how a thread ends up showing one turn twice.
//  2. An upsert whose `uuid` is held overwrites IN PLACE and keeps the `seq` it already had, never
//     the `seq` in the answer. A turn that changed did not move. This is not a nicety: opencode
//     re-emits a whole streaming reply under a `uuid` already held, and a `?before=` page and a live
//     page can both carry the same turn.
//  3. An upsert whose `uuid` is new goes in AT ITS OWN `seq`. `?before=` numbers DOWNWARD, and an
//     incremental answer can carry a turn that sits below what the client holds (a tool result edits
//     a turn that went out long ago), so insertion may never assume append.
//
// ── AND THE TWO EMPTY ANSWERS ARE DIFFERENT FACTS ────────────────────────────
// `available: false` is "this pane has no session to show". A 404 is "this machine is a release
// behind" — the route is additive-optional over a crew link (ADR 0073 point 7). A client that draws
// them alike tells an operator to wait for something that will never arrive, so they are two kinds
// of {@link ChatStatus} and never one.

import type {
  ChatEntry,
  ChatOlderBody,
  ChatWindowBody,
  PaneChatResponse,
} from "./types";

/** Why the bridge had nothing to show. Taken off the wire type so the two can never drift. */
type ChatUnavailableReason = Extract<PaneChatResponse, { available: false }>["reason"];

/**
 * What the last answer said this pane's session is.
 *
 * Every kind here is a FACT, never a sentence. Wording is the view's, resolved through `t()`, the way
 * every other user-facing string in this app is.
 */
export type ChatStatus =
  /** Nothing has been asked yet. */
  | { kind: "empty" }
  /** The window answered. `entries` are its turns. */
  | { kind: "live" }
  /** An ordinary empty answer: a shell pane, an agent with no session, a log that cannot be read. */
  | { kind: "unavailable"; reason: ChatUnavailableReason }
  /**
   * A 404. This machine's Collie predates the route — NOT an empty session.
   *
   * It carries no sentence. `api.ts` is transport and does not decide wording: an api error there
   * carries a CODE and `lib/api-error-message.ts` turns it into words. A message resolved in the
   * fetch would also freeze the language at the moment of the answer. The view calls
   * `t("chat.stale.member")`, which is where every other user-facing sentence is resolved.
   */
  | { kind: "stale" };

/**
 * One session as the client holds it.
 *
 * `hasOlder` and `oldest` are fields rather than something a view works out, because the load-older
 * tap is drawn from them and two places computing the same thing is two places to get it wrong.
 */
export interface ChatWindow {
  readonly status: ChatStatus;
  /** Which numbering {@link entries} are in. Zero until an answer lands; a real `gen` is clock-seeded. */
  readonly gen: number;
  /** The revision held. Sent back as `?after=<gen>:<rev>`. */
  readonly rev: number;
  /** The newest `seq` the live window reported. */
  readonly head: number;
  /** The oldest `seq` HELD — the `seq` half of the next `?before=`; its uuid is `entries[0].uuid`. */
  readonly oldest: number;
  /** Turns exist before {@link oldest}, so "load older" has something to fetch. */
  readonly hasOlder: boolean;
  /** Ascending by `seq`, ready to render top-down. */
  readonly entries: readonly ChatEntry[];
  /**
   * What the operator typed that the agent has not started on yet, oldest first.
   *
   * NOT merged, REPLACED, and that is the fourth rule beside the three above. A queue is state: the
   * whole list arrives on every answer and the one in hand is simply the older reading. Merging it
   * would keep an item the bridge has already stopped reporting, which is exactly the lie this field
   * exists to avoid.
   *
   * A `?before=` page leaves it alone. An older page cannot see the tail, so it says nothing about it.
   */
  readonly queued: readonly string[];
  /**
   * When the bridge answered with these turns, set ONLY while the window is the SAVED COPY: the tail
   * the phone kept (lib/chat-tail.ts), read back because a live read failed (M46 spec 09). `null` for
   * every window a live answer built. The view says "Saved copy from {time}" while it is set, and
   * any live answer clears it.
   *
   * Not folded into {@link status}: `stale` there already means a 404 from a release-behind machine,
   * and a saved copy is drawn exactly like a live window. Only its age and its banner differ.
   */
  readonly savedAt: number | null;
}

/**
 * One answer, as {@link mergeChat} reads it.
 *
 * Three outcomes and not two: a 304 says "nothing moved", a 404 says "this machine cannot answer at
 * all", and neither is a body. A transport failure is not here — that still throws.
 */
export type ChatAnswer =
  | { outcome: "body"; body: PaneChatResponse }
  | { outcome: "unchanged" }
  | { outcome: "stale" };

/** The 304 answer, shared so an unchanged poll allocates nothing. */
export const CHAT_UNCHANGED: ChatAnswer = { outcome: "unchanged" };

/** One shared value, for the same reason {@link LIVE} is one: a stale status never varies. */
const STALE: ChatStatus = { kind: "stale" };

/** One shared value, so an unchanged status keeps its identity across polls. */
const LIVE: ChatStatus = { kind: "live" };

/** One shared empty queue, so the common answer — nothing waiting — allocates nothing. */
const EMPTY_QUEUE: readonly string[] = Object.freeze<string[]>([]);

/** What a client holds before it has asked anything. */
export const EMPTY_CHAT_WINDOW: ChatWindow = {
  status: { kind: "empty" },
  gen: 0,
  rev: 0,
  head: 0,
  oldest: 0,
  hasOlder: false,
  entries: [],
  queued: EMPTY_QUEUE,
  savedAt: null,
};

/**
 * The saved copy of a pane's tail, as a window the Chat body draws (M46 spec 09).
 *
 * It carries NO numbering: `gen` and `rev` are 0, so the next read asks for a first page and its answer
 * replaces this window whole (rule 1), never merges into it. `hasOlder` is false, because a `?before=`
 * cursor taken from a copy would ask the bridge about a numbering it may no longer hold; older text is
 * on the bridge, and the banner says so. The queue is empty: what was waiting then is not waiting now.
 */
export function savedChatWindow(entries: readonly ChatEntry[], savedAt: number): ChatWindow {
  return {
    status: LIVE,
    gen: 0,
    rev: 0,
    head: entries.at(-1)?.seq ?? 0,
    oldest: entries[0]?.seq ?? 0,
    hasOlder: false,
    entries,
    queued: EMPTY_QUEUE,
    savedAt,
  };
}

/**
 * The window held, marked as a saved copy from `savedAt`: the bridge stopped answering and what is on
 * screen is now only as current as the last answer. The same object when it is already marked.
 */
export function markSaved(held: ChatWindow, savedAt: number): ChatWindow {
  return held.savedAt === null ? { ...held, savedAt } : held;
}

/**
 * What the client now holds, given what it held and one answer.
 *
 * Pure, total, and never throws: every answer the route can give has a reading here, and an answer
 * that cannot be placed leaves the held value alone rather than guessing.
 */
export function mergeChat(held: ChatWindow, answer: ChatAnswer): ChatWindow {
  // A 304 is neither an error nor a change. Returned by IDENTITY on purpose: a poll that found
  // nothing must not hand a view a new object and make it re-render over it. The one exception is a
  // window marked as a saved copy: a 304 is a live answer that it is still current, so the mark goes.
  if (answer.outcome === "unchanged") return held.savedAt === null ? held : { ...held, savedAt: null };
  // A 404 restates the status and keeps the turns. They were true when they arrived, and a version
  // skew does not unsay them.
  if (answer.outcome === "stale") return restate(held, STALE);
  const body = answer.body;
  if (!body.available) return restate(held, { kind: "unavailable", reason: body.reason });
  return body.page === "older" ? mergeOlder(held, body) : mergeLive(held, body);
}

/** A new status over the same turns — and the same object when the status did not actually move. */
function restate(held: ChatWindow, status: ChatStatus): ChatWindow {
  return sameStatus(held.status, status) ? held : { ...held, status };
}

function sameStatus(held: ChatStatus, next: ChatStatus): boolean {
  if (held.kind === "unavailable" && next.kind === "unavailable") return held.reason === next.reason;
  return held.kind === next.kind;
}

function mergeLive(held: ChatWindow, body: ChatWindowBody): ChatWindow {
  // Rule 1. A numbering we do not hold replaces what we hold; there is no merging two of them.
  const known = body.gen === held.gen;
  const entries = upsert(known ? held.entries : [], body.upserts);
  const oldest = entries[0]?.seq ?? body.oldest;
  return {
    status: LIVE,
    gen: body.gen,
    rev: body.rev,
    head: body.head,
    oldest,
    hasOlder: olderExists(oldest, body, known ? held.hasOlder : body.hasOlder),
    entries,
    // Replaced, never merged (see `ChatWindow.queued`), and the held list is reused when it says the
    // same thing, so a poll that changed nothing hands the view the same array it already has.
    // `?? EMPTY_QUEUE`: a member one release behind sends no `queued` at all, and "nothing waiting"
    // is the honest reading of a bridge that does not know the question.
    queued: nextQueue(held.queued, body.queued ?? EMPTY_QUEUE),
    // A live answer: whatever the window was before, it is current now.
    savedAt: null,
  };
}

/**
 * The held list when it already says what the answer says, else the answer's.
 *
 * Identity matters here: the queue is empty on almost every poll, and handing a view a fresh `[]`
 * each time would re-render a row that did not change. Short lists, so the compare is cheap.
 */
function nextQueue(held: readonly string[], next: readonly string[]): readonly string[] {
  const same = held.length === next.length && held.every((text, i) => text === next[i]);
  return same ? held : next;
}

/**
 * Whether anything sits before the oldest turn HELD — which is not the question the window answers.
 *
 * `ChatWindowBody.hasOlder` is about the WINDOW's own front, and a first paint is a screenful
 * (`DEFAULT_CHAT_LIMIT`, 40) out of a window that may hold two thousand turns. Passing it straight
 * through would hide sixty turns the window is holding right now. So where the client's own front
 * sits is what decides which answer is the honest one.
 */
function olderExists(oldest: number, body: ChatWindowBody, previous: boolean): boolean {
  // Above the window's front: the window itself is holding turns we never asked for.
  if (oldest > body.oldest) return true;
  // Exactly the window's front: the window's own answer is about us.
  if (oldest === body.oldest) return body.hasOlder;
  // Behind it — a `?before=` page walked us past the window, and only that page can say what is
  // left. The window's `hasOlder` is about a position we are already below.
  return previous;
}

function mergeOlder(held: ChatWindow, body: ChatOlderBody): ChatWindow {
  // A page computed against a numbering we no longer hold cannot be placed, so it is thrown away
  // whole rather than merged into the wrong thread (ADR 0073 § `older`).
  if (body.gen !== held.gen) return held;
  const entries = upsert(held.entries, body.upserts);
  return { ...held, entries, oldest: entries[0]?.seq ?? held.oldest, hasOlder: body.hasOlder };
}

const bySeq = (a: ChatEntry, b: ChatEntry): number => a.seq - b.seq;

/**
 * Rules 2 and 3, and nothing else: held `uuid`s are written over at the `seq` they already have,
 * new ones go in at the `seq` the answer gave them.
 *
 * The sort runs only when something was actually inserted, and only then: an answer that changed
 * turns in place cannot have moved any of them, so re-ordering would be work with no effect.
 */
function upsert(held: readonly ChatEntry[], upserts: readonly ChatEntry[]): readonly ChatEntry[] {
  if (upserts.length === 0) return held;
  const next = held.slice();
  const at = new Map<string, number>();
  for (const [index, entry] of next.entries()) at.set(entry.uuid, index);
  let inserted = false;
  for (const entry of upserts) {
    const index = at.get(entry.uuid);
    if (index === undefined) {
      at.set(entry.uuid, next.length);
      next.push(entry);
      inserted = true;
      continue;
    }
    // Rule 2 — the `seq` it already had, never the one in the answer.
    next[index] = { ...entry, seq: next[index].seq };
  }
  // Rule 3 — a new turn is placed by its own `seq`, which a `?before=` page numbers downward.
  return inserted ? next.toSorted(bySeq) : next;
}
