// HOW A BEACON NAMES ONE OF THIS ADAPTER'S PANES (M74 spec 04), herdr-core's half of the beacon join.
//
// The core exports two variables into every terminal it runs (probed 2026-10-29, hc 0.1.14, in a
// private core session; HC_API.md § The terminal's own environment):
//
//   HC_TERMINAL_ID      the terminal's address on its core: `t1`. The adapter carries the address
//                       through unchanged as the Collie pane id, so the pane half is an equality.
//   HC_TERMINAL_SOCKET  the client socket of the core that owns the terminal. It stays the core's own
//                       path when the operator set `HC_SOCKET` to another one.
//
// Addresses restart at `t1` in every core session, so the pane alone is not an identity: the scope is
// the socket, and the join keeps a terminal of another session off this one's panes. The two paths are
// compared after `realpath` (Fedora Atomic spells `/home` as `/var/home`).
//
// herdr-core names the agent and its status from the program's own report (or, with none, from the
// foreground process name, see layout.ts), so this matcher lifts no agent. What a hook adds is the agent's session id, the key History and Chat read a journal by, which
// the core cannot know. `withAgentBeacons` joins it in session-only mode (bridge/beacon/decorate.ts).

import type { BeaconMatcher } from "../../beacon/decorate.ts";
import type { MuxPane } from "../types.ts";
import { socketKey } from "../herdr/markers.ts";

/**
 * herdr-core's beacon matcher. `namespace` is the adapter's registry key, which the emitter writes
 * into every marker (`cli/beacon.ts` MUX_ENV_MARKERS). `endpoint` is the socket this adapter dials.
 */
export function herdrCoreBeaconMatcher(namespace: string, endpoint: string): BeaconMatcher {
  const keys = new Map<string, string>();
  const keyOf = (path: string): string => {
    let key = keys.get(path);
    if (key === undefined) {
      // A marker's scope comes from a file anyone with the state dir can write, so the memo is bounded.
      if (keys.size >= 64) keys.clear();
      key = socketKey(path);
      keys.set(path, key);
    }
    return key;
  };
  return {
    namespace,
    scope(): Promise<string | null> {
      const trimmed = endpoint.trim();
      return Promise.resolve(trimmed === "" ? null : keyOf(trimmed));
    },
    matches(pane: Pick<MuxPane, "paneId">, marker, scope): boolean {
      return marker.pane === pane.paneId && keyOf(marker.scope) === scope;
    },
    notesWithoutHooks: {
      agentDetection: "herdr-core names each terminal's agent on its own.",
      agentSessionRef:
        "herdr-core keeps an agent's status but not its conversation id. Install the hooks with `collie hooks install claude` and a pane running Claude names its session, which gives it History.",
    },
  };
}
