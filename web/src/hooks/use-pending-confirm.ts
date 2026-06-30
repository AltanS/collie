import { useCallback, useEffect, useRef, useState } from "react";

// Two-tap confirm for destructive actions (Kill, /clear, Ctrl-D, …): the first tap "arms" a target
// keyed by a string id and auto-disarms after a timeout; the confirming second tap fires. Shared so
// the nav footer, command palette, and key tray don't each re-implement the same pending+timer dance.
export function usePendingConfirm(timeoutMs = 3000) {
  const [pending, setPending] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    setPending(null);
  }, [clearTimer]);

  // Returns true when `id` was already armed (this is the confirming second tap) — the caller should
  // proceed. On the first tap it arms `id`, starts the disarm timer, and returns false.
  const confirm = useCallback(
    (id: string): boolean => {
      if (pending === id) {
        reset();
        return true;
      }
      clearTimer();
      setPending(id);
      timer.current = setTimeout(() => setPending(null), timeoutMs);
      return false;
    },
    [pending, clearTimer, reset, timeoutMs],
  );

  useEffect(() => clearTimer, [clearTimer]);

  return { pending, confirm, reset };
}
