import { useSyncExternalStore } from "react";

// A ROW THAT IS OPENING SAYS SO (hitbox investigation, proposal 4).
//
// The pane route's loader waits for a read before the router commits the screen. A glide waits for it at
// most `READY_WAIT_MS` (lib/glide.ts); a read still out then opens the pane the plain way, and the old
// screen stays up until the answer is in, with only the page's 2px busy bar to say anything happened.
// Measured: a tap waited 929ms on a 1000ms read and 5329ms on a 3000ms one, and a second tap on the same
// row sent another read and landed later still (3 taps over a 1500ms read landed at 3908ms, 6 reads sent).
//
// So a tap on a row is PENDING from the tap until the read settles. Two things follow:
//   - a second tap on a pending row is ignored (`beginOpening` answers false), and
//   - from `OPENING_SHOWN_MS` on, the row shows a mark of its own (`useOpeningShown`): a bar inside the row,
//     never a size or a position, so nothing moves (DESIGN.md §2).
// A read that is in before `OPENING_SHOWN_MS` never shows the mark: the common tap is unchanged.
//
// THE MARK ALWAYS ENDS: on success and on failure (the read settles either way, the loader reports a
// failure itself), when the person leaves the screen that began it (`endOpeningsOf`), and at the latest
// after `OPENING_GIVE_UP_MS`, so a read that never answers cannot leave a row dead.

/** The row shows its mark after this, the moment the glide gives up waiting (READY_WAIT_MS). */
export const OPENING_SHOWN_MS = 120;
/** A pending open ends on its own after this, answered or not. */
export const OPENING_GIVE_UP_MS = 15_000;

interface Opening {
  shown: boolean;
  showTimer: ReturnType<typeof setTimeout>;
  giveUpTimer: ReturnType<typeof setTimeout>;
  /** The screen that began it, so leaving that screen ends it. */
  readonly owner: symbol;
  /** This opening and no other: only the read that began it may end it (`endOpening`). */
  readonly token: symbol;
}

const pending = new Map<string, Opening>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const l of listeners) l();
}

function stop(key: string): void {
  const o = pending.get(key);
  if (o === undefined) return;
  clearTimeout(o.showTimer);
  clearTimeout(o.giveUpTimer);
  pending.delete(key);
  if (o.shown) changed();
}

/**
 * A tap on the row `key` (its glide key, the pane's path). Answers null when that row is already
 * opening: the tap is then a second one and is ignored. Otherwise starts the pending state and answers
 * its TOKEN, which `endOpening` needs: an old read that settles after the person left and came back
 * must not end the NEW opening of the same row, whose own read is still out.
 */
export function beginOpening(key: string, owner: symbol): symbol | null {
  if (pending.has(key)) return null;
  const showTimer = setTimeout(() => {
    const o = pending.get(key);
    if (o === undefined) return;
    o.shown = true;
    changed();
  }, OPENING_SHOWN_MS);
  const giveUpTimer = setTimeout(() => stop(key), OPENING_GIVE_UP_MS);
  const token = Symbol("opening");
  pending.set(key, { shown: false, showTimer, giveUpTimer, owner, token });
  return token;
}

/** The read of the opening `token` settled, answered or failed. An opening that is no longer that one stays. */
export function endOpening(key: string, token: symbol): void {
  if (pending.get(key)?.token === token) stop(key);
}

/** The screen `owner` went away: whatever it began is over. */
export function endOpeningsOf(owner: symbol): void {
  for (const [key, o] of pending) if (o.owner === owner) stop(key);
}

/** For a test. */
export function resetOpenings(): void {
  for (const key of pending.keys()) stop(key);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the row `key` is opening and has passed the moment its mark shows. */
export function useOpeningShown(key: string | undefined): boolean {
  useSyncExternalStore(subscribe, () => version);
  return key !== undefined && pending.get(key)?.shown === true;
}
