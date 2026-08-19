import { useEffect, useSyncExternalStore } from "react";

import { fetchConfig } from "@/lib/api";
import type { MuxConfig, OperatorCommand, OperatorKeyRow } from "@/lib/types";

// The startup-resolved half of /api/config, read ONCE and held in module state: the operator's own
// rows (their `commands.toml` palette and their `keys.toml` tray presets) and the multiplexer's
// declared capabilities (M10/06). All three ride the same request because all three are the same
// kind of thing — config the bridge resolves at startup and the client reads once.
//
// THE CAPABILITIES BELONG HERE RATHER THAN IN A SECOND STORE for the reason the header already
// gives: this is ONE /api/config call, never a second channel. A capability store with its own
// fetch would double the request and could disagree with this one about what the same response
// said. lib/mux-capability.ts holds the POLICY (what an absent answer means, which control asks
// what); this file holds only the bytes.
//
// Modelled on the lib/server-build.ts store idiom: plain module state + subscribe + a
// useSyncExternalStore hook, so the composer participates without prop-drilling through the route
// tree.
//
// THE CONTRACT: one SUCCESSFUL read is cached for the life of the page; a failed attempt is not
// cached, so a later mount tries again. Never polled, and deliberately not folded into the 1.5s
// snapshot: this is startup config on the bridge side (loadConfig() runs once, bridge/index.ts), so
// re-reading it every tick would spend bytes on a value that cannot change without a bridge
// restart. Which is also why changing it takes a bridge restart AND a page load, not just the
// restart — the same contract every other COLLIE_* var has, and what `.env.example` promises.
//
// A FAILED FETCH IS NOT AN ERROR STATE. With no rows, every pane falls back to its shipped catalog,
// which is exactly what a user without this var already sees. So a refusal (read-only
// device, auth lapse) or an offline start leaves an empty list and no status noise, and the single
// in-flight promise is cleared so a later MOUNT retries. Retry granularity is the reason the kick
// below lives in an effect and not in the render body: the composer re-renders on every 1.5s
// snapshot, so a render-phase kick would turn one refusal into a request per tick, forever.

let current: readonly OperatorCommand[] = [];
let currentKeys: readonly OperatorKeyRow[] = [];
// `null` until a read succeeds, AND on a bridge that publishes none — the two are deliberately the
// same value, because both mean "nothing said otherwise" and mux-capability.ts answers both the
// same way: capable.
let currentMux: MuxConfig | null = null;
let inflight: Promise<void> | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Read the list once per page load. Concurrent callers share the one in-flight request. */
export function loadOperatorCommands(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const cfg = await fetchConfig();
      current = cfg.operatorCommands ?? [];
      currentKeys = cfg.operatorKeys ?? [];
      currentMux = cfg.mux ?? null;
      loaded = true;
      emit();
    } catch {
      // Additive feature — see the header. Leave the list empty and allow a later retry.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getOperatorCommands(): readonly OperatorCommand[] {
  return current;
}

export function getOperatorKeys(): readonly OperatorKeyRow[] {
  return currentKeys;
}

/**
 * The multiplexer block, or `null` when nothing has said otherwise (no read yet, a failed read, or a
 * bridge older than the field). Every consumer goes through lib/mux-capability.ts, which is where
 * `null` is turned into an answer.
 */
export function getMuxConfig(): MuxConfig | null {
  return currentMux;
}

export function subscribeOperatorConfig(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Reactive read. Kicks the one-shot fetch on mount, so the only thing a call site has to do is read
 * the value — there is no "load this somewhere at startup" step to forget.
 */
export function useOperatorCommands(): readonly OperatorCommand[] {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  return useSyncExternalStore(subscribeOperatorConfig, getOperatorCommands, getOperatorCommands);
}

/** Reactive read of the Keys-tray presets. Same one-shot fetch, same contract. */
export function useOperatorKeys(): readonly OperatorKeyRow[] {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  return useSyncExternalStore(subscribeOperatorConfig, getOperatorKeys, getOperatorKeys);
}

/** Test helper — reset module state between cases. */
export function __resetOperatorCommands(): void {
  current = [];
  currentKeys = [];
  currentMux = null;
  inflight = null;
  loaded = false;
  listeners.clear();
}
