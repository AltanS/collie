import { useCallback, useEffect, useRef, useState } from "react";

import {
  disablePush,
  enablePush,
  getPushState,
  isPushDisabledByUser,
  type EnableResult,
  type PushState,
} from "@/lib/push";

// On mount, subscribe to Web Push — unless the user turned it off in Settings. Best-effort and
// silent: service workers + Push need a secure context, so over plain HTTP this no-ops (it lights up
// once served over HTTPS). The subscribe flow lives in lib/push so the settings page can reuse it.
//
// `paused` HOLDS THE ATTEMPT BACK, and the first-launch tour is why it exists: `enablePush()` raises
// the browser's own permission prompt with no user gesture behind it, seconds after boot, and behind
// the tour's backdrop that prompt is a dialog about a thing the operator has not been told about
// yet. `RootLayout` starts its decision at "pending" and passes `paused` true until the tour says
// it is closed. The ref is what keeps the attempt to at most once per mount: `paused` flipping
// false re-runs the effect, and a second run must not re-subscribe.
export function usePushSetup(paused: boolean) {
  const attempted = useRef(false);
  useEffect(() => {
    if (paused || attempted.current) return;
    if (isPushDisabledByUser()) return;
    attempted.current = true;
    let cancelled = false;
    void (async () => {
      try {
        await enablePush();
      } catch (e) {
        if (!cancelled) console.warn("[push] setup skipped:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paused]);
}

// Settings-page controller: the current push state plus an enable/disable action that refreshes it.
export function usePushControl() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setState(await getPushState());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setEnabled = useCallback(
    async (enabled: boolean): Promise<EnableResult> => {
      setBusy(true);
      try {
        if (enabled) {
          return await enablePush();
        }
        await disablePush();
        return { ok: true };
      } finally {
        try {
          await refresh();
        } finally {
          setBusy(false);
        }
      }
    },
    [refresh],
  );

  return { state, busy, setEnabled };
}
