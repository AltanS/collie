import { useSyncExternalStore } from "react";

import { apiErrorStatus, fetchMorph } from "@/lib/api";
import { bareAddress } from "@/lib/walky";

import type { MorphAnswer, MorphSession } from "./wire";

// MORPH, HELD ON THE PHONE: every session's switch, its hint and the screen its agent drew last, in one
// small store read with `useSyncExternalStore`. Modelled on the hill's store (lib/hill/store.ts).
//
// ── ONE READ SAYS WHETHER THE BRIDGE HAS MORPH ───────────────────────────────────────────────────
// The first live snapshot starts one whole read of `GET /api/morph`. A 200 is a bridge that knows
// Morph; a 404 is one that does not, and the switch is offered nowhere. `morphRev` cannot say it: a
// fresh bridge sends no number until some Morph state exists. Any other failure leaves the question
// open, and the next snapshot asks again. A snapshot that does carry a number proves Morph, so a "no"
// is asked again then (a bridge that was updated under the page).
//
// ── THEN THE SNAPSHOT SAYS WHEN TO READ ──────────────────────────────────────────────────────────
// The bridge moves `morphRev` on every switch and every show. The root loader hands it to `syncMorph`
// on every live snapshot, and that is the only door: the store reads `GET /api/morph?since=<held rev>`
// when the number differs from the one it holds. A number BELOW the held one is a bridge that
// restarted, so the store reads the whole list without `since`. A snapshot with no number reads nothing
// and keeps what is held.
//
// One read at a time. A snapshot that names a newer number while a read is in flight is remembered,
// and the store reads again once the first answer is in. A failed read leaves the held list alone, so
// the next snapshot asks again.
//
// ── A SESSION IS ITS WALKY ADDRESS ───────────────────────────────────────────────────────────────
// The wire keys a session by the pane's walky address (lib/morph/wire.ts), which may carry the session's
// `#<instance>` token. A lookup takes the exact key first; a held key with no token also answers for the
// same pane with one. A held key with ANOTHER token is another session in the same pane, and answers for
// nothing here.

interface MorphHeld {
  /** The revision of the list held, or null when none is. */
  rev: number | null;
  sessions: ReadonlyMap<string, MorphSession>;
}

const NO_SESSIONS: ReadonlyMap<string, MorphSession> = new Map();
const EMPTY: MorphHeld = { rev: null, sessions: NO_SESSIONS };

let held: MorphHeld = EMPTY;
/** The newest revision a snapshot named, or null while none has. */
let wanted: number | null = null;
/** Whether the bridge has Morph, from the one whole read (the top of this file). */
let support: "unknown" | "yes" | "no" = "unknown";
let reading = false;
/** Counts the times the store was emptied; a read that lands under another count is dropped. */
let generation = 0;
/** The read loop in flight, for a test to wait on. */
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: MorphHeld): void {
  held = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function keyed(sessions: readonly MorphSession[]): ReadonlyMap<string, MorphSession> {
  if (sessions.length === 0) return NO_SESSIONS;
  return new Map(sessions.map((session) => [session.session, session]));
}

/** Take an answer the bridge served. An `unchanged` answer moves the number only. */
function take(answer: MorphAnswer): void {
  if (answer.unchanged === true) {
    if (held.rev !== answer.rev) publish({ ...held, rev: answer.rev });
    return;
  }
  publish({ rev: answer.rev, sessions: keyed(answer.sessions) });
}

/** Read until the held number is the wanted one, one read at a time. */
async function readUntilCurrent(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    // Bounded: each pass either reaches the wanted number or stops on a failed read.
    for (let pass = 0; pass < 4; pass += 1) {
      const target = wanted;
      if (target === null || target === held.rev) return;
      const since = held.rev !== null && target > held.rev ? held.rev : undefined;
      const startedIn = generation;
      let answer: MorphAnswer;
      try {
        answer = await fetchMorph(since);
      } catch {
        return;
      }
      if (startedIn !== generation) continue;
      if (wanted === null) return;
      take(answer);
    }
  } finally {
    reading = false;
  }
}

/** Tell every reader; for a change no held list carries (the support answer). */
function notify(): void {
  for (const listener of listeners) listener();
}

/** The one whole read that says whether the bridge has Morph, then the reads the number asks for. */
async function probe(): Promise<void> {
  reading = true;
  const startedIn = generation;
  try {
    const answer = await fetchMorph();
    if (startedIn !== generation) return;
    support = "yes";
    take(answer);
    notify();
  } catch (thrown) {
    if (startedIn !== generation) return;
    if (apiErrorStatus(thrown) !== 404) return;
    support = "no";
    notify();
    return;
  } finally {
    reading = false;
  }
  if (wanted !== null && wanted !== held.rev) await readUntilCurrent();
}

/**
 * The root loader's call on every live snapshot, with the snapshot's `morphRev`. Asks once whether the
 * bridge has Morph, then reads the list when the number moved.
 */
export function syncMorph(rev: number | undefined): void {
  if (rev !== undefined) wanted = rev;
  if (reading) return;
  // A number proves Morph: a "no" from an older bridge is asked again.
  if (support === "unknown" || (support === "no" && rev !== undefined)) {
    inFlight = probe();
    return;
  }
  if (support === "no" || rev === undefined || rev === held.rev) return;
  inFlight = readUntilCurrent();
}

/** The held session for a walky address, by the rule at the top of this file. */
export function morphSessionOf(sessions: ReadonlyMap<string, MorphSession>, address: string): MorphSession | null {
  const exact = sessions.get(address);
  if (exact !== undefined) return exact;
  const bare = bareAddress(address);
  if (bare === address) return null;
  return sessions.get(bare) ?? null;
}

/**
 * Keep what one switch came to, until the next read. `answered` is the session the bridge sent back,
 * when it sent one; without it the held session (or a new one, with no hint yet) takes the new value.
 */
export function noteMorphSwitch(address: string, on: boolean, answered: MorphSession | null): void {
  const sessions = new Map(held.sessions);
  if (answered !== null) {
    sessions.set(answered.session, answered);
    publish({ ...held, sessions });
    return;
  }
  const had = morphSessionOf(held.sessions, address);
  const next: MorphSession = had === null ? { session: address, on, hint: "" } : { ...had, on };
  sessions.set(next.session, next);
  publish({ ...held, sessions });
}

/** One session's Morph, or null when the bridge holds none for it (Morph is off there). */
export function useMorphSession(address: string): MorphSession | null {
  return useSyncExternalStore(
    subscribe,
    () => morphSessionOf(held.sessions, address),
    () => null,
  );
}

/** Whether the bridge this phone reads has Morph: its one whole read answered 200. */
export function useMorphAvailable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => support === "yes",
    () => false,
  );
}

/** Forget everything. For tests, which share one module between cases. */
export function __resetMorph(): void {
  wanted = null;
  support = "unknown";
  generation += 1;
  reading = false;
  inFlight = null;
  publish(EMPTY);
}

/** Wait for the read in flight, if any. For tests. */
export async function __settleMorph(): Promise<void> {
  await inFlight;
}
