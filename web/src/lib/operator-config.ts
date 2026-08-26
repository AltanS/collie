import { useEffect, useSyncExternalStore } from "react";

import { fetchConfig } from "@/lib/api";
import type { OperatorCommand, OperatorKeyRow, OperatorQuickReplyRow } from "@/lib/types";

// The operator's own rows — their `commands.toml` palette AND their `keys.toml` tray presets — read
// from ONE /api/config call and held in module state. Both files ride the same request because both
// are the same kind of thing: startup-resolved operator config the client reads once. Modelled on the lib/server-build.ts store idiom: plain module state + subscribe +
// a useSyncExternalStore hook, so the composer participates without prop-drilling through the route
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
let currentReplies: readonly OperatorQuickReplyRow[] = [];
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
      currentReplies = cfg.operatorQuickReplies ?? [];
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

export function getOperatorQuickReplies(): readonly OperatorQuickReplyRow[] {
  return currentReplies;
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

/** Reactive read of the Quick-dock groups. Same one-shot fetch, same contract. */
export function useOperatorQuickReplies(): readonly OperatorQuickReplyRow[] {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  return useSyncExternalStore(
    subscribeOperatorConfig,
    getOperatorQuickReplies,
    getOperatorQuickReplies,
  );
}

/** Test helper — reset module state between cases. */
export function __resetOperatorCommands(): void {
  current = [];
  currentKeys = [];
  currentReplies = [];
  inflight = null;
  loaded = false;
  listeners.clear();
}
