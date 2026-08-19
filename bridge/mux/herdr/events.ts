// Which Herdr events Collie subscribes to, and which half of the contract's watch each one is.
//
// Lifted verbatim out of `bridge/event-poker.ts` when Herdr moved behind the port: the poker owns
// the stream LIFECYCLE (debounce, backoff, health) in Collie's words, and the subscription list is
// Herdr vocabulary, so it belongs on this side of the seam. Nothing about the set changed.

import { eventPaneId, type EventData } from "../../wire.ts";

/** A subscription request entry: global (just `type`) or pane-scoped (needs `pane_id`). */
export type Subscription = { type: string; pane_id?: string };

// Global events that change what Collie's snapshot renders. We deliberately DROP layout.*,
// worktree.*, pane.scroll_changed and pane.output_matched — none of them alter the herd view we
// poll for, so subscribing would only add pokes that re-fetch identical state. Also NO
// workspace.moved / tab.moved: they're new in herdr 0.7.2, and one unknown subscription type
// rejects the whole subscribe — which would keep the stream permanently down on exactly the older
// servers the session.snapshot fallback supports. Moves are rare and the safety-net poll covers
// them within one COLLIE_POLL_IDLE_MS.
const GLOBAL_SUBSCRIPTIONS: readonly string[] = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.closed",
  "workspace.focused",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "pane.created",
  "pane.closed",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
];

/**
 * The full subscription list for the current set of agent panes: every global above, plus one
 * pane-scoped `pane.agent_status_changed` per agent pane (the status flips that drive triage).
 */
export function buildSubscriptions(agentPaneIds: readonly string[]): Subscription[] {
  const subs: Subscription[] = GLOBAL_SUBSCRIPTIONS.map((type) => ({ type }));
  for (const id of agentPaneIds) subs.push({ type: "pane.agent_status_changed", pane_id: id });
  return subs;
}

/**
 * The pane an event is about, or null when it is about the herd's structure.
 *
 * Subscriptions are dotted (`pane.created`); the stream spells the same event snake_case
 * (`pane_created`) — HERDR_API.md. The data payload is read for ONE field and no further: Collie
 * treats an event as a poke to re-read and never as state, so this decides which of the contract's
 * two callbacks fires and nothing else. An event that names no pane is a topology change, which is
 * the conservative side of the split — the caller re-reads more, never less.
 */
export function changedPaneId(event: string, data: EventData): string | null {
  return event.startsWith("pane_") ? eventPaneId(data) : null;
}
