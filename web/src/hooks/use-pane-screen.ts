import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import { fetchPane } from "@/lib/api";
import type { Scope } from "@/lib/scope";

/**
 * One pane's screen text for a large screen's read-only column (ADR 0120), moved by the poll that
 * already exists: it rides `useRevalidator()`'s loading-to-idle edge, as `useChatWindow` does, so it
 * reads at the app's normal rate, stops behind a hidden tab with the poller, and starts no timer.
 *
 * The read is `seen: false`: the column is on screen, but only the focused pane counts as opened.
 * A failed read keeps what is held; the connection strip is the app's one answer to an outage.
 */
export function usePaneScreen(paneId: string, scope: Scope | undefined, enabled: boolean): string | null {
  const revalidator = useRevalidator();
  const idle = revalidator.state === "idle";
  const [text, setText] = useState<string | null>(null);
  // One read at a time, and none landing after the column left. The read is not aborted when the next
  // poll starts: on a slow link that would cancel every read before it answered.
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled || !idle || busy.current) return;
    busy.current = true;
    const read = async () => {
      try {
        const got = await fetchPane(paneId, undefined, scope, undefined, { seen: false });
        if (alive.current) setText(got.text);
      } catch {
        // Keep what is held (see above).
      } finally {
        busy.current = false;
      }
    };
    void read();
  }, [enabled, idle, paneId, scope]);
  return text;
}
