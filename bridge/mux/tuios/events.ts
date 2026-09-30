// Which tuios events Collie subscribes to, and which half of the contract's watch each one is.
//
// tuios vocabulary, so it lives on this side of the seam, exactly as Herdr's list does. The table is
// tuios's docs/protocol.md § Event stream; every type below was seen on a live stream on 2026-10-01.
//
// An event is a POKE to re-read and never state: this decides which callback fires and reads one
// field, the window id, to do it.

import { TUIOS_REQUIRED_EVENT } from "./client.ts";

/**
 * Events that change the herd's shape: a window or session appearing, closing, moving or being
 * renamed, a workspace being renamed, and the focus moving. `gap` is here too: it says events were
 * lost, so everything is re-read.
 */
const TOPOLOGY_EVENTS: readonly string[] = [
  "window-created",
  "window-closed",
  "window-exit",
  "window-retitled",
  "window-focused",
  "window-moved",
  "window-minimized",
  "window-restored",
  "workspace-switched",
  TUIOS_REQUIRED_EVENT,
  "session-created",
  "session-closed",
  "gap",
];

/**
 * Events about one pane's content or status. `agent-state` is the one that drives triage; `output`
 * is the screen changing, subscribed only while some pane is watched, because it fires on every read
 * of every pane's terminal.
 */
const PANE_EVENTS: readonly string[] = ["agent-state", "attention", "bell", "notification", "output"];

/** The `types` filter for one subscription. `output` joins only when a pane is being watched. */
export function subscriptionTypes(watchedPanes: readonly string[]): string[] {
  const pane = watchedPanes.length > 0 ? PANE_EVENTS : PANE_EVENTS.filter((type) => type !== "output");
  return [...TOPOLOGY_EVENTS, ...pane];
}

/** Which callback one event fires. */
export type EventRoute =
  | { readonly kind: "topology" }
  | { readonly kind: "pane"; readonly paneId: string }
  | { readonly kind: "none" };

/**
 * Route one event.
 *
 * A pane event about a pane nobody is watching is a TOPOLOGY change, on purpose: an `agent-state`
 * for an unwatched pane can mean an agent just appeared, which changes the snapshot's split into
 * agents and shells. Re-reading more is the conservative side.
 */
export function routeEvent(type: string, window: string, watched: ReadonlySet<string>): EventRoute {
  if (TOPOLOGY_EVENTS.includes(type)) return { kind: "topology" };
  if (!PANE_EVENTS.includes(type)) return { kind: "none" };
  if (window !== "" && watched.has(window)) return { kind: "pane", paneId: window };
  // Output from a pane nobody watches changes nothing Collie shows.
  if (type === "output") return { kind: "none" };
  return { kind: "topology" };
}
