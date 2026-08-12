import { useCallback, useEffect, useRef, useState } from "react";

// Two-tap confirm for destructive actions (Kill, /clear, Ctrl-D, …): the first tap "arms" a target
// keyed by a string id and auto-disarms after a timeout; the confirming second tap fires. Shared so
// the nav footer, command palette, and key tray don't each re-implement the same pending+timer dance.
export function usePendingConfirm<T = never>(timeoutMs = 3000) {
  const [pending, setPending] = useState<string | null>(null);
  const [payload, setPayload] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDisarm = useRef<(() => void) | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // A caller can arm an exact transient alongside the control (such as an explanatory status). It
  // must die with this attempt, including on replacement, expiry, confirmation, or owner unmount.
  const release = useCallback(() => {
    clearTimer();
    const cleanup = onDisarm.current;
    onDisarm.current = null;
    cleanup?.();
  }, [clearTimer]);

  const reset = useCallback(() => {
    release();
    setPending(null);
    setPayload(null);
  }, [release]);

  // Arm (or replace) a pending action. Callers that discover a new guarded attempt while one is
  // already armed must use this rather than treating the attempt as the user's confirming second tap.
  // `cleanup` owns a transient published for this exact arm.
  const arm = useCallback(
    (id: string, nextPayload: T | null = null, cleanup?: () => void) => {
      release();
      onDisarm.current = cleanup ?? null;
      setPending(id);
      setPayload(nextPayload);
      timer.current = setTimeout(reset, timeoutMs);
    },
    [release, reset, timeoutMs],
  );

  // Returns true when `id` was already armed (this is the confirming second tap) — the caller should
  // proceed. On the first tap it arms `id`, starts the disarm timer, and returns false.
  const confirm = useCallback(
    (id: string): boolean => {
      if (pending === id) {
        reset();
        return true;
      }
      arm(id);
      return false;
    },
    [pending, arm, reset],
  );

  useEffect(() => release, [release]);

  return { pending, payload, arm, confirm, reset };
}
