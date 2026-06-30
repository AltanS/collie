import { useSyncExternalStore } from "react";

// A tiny global status channel. Anything that wants to tell the user something (lifecycle
// transitions, send/kill confirmations, errors) calls setStatus(); the header's <StatusArea/>
// renders the latest one inline and it auto-dismisses. Replaces the toast overlays — there's
// nothing to close, and it never covers the UI.
export type StatusTone = "info" | "success" | "warn" | "error";

export interface StatusMessage {
  id: number;
  text: string;
  tone: StatusTone;
}

let current: StatusMessage | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/**
 * Publish a transient status. Latest wins. Errors persist until dismissed (tap the bar); everything
 * else auto-clears. Pass an explicit `ttlMs` (or `null` to persist) to override the per-tone default.
 */
export function setStatus(text: string, tone: StatusTone = "info", ttlMs?: number | null): void {
  if (timer) clearTimeout(timer);
  timer = null;
  current = { id: nextId++, text, tone };
  emit();
  const ttl = ttlMs === undefined ? (tone === "error" ? null : 2500) : ttlMs;
  if (ttl != null) {
    timer = setTimeout(() => {
      current = null;
      timer = null;
      emit();
    }, ttl);
  }
}

export function clearStatus(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  current = null;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): StatusMessage | null {
  return current;
}

export function useStatus(): StatusMessage | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
