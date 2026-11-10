import { useSyncExternalStore } from "react";

import { fetchHill } from "@/lib/api";

import { sortOpenDecisions, type HillDecision, type HillList, type HillReceipt } from "./wire";

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
  receipts: ReadonlyMap<string, HillAnswerHeld>;
  /** The words of an answer that did not reach its target, per decision. */
  kept: ReadonlyMap<string, string>;
}

const NO_DECISIONS: readonly HillDecision[] = [];
const NO_RECEIPTS: ReadonlyMap<string, HillAnswerHeld> = new Map();
const NO_KEPT: ReadonlyMap<string, string> = new Map();
const EMPTY: HillHeld = { rev: null, open: NO_DECISIONS, closed: NO_DECISIONS, receipts: NO_RECEIPTS, kept: NO_KEPT };

let held: HillHeld = EMPTY;
/** The newest revision a snapshot named, or null when the last one named none. */
let wanted: number | null = null;
let reading = false;
/** True when `readHillNow` asked for one read whatever the numbers say; the read loop spends it. */
let forced = false;
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

/** Take a list the bridge served. An `unchanged` answer moves the number only. */
function take(list: HillList): void {
  if (list.unchanged === true) {
    if (held.rev !== list.rev) publish({ ...held, rev: list.rev });
    return;
  }
  publish({
    rev: list.rev,
    open: list.open.length === 0 ? NO_DECISIONS : sortOpenDecisions(list.open),
    closed: list.closed.length === 0 ? NO_DECISIONS : list.closed,
    receipts: receiptsOfClosed(list.closed),
    kept: held.kept,
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
export function syncHill(rev: number | undefined): void {
  if (rev === undefined) {
    wanted = null;
    generation += 1;
    // The open and closed lists, the number and the receipts go; the words of a gone answer stay, because
    // they are the person's own and the bridge no longer has them.
    const holdsList = held.rev !== null || held.open.length > 0 || held.closed.length > 0 || held.receipts.size > 0;
    if (holdsList) publish({ ...EMPTY, kept: held.kept });
    return;
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

/** Keep what one answer came to, until the next list. A `gone` answer's words are kept beyond it. */
export function noteHillAnswer(decisionId: string, answer: HillAnswerHeld): void {
  const receipts = new Map(held.receipts);
  receipts.set(decisionId, answer);
  let kept = held.kept;
  if (answer.receipt.code === "gone" && answer.text !== null && answer.text.trim() !== "") {
    const next = new Map(kept);
    next.set(decisionId, answer.text);
    kept = next;
  }
  publish({ ...held, receipts, kept });
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

/** How many decisions are open. */
export function useHillCount(): number {
  return useSyncExternalStore(
    subscribe,
    () => held.open.length,
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

/** Forget everything. For tests, which share one module between cases. */
export function __resetHill(): void {
  wanted = null;
  forced = false;
  generation += 1;
  reading = false;
  inFlight = null;
  publish(EMPTY);
}

/** Wait for the read in flight, if any. For tests. */
export async function __settleHill(): Promise<void> {
  await inFlight;
}
