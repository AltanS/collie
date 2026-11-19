import { useEffect, useRef } from "react";

import { postComposerDiag } from "@/lib/api";
import { startComposerOffscreenWatch, type OffscreenViewState } from "@/lib/composer-offscreen";

/**
 * Watches the mounted pane view for a reply box below the screen and reports the heights once
 * (lib/composer-offscreen.ts). One watch per mount: the view's current state is read when a look runs, so
 * a change of zen or keyboard never restarts the watch or its timers. Renders nothing.
 */
export function useComposerOffscreenWatch(state: OffscreenViewState): void {
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });
  useEffect(
    () =>
      startComposerOffscreenWatch({
        getState: () => latest.current,
        send: (record) => void postComposerDiag(record),
      }),
    [],
  );
}
