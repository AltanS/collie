// THE PHONE'S COPY OF THE MODS (M94 slice 02): the parts by key, the mod list, and the taps in flight.
//
// NO TIMER OF ITS OWN. Whoever holds the snapshot calls `syncMods(snapshot.modsRev)`; when the rev
// differs from the one this store holds, it asks `GET /api/mods?since=<held rev>` for the changes and
// merges them: a changed part replaces the held one, a key missing from `present` is dropped. So the
// mods ride the snapshot's cadence, and a clock mod does not resend twenty mods every five seconds.
//
// A TAP IS AN ACTION WITH A RECEIPT (v2 question 8). It carries a fresh request id; the pressed
// control draws Collie's busy state until the reply lands; `applied` and `replayed` apply the reply's
// parts at once; `failed` puts the masked reason in the part's frame; `unknown` is shown and NEVER sent
// again on its own. A second tap on the same part while one is in flight does nothing. When the
// operator taps the same control again after an `unknown`, the tap goes out with the SAME request id,
// so a run that did happen the first time answers `replayed` and runs nothing twice.

import { useMemo, useSyncExternalStore } from "react";

import { apiErrorStatus, fetchMods, tapMod } from "../api";
import { t } from "../i18n";
import type { JsonObject } from "../json";
import { mintRequestId } from "../worktree-name";
import {
  parsePartKey,
  partKey,
  type Draft,
  type ModPartKey,
  type ModTapReply,
  type ModsReply,
  type OpenTarget,
  type PlaceKind,
  type TapFrom,
  type TapOutcome,
  type TapRequest,
  type WireModInfo,
  type WireModPart,
} from "./schema";

/** The state of the last tap on one part. A part with no entry has no tap to show. */
export type TapState =
  | { phase: "busy"; requestId: string; control: string; intent: string; args?: JsonObject }
  | { phase: "failed"; requestId: string; control: string; intent: string; args?: JsonObject; message: string }
  | { phase: "unknown"; requestId: string; control: string; intent: string; args?: JsonObject };

export interface ModsState {
  /** The `modsRev` the held parts are at. `null` until the first reply. */
  rev: number | null;
  /** The mods in manifest order, as the last reply listed them. */
  mods: readonly WireModInfo[];
  /** Every held part by `partKey`, in the order the phone first saw it. */
  parts: ReadonlyMap<string, WireModPart>;
  /** The last tap on a part, by `partKey`. */
  taps: ReadonlyMap<string, TapState>;
}

/** The two routes and the id source, so a test or the playground can stand in for the bridge. */
export interface ModsTransport {
  fetchMods: (since: number) => Promise<ModsReply>;
  tapMod: (host: string, mod: string, body: TapRequest) => Promise<ModTapReply>;
  mintRequestId: () => string;
}

/** A draft the renderer hands up: the reply's own (with its session) or the fix button's (without). */
export interface DraftRequest {
  text: string;
  /** The real session the draft is for. Absent: the caller asks the person which one (slice 03). */
  session?: string;
}

/** Where a tap's reply sends the draft and the open. Wired by slice 03 to the reply box and navigation. */
export interface TapHandlers {
  onDraft?: (draft: Draft) => void;
  onOpen?: (target: OpenTarget) => void;
  /** The session open on the phone, sent with the tap. */
  from?: TapFrom;
}

/** One tap, as the renderer asks for it. `control` names the pressed control inside its part. */
export interface TapInput extends ModPartKey {
  intent: string;
  args?: JsonObject;
  control: string;
}

/** What a tap came to: the receipt's outcome, or `ignored` for a second tap while one is in flight. */
export type TapResult = TapOutcome | "ignored";

export interface ModsStore {
  getState: () => ModsState;
  subscribe: (listener: () => void) => () => void;
  /** Bring the held parts to `modsRev`. Resolves when this round of fetching is over, whatever it gave. */
  syncMods: (modsRev: number | undefined) => Promise<void>;
  tap: (input: TapInput, handlers?: TapHandlers) => Promise<TapResult>;
}

/** Fetch rounds one `syncMods` may run, when the bridge moves again while it fetches. The next snapshot asks again. */
const SYNC_ROUNDS = 3;
/** After a failed fetch, the same rev is asked again only after this long, so a broken route is not asked every poll. */
export const SYNC_RETRY_MS = 30_000;

const EMPTY: ModsState = { rev: null, mods: [], parts: new Map(), taps: new Map() };

function sameArgs(a: JsonObject | undefined, b: JsonObject | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function modOf(key: string): string | undefined {
  const parsed = parsePartKey(key);
  return parsed === undefined ? undefined : `${parsed.host}/${parsed.mod}`;
}

/** Merge parts. A held part with a higher rev wins, unless the whole set is replaced. */
function mergeParts(parts: Map<string, WireModPart>, taps: Map<string, TapState>, incoming: readonly WireModPart[], replace: boolean): void {
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

function dropAbsent(parts: Map<string, WireModPart>, taps: Map<string, TapState>, present: ReadonlySet<string>, scope?: string): void {
  for (const key of parts.keys()) {
    if (present.has(key)) continue;
    if (scope !== undefined && modOf(key) !== scope) continue;
    parts.delete(key);
    if (taps.get(key)?.phase !== "busy") taps.delete(key);
  }
}

/** A store over a transport. The app uses {@link modsStore}; tests and the playground make their own. */
export function createModsStore(transport: ModsTransport, clock: () => number = Date.now): ModsStore {
  let state: ModsState = EMPTY;
  const listeners = new Set<() => void>();
  /** The highest rev a snapshot asked for that the store has not reached yet. */
  let wanted: number | null = null;
  /** A snapshot named a rev below the held one: the bridge restarted, so the next fetch is a full one. */
  let resetWanted = false;
  let syncing: Promise<void> | null = null;
  let failed: { rev: number; at: number } | null = null;

  function commit(next: ModsState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function withTap(key: string, entry: TapState | undefined): Map<string, TapState> {
    const taps = new Map(state.taps);
    if (entry === undefined) taps.delete(key);
    if (entry !== undefined) taps.set(key, entry);
    return taps;
  }

  function applyReply(reply: ModsReply, replace: boolean): void {
    const parts = replace ? new Map<string, WireModPart>() : new Map(state.parts);
    const taps = new Map(state.taps);
    mergeParts(parts, taps, reply.parts, replace);
    dropAbsent(parts, taps, new Set(reply.present));
    commit({ rev: reply.rev, mods: reply.mods, parts, taps });
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
      let reply: ModsReply;
      try {
        reply = await transport.fetchMods(replace ? 0 : held);
      } catch {
        // The held parts stay; their frames go stale on their own clock. The next snapshot asks again.
        failed = { rev: target, at: clock() };
        return;
      }
      failed = null;
      applyReply(reply, replace);
    }
  }

  function sync(modsRev: number | undefined): Promise<void> {
    if (modsRev === undefined || !Number.isFinite(modsRev)) return Promise.resolve();
    if (state.rev !== null && modsRev < state.rev) resetWanted = true;
    wanted = modsRev;
    if (syncing !== null) return syncing;
    if (state.rev === modsRev && !resetWanted) return Promise.resolve();
    syncing = runSync().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  function applyTapReply(input: TapInput, reply: ModTapReply): void {
    const parts = new Map(state.parts);
    const taps = new Map(state.taps);
    mergeParts(parts, taps, reply.parts ?? [], false);
    if (reply.present !== undefined) dropAbsent(parts, taps, new Set(reply.present), `${input.host}/${input.mod}`);
    commit({ ...state, parts, taps });
  }

  function settle(key: string, input: TapInput, requestId: string, outcome: "failed" | "unknown", message?: string): TapResult {
    const base = { requestId, control: input.control, intent: input.intent };
    const entry: TapState = outcome === "failed" ? { phase: "failed", ...base, message: message ?? t("mods.frame.tapFailed") } : { phase: "unknown", ...base };
    if (input.args !== undefined) entry.args = input.args;
    commit({ ...state, taps: withTap(key, entry) });
    return outcome;
  }

  async function runTap(input: TapInput, handlers: TapHandlers = {}): Promise<TapResult> {
    const key = partKey(input);
    const current = state.taps.get(key);
    if (current?.phase === "busy") return "ignored";
    const retry = current?.phase === "unknown" && current.control === input.control && current.intent === input.intent && sameArgs(current.args, input.args);
    const requestId = retry ? current.requestId : transport.mintRequestId();
    const busy: TapState = { phase: "busy", requestId, control: input.control, intent: input.intent };
    if (input.args !== undefined) busy.args = input.args;
    commit({ ...state, taps: withTap(key, busy) });

    const body: TapRequest = { requestId, intent: input.intent, part: input.part };
    if (input.args !== undefined) body.args = input.args;
    if (handlers.from !== undefined) body.from = handlers.from;
    let reply: ModTapReply;
    try {
      reply = await transport.tapMod(input.host, input.mod, body);
    } catch (error) {
      // A refusal before the run (a 4xx) ran nothing, so it is a plain failure. No answer at all, a
      // deadline or a 5xx may have come after the provider ran, so the phone does not know.
      const status = apiErrorStatus(error);
      if (status !== undefined && status >= 400 && status < 500) return settle(key, input, requestId, "failed", t("mods.tap.refused", { status }));
      return settle(key, input, requestId, "unknown");
    }
    if (reply.requestId !== requestId) return settle(key, input, requestId, "unknown");
    applyTapReply(input, reply);
    if (reply.outcome === "failed") return settle(key, input, requestId, "failed", reply.message);
    if (reply.outcome === "unknown") return settle(key, input, requestId, "unknown");
    commit({ ...state, taps: withTap(key, undefined) });
    if (reply.draft !== undefined) handlers.onDraft?.(reply.draft);
    if (reply.open !== undefined) handlers.onOpen?.(reply.open);
    return reply.outcome;
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncMods: sync,
    tap: runTap,
  };
}

/** The app's one store, over the real routes. */
export const modsStore: ModsStore = createModsStore({
  // Each route is read at call time, not when this module loads: the root loader imports this store,
  // so every module that imports the loader would otherwise need `tapMod` from the api module first.
  fetchMods: (since) => fetchMods(since),
  tapMod: (host, mod, body) => tapMod(host, mod, body),
  mintRequestId: () => mintRequestId(),
});

/** Bring the app's store to the snapshot's `modsRev`. Called by whoever holds the snapshot (slice 03). */
export function syncMods(modsRev: number | undefined): Promise<void> {
  return modsStore.syncMods(modsRev);
}

/** The whole state of a store, re-read on every change. */
export function useModsState(store: ModsStore = modsStore): ModsState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** The place an `at` names, read by its prefix. The match inside it is the place's own business. */
export function placeOfAt(at: string): PlaceKind | undefined {
  if (at === "belt" || at === "session" || at === "tab" || at === "dashboard" || at === "header.line" || at === "settings") return at;
  if (at.startsWith("tab:")) return "tab-mark";
  if (at.startsWith("view:")) return "view";
  if (at.startsWith("menu:")) return "menu";
  return undefined;
}

/**
 * The held parts of one place, in mod order (the manifest order the list gives) and, inside one mod,
 * in the order the phone first saw them. `filter` narrows further, for a match. Mods that are off
 * draw nothing.
 */
export function useModParts(place: PlaceKind, filter?: (part: WireModPart) => boolean, store: ModsStore = modsStore): WireModPart[] {
  const state = useModsState(store);
  return useMemo(() => {
    const order = new Map(state.mods.map((mod, i) => [`${mod.host}/${mod.id}`, i]));
    const off = new Set(state.mods.filter((mod) => !mod.on).map((mod) => `${mod.host}/${mod.id}`));
    const found = [...state.parts.values()].filter((part) => {
      const mod = `${part.host}/${part.mod}`;
      return !off.has(mod) && placeOfAt(part.value.at) === place && (filter === undefined || filter(part));
    });
    return found.toSorted((a, b) => (order.get(`${a.host}/${a.mod}`) ?? order.size) - (order.get(`${b.host}/${b.mod}`) ?? order.size));
  }, [state.parts, state.mods, place, filter]);
}

/** One held part and its mod's entry and tap, for a frame. */
export function useModPart(key: string, store: ModsStore = modsStore): { part?: WireModPart; mod?: WireModInfo; tap?: TapState } {
  const state = useModsState(store);
  return useMemo(() => {
    const part = state.parts.get(key);
    const mod = part === undefined ? undefined : state.mods.find((entry) => entry.host === part.host && entry.id === part.mod);
    return { part, mod, tap: state.taps.get(key) };
  }, [state.parts, state.mods, state.taps, key]);
}

/**
 * The tap function a renderer's context takes: it reads the part key back into host, mod and part
 * and hands the reply's draft and open to `handlers`.
 */
export function modTapper(handlers: TapHandlers, store: ModsStore = modsStore): (key: string, intent: string, args: JsonObject | undefined, control: string) => void {
  return (key, intent, args, control) => {
    const parsed = parsePartKey(key);
    if (parsed === undefined) return;
    const input: TapInput = { ...parsed, intent, control };
    if (args !== undefined) input.args = args;
    void store.tap(input, handlers);
  };
}
