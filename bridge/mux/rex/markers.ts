// HOW A BEACON NAMES ONE OF THIS ADAPTER'S PANES — Rex's half of the beacon join.
//
// Rex exports its own identity into every block (probed on rex 0.0.1795019727, MUX_CONTRACT.md **RX**):
//
//   REX_BLOCK    the block's full id, `block:01a1f14c-…`. The adapter carries it through unchanged as
//                the Collie pane id, so the pane half of the join is an equality.
//   REX_SERVER   the address of the server that owns the block, `unix:///run/user/1000/rex/server.sock`.
//
// Block ids are UUIDs, so a collision across servers is not the worry; the scope still keeps a
// beacon from another rex server (another user, a `-S` server) off this one's panes, as every
// matcher does. The adapter's own scope is the server's PRIMARY listener, asked of the server itself
// (`rex api call server.status`), which is the address `REX_SERVER` holds inside its blocks — so the
// two agree on every platform without this file guessing a socket path.
//
// Rex names a block's agent and status from the program's own OSC 7501 report, so this matcher lifts
// no agent: the adapter declares `agentDetection`, and `withAgentBeacons` joins in SESSION-ONLY mode,
// adding the agent's conversation id, which Rex does not know and History needs.

import type { BeaconMatcher } from "../../beacon/decorate.ts";
import type { MuxPane } from "../types.ts";
import type { RexExec } from "./exec.ts";
import { primaryListener } from "./protocol.ts";

/** A server address, compared without its `unix://` scheme: `REX_SERVER` carries one, a path may not. */
export function rexScopeKey(address: string): string {
  return address.trim().replace(/^unix:\/\//u, "");
}

export function rexBeaconMatcher(namespace: string, exec: RexExec): BeaconMatcher {
  let scope: string | null = null;
  return {
    namespace,
    async scope(): Promise<string | null> {
      // Asked once and kept: a server's primary listener does not move while it runs, and a failed
      // ask is asked again next time rather than remembered as "no scope".
      if (scope !== null) return scope;
      const res = await exec.run(["api", "call", "server.status"]);
      if (res.code !== 0) return null;
      const address = primaryListener(res.stdout);
      scope = address === null ? null : rexScopeKey(address);
      return scope;
    },
    matches(pane: Pick<MuxPane, "paneId">, marker, ownScope): boolean {
      return marker.pane === pane.paneId && rexScopeKey(marker.scope) === ownScope;
    },
    notesWithoutHooks: {
      agentDetection: "Rex names each block's agent from the program's own status report.",
      agentSessionRef:
        "Rex keeps an agent's status but not its conversation id. Install the hooks with `collie hooks install claude` and a pane running Claude names its session, which gives it History.",
    },
  };
}
