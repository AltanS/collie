// WHAT THE ASKS BOARD OFFERS FIRST (Asks build 6, 2026-11-23), as pure rules, and the one request that carries it from
// a shortcut to the page that owns the Send sheet. The "Next up" card and the action `answer_next_ask` read the same
// answer, so a key and the card's button always do the same thing.

import { useSyncExternalStore } from "react";

import { markedAnswer, markedAnswersOf, type AskDecision, type AskSession } from "./asks";
import { deckOf } from "./asks-board";
import { NO_DRAFT, type AskDraft } from "./asks-drafts";

/**
 * What the Next up card offers. Normally the first open ask of the board that has no answer marked here. When every
 * open ask has an answer marked and only Send is left, the first session of the board that has marks: its Send.
 */
export type NextUp = { kind: "ask"; ask: AskDecision; session: AskSession } | { kind: "send"; session: AskSession; answered: number; total: number };

/** The Next up offer of the sessions in board order, or null when no ask is open. */
export function nextUpOf(sessions: readonly AskSession[], drafts: ReadonlyMap<string, AskDraft>): NextUp | null {
  for (const session of sessions) {
    const ask = session.asks.find((candidate) => markedAnswer(candidate, drafts.get(candidate.id) ?? NO_DRAFT) === null);
    if (ask !== undefined) return { kind: "ask", ask, session };
  }
  for (const session of sessions) {
    const answered = markedAnswersOf(session.asks, drafts).length;
    if (answered > 0) return { kind: "send", session, answered, total: session.asks.length };
  }
  return null;
}

/** How many asks the board holds in all: the one number the action's availability reads. */
export function openAskCount(sessions: readonly AskSession[]): number {
  return deckOf(sessions).length;
}

// The key of the session whose Send sheet a shortcut asks the board to open. The board owns the sheet (it holds the
// drafts' review and the send hook), so the action cannot open it from another screen: it asks, goes to the board when
// it is not there, and the board answers the request once and clears it.
let requested: string | null = null;
const listeners = new Set<() => void>();

/** Ask the board to open the Send sheet of this session. */
export function requestAsksSend(key: string): void {
  requested = key;
  for (const listener of listeners) listener();
}

/** The board took the request (or could not honour it): forget it. */
export function clearAsksSendRequest(): void {
  if (requested === null) return;
  requested = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The session key a shortcut asked the board to send, or null. */
export function useAsksSendRequest(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => requested,
    () => null,
  );
}
