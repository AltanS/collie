import { useEffect, useState } from "react";

import { graceLeftMs, oldestWaitingSince, type WalkyRow } from "@/lib/walky";

/**
 * Whether the mark above the box may show for these waiting messages: the oldest has waited
 * `WALKY_MARK_GRACE_MS`, counted from the bridge's own time for when it began to wait (`waitingSince`), so a
 * reload or a tab that slept in the background changes nothing about it.
 *
 * There is no tick. One timer is set for the exact moment the oldest message reaches its grace and is set
 * again when the oldest changes. A timer that a background tab delayed is harmless: it only asks the clock,
 * and a tab that comes back to the front asks it too (`visibilitychange`). When the messages go in by
 * themselves the list empties and the answer is false at once.
 */
export function useWalkyMarkGrace(waiting: readonly WalkyRow[]): boolean {
  const [now, setNow] = useState(() => Date.now());
  const since = oldestWaitingSince(waiting);
  useEffect(() => {
    if (since === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Ask the clock, and wait for what is left of the grace. A timer that fires a hair early waits again for the hair.
    const arm = () => {
      const t = Date.now();
      setNow(t);
      const left = graceLeftMs(since, t);
      timer = left > 0 ? setTimeout(arm, left) : undefined;
    };
    arm();
    const onVisible = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [since]);
  return since !== null && graceLeftMs(since, now) <= 0;
}
