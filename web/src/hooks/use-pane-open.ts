import { useNav } from "@/hooks/use-nav";
import { glideForwardWhenReady } from "@/lib/glide";
import { paneScope } from "@/lib/hosts";
import { prefetchPaneData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import type { Scope } from "@/lib/scope";
import type { AgentView, ServerSummary, SessionSummary } from "@/lib/types";

/** How a list of pane rows opens one, and what it tells each row (agent-list.tsx, space-view.tsx). */
export interface PaneOpen {
  /** The row's glide key: the pane's own path, the same string the pane header spells. */
  glideKeyOf: (pane: AgentView) => string;
  /** The finger landed on a row: start the pane's read (lib/pane-prefetch.ts). */
  press: (pane: AgentView) => void;
  /** The tap: down to the pane, gliding from `row` when the read is in time (lib/glide.ts). */
  open: (pane: AgentView, row?: HTMLElement) => void;
}

/**
 * Opening a pane from the dashboard or a space, both the same way. A row is opened with the PANE's
 * host, never the ambient one: the dashboard is one list across every machine, so the row tapped
 * may live somewhere other than where the URL points (`paneScope`).
 *
 * The tap is a down move (ADR 0067) that glides the row's dot, tile and name into the pane header
 * (the `pane` pair). The pane route's loader awaits a read, so the row starts that read on
 * `pointerdown` and the tap waits for it at most `READY_WAIT_MS` before it glides; a read still out
 * then opens the pane the plain way, with the slide.
 */
export function usePaneOpen(
  scope: Scope,
  servers: readonly ServerSummary[] | undefined,
  sessions: readonly SessionSummary[] | undefined,
): PaneOpen {
  const nav = useNav();
  const scopeOf = (pane: AgentView) => paneScope(scope, pane, servers, sessions);
  const glideKeyOf = (pane: AgentView) => panePath(pane.paneId, scopeOf(pane));
  return {
    glideKeyOf,
    press: (pane) => void prefetchPaneData(pane.paneId, scopeOf(pane)),
    open: (pane, row) => {
      const to = glideKeyOf(pane);
      const ready = prefetchPaneData(pane.paneId, scopeOf(pane));
      glideForwardWhenReady("pane", to, ready, () => nav.down(to), row);
    },
  };
}
