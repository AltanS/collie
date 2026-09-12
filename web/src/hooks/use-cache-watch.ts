import { useCallback, useEffect, useState } from "react";

import { getCacheWatch, setCacheWatch } from "@/lib/api";
import { mutate } from "@/lib/mutate";
import type { Scope } from "@/lib/scope";
import type { CacheWatchState } from "@/lib/types";

// One pane's cache warning, for the pane settings sheet. `use-notify-prefs.ts`'s posture, one dimension
// narrower: read once when the sheet opens, toggle optimistically, and revert LOUDLY on failure.
//
// THE REVERT MUST SPEAK, for the reason stated at `use-notify-prefs.ts`'s own toggle: a switch that
// moves twice with no cause the operator can see leaves them carrying away the state they saw first,
// which is the one that did not happen. `lib/mutate` publishes the sentence; this hook only flips back.
//
// It reads on OPEN rather than on mount, because the answer moves: the global switch may have been
// turned on from Settings since, and `warnSeconds` is the bridge's number rather than this build's.
export function useCacheWatch(paneId: string | undefined, open: boolean, scope?: Scope) {
  const [state, setState] = useState<CacheWatchState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || paneId === undefined) return;
    let alive = true;
    setState(null);
    getCacheWatch(paneId, scope)
      .then((s) => alive && setState(s))
      .catch(() => {
        /* no reading: the sheet renders its switch disabled, which is the honest shape */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, paneId, scope?.host, scope?.session]);

  const toggle = useCallback(
    async (next: boolean) => {
      if (paneId === undefined) return;
      setState((prev) => (prev ? { ...prev, on: next } : prev)); // optimistic
      setBusy(true);
      const res = await mutate(() => setCacheWatch(paneId, next, scope));
      if (res.ok) setState(res.value); // reconcile: the bridge's merged view is the last word
      else setState((prev) => (prev ? { ...prev, on: !next } : prev)); // revert, and `mutate` said why
      setBusy(false);
    },
    [paneId, scope],
  );

  return { state, busy, toggle };
}
