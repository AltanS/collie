import { useEffect, useState } from "react";

import { fetchLaunchers } from "@/lib/api";
import type { Scope } from "@/lib/scope";
import type { HarnessInfo, Launcher } from "@/lib/types";

// THIS scope's own launcher rows — deliberately NOT part of lib/operator-config.ts's one-shot
// `/api/config` cache. Rows must come from the host that RUNS them: a crew peer keeps its own
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
  /**
   * The agents that host starts by id (ADR 0091). `null` until an answer arrived, and for good from a
   * bridge older than 1.19.0, which sends none: tell the two apart with {@link loadedFor}.
   */
  harnesses: readonly HarnessInfo[] | null;
  /**
   * The `host\u0000session` of the scope the answer above belongs to, `null` before the first one. A
   * view that switches machines keeps the last machine's rows until the new answer lands, so a
   * caller that must not show one machine's agents under another's name compares this first.
   */
  loadedFor: string | null;
}

const EMPTY: LaunchersState = { launchers: [], home: "", harnesses: null, loadedFor: null };

/** The key {@link LaunchersState.loadedFor} is written with. */
export function launchersKey(scope: Scope | undefined): string {
  return `${scope?.host ?? ""}\u0000${scope?.session ?? ""}`;
}

/**
 * Reactive read of one scope's launcher rows. The dashboard calls this with the ambient scope (no
 * `?h=`); the switcher sheet in agent-chat.tsx calls it with the current pane's scope, which is
 * already ambient there.
 */
export function useLaunchers(scope?: Scope, enabled = true): LaunchersState {
  const host = scope?.host;
  const session = scope?.session;
  const [state, setState] = useState<LaunchersState>(EMPTY);

  // `enabled` false reads nothing, for a caller that does not want the answer yet.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchLaunchers(host === undefined && session === undefined ? undefined : { host, session });
        if (!cancelled) {
          setState({
            launchers: res.launchers,
            home: res.home,
            harnesses: res.harnesses ?? null,
            loadedFor: launchersKey({ host, session }),
          });
        }
      } catch {
        // See the header: leave the previous rows in place and let the next mount retry.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, session, enabled]);

  return state;
}
