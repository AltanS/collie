import { useEffect, useRef, useState } from "react";
import { firstScreenRead, STARTUP_GATE_MS, type AgentLaunch } from "@/lib/agent-startup";
import type { Surface } from "@/lib/surface/surface";

interface Latch {
  readonly id: string;
  readonly at: number;
  /** The multiplexer named the launched harness on this pane at least once. */
  observed: boolean;
  done: boolean;
}

/**
 * Whether Send stays gated for a launch the phone started: from the launch until the bridge's Surface
 * reads the agent's first screen ({@link firstScreenRead}), the agent leaves the pane, or
 * {@link STARTUP_GATE_MS} runs out. The gate opens once per launch and never closes again: a later
 * unknown screen keeps the composer's ordinary rules. `onReady` retires the launch intent; it sends
 * nothing.
 */
export function useStartupReadiness(input: {
  launch?: AgentLaunch;
  agent?: string;
  surface?: Surface;
  live: boolean;
  onReady?: () => void;
}) {
  const { launch, agent, surface, live, onReady } = input;
  const latch = useRef<Latch | null>(null);
  if (launch === undefined) latch.current = null;
  else if (latch.current?.id !== launch.id) latch.current = { id: launch.id, at: Date.now(), observed: false, done: false };
  const current = latch.current;
  if (current !== null && launch !== undefined && !current.done && live) {
    if (agent === launch.harness) current.observed = true;
    // An agent seen on the pane that is no longer named has left it: nothing is starting there any more.
    // A pane that fell back to a plain shell names no agent at all, so `undefined` counts as gone too.
    const exited = current.observed && agent !== launch.harness;
    if (exited || firstScreenRead(launch.harness, agent, surface)) current.done = true;
  }
  // The bound needs a render of its own: a pane whose screen stopped moving may not poll again soon.
  const [, expire] = useState(0);
  const pendingSince = current !== null && !current.done ? current.at : null;
  useEffect(() => {
    if (pendingSince === null) return;
    const timer = setTimeout(() => expire((n) => n + 1), Math.max(0, pendingSince + STARTUP_GATE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [pendingSince]);
  if (current !== null && !current.done && Date.now() - current.at >= STARTUP_GATE_MS) current.done = true;
  const doneId = current?.done === true ? current.id : null;
  const notified = useRef<string | null>(null);
  useEffect(() => {
    if (doneId === null || notified.current === doneId) return;
    notified.current = doneId;
    onReady?.();
  }, [doneId, onReady]);
  return { starting: current !== null && !current.done };
}
