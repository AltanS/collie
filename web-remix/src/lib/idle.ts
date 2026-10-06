// The idle lock (ADR 0007): a PAUSE on an unattended, visibly open Collie, not a gate.
//
// Two rules, as in web/src/hooks/use-idle-lock.ts: a hidden page never locks, and coming back to
// the foreground auto-resumes. So the lock appears one way only: the page stayed open, visible and
// untouched past the deadline. The cover sits over a still-mounted tree (the shell renders it and
// makes the content `inert`); polling pauses while it is up, and releasing it refetches at once.
import { createStore } from "./store";

/** web/'s deadline. A test shortens it through `globalThis.__collieIdleMs` before the app boots. */
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
/** Hard cap on the catch-up beat, as web/src/lib/idle.ts: a refetch that never settles must not
 *  strand the cover. */
const CATCH_UP_CAP_MS = 8_000;

declare global {
  var __collieIdleMs: number | undefined;
}

export interface IdleState {
  locked: boolean;
  /** The cover outlives the lock by one refetch, so resuming never shows the stale screen. */
  catchingUp: boolean;
}

export const idle = createStore<IdleState>(
  { locked: false, catchingUp: false },
  (a, b) => a.locked === b.locked && a.catchingUp === b.catchingUp,
);

export function isLocked(): boolean {
  return idle.get().locked;
}

let capTimer: ReturnType<typeof setTimeout> | undefined;

export function endCatchUp(): void {
  if (capTimer) clearTimeout(capTimer);
  capTimer = undefined;
  idle.update((s) => ({ ...s, catchingUp: false }));
}

let onRelease: () => Promise<void> = async () => {};

/** What releasing the lock refetches (lib/polling.ts wires `refreshNow` in at boot). */
export function setReleaseRefresh(refresh: () => Promise<void>): void {
  onRelease = refresh;
}

/** Dismiss the cover: hold it through one refetch, then drop it. */
export function unlock(): void {
  if (!idle.get().locked) return;
  idle.set({ locked: false, catchingUp: true });
  capTimer = setTimeout(endCatchUp, CATCH_UP_CAP_MS);
  void onRelease().finally(endCatchUp);
}

/**
 * Start the countdown. Activity (a pointer or a key) restarts it; a hidden page lets it die; the
 * return to the foreground stamps fresh activity and auto-resumes. Runs for the page's lifetime.
 */
export function startIdleLock(idleMs = globalThis.__collieIdleMs ?? DEFAULT_IDLE_MS): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastActivity = Date.now();

  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, Math.max(0, idleMs - (Date.now() - lastActivity)));
  };
  function check(): void {
    if (document.visibilityState !== "visible") return;
    if (isLocked()) return;
    if (Date.now() - lastActivity >= idleMs) idle.update((s) => ({ ...s, locked: true }));
    else arm();
  }
  const onActivity = (): void => {
    if (isLocked()) return;
    lastActivity = Date.now();
    arm();
  };
  document.addEventListener("pointerdown", onActivity, { passive: true });
  document.addEventListener("keydown", onActivity, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    lastActivity = Date.now();
    if (isLocked()) unlock();
    arm();
  });
  idle.subscribe(() => {
    if (idle.get().locked) return;
    lastActivity = Date.now();
    arm();
  });
  arm();
}
