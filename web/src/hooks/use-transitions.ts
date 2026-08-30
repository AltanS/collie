import { useEffect, useRef } from "react";

import type { AgentStatus, AgentView } from "@/lib/types";
import { setStatus } from "@/lib/status";

// In-app lifecycle notifications. We diff each snapshot against the previous one and surface a
// header status line when an agent crosses into a state that wants attention.
//
// Nothing the operator did produced these — they are a poll noticing that a machine somewhere
// finished a job, and they are the case the Collie mark's orbit round earns its keep on: the eye is
// not on the header, so something has to fetch it. A whole herd finishing at once arrives as a burst
// of these, and the mark turns ONCE for the burst (components/collie-home.tsx drops a status that
// lands mid-round), which is the right reading — the world moved, not five times. Background/OS
// notifications are handled separately by the server via Web Push; this is the foreground equivalent.
//
// The first snapshot never fires (prev is null), so opening the app doesn't spam the status line
// for agents that were already blocked — matching the server's transition semantics.
export function useAgentTransitions(agents: AgentView[], openPaneId: string | null) {
  const prev = useRef<Map<string, AgentStatus> | null>(null);

  useEffect(() => {
    const now = new Map(agents.map((a) => [a.paneId, a.status]));
    const before = prev.current;
    if (before) {
      for (const a of agents) {
        const was = before.get(a.paneId);
        if (!was || was === a.status) continue;
        if (a.paneId === openPaneId) continue; // you're already looking at it
        if (a.status === "blocked") {
          setStatus(`${a.agent} needs you · ${a.workspaceLabel}`, "warn");
        } else if (a.status === "done") {
          setStatus(`${a.agent} is done · ${a.workspaceLabel}`, "success");
        }
      }
    }
    prev.current = now;
  }, [agents, openPaneId]);
}
