import { useEffect, useSyncExternalStore } from "react";

import { fetchConfig } from "@/lib/api";
import type { Launcher, OperatorCommand, OperatorKeyRow } from "@/lib/types";

// The operator's own rows — their `commands.toml` palette, their `keys.toml` tray presets AND
// their `launchers.toml` dashboard row — read from ONE /api/config call and held in module state.
// All three files ride the same request because all three are the same kind of thing:
// startup-resolved operator config the client reads once. Modelled on the lib/server-build.ts store
// idiom: plain module state + subscribe + a useSyncExternalStore hook, so the composer participates
// without prop-drilling through the route tree.
//
// THE CONTRACT: one SUCCESSFUL read is cached for the life of the page; a failed attempt is not
// cached, so a later mount tries again. Never polled, and deliberately not folded into the 1.5s
// snapshot: the bridge re-reads these files behind an mtime check, so an edit is live THERE without
// a restart, but nothing in an already-open tab depends on hearing about it within the second. So
// re-reading every tick would spend bytes on a value that changes when the operator edits a file
// they are looking at — which is why applying an edit takes a page load, and only a page load.
//
// A FAILED FETCH IS NOT AN ERROR STATE. With no rows, every pane falls back to its shipped catalog,
// which is exactly what a user without this var already sees. So a refusal (read-only
// device, auth lapse) or an offline start leaves an empty list and no status noise, and the single
// in-flight promise is cleared so a later MOUNT retries. Retry granularity is the reason the kick
// below lives in an effect and not in the render body: the composer re-renders on every 1.5s
// snapshot, so a render-phase kick would turn one refusal into a request per tick, forever.

let current: readonly OperatorCommand[] = [];
let currentKeys: readonly OperatorKeyRow[] = [];
let currentLaunchers: readonly Launcher[] = [];
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
  inflight = fetchConfig()
    .then((cfg) => {
      current = cfg.operatorCommands ?? [];
      currentKeys = cfg.operatorKeys ?? [];
      currentLaunchers = cfg.launchers ?? [];
      loaded = true;
      emit();
    })
    .catch(() => {
      // Additive feature — see the header. Leave the list empty and allow a later retry.
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function getOperatorCommands(): readonly OperatorCommand[] {
  return current;
}

export function getOperatorKeys(): readonly OperatorKeyRow[] {
  return currentKeys;
}

export function getLaunchers(): readonly Launcher[] {
  return currentLaunchers;
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

/** Reactive read of the dashboard launcher rows. Same one-shot fetch, same contract. */
export function useLaunchers(): readonly Launcher[] {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  return useSyncExternalStore(subscribeOperatorConfig, getLaunchers, getLaunchers);
}

/** Test helper — reset module state between cases. */
export function __resetOperatorCommands(): void {
  current = [];
  currentKeys = [];
  currentLaunchers = [];
  inflight = null;
  loaded = false;
  listeners.clear();
}
