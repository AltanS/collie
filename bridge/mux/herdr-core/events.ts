import { isLocalAddress } from "./layout.ts";

// Which callback one line of `events.subscribe` fires (HC_API.md § events.subscribe).

/**
 * Events that change the herd's shape or its names: a terminal appearing, ending, being removed or
 * coming back, its labels (which say which space and tab it is in), and a document (herdr-app's
 * layout, which names the spaces and tabs). `missed` is here too: events were lost, so everything
 * is read again.
 */
const TOPOLOGY_EVENTS: ReadonlySet<string> = new Set(["created", "removed", "finished", "lost", "restarted", "labels", "doc", "missed"]);

/**
 * Events about one terminal's own state: its status (the agent's word), its turn, its title and
 * what runs in its foreground. The core announces no screen output, so a pane's text changing on
 * its own is never pushed; the bridge reads it on its own schedule.
 */
const PANE_EVENTS: ReadonlySet<string> = new Set(["status", "turn", "title", "foreground"]);

export type EventRoute =
  | { readonly kind: "topology" }
  | { readonly kind: "pane"; readonly paneId: string }
  | { readonly kind: "none" };

/**
 * Route one event.
 *
 * An event about a terminal on another machine (`box/t7`) is nobody's here (ADR 0036). A pane event
 * about a pane nobody is watching is a TOPOLOGY change, on purpose: a `status` there can mean an
 * agent just appeared, which changes the snapshot's split into agents and shells. `keep` and `size`
 * change nothing Collie shows.
 */
export function routeEvent(type: string, terminal: string, watched: ReadonlySet<string>): EventRoute {
  if (terminal !== "" && !isLocalAddress(terminal)) return { kind: "none" };
  if (TOPOLOGY_EVENTS.has(type)) return { kind: "topology" };
  if (!PANE_EVENTS.has(type)) return { kind: "none" };
  if (watched.has(terminal)) return { kind: "pane", paneId: terminal };
  return { kind: "topology" };
}
