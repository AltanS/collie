import { startUpdate } from "./api";
import { BUILD } from "./build";
import { getUpdateRunSnapshot, noteCrewRunBegun, noteStartedRun } from "./update-run-store";
import { clearUpdateStarted, noteUpdateStarted } from "./update-ribbon";

// ── WHAT THE OPERATOR ASKED FOR, BEFORE THEY CONFIRMED IT (ADR 0064) ────────────────────────────
//
// The Updates card no longer opens a confirm inside itself. Growing the card by the confirm's height
// moved everything under the thumb by about 100px (the card's M20/07 comment has the old numbers),
// and the confirm was a second place that said what an update does. So the card's button opens
// update mode at its first screen, "Ready to start", and "Start update" there is the confirm.
//
// The screen is mounted in `App.tsx`, outside the router, and the card is a route away inside it, so
// the ask crosses that boundary through this module store, the same way the run does through
// `lib/update-run-store.ts`. Nothing here renders and nothing here decides what the screen says:
// `lib/update-screen.ts` reads the ask as one more input.

/** One start of an update, as the card offers it. `kind` decides the words; `peersOnly` and `major`
 *  are what the bridge acts on. */
export interface UpdateAsk {
  readonly kind: "single" | "crew" | "retry" | "major";
  /** The version the run goes to. On a retry, the version the lead already runs. */
  readonly version: string;
  readonly major: boolean;
  readonly peersOnly: boolean;
  /** The version this machine runs now. */
  readonly current: string;
  /** On a retry, the members it is for, so the screen can name them. */
  readonly names?: readonly string[];
}

let ask: UpdateAsk | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Open update mode at "Ready to start". */
export function openUpdateMode(next: UpdateAsk): void {
  ask = next;
  emit();
}

/** "Not now", or the start was accepted and the run owns the screen from here. */
export function closeUpdateAsk(): void {
  if (ask === null) return;
  ask = null;
  emit();
}

export function getUpdateAsk(): UpdateAsk | null {
  return ask;
}

export function subscribeUpdateAsk(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * THE CONFIRM. Sends the one `POST /api/update` the ask describes and stamps this device's claim.
 *
 * Throws what `startUpdate` threw, after spending the claim, so the caller can put the bridge's own
 * sentence on screen (`update.in_progress` for a double tap, `update.target_mismatch` for a stale
 * offer). Moved here from `components/update-card.tsx` unchanged in what it sends.
 */
export async function beginAskedUpdate(asked: UpdateAsk): Promise<void> {
  try {
    const answer = await startUpdate({ target: asked.version, major: asked.major, peersOnly: asked.peersOnly });
    // A PEERS-ONLY START IS A RUN THIS DEVICE STARTED TOO (M32). Its 202 carries this lead's OLD
    // record, because nothing runs here, so that record's id is not this run's and is not recorded
    // as if it were, and the record is not handed to the store as the run just begun.
    const known = getUpdateRunSnapshot();
    noteUpdateStarted(Date.now(), asked.peersOnly ? null : (answer.run?.runId ?? null), {
      target: asked.version,
      peersOnly: asked.peersOnly,
      bundleAtStart: BUILD.id,
      lead: known.leadName,
      members: known.crew.map((member) => member.name).filter((name) => name !== known.leadName),
    });
    if (asked.peersOnly) noteCrewRunBegun(asked.current);
    else noteStartedRun(answer.run);
    closeUpdateAsk();
  } catch (thrown) {
    // Nothing was started, so this device has no claim on the screen.
    clearUpdateStarted();
    throw thrown;
  }
}

/** Test seam: module state outlives a `render()`. */
export function __resetUpdateAsk(): void {
  ask = null;
}
