import type { ActivityLedger } from "./activity.ts";
import type { StateEngine } from "./state-engine.ts";

/** Bind a session's activity to observed agent lifecycles, not just terminal lifetimes. */
export function trackActivity(engine: StateEngine, activity: ActivityLedger, session: string): void {
  engine.onTransition((agent) => activity.noteActive(session, agent.paneId));
  // onRemove also fires when an agent exits to a still-live shell. Forget its unread history before
  // onUpdate seeds the shell as seen, so a new idle agent cannot inherit the old agent's work.
  engine.onRemove((paneId) => activity.forget(session, paneId));
  engine.onUpdate((snapshot) =>
    activity.reconcile(session, [...snapshot.agents, ...snapshot.shellPanes].map((p) => p.paneId)),
  );
}
