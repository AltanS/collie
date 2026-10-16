// HOW AN EDGE NAMES ONE OF THIS ADAPTER'S PANES (M56 spec 11), Herdr's half of the beacon join.
//
// Herdr exports its pane identity into every pane it runs: `HERDR_PANE_ID` (`w54:pW`) and
// `HERDR_SOCKET_PATH`, the socket of the Herdr server that owns the pane (probed 2026-10-16, Herdr
// 0.9.4). The pane id is the Herdr wire id, which this adapter carries through unchanged as the
// Collie pane id, so the pane half of the join is an equality.
//
// The scope is the socket path. Herdr pane ids are per server, so the scope check keeps an edge from
// a second Herdr server on the same host off this one's panes. The two paths are compared after
// `realpath`: on a host where `/home` is a link (`/var/home` on Fedora Atomic), the pane's variable
// and the bridge's configured socket can name one file in two spellings.
//
// Herdr reports the agent and its session on its own wire, so this matcher never lifts a capability.
// The decorator does not wrap a seeing adapter; the matcher serves the hook edges alone.

import { realpathSync } from "node:fs";

import type { BeaconMatcher } from "../../beacon/decorate.ts";
import type { MuxPane } from "../types.ts";

/** A socket path in one spelling: its real path, or the path itself when it cannot be resolved. */
export function socketKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Herdr's beacon matcher. `namespace` is the adapter's registry key, which the emitter writes into
 * every marker (`cli/beacon.ts` MUX_ENV_MARKERS). `endpoint` is the socket this adapter dials.
 */
export function herdrBeaconMatcher(namespace: string, endpoint: string): BeaconMatcher {
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
    // Never shown: Herdr declares both capabilities from its own wire, so nothing is lifted or lowered.
    notesWithoutHooks: {
      agentDetection: "Herdr names each pane's agent on its own.",
      agentSessionRef: "Herdr names each pane's agent session on its own.",
    },
  };
}
