// WHILE A FINGER HOLDS A YES (hooks/use-approve-hold.ts), the chat does not move under it. The chat's scroller
// follows its tail (hooks/use-auto-scroll.ts `pinToBottom`): every poll that brings a line scrolls the list, and the
// card at the tail would slide away under the thumb. One page-wide flag, set while a hold is under way, tells the
// scroller to wait; the next change after the hold ends pins the tail again. A count, not a boolean, so two holds
// on two cards cannot clear each other's flag.

let holds = 0;

/** A hold began. Pair each call with one {@link endHold}. */
export function beginHold(): void {
  holds += 1;
}

/** A hold ended, with a yes or without. */
export function endHold(): void {
  holds = Math.max(0, holds - 1);
}

/** Whether a finger holds a yes now: the chat's scroller does not follow its tail meanwhile. */
export function aHoldIsActive(): boolean {
  return holds > 0;
}
