import { useSyncExternalStore } from "react";

export interface SttPrefs {
  enabled: boolean;
  handsFree: boolean;
}

const STORAGE_KEY = "collie:stt-prefs:v1";
const DEFAULT_PREFS: SttPrefs = { enabled: true, handsFree: true };

let prefs = load();
const listeners = new Set<() => void>();

function load(): SttPrefs {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_PREFS;
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFS;
    const value = parsed as Partial<SttPrefs>;
    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : true,
      handsFree: typeof value.handsFree === "boolean" ? value.handsFree : true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function update(patch: Partial<SttPrefs>): void {
  prefs = { ...prefs, ...patch };
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    }
  } catch {
    // Private mode/quota failure: keep the preference for this page session.
  }
  for (const listener of listeners) listener();
}

export function getSttPrefs(): SttPrefs {
  return prefs;
}

export function setSttEnabled(enabled: boolean): void {
  update({ enabled });
}

export function setHandsFree(handsFree: boolean): void {
  update({ handsFree });
}

export function useSttPrefs(): SttPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSttPrefs,
    () => DEFAULT_PREFS,
  );
}

export function __resetSttPrefs(): void {
  prefs = load();
  for (const listener of listeners) listener();
}
