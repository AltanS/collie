import { useCallback, useEffect, useState } from "react";

import { getSent } from "@/lib/api";
import type { Scope } from "@/lib/scope";
import { suggestionLines, type SuggestionLine } from "@/lib/sent-suggest";

// THE LINES BEHIND THE SUGGESTION STRIP (M61 spec 02): one read of this pane's folder (100 lines) and
// one of its machine (200) when the pane opens, filtered on the phone per keystroke (lib/sent-suggest),
// and read again after each confirmed send. Held in this hook's memory and nowhere else: no
// localStorage, no IndexedDB, no offline copy. A bridge that is older than Sent, has Sent off or does
// not answer leaves the list empty, and an empty list draws no strip.

/** Lines asked of the pane's folder. */
export const FOLDER_READ = 100;
/** Lines asked of the pane's machine. */
export const MACHINE_READ = 200;

export interface UseSentSuggestions {
  lines: readonly SuggestionLine[];
  /** Read again, now: a send was confirmed and the bridge has a new line. */
  refresh: () => void;
}

export function useSentSuggestions({ enabled, scope, cwd }: { enabled: boolean; scope: Scope | undefined; cwd: string | undefined }): UseSentSuggestions {
  const [lines, setLines] = useState<readonly SuggestionLine[]>([]);
  const [nonce, setNonce] = useState(0);
  // The scope is read by value: the pane view re-creates the object on every render.
  const host = scope?.host;

  useEffect(() => {
    if (!enabled) {
      setLines([]);
      return;
    }
    const abort = new AbortController();
    async function read() {
      try {
        const where = host === undefined ? undefined : { host };
        const [folder, machine] = await Promise.all([
          cwd === undefined ? Promise.resolve(null) : getSent({ scope: "here", cwd, limit: FOLDER_READ }, where, abort.signal),
          getSent({ scope: "here", limit: MACHINE_READ }, where, abort.signal),
        ]);
        if (abort.signal.aborted) return;
        setLines(suggestionLines(folder?.entries ?? [], machine.entries));
      } catch {
        // No answer, an older bridge or Sent off: the strip has nothing to offer, and says nothing.
        if (!abort.signal.aborted) setLines([]);
      }
    }
    void read();
    return () => abort.abort();
  }, [enabled, host, cwd, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { lines, refresh };
}
