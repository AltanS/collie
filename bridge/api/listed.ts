// THE PANES THE LOCAL API NAMES (security read 2, item 4). ONE predicate decides which panes of this
// bridge the API ever names by a session id: `sessions` lists them (reads.ts), and the bus source
// (bridge/events/sources.ts) publishes `session.status`, `turn.end` and `ask.open` for them alone, so
// `events` and a trick's `on` never carry an id `sessions` would not list. bridge/index.ts hands this very
// function to both; the bus may not import bridge/api/ (events/seam.test.ts), so it gets it injected.
//
// An allow-list: a pane of kind `agent`, or of no kind (older panes report none, and `types.ts` reads that
// as an agent). A bare shell (`shell`), a trick's own session (`trick`) and any kind added later are left
// out. The pane must also hold an instance token to be named; each consumer checks that beside this (a
// peek, never a mint), since the token is looked up by the multiplexer session.

/** What the predicate reads of a pane. */
export interface PaneKind {
  readonly kind?: string;
}

/** Whether the local API names this pane: an agent pane, never a shell and never a trick session. */
export function apiListedPane(pane: PaneKind): boolean {
  return pane.kind === undefined || pane.kind === "agent";
}
