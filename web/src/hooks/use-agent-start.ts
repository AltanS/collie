import { useEffect, useRef, useState } from "react";

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
  const [started, setStarted] = useState<string | null>(null);
  // What this pane was, last time we looked: "shell", "agent", or null for "never seen".
  const was = useRef<{ paneId: string; kind: "shell" | "agent" } | null>(null);

  useEffect(() => {
    // The pane is not in the snapshot: say nothing and remember nothing. A missing reading is not
    // evidence that the pane changed, and treating it as one would fire on every reconnect.
    if (harness === undefined) return;
    const kind = isShell ? "shell" : "agent";
    const prev = was.current;
    was.current = { paneId, kind };
    if (prev === null || prev.paneId !== paneId) return; // baseline, or a different pane
    if (prev.kind === "shell" && kind === "agent") setStarted(harness);
  }, [paneId, harness, isShell]);

  // A pane switch inside one mount clears anything still on screen: the announcement belongs to the
  // pane that made it, and carrying it across would put another pane's name over this one's mirror.
  useEffect(() => {
    setStarted(null);
  }, [paneId]);

  return { started, clear: () => setStarted(null) };
}
