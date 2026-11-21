import { useSyncExternalStore } from "react";

import { fetchHill } from "@/lib/api";

import { isTrickCard, sortOpenDecisions, type HillCrewStateView, type HillDecision, type HillList, type HillReceipt } from "./wire";

// THE HILL, HELD ON THE PHONE (M96): the open decisions, the newest closed ones, and the receipts of
// the answers this page sent, in one small store read with `useSyncExternalStore`.
//
// ── THE SNAPSHOT SAYS WHEN TO READ ───────────────────────────────────────────────────────────────
// The bridge puts one number on every snapshot, `hillRev`, and moves it on every change to the hill.
// The root loader hands it to `syncHill` on every live snapshot, and that is the only door: the store
// reads `GET /api/hill?since=<held rev>` when the number differs from the one it holds, so a poll that
// moved nothing on the hill costs nothing. A number BELOW the held one is a bridge that restarted and
// counts from the start again, so the store reads the whole list without `since`. A snapshot with no
// number (a bridge older than the hill, or a crew member's own) empties the store: there is no hill
// to show, and the Dashboard row goes with it. What it keeps is the words of a gone answer (below), and
// a read still in flight when it empties the store is dropped when it lands.
//
// One read at a time. A snapshot that names a newer number while a read is in flight is remembered,
// and the store reads again once the first answer is in, so the last number always wins. A failed read
// leaves the held list and its number alone, so the next snapshot asks again.
//
// ── A RECEIPT LIVES UNTIL THE NEXT LIST ──────────────────────────────────────────────────────────
// An answer's receipt is kept per decision, so the card says what happened. The next list that
// changed (the bridge closed the decision, so its number moved) replaces the lists and drops the
// receipt of every decision that is open in it: for a refusal the card is open again with nothing to
// say. A decision that list serves as CLOSED keeps its receipt for as long as it is served, because its
// card is leaving the open list right then (ui/presence.tsx), and it must leave showing what happened,
// not snap back to its options for the 240 ms of its exit.
//
// An answer that closed its decision also reads the list at once (`readHillNow`), a short moment after
// the tap (`HILL_LIST_READ_AFTER_MS`, lib/hill/motion.ts), instead of waiting for the next snapshot:
// the bridge moved its number when it answered, so the card leaves while the person still looks at it,
// not up to six seconds later on an idle poll. One read per answer, never repeated. One kind outlives the list: a `gone` answer that carried words. The bridge closes that
// decision as undeliverable and the card leaves the open list, so the person's words are KEPT here,
// keyed by the decision, for as long as the page lives, and its row under Answered shows them with
// Copy. Nothing is persisted: a reload reads the bridge's own list.
//
// ── WORDS NEVER LEAVE WITH THEIR CARD (M96 spec 10) ──────────────────────────────────────────────
// A card that closed without the person leaves the Hill a minute later (the bridge's sweep clears it),
// and a card can leave the open list while the person types a note into it (it expired, its session
// ended, another phone answered it). The words stay here. A card's unsent words are noted as they are
// typed (`noteHillDraft`, no publish); a list that no longer serves the card as open moves them into
// `kept`, with the card's title. An answer that went (`ok`) or that the bridge kept as gone drops them.
// A kept entry whose closed row the bridge no longer serves draws a row of its own under Answered
// (hill-view.tsx), with "Your answer, not delivered" and Copy, until the page is left or reloaded.
//
// ── TWO SCOPES: THE HILL, OR ONLY THE CARDS ABOUT TRICKS (M96 spec 14) ──────────────────────────
// With the Hill off the snapshot carries no `hillRev`, but `trickCardsRev` while the bridge holds a card
// of Collie's own about a trick, and the bridge's list then serves only those cards. The root loader hands
// that number in with the scope `tricks`. A change of scope empties the store and reads afresh, so a list
// read under one scope never stands for the other (the two numbers can be equal across a switch).
//
// ── THE CREW STATE (1.29.0) ──────────────────────────────────────────────────────────────────────
// The lead's `here` / `quiet` / `away` rides on the list (`crewState`), and a change of it moves the
// hill's number, so every phone reads it as it reads a new card. A lead with no decisions file yet sends
// no number, so the Hill's route also reads `GET /api/hill/state` when it opens (`noteHillCrewState`).
// Null is "no crew state here": a crew member or a deposed lead (409), or an older bridge, and the Hill's
// route then shows no control.

/** What one answer came to, kept beside the decision it answered. */
export interface HillAnswerHeld {
  receipt: HillReceipt;
  intent: string;
  /** The words the person sent with it, or null. */
  text: string | null;
}

interface HillHeld {
  /** The revision of the list held, or null when none is. */
  rev: number | null;
  /** Open decisions in the order the phone shows them. */
  open: readonly HillDecision[];
  /** Closed decisions, newest first, as the bridge serves them. */
  closed: readonly HillDecision[];
  /** How many closed decisions the bridge holds, which may exceed `closed`. What Clear says it removes. */
  closedTotal: number;
  receipts: ReadonlyMap<string, HillAnswerHeld>;
  /** The words of an answer that did not reach its target, or of a note whose card left, per decision. */
  kept: ReadonlyMap<string, string>;
  /** The title of each card in `kept`, for its row once the bridge no longer serves the card. */
  keptTitles: ReadonlyMap<string, string>;
  /** The lead's crew state, or null when this bridge serves none. */
  crewState: HillCrewStateView | null;
}

const NO_DECISIONS: readonly HillDecision[] = [];
const NO_RECEIPTS: ReadonlyMap<string, HillAnswerHeld> = new Map();
const NO_KEPT: ReadonlyMap<string, string> = new Map();
const EMPTY: HillHeld = { rev: null, open: NO_DECISIONS, closed: NO_DECISIONS, closedTotal: 0, receipts: NO_RECEIPTS, kept: NO_KEPT, keptTitles: NO_KEPT, crewState: null };

/** The words typed into each open card and not sent yet. Noted, never published: the card draws its own. */
const drafts = new Map<string, string>();
/** The cards whose answer is on its way: a list that closes one (the answer itself did) keeps its words noted. */
const sending = new Set<string>();

let held: HillHeld = EMPTY;
/** What the held list stands for: the whole Hill, or only Collie's cards about tricks (the Hill off). */
export type HillScope = "all" | "tricks";
let scope: HillScope = "all";
/** The newest revision a snapshot named, or null when the last one named none. */
let wanted: number | null = null;
let reading = false;
/** True when `readHillNow` asked for one read whatever the numbers say; the read loop spends it. */
let forced = false;
/** Counts the lists taken, so a Clear's way back can tell whether a newer list replaced its rows. */
let lists = 0;
/**
 * Counts the times the store was emptied. A read that started under one number and lands under another
 * is the hill of a bridge that went away (or of a test that reset), and its answer is dropped.
 */
let generation = 0;
/** The read loop in flight, for a test to wait on. */
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: HillHeld): void {
  held = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The receipts of the decisions a new list serves as closed: their cards leave showing them. */
function receiptsOfClosed(closed: readonly HillDecision[]): ReadonlyMap<string, HillAnswerHeld> {
  if (held.receipts.size === 0 || closed.length === 0) return NO_RECEIPTS;
  const keep = new Map<string, HillAnswerHeld>();
  for (const decision of closed) {
    const receipt = held.receipts.get(decision.id);
    if (receipt !== undefined) keep.set(decision.id, receipt);
  }
  return keep.size === 0 ? NO_RECEIPTS : keep;
}

/**
 * Move the unsent words of every held open card that `stillOpen` does not list into `kept`, with its
 * title. Answers the new `kept` and `keptTitles`, the held ones when nothing moved.
 */
function keepLeftDrafts(stillOpen: ReadonlySet<string>): Pick<HillHeld, "kept" | "keptTitles"> {
  let kept = held.kept;
  let keptTitles = held.keptTitles;
  for (const [id, text] of drafts) {
    if (stillOpen.has(id) || sending.has(id)) continue;
    const card = held.open.find((decision) => decision.id === id);
    // A note for a card this page never held open stays noted until a list that held it.
    if (card === undefined) continue;
    drafts.delete(id);
    if (text.trim() === "" || kept.get(id) !== undefined) continue;
    kept = new Map(kept).set(id, text.trim());
    keptTitles = new Map(keptTitles).set(id, card.title);
  }
  return { kept, keptTitles };
}

/** Take a list the bridge served. An `unchanged` answer moves the number only. */
function take(list: HillList): void {
  lists += 1;
  if (list.unchanged === true) {
    if (held.rev !== list.rev) publish({ ...held, rev: list.rev });
    return;
  }
  publish({
    rev: list.rev,
    open: list.open.length === 0 ? NO_DECISIONS : sortOpenDecisions(list.open),
    closed: list.closed.length === 0 ? NO_DECISIONS : list.closed,
    closedTotal: Math.max(list.closedTotal ?? 0, list.closed.length),
    receipts: receiptsOfClosed(list.closed),
    ...keepLeftDrafts(new Set(list.open.map((decision) => decision.id))),
    crewState: list.crewState ?? null,
  });
}

/** Read until the held number is the wanted one, one read at a time. */
async function readUntilCurrent(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    // Bounded: each pass either reaches the wanted number or stops on a failed read. A snapshot that
    // keeps moving the number while reads are slow gets one read per pass, never a loop of its own.
    for (let pass = 0; pass < 4; pass += 1) {
      const target = wanted;
      if (target === null) return;
      if (target === held.rev && !forced) return;
      forced = false;
      // Below the held number is a restarted bridge: its old revisions mean nothing, read it whole.
      const since = held.rev !== null && target >= held.rev ? held.rev : undefined;
      const startedIn = generation;
      let list: HillList;
      try {
        list = await fetchHill(since);
      } catch {
        return;
      }
      // The store was emptied while the read was out: its answer is for a hill that went away. A number
      // that came after the emptying reads again on the next pass.
      if (startedIn !== generation) continue;
      // A snapshot with no number arrived while the read was out: the hill went away, keep nothing.
      if (wanted === null) return;
      take(list);
      // The list is newer than the snapshot that asked for it (the bridge moved on meanwhile, or a read
      // forced by an answer overtook a snapshot still on its way): what is held already covers it.
      if (held.rev !== null && held.rev > target && wanted === target) return;
    }
  } finally {
    reading = false;
  }
}

/**
 * The root loader's call on every live snapshot, with the snapshot's `hillRev`. Reads the list when
 * the number moved, and empties the store when the snapshot carries none.
 */
export function syncHill(rev: number | undefined, as: HillScope = "all"): void {
  // Another scope: what is held was read for the other one, so it goes first, and the number reads afresh.
  const moved = as !== scope;
  scope = as;
  if (rev === undefined || moved) {
    wanted = null;
    generation += 1;
    lists += 1;
    // The open and closed lists, the number and the receipts go; the words of a gone answer stay, because
    // they are the person's own and the bridge no longer has them.
    // The crew state stays too: a lead that never had a decision sends no number, and its state is the
    // one the route read itself (`noteHillCrewState`). A member's route reads none, so it holds none.
    const holdsList = held.rev !== null || held.open.length > 0 || held.closed.length > 0 || held.receipts.size > 0;
    if (holdsList) publish({ ...EMPTY, ...keepLeftDrafts(new Set()), crewState: held.crewState });
    if (rev === undefined) return;
  }
  wanted = rev;
  if (rev === held.rev || reading) return;
  inFlight = readUntilCurrent();
}

/**
 * Read the list now, once, whatever the last snapshot said: an answer just closed a decision, so the
 * bridge's number has moved and the snapshot that says so may be seconds away. Nothing while no hill
 * is held (no snapshot named one). A read already out reads once more when it lands.
 */
export function readHillNow(): void {
  if (wanted === null) return;
  forced = true;
  if (reading) return;
  inFlight = readUntilCurrent();
}

/**
 * Hold a crew state the bridge answered outside a list: the route's own read when it opens, or the answer
 * to this phone's own change. Kept until the next list, which carries the lead's value itself.
 */
export function noteHillCrewState(view: HillCrewStateView | null): void {
  const same = view === held.crewState || (view !== null && held.crewState !== null && view.state === held.crewState.state && view.at === held.crewState.at && view.told === held.crewState.told);
  if (same) return;
  publish({ ...held, crewState: view });
}

/**
 * Note the words typed into an open card and not sent yet, as they change; empty words drop the note. Never
 * publishes: the card draws its own field. A list that takes the card off the open list keeps them.
 */
export function noteHillDraft(decisionId: string, text: string): void {
  if (text.trim() === "") drafts.delete(decisionId);
  else drafts.set(decisionId, text);
}

/** An answer to the card is on its way: its words wait for the answer's end, not for the next list. */
export function noteHillSending(decisionId: string): void {
  sending.add(decisionId);
}

/**
 * The answer's request ended (after `noteHillAnswer` when a receipt came). Words still noted for a card
 * the held list no longer serves as open are kept now, as a list would have kept them.
 */
export function noteHillSendEnded(decisionId: string): void {
  sending.delete(decisionId);
  if (!drafts.has(decisionId) || held.open.some((decision) => decision.id === decisionId)) return;
  const text = drafts.get(decisionId) ?? "";
  drafts.delete(decisionId);
  if (text.trim() === "" || held.kept.has(decisionId)) return;
  const title = held.closed.find((decision) => decision.id === decisionId)?.title;
  publish({ ...held, kept: new Map(held.kept).set(decisionId, text.trim()), keptTitles: title === undefined ? held.keptTitles : new Map(held.keptTitles).set(decisionId, title) });
}

/** The words noted for an open card, or "" with none: what the card's field starts with when it draws again. */
export function hillDraft(decisionId: string): string {
  return drafts.get(decisionId) ?? "";
}

/** Keep what one answer came to, until the next list. A `gone` answer's words are kept beyond it. */
export function noteHillAnswer(decisionId: string, answer: HillAnswerHeld): void {
  const receipts = new Map(held.receipts);
  receipts.set(decisionId, answer);
  let kept = held.kept;
  let keptTitles = held.keptTitles;
  // An answer that went, or that the bridge took as gone, settles the card's unsent words: they went with it.
  if (answer.receipt.code === "ok" || answer.receipt.code === "gone") drafts.delete(decisionId);
  if (answer.receipt.code === "gone" && answer.text !== null && answer.text.trim() !== "") {
    kept = new Map(kept).set(decisionId, answer.text);
    const title = held.open.find((decision) => decision.id === decisionId)?.title ?? held.closed.find((decision) => decision.id === decisionId)?.title;
    if (title !== undefined) keptTitles = new Map(keptTitles).set(decisionId, title);
  }
  publish({ ...held, receipts, kept, keptTitles });
}

/**
 * Take the closed rows off the list at once, for a Clear that is on its way to the bridge. Answers the
 * way back: a function that puts the rows and the count back, unless a newer list already replaced them.
 * The next list the bridge serves (its number moved when it cleared) is the truth either way.
 */
export function clearClosedLocally(): () => void {
  const before = { closed: held.closed, closedTotal: held.closedTotal };
  if (before.closed.length === 0 && before.closedTotal === 0) return () => undefined;
  publish({ ...held, closed: NO_DECISIONS, closedTotal: 0 });
  const taken = lists;
  return () => {
    // Only while no list came in since: one that did is newer than these rows, whatever it holds.
    if (lists === taken && held.closed.length === 0) publish({ ...held, ...before });
  };
}

/** The open decisions, most urgent first (`sortOpenDecisions`). The same array until the list changes. */
export function useHillOpen(): readonly HillDecision[] {
  return useSyncExternalStore(
    subscribe,
    () => held.open,
    () => NO_DECISIONS,
  );
}

/** The closed decisions the bridge serves, newest first. */
export function useHillClosed(): readonly HillDecision[] {
  return useSyncExternalStore(
    subscribe,
    () => held.closed,
    () => NO_DECISIONS,
  );
}

/** How many closed decisions the bridge holds: at least as many as the rows `useHillClosed` lists. */
export function useHillClosedTotal(): number {
  return useSyncExternalStore(
    subscribe,
    () => held.closedTotal,
    () => 0,
  );
}

/**
 * The open cards of Collie's own about a trick (wire.ts `isTrickCard`), oldest first: what Settings, Tricks and the Hill
 * lists and the Dashboard's line opens, with the Hill on or off (spec 14). The same array until the list changes.
 */
export function useTrickCards(): readonly HillDecision[] {
  return useSyncExternalStore(
    subscribe,
    trickCardsOf,
    () => NO_DECISIONS,
  );
}

/** Whether the open decision `decisionId` is one of Collie's own cards about a trick (a new trick, a new version). */
export function isHeldTrickCard(decisionId: string): boolean {
  return held.open.some((decision) => decision.id === decisionId && isTrickCard(decision.from));
}

let trickCardsFrom: readonly HillDecision[] | null = null;
let trickCards: readonly HillDecision[] = NO_DECISIONS;
function trickCardsOf(): readonly HillDecision[] {
  if (trickCardsFrom === held.open) return trickCards;
  trickCardsFrom = held.open;
  const cards = held.open.filter((decision) => isTrickCard(decision.from)).toSorted((a, b) => a.at - b.at);
  trickCards = cards.length === 0 ? NO_DECISIONS : cards;
  return trickCards;
}

/** Whether the store holds a list the bridge served (the first read landed), for a page that waits for it. */
export function useHillHeld(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => held.rev !== null,
    () => false,
  );
}

/** How many decisions are open. */
export function useHillCount(): number {
  return useSyncExternalStore(
    subscribe,
    () => held.open.length,
    () => 0,
  );
}

/**
 * How many open decisions a trick posted (`from.kind === "trick"`). The switch for tricks as a whole arms on
 * these: off, the bridge hides them and they cannot be answered, but they stay stored and come back when
 * tricks are switched on. Collie's own cards about a trick (kind `collie`) are no trick's Decision.
 */
export function useHillTrickCount(): number {
  return useSyncExternalStore(
    subscribe,
    () => held.open.filter((decision) => decision.from.kind === "trick").length,
    () => 0,
  );
}

/** What this page's answer to one decision came to, until the next list; null when it sent none. */
export function useHillAnswerHeld(decisionId: string): HillAnswerHeld | null {
  return useSyncExternalStore(
    subscribe,
    () => held.receipts.get(decisionId) ?? null,
    () => null,
  );
}

/** The words of the answers that did not reach their target, per decision. */
export function useHillKept(): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    subscribe,
    () => held.kept,
    () => NO_KEPT,
  );
}

/** The title of each card whose words are kept, for its row once the bridge no longer serves the card. */
export function useHillKeptTitles(): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    subscribe,
    () => held.keptTitles,
    () => NO_KEPT,
  );
}

/** The lead's crew state, or null when this bridge serves none (a member, or an older bridge). */
export function useHillCrewState(): HillCrewStateView | null {
  return useSyncExternalStore(
    subscribe,
    () => held.crewState,
    () => null,
  );
}

/** Forget everything. For tests, which share one module between cases. */
export function __resetHill(): void {
  wanted = null;
  scope = "all";
  forced = false;
  generation += 1;
  lists += 1;
  reading = false;
  inFlight = null;
  drafts.clear();
  sending.clear();
  publish(EMPTY);
}

/** Wait for the read in flight, if any. For tests. */
export async function __settleHill(): Promise<void> {
  await inFlight;
}
