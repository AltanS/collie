import { useEffect, useState } from "react";

import { fetchLaunchers } from "@/lib/api";
import type { Scope } from "@/lib/scope";
import type { Launcher } from "@/lib/types";

// THIS scope's own launcher rows — deliberately NOT part of lib/operator-config.ts's one-shot
// `/api/config` cache. Rows must come from the host that RUNS them: a pack peer keeps its own
// `launchers.toml`, and the lead's single startup fetch can only ever answer for itself. So this
// reads `GET /api/launchers` (session-scoped, forwarded on `?host=` — server.ts) fresh on every
// mount and whenever `scope` changes, rather than once per page load — the file is read live on the
// bridge behind an mtime check, so a fresh look is what "live" is supposed to buy the operator.
//
// A FAILED FETCH IS NOT AN ERROR STATE, on the same terms lib/operator-config.ts's read is: this
// leaves the rows exactly as they were (empty on a first failed mount) and any later mount — the
// switcher sheet reopened, the dashboard revisited — tries again.

export interface LaunchersState {
  launchers: readonly Launcher[];
  home: string;
}

const EMPTY: LaunchersState = { launchers: [], home: "" };

/**
 * Reactive read of one scope's launcher rows. The dashboard calls this with the ambient scope (no
 * `?h=`); the switcher sheet in agent-chat.tsx calls it with the current pane's scope, which is
 * already ambient there.
 */
export function useLaunchers(scope?: Scope): LaunchersState {
  const host = scope?.host;
  const session = scope?.session;
  const [state, setState] = useState<LaunchersState>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchLaunchers(host === undefined && session === undefined ? undefined : { host, session });
        if (!cancelled) setState({ launchers: res.launchers, home: res.home });
      } catch {
        // See the header: leave the previous rows in place and let the next mount retry.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, session]);

  return state;
}
