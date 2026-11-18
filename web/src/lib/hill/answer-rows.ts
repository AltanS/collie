import { useSyncExternalStore } from "react";

// WHICH ANSWER ROWS THE CHAT DRAWS (Altan, 2026-11-18). Who answers which turn is lib/hill/answer-turn.ts.
//
// The answered card's own collapsed line (components/trick-approval-line.tsx) says what the row says. While the row is
// on the screen the line is not drawn; with no row (an approval with no agent behind it, an answer that has not reached
// the transcript yet, the mirror, an agent view) the line stays. A row notes its decision id while it is mounted.

const drawn = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** A mounted answer row notes its decision; the returned function takes the note back. */
export function noteAnswerRow(decisionId: string): () => void {
  drawn.set(decisionId, (drawn.get(decisionId) ?? 0) + 1);
  emit();
  return () => {
    const left = (drawn.get(decisionId) ?? 1) - 1;
    if (left <= 0) drawn.delete(decisionId);
    else drawn.set(decisionId, left);
    emit();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether an answer row for `decisionId` is on the screen now. */
export function useAnswerRowDrawn(decisionId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => drawn.has(decisionId),
    () => false,
  );
}
