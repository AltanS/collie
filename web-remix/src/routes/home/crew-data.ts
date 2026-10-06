// The crew's two reads as module stores: `GET /api/crew` (the census the formation draws) and
// `GET /api/machines?spark=30` (the cards of the Crew tab). Port of what web/src/lib/loaders.ts
// `crewLoader` and `machinesLoader` do, and of web/src/hooks/use-machine-census.ts.
//
// ── KEEP THE LAST GOOD BODY ──────────────────────────────────────────────────
// A failed refresh keeps the data it had and sets `error`; the screen then shows its cards with a
// notice instead of an empty page (the keep-previous-data rule of lib/data.ts).
//
// ── A 404 IS AN ANSWER ───────────────────────────────────────────────────────
// Only a lead (or, for machines, a solo collie) serves these endpoints. A peer and a solo collie
// refuse `/api/crew` with 404, which means "there is no crew here". It is stored as `absent`, never as
// `error`: "I could not ask" and "there is nothing to ask about" are different sentences.
//
// ── READ ONLY WHILE SOMEONE LOOKS ────────────────────────────────────────────
// Nothing here polls on its own. A screen that renders from a store calls `want(SOURCE,
// handle.signal)` (lib/polling.ts) in its setup, so the read rides the app's one beat while the screen
// is mounted and stops with it. The beat already holds still while the page is hidden or locked.
//
// The machines read is spaced out: the beat is 1.5 to 6 s, a machine's numbers move every 5 s and its
// sparks once a minute, so a card is a glance and 15 s is honest (ADR 0085). `MACHINES_GAP_MS` is a
// little under 15 s because a beat lands on a multiple of its own length: a 12 s gap reads every 12 to
// 15 s whichever beat is running. One round at a time: a read starts only after the last one ended.
//
// `at` is when the stores LAST CHANGED, not when the last read started. An answer equal to the one
// held (same data, same flags) is not written, so a quiet poll wakes nobody (lib/store.ts).
import { mounted } from "@web/lib/base-path";
import { shareEqual } from "@web/lib/share-equal";
import type { CrewStatusResponse, MachinesResponse } from "@web/lib/types";

import { serverBuild } from "../../lib/api";
import { authHeader } from "../../lib/pairing";
import type { PollSource } from "../../lib/polling";
import { createStore, type Store } from "../../lib/store";

/** The minutes each card's sparks span: the Crew tab's half hour (web/ loaders.ts). */
export const MACHINE_SPARK_MINUTES = 30;
/** How often the Crew tab means to read the census (web/ use-machine-census.ts `CREW_TAB_POLL_MS`). */
export const CREW_TAB_POLL_MS = 15_000;
/** The gap the source enforces between two reads; see the header for why it is under 15 s. */
export const MACHINES_GAP_MS = 12_000;
/** A read this long without an answer is a black-holed link (lib/api.ts has the same deadline). */
const GET_TIMEOUT_MS = 10_000;

/** One read's last state. */
export interface Feed<T> {
  /** The last good body, kept through a failed read. `undefined` before the first answer and on a 404. */
  data: T | undefined;
  /** The bridge answered 404: this collie keeps no such list (no crew here). An answer, not a failure. */
  absent: boolean;
  /** The last read failed (anything but a 404). `data` is then what the read before it brought. */
  error: boolean;
  /** When the feed last changed (epoch ms); 0 before the first answer. */
  at: number;
}

export function emptyFeed<T>(): Feed<T> {
  return { data: undefined, absent: false, error: false, at: 0 };
}

function sameFeed<T>(a: Feed<T>, b: Feed<T>): boolean {
  return a.data === b.data && a.absent === b.absent && a.error === b.error;
}

/** The feed after an answer: the body, with every part equal to the held one keeping its identity. */
export function feedAfterAnswer<T>(prev: Feed<T>, body: T, at: number): Feed<T> {
  const data = prev.data === undefined ? body : shareEqual(prev.data, body);
  return { data, absent: false, error: false, at };
}

/** The feed after a failure: a 404 clears the data ("none here"); anything else keeps it, flagged. */
export function feedAfterFailure<T>(prev: Feed<T>, status: number | undefined, at: number): Feed<T> {
  if (status === 404) return { data: undefined, absent: true, error: false, at };
  return { data: prev.data, absent: false, error: true, at };
}

// ── The census as the Crew tab's four states ─────────────────────────────────

/** What the Crew tab knows about the machines (web/ `MachineCensusState`). */
export type MachineCensusState =
  | { kind: "loading" }
  /** The census, kept through a failed refresh: `failed` says the last read did not answer. */
  | { kind: "census"; census: MachinesResponse; failed: boolean }
  /** This collie keeps no machine list (a crew member answers 404). An answer, not a failure. */
  | { kind: "unavailable" }
  /** The first read failed and there is nothing kept to show. */
  | { kind: "error" };

export function machineCensusState(feed: Feed<MachinesResponse>): MachineCensusState {
  if (feed.data !== undefined) return { kind: "census", census: feed.data, failed: feed.error };
  if (feed.absent) return { kind: "unavailable" };
  if (feed.error) return { kind: "error" };
  return { kind: "loading" };
}

// ── The reads ────────────────────────────────────────────────────────────────

interface ReadResult<T> {
  status: number;
  body?: T;
}

async function getJson<T>(path: string, signal: AbortSignal): Promise<ReadResult<T>> {
  const res = await fetch(mounted(path), {
    headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", ...authHeader() },
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(GET_TIMEOUT_MS)]),
  });
  const build = res.headers.get("x-collie-build");
  if (build) serverBuild.set(build);
  // A fronting identity proxy answers a sign-in redirect; that is a failure, never data.
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) return { status: 401 };
  if (!res.ok) return { status: res.status };
  // SAFETY: a 200 on these endpoints is the bridge's own response type by contract (the same
  // contract web/src/lib/api.ts `fetchCrew` and `fetchMachines` rest on).
  return { status: res.status, body: (await res.json()) as T };
}

interface Reader<T> {
  store: Store<Feed<T>>;
  source: PollSource;
  /** Forget when the last read began, so the next beat reads at once (a screen just opened). */
  reopen(): void;
}

function reader<T>(key: string, path: string, gapMs: number): Reader<T> {
  const store = createStore<Feed<T>>(emptyFeed<T>(), sameFeed);
  let began = 0;
  let busy = false;
  const poll = async (signal: AbortSignal): Promise<boolean> => {
    if (busy || Date.now() - began < gapMs) return false;
    busy = true;
    began = Date.now();
    const before = store.get();
    try {
      const got = await getJson<T>(path, signal);
      if (signal.aborted) {
        // Superseded or left behind: the next beat may ask again at once.
        began = 0;
        return false;
      }
      const now = Date.now();
      store.set(got.body === undefined ? feedAfterFailure(store.get(), got.status, now) : feedAfterAnswer(store.get(), got.body, now));
    } catch {
      // A network error, a timeout or an unreadable body. An abort is not a failure.
      if (signal.aborted) began = 0;
      else store.set(feedAfterFailure(store.get(), undefined, Date.now()));
    } finally {
      busy = false;
    }
    return store.get() !== before;
  };
  return {
    store,
    source: { key, poll },
    reopen() {
      began = 0;
    },
  };
}

const crew = reader<CrewStatusResponse>("crew-status", "/api/crew", 0);
const machines = reader<MachinesResponse>(
  "machines-census",
  `/api/machines?spark=${String(MACHINE_SPARK_MINUTES)}`,
  MACHINES_GAP_MS,
);

/** The crew census (`/api/crew`), for the formation. Read on every beat while a screen wants it. */
export const crewStatus: Store<Feed<CrewStatusResponse>> = crew.store;
/** The machines census with each card's last half hour (`/api/machines?spark=30`). */
export const machinesCensus: Store<Feed<MachinesResponse>> = machines.store;

/** Register with `want(CREW_SOURCE, handle.signal)` while a screen renders from `crewStatus`. */
export const CREW_SOURCE: PollSource = crew.source;
/** Register with `want(MACHINES_SOURCE, handle.signal)` while a screen renders from `machinesCensus`. */
export const MACHINES_SOURCE: PollSource = machines.source;

/** A screen that reads the machines opened: the next beat reads at once instead of waiting out the gap. */
export function reopenMachines(): void {
  machines.reopen();
}
