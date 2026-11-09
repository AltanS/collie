// THE PHONE'S COPY OF THE TRICKS (M94 slice 02): the parts by key, the trick list, and the taps in flight.
//
// NO TIMER OF ITS OWN. Whoever holds the snapshot calls `syncTricks(snapshot.tricksRev)`; when the rev
// differs from the one this store holds, it asks `GET /api/tricks?since=<held rev>` for the changes and
// merges them: a changed part replaces the held one, a key missing from `present` is dropped. So the
// tricks ride the snapshot's cadence, and a clock trick does not resend twenty tricks every five seconds.
//
// A TAP IS AN ACTION WITH A RECEIPT (v2 question 8), in the tree's intent shape `{ rid, node, intent,
// value }`. It carries a fresh rid; the pressed control draws Collie's busy state until the reply lands;
// `ok` and `changed` apply the reply's parts at once; `rejected`, `gone` and `denied` put the masked
// reason in the part's frame; `unknown` is shown and NEVER sent again on its own. A second tap on the
// same part while one is in flight does nothing. When the operator taps the same control again after an
// `unknown`, the tap goes out with the SAME rid, so a run that did happen the first time answers the
// same receipt from the bridge's log and runs nothing twice.

import { useMemo, useSyncExternalStore } from "react";

import { apiErrorStatus, fetchTricks, tapTrick } from "../api";
import { t } from "../i18n";
import { mintRequestId } from "../worktree-name";
import {
  parsePartKey,
  partKey,
  type TrickPartKey,
  type TrickTapReply,
  type TricksReply,
  type PlaceKind,
  type TapCode,
  type TapFrom,
  type TapRequest,
  type TapValue,
  type WireTrickInfo,
  type WireTrickPart,
} from "./schema";

/** The state of the last tap on one part. A part with no entry has no tap to show. */
export type TapState =
  | { phase: "busy"; rid: string; control: string; intent: string; value?: TapValue }
  | { phase: "failed"; rid: string; control: string; intent: string; value?: TapValue; message: string }
  | { phase: "unknown"; rid: string; control: string; intent: string; value?: TapValue };

export interface TricksState {
  /** The `tricksRev` the held parts are at. `null` until the first reply. */
  rev: number | null;
  /** The tricks in manifest order, as the last reply listed them. */
  tricks: readonly WireTrickInfo[];
  /** Every held part by `partKey`, in the order the phone first saw it. */
  parts: ReadonlyMap<string, WireTrickPart>;
  /** The last tap on a part, by `partKey`. */
  taps: ReadonlyMap<string, TapState>;
}

/** The two routes and the id source, so a test or the playground can stand in for the bridge. */
export interface TricksTransport {
  fetchTricks: (since: number) => Promise<TricksReply>;
  tapTrick: (host: string, trick: string, body: TapRequest) => Promise<TrickTapReply>;
  mintRequestId: () => string;
}

/**
 * What travels beside a tap. Only the session open on the phone: a tap moves nothing on the phone and
 * writes into no reply box (step 3: there is no draft handler anywhere in tricks).
 */
export interface TapHandlers {
  /** The session open on the phone, sent with the tap. */
  from?: TapFrom;
}

/** One tap, as the renderer asks for it. `control` names the pressed control inside its part. */
export interface TapInput extends TrickPartKey {
  intent: string;
  value?: TapValue;
  control: string;
}

/** What a tap came to: the receipt's code, or `ignored` for a second tap while one is in flight. */
export type TapResult = TapCode | "ignored";

export interface TricksStore {
  getState: () => TricksState;
  subscribe: (listener: () => void) => () => void;
  /** Bring the held parts to `tricksRev`. Resolves when this round of fetching is over, whatever it gave. */
  syncTricks: (tricksRev: number | undefined) => Promise<void>;
  tap: (input: TapInput, handlers?: TapHandlers) => Promise<TapResult>;
}

/** Fetch rounds one `syncTricks` may run, when the bridge moves again while it fetches. The next snapshot asks again. */
const SYNC_ROUNDS = 3;
/** After a failed fetch, the same rev is asked again only after this long, so a broken route is not asked every poll. */
export const SYNC_RETRY_MS = 30_000;

const EMPTY: TricksState = { rev: null, tricks: [], parts: new Map(), taps: new Map() };

function sameValue(a: TapValue | undefined, b: TapValue | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function trickOf(key: string): string | undefined {
  const parsed = parsePartKey(key);
  return parsed === undefined ? undefined : `${parsed.host}/${parsed.trick}`;
}

/** Merge parts. A held part with a higher rev wins, unless the whole set is replaced. */
function mergeParts(parts: Map<string, WireTrickPart>, taps: Map<string, TapState>, incoming: readonly WireTrickPart[], replace: boolean): void {
  for (const part of incoming) {
    const key = partKey(part);
    const held = parts.get(key);
    if (!replace && held !== undefined && held.rev > part.rev) continue;
    parts.set(key, part);
    // A newer version of the part answers whatever the last tap left on it, unless one is in flight.
    const last = taps.get(key);
    if (held !== undefined && part.rev > held.rev && last !== undefined && last.phase !== "busy") taps.delete(key);
  }
}

function dropAbsent(parts: Map<string, WireTrickPart>, taps: Map<string, TapState>, present: ReadonlySet<string>, scope?: string): void {
  for (const key of parts.keys()) {
    if (present.has(key)) continue;
    if (scope !== undefined && trickOf(key) !== scope) continue;
    parts.delete(key);
    if (taps.get(key)?.phase !== "busy") taps.delete(key);
  }
}

/** A store over a transport. The app uses {@link tricksStore}; tests and the playground make their own. */
export function createTricksStore(transport: TricksTransport, clock: () => number = Date.now): TricksStore {
  let state: TricksState = EMPTY;
  const listeners = new Set<() => void>();
  /** The highest rev a snapshot asked for that the store has not reached yet. */
  let wanted: number | null = null;
  /** A snapshot named a rev below the held one: the bridge restarted, so the next fetch is a full one. */
  let resetWanted = false;
  let syncing: Promise<void> | null = null;
  let failed: { rev: number; at: number } | null = null;

  function commit(next: TricksState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function withTap(key: string, entry: TapState | undefined): Map<string, TapState> {
    const taps = new Map(state.taps);
    if (entry === undefined) taps.delete(key);
    if (entry !== undefined) taps.set(key, entry);
    return taps;
  }

  function applyReply(reply: TricksReply, replace: boolean): void {
    const parts = replace ? new Map<string, WireTrickPart>() : new Map(state.parts);
    const taps = new Map(state.taps);
    mergeParts(parts, taps, reply.parts, replace);
    dropAbsent(parts, taps, new Set(reply.present));
    commit({ rev: reply.rev, tricks: reply.tricks, parts, taps });
  }

  async function runSync(): Promise<void> {
    for (let round = 0; round < SYNC_ROUNDS; round += 1) {
      const held = state.rev;
      const target = wanted;
      if (target === null) return;
      const replace = held === null || resetWanted;
      if (!replace && held >= target) return;
      if (failed !== null && failed.rev === target && clock() - failed.at < SYNC_RETRY_MS) return;
      resetWanted = false;
      let reply: TricksReply;
      try {
        reply = await transport.fetchTricks(replace ? 0 : held);
      } catch {
        // The held parts stay; their frames go stale on their own clock. The next snapshot asks again.
        failed = { rev: target, at: clock() };
        return;
      }
      failed = null;
      applyReply(reply, replace);
    }
  }

  function sync(tricksRev: number | undefined): Promise<void> {
    if (tricksRev === undefined || !Number.isFinite(tricksRev)) return Promise.resolve();
    if (state.rev !== null && tricksRev < state.rev) resetWanted = true;
    wanted = tricksRev;
    if (syncing !== null) return syncing;
    if (state.rev === tricksRev && !resetWanted) return Promise.resolve();
    syncing = runSync().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  function applyTapReply(input: TapInput, reply: TrickTapReply): void {
    const parts = new Map(state.parts);
    const taps = new Map(state.taps);
    mergeParts(parts, taps, reply.parts ?? [], false);
    if (reply.present !== undefined) dropAbsent(parts, taps, new Set(reply.present), `${input.host}/${input.trick}`);
    commit({ ...state, parts, taps });
  }

  function settle(key: string, input: TapInput, rid: string, code: Exclude<TapCode, "ok" | "changed">, message?: string): TapResult {
    const base = { rid, control: input.control, intent: input.intent };
    const entry: TapState = code === "unknown" ? { phase: "unknown", ...base } : { phase: "failed", ...base, message: message ?? t("tricks.frame.tapFailed") };
    if (input.value !== undefined) entry.value = input.value;
    commit({ ...state, taps: withTap(key, entry) });
    return code;
  }

  async function runTap(input: TapInput, handlers: TapHandlers = {}): Promise<TapResult> {
    const key = partKey(input);
    const current = state.taps.get(key);
    if (current?.phase === "busy") return "ignored";
    const retry = current?.phase === "unknown" && current.control === input.control && current.intent === input.intent && sameValue(current.value, input.value);
    const rid = retry ? current.rid : transport.mintRequestId();
    const busy: TapState = { phase: "busy", rid, control: input.control, intent: input.intent };
    if (input.value !== undefined) busy.value = input.value;
    commit({ ...state, taps: withTap(key, busy) });

    // STEP 3: a decision's answer taps `hill/<key>`; the store keys taps by part, so it sends the part id.
    const body: TapRequest = { rid, node: input.part, intent: input.intent };
    if (input.value !== undefined) body.value = input.value;
    if (handlers.from !== undefined) body.from = handlers.from;
    let reply: TrickTapReply;
    try {
      reply = await transport.tapTrick(input.host, input.trick, body);
    } catch (error) {
      // A refusal before the run (a 4xx) ran nothing, so it is a plain failure. No answer at all, a
      // deadline or a 5xx may have come after the provider ran, so the phone does not know.
      const status = apiErrorStatus(error);
      if (status !== undefined && status >= 400 && status < 500) return settle(key, input, rid, "rejected", t("tricks.tap.refused", { status }));
      return settle(key, input, rid, "unknown");
    }
    if (reply.rid !== rid) return settle(key, input, rid, "unknown");
    applyTapReply(input, reply);
    if (reply.code !== "ok" && reply.code !== "changed") return settle(key, input, rid, reply.code, reply.message);
    commit({ ...state, taps: withTap(key, undefined) });
    return reply.code;
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncTricks: sync,
    tap: runTap,
  };
}

/** The app's one store, over the real routes. */
export const tricksStore: TricksStore = createTricksStore({
  // Each route is read at call time, not when this module loads: the root loader imports this store,
  // so every module that imports the loader would otherwise need `tapTrick` from the api module first.
  fetchTricks: (since) => fetchTricks(since),
  tapTrick: (host, trick, body) => tapTrick(host, trick, body),
  mintRequestId: () => mintRequestId(),
});

/** Bring the app's store to the snapshot's `tricksRev`. Called by whoever holds the snapshot (slice 03). */
export function syncTricks(tricksRev: number | undefined): Promise<void> {
  return tricksStore.syncTricks(tricksRev);
}

/** The whole state of a store, re-read on every change. */
export function useTricksState(store: TricksStore = tricksStore): TricksState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** The place an `at` names, read by its prefix. The match inside it is the place's own business. A bare `tab` and `tab:<match>` are both `tab`. */
export function placeOfAt(at: string): PlaceKind | undefined {
  if (at === "belt" || at === "session" || at === "dashboard" || at === "tab") return at;
  if (at.startsWith("tab:")) return "tab";
  if (at.startsWith("view:")) return "view";
  return undefined;
}

/**
 * The held parts of one place, in trick order (the manifest order the list gives) and, inside one trick,
 * in the order the phone first saw them. `filter` narrows further, for a match. Tricks that are off
 * draw nothing.
 */
export function useTrickParts(place: PlaceKind, filter?: (part: WireTrickPart) => boolean, store: TricksStore = tricksStore): WireTrickPart[] {
  const state = useTricksState(store);
  return useMemo(() => {
    const order = new Map(state.tricks.map((trick, i) => [`${trick.host}/${trick.id}`, i]));
    const off = new Set(state.tricks.filter((trick) => !trick.on).map((trick) => `${trick.host}/${trick.id}`));
    const found = [...state.parts.values()].filter((part) => {
      const trick = `${part.host}/${part.trick}`;
      return !off.has(trick) && placeOfAt(part.value.at) === place && (filter === undefined || filter(part));
    });
    return found.toSorted((a, b) => (order.get(`${a.host}/${a.trick}`) ?? order.size) - (order.get(`${b.host}/${b.trick}`) ?? order.size));
  }, [state.parts, state.tricks, place, filter]);
}

/** One held part and its trick's entry and tap, for a frame. */
export function useTrickPart(key: string, store: TricksStore = tricksStore): { part?: WireTrickPart; trick?: WireTrickInfo; tap?: TapState } {
  const state = useTricksState(store);
  return useMemo(() => {
    const part = state.parts.get(key);
    const trick = part === undefined ? undefined : state.tricks.find((entry) => entry.host === part.host && entry.id === part.trick);
    return { part, trick, tap: state.taps.get(key) };
  }, [state.parts, state.tricks, state.taps, key]);
}

/**
 * The tap function a renderer's context takes: it reads the part key back into host, trick and part
 * and sends the tap with `handlers.from`.
 */
export function trickTapper(handlers: TapHandlers, store: TricksStore = tricksStore): (key: string, intent: string, value: TapValue | undefined, control: string) => void {
  return (key, intent, value, control) => {
    const parsed = parsePartKey(key);
    if (parsed === undefined) return;
    const input: TapInput = { ...parsed, intent, control };
    if (value !== undefined) input.value = value;
    void store.tap(input, handlers);
  };
}
