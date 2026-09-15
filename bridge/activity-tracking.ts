import type { ActivityLedger } from "./activity.ts";
import type { StateEngine } from "./state-engine.ts";
import type { AgentStatus } from "./types.ts";

/**
 * Does this status change mean the pane did new work?
 *
 * A pane that settles into `idle` only counts when a turn actually ended, so the change must come
 * from `working` or `blocked`. Herdr 0.9's TUI flips a pane from `done` to `idle` when the operator
 * acknowledges it there, and detection flicker gives `unknown → idle`. Neither is new work, and
 * both would put a pane Collie already showed as seen back under "Ready · unseen".
 *
 * Every other change still counts. A Working row counts its "since" from `lastActiveAt`, so going
 * into `working`, `blocked`, `done` or `unknown` must keep bumping the clock.
 */
export function isNewWork(from: AgentStatus, to: AgentStatus): boolean {
  if (to !== "idle") return true;
  return from === "working" || from === "blocked";
}

/** Bind a session's activity to observed agent lifecycles, not just terminal lifetimes. */
export function trackActivity(engine: StateEngine, activity: ActivityLedger, session: string): void {
  engine.onTransition((agent, from, to) => {
    if (isNewWork(from, to)) activity.noteActive(session, agent.paneId);
  });
  // onRemove also fires when an agent exits to a still-live shell. Forget its unread history before
  // onUpdate seeds the shell as seen, so a new idle agent cannot inherit the old agent's work.
  engine.onRemove((paneId) => activity.forget(session, paneId));
  engine.onUpdate((snapshot) =>
    activity.reconcile(session, [...snapshot.agents, ...snapshot.shellPanes].map((p) => p.paneId)),
  );
}
