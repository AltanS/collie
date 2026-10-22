import { useEffect, useMemo, useRef, useState } from "react";
import { firstLaunchScreen, type AgentLaunch } from "@/lib/agent-startup";
import type { Surface } from "@/lib/surface/surface";

interface StartupLatch {
  paneKey: string;
  launch: AgentLaunch | undefined;
  phase: "waiting" | "dialog" | "ready";
  observedAgent: boolean;
}

/** One startup latch per full pane address. Clearing the nav marker does not re-arm it. */
export function useStartupReadiness(input: {
  paneKey: string;
  launch?: AgentLaunch;
  text: string;
  surface?: Surface;
  agent?: string;
  marked?: boolean;
  live: boolean;
  stale: boolean;
  onReady?: () => void;
}) {
  const { paneKey, launch, text, surface, agent, marked, live, stale, onReady } = input;
  const [held, setHeld] = useState<StartupLatch>(() => ({ paneKey, launch, phase: "waiting", observedAgent: false }));
  let current = held;
  if (held.paneKey !== paneKey || (launch !== undefined && launch.id !== held.launch?.id)) {
    current = { paneKey, launch, phase: "waiting", observedAgent: false };
    setHeld(current);
  }
  const known = current.launch?.paneKey === paneKey ? current.launch : undefined;
  const probing = current.phase !== "ready";
  const screen = useMemo(
    () => {
      if (!probing || known === undefined) return null;
      const found = firstLaunchScreen({ harness: known.harness, text, surface, live, stale });
      // A normal-looking box must not open a blind shell send while agent discovery is still behind.
      return found === "composer" && (agent !== known.harness || marked !== true) ? null : found;
    },
    [probing, known, text, surface, agent, marked, live, stale],
  );
  if (known !== undefined && live && !stale && agent === known.harness && !current.observedAgent) {
    current = { ...current, observedAgent: true };
    setHeld(current);
  }
  // A launched agent returning to its shell has ended, not remained in startup forever. No draft
  // is sent here; the pane's actual owner and its normal Surface resume control.
  const exited = known !== undefined && current.observedAgent && agent !== undefined && agent !== known.harness && live && !stale;
  // The first composer is sticky. A later unknown panel must keep the ordinary manual Send.
  if (exited && current.phase !== "ready") {
    current = { ...current, phase: "ready" };
    setHeld(current);
  } else if (known !== undefined && current.phase === "waiting" && screen !== null) {
    current = { ...current, phase: screen === "dialog" ? "dialog" : "ready" };
    setHeld(current);
  } else if (current.phase === "dialog" && screen === "composer") {
    current = { ...current, phase: "ready" };
    setHeld(current);
  }
  const recognized = known !== undefined && current.phase === "ready";
  const notified = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!recognized || launch?.id !== known?.id || onReady === undefined || notified.current === known?.id) return;
    notified.current = known?.id;
    onReady();
  }, [recognized, launch?.id, known?.id, onReady]);
  return {
    harness: known?.harness,
    starting: known !== undefined && (current.phase === "waiting" || (current.phase === "dialog" && screen === null)),
    initialDialog: known !== undefined && current.phase === "dialog" && screen === "dialog",
  };
}
