import { useSyncExternalStore } from "react";

// A tiny global status channel. Anything that wants to tell the user something (lifecycle
// transitions, send/kill confirmations, errors) calls setStatus(); the header's <StatusArea/>
// renders the latest one inline and it auto-dismisses. Replaces the toast overlays — there's
// nothing to close, and it never covers the UI.
// `info` is the quiet default (muted). `note` is a neutral fact worth a colour: it paints with
// `status-info`, the blue of a fact that is not a warning (the desk answered before the phone).
export type StatusTone = "info" | "note" | "success" | "warn" | "error";

export interface StatusMessage {
  id: number;
  text: string;
  tone: StatusTone;
  /**
   * A word that stands beside what the slot shows instead of in its place (M104): the pane header keeps the
   * session's name and time, and "Sent" rides in the free room of their line. Absent: the status takes the slot.
   */
  beside?: boolean;
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
 *
 * EVERY publish here also turns the Collie mark's orbit one round (components/collie-home.tsx), so
 * this channel is the app's one definition of "worth telling the operator about". A second, narrower
 * channel was built and removed — see that file for what was tried.
 */
export function setStatus(text: string, tone: StatusTone = "info", ttlMs?: number | null, beside = false): void {
  if (timer) clearTimeout(timer);
  timer = null;
  current = beside ? { id: nextId++, text, tone, beside } : { id: nextId++, text, tone };
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

/**
 * Start the default countdown on a status published to persist (`ttlMs: null`), when it is still the
 * one on screen. Publishes nothing new, so the mark's orbit does not turn again. For a notice that must
 * stay until something finishes: a refused tap's "changed, refreshing" stays until the card refreshed.
 */
export function releaseStatus(id: number, ttlMs = 2500): void {
  if (current?.id !== id) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    timer = null;
    emit();
  }, ttlMs);
}

export function clearStatus(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  current = null;
  emit();
}

/** The status on screen now, or null. A plain read, for a caller that must not replace an error. */
export function currentStatus(): StatusMessage | null {
  return current;
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
