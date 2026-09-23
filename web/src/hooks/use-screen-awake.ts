import { useEffect } from "react";

/**
 * Hold the screen awake while `active`, FOREGROUND ONLY and best-effort (ADR 0064).
 *
 * The browser drops a screen wake lock whenever the page is hidden, so this takes it again on every
 * return to the foreground rather than once. A refused or missing lock changes nothing: the caller's
 * work goes on, the phone may only dim. Never requested while hidden, for the same reason as the
 * recorder's lock (`use-stt-recorder.ts`).
 */
export function useScreenAwake(active: boolean): void {
  useEffect(() => {
    if (!active || !navigator.wakeLock) return;
    let lock: WakeLockSentinel | null = null;
    let done = false;

    const take = async () => {
      if (done || lock !== null || document.visibilityState !== "visible") return;
      try {
        const taken = await navigator.wakeLock.request("screen");
        // The request is asynchronous, so the caller may have let go while it was pending.
        if (done) {
          void taken.release().catch(() => {});
          return;
        }
        lock = taken;
        taken.addEventListener("release", () => {
          if (lock === taken) lock = null;
        });
      } catch {
        // Refused (battery saver, no user activation yet): a comfort, not a dependency.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void take();
    };

    void take();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      done = true;
      document.removeEventListener("visibilitychange", onVisible);
      const held = lock;
      lock = null;
      void held?.release().catch(() => {});
    };
  }, [active]);
}
