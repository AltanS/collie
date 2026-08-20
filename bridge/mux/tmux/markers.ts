// HOW A BEACON NAMES ONE OF THIS ADAPTER'S PANES (M11/03) — tmux's half of the join.
//
// It lives beside the adapter because it is knowledge about TMUX's environment, and the decorator
// (bridge/beacon/decorate.ts) only knows how to ask. Two facts, both probed 2026-08-20 inside a real
// tmux pane:
//
//   • `$TMUX_PANE` is `%1` — IDENTICAL to the Collie pane id, because this adapter carries tmux's own
//     `%N` through unchanged (adapter.ts § the mapping). So the pane half of the join is an equality
//     and nothing more; there is no prefix to add here, unlike zellij's.
//   • `$TMUX` is `/tmp/tmux-1000/m11probe,932254,0`, whose FIRST field is the server socket path.
//     `cli/beacon.ts` stores exactly that first field as `BeaconMarker.scope`, and this module must
//     compare against the same string or every beacon reads as somebody else's.
//
// ── THE SCOPE CHECK IS LOAD-BEARING, NOT DEFENSIVE ────────────────────────────────────────────────
//
// tmux pane ids are per-SERVER. `%7` on a second tmux server on the same host is a different pane
// with the same name, so without the scope check a beacon from the operator's other server would
// hand this pane somebody else's agent, session and status. Two tmux servers on one host is ordinary
// (`-L` is one flag), so this is a case that happens rather than one that is imagined.
//
// ── WHERE THE SOCKET PATH COMES FROM ──────────────────────────────────────────────────────────────
//
// tmux is asked, rather than the value being re-derived from the configured endpoint. Collie's
// endpoint is a socket NAME, a socket PATH or empty (exec.ts `tmuxServerArgs`), and turning a name
// into the path tmux actually opened means reimplementing tmux's own rule for the socket directory
// (`$TMUX_TMPDIR`, `/tmp/tmux-<uid>`, the default name) — a re-derivation that would be wrong on
// exactly the systems that configure it. `display-message -p -F '#{socket_path}'` is the server's own
// answer and was probed to equal `$TMUX`'s first field byte for byte.

import type { BeaconMatcher } from "../../beacon/decorate.ts";
import type { MuxPane } from "../types.ts";
import type { TmuxExec } from "./exec.ts";

/** Ask the server where its own socket is. One cheap command; the answer never changes while it lives. */
export const TMUX_SOCKET_PATH_ARGS: readonly string[] = ["display-message", "-p", "-F", "#{socket_path}"];

/**
 * tmux's beacon matcher.
 *
 * `namespace` is handed in rather than imported from `adapter.ts`, so this module does not import
 * back into the module that imports it. It IS the adapter's registry key and nothing else — the
 * emitter writes that same key into every marker it records (`cli/beacon.ts` MUX_ENV_MARKERS).
 */
export function tmuxBeaconMatcher(namespace: string, exec: TmuxExec): BeaconMatcher {
  // Cached because it cannot change under a running server, and a snapshot poll would otherwise pay
  // one extra spawn per tick. A server that restarts on a different socket is a different endpoint,
  // which this process is not reconfigured for anyway.
  let socketPath: string | null = null;
  return {
    namespace,
    async scope(): Promise<string | null> {
      if (socketPath !== null) return socketPath;
      try {
        const result = await exec.run([...TMUX_SOCKET_PATH_ARGS]);
        const answered = result.stdout.trim();
        // No server, no binary, no answer: the honest scope is "unknown", and the decorator joins
        // nothing at all rather than joining on the pane id alone.
        if (result.code !== 0 || answered.length === 0) return null;
        socketPath = answered;
        return socketPath;
      } catch {
        return null;
      }
    },
    matches(pane: MuxPane, marker, scope): boolean {
      return marker.scope === scope && marker.pane === pane.paneId;
    },
    notesWithoutHooks: {
      agentDetection:
        "tmux does not know what an agent is, so Collie asks the agent instead: install the beacon hooks with `collie hooks install claude` and a pane running Claude names itself and its status. Until then every pane reads as a shell rather than as a guess that would pick the wrong grammar.",
      agentSessionRef:
        "Pane history reads the agent's own session log, and tmux supplies no reference to one. `collie hooks install claude` lets the agent supply it; until then history is absent here, not empty.",
    },
  };
}
