import { useCallback, useState } from "react";

/** What {@link useAgentStart} hands back: the harness that just started, and the way to stop saying so. */
export interface AgentStartEdge {
  /** The harness whose session just began in this pane, or null when nothing is being announced. */
  started: string | null;
  /** Call when the announcement is over. */
  clear: () => void;
}

/**
 * The moment a bare shell pane becomes an agent pane.
 *
 * A person types `opencode` at their desk. On the next poll the snapshot reports that pane's kind as
 * "agent" where it reported "shell" before. This hook is that edge, and nothing else.
 *
 * ── IT IS AN OBSERVED TRANSITION, NEVER A STATE ──────────────────────────────
 * The first reading of a pane is a BASELINE and never fires. Opening a pane that has been running
 * Claude for an hour must not announce that Claude started, and it is the same reading either way:
 * "this pane has an agent". Only a pane this hook watched turn over announces anything.
 *
 * An unknown pane (not in the snapshot yet, so `isShell` cannot be answered) is not a baseline
 * either. It is skipped, so a pane that first appears already running its agent stays quiet, and a
 * freshly created shell still gets its baseline on the poll that finds it.
 *
 * @param paneId the pane being watched. Changing it resets the baseline.
 * @param harness the agent's name, or undefined while the pane is unknown.
 * @param isShell whether the snapshot calls this pane a bare shell.
 * @returns the harness that just started, or null. Call `clear` when the announcement is over.
 */
export function useAgentStart(
  paneId: string,
  harness: string | undefined,
  isShell: boolean,
): AgentStartEdge {
  // What this pane was, last time we looked: "shell", "agent", or null for "never seen".
  const [was, setWas] = useState<{ paneId: string; kind: "shell" | "agent" } | null>(null);
  const [started, setStarted] = useState<{ paneId: string; harness: string } | null>(null);

  // TAKEN IN THE RENDER THAT SEES IT (the adjust-state-in-render pattern, 1.17.0). The handover
  // (hooks/use-handover.ts) holds the body from the first frame of the edge, and an edge found one
  // effect later left one frame where the new agent's body could be drawn with no cover over it.
  let edge = started;
  // The pane is not in the snapshot: say nothing and remember nothing. A missing reading is not
  // evidence that the pane changed, and treating it as one would fire on every reconnect.
  if (harness !== undefined) {
    const kind = isShell ? "shell" : "agent";
    if (was === null || was.paneId !== paneId || was.kind !== kind) {
      setWas({ paneId, kind });
      // Baseline, or a different pane: nothing to announce. Only a shell this view watched turn into
      // an agent is an edge.
      if (was !== null && was.paneId === paneId && was.kind === "shell" && kind === "agent") {
        edge = { paneId, harness };
        setStarted(edge);
      }
    }
  }
  // A pane switch inside one mount drops anything still on screen: the announcement belongs to the
  // pane that made it, and carrying it across would put another pane's name over this one's mirror.
  if (edge !== null && edge.paneId !== paneId) {
    edge = null;
    setStarted(null);
  }

  // Stable: the handover hook's timers hang on it (hooks/use-handover.ts).
  const clear = useCallback(() => setStarted(null), []);
  return { started: edge?.harness ?? null, clear };
}
