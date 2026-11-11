// What a session's pane runs now, as one opaque word, for Morph's rules proof (bridge/morph/service.ts).
// A proof holds while the mark is the one its `morph start` saw: another harness in the pane, another
// conversation of the same harness, or the pane gone, ends it.
//
// Read from what the bridge already holds per pane, with no harness named here: the snapshot's `agent`
// (the harness the detection settled on) and its `agentSession` (the conversation the harness itself
// reported through its integration, Herdr's `agent_session`). A harness that reports no conversation
// marks by its harness alone; for it, a harness change and `morph off`/`clear` are the resets. Nothing
// here is read from the pane's screen or a log, and nothing leaves the bridge: the mark is compared in
// memory and never served.

import { realAgentPanes } from "../tricks/panes.ts";
import { isSelf, parseAddress } from "../walky/address.ts";

/** A pane as the snapshot holds it, as far as the mark reads it. */
export interface MarkablePane {
  readonly paneId: string;
  readonly agent: string;
  readonly kind?: "agent" | "shell" | "trick";
  readonly agentSession?: { readonly kind: string; readonly value: string };
}

/**
 * The mark of the live pane a walky address names now, or null: an address the probe does not place (the
 * instance token must still match, through `place`), a pane on another crew member, a pane id that no
 * view or more than one holds, or a pane that is no agent now.
 */
export function morphPaneMark(opts: {
  readonly place: (address: string) => { readonly address: string } | null;
  readonly views: () => readonly MarkablePane[];
  readonly memberId: string | null;
}): (session: string) => string | null {
  return (session) => {
    const placed = opts.place(session);
    const at = placed === null ? null : parseAddress(placed.address);
    if (at === null || at.kind !== "pane" || !isSelf(at.memberId, opts.memberId)) return null;
    const views = realAgentPanes(opts.views()).filter((view) => view.paneId === at.paneId);
    if (views.length !== 1) return null;
    const view = views[0]!;
    const conversation = view.agentSession === undefined ? "" : `${view.agentSession.kind}:${view.agentSession.value}`;
    return `${view.agent}\u0000${conversation}`;
  };
}
