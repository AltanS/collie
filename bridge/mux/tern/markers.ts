// HOW A BEACON NAMES ONE OF THIS ADAPTER'S PANES — Tern's half of the join.

import type { BeaconMatcher } from "../../beacon/decorate.ts";
import type { MuxPane } from "../types.ts";
import { defaultTernSocket, type TernExec } from "./exec.ts";

export function ternBeaconMatcher(
  namespace: string,
  _exec: TernExec,
  configuredSocket?: string,
): BeaconMatcher {
  const socketPath = configuredSocket?.trim() || defaultTernSocket();
  return {
    namespace,
    async scope(): Promise<string | null> {
      return socketPath;
    },
    matches(pane: MuxPane, marker, scope): boolean {
      return marker.scope === scope && marker.pane === pane.paneId;
    },
    notesWithoutHooks: {
      agentDetection:
        "Tern does not track agent state directly. Install beacon hooks with `collie hooks install claude` so an agent names itself and its status.",
      agentSessionRef:
        "Pane history reads the agent's own session log. `collie hooks install claude` supplies the session reference; until then history is absent.",
    },
  };
}
