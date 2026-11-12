// What a session's pane runs now, as one opaque word, for an agent view's rules proof and its stale
// screens (bridge/agent-view/service.ts). A proof holds while the mark is the one its `trick view <id>
// start` saw, and a screen holds while the mark is the one its write saw: another harness in the pane,
// another conversation of the same harness, or the pane gone, ends both.
//
// Read from what the bridge already holds per pane, with no harness named here: the snapshot's `agent`
// (the harness the detection settled on) and its `agentSession` (the conversation the harness itself
// reported through its integration, Herdr's `agent_session`). A harness that reports no conversation
// marks by its harness alone; for it, a harness change, the switch going off and `clear` are the resets,
// and a screen goes stale at the next person turn that did not come from the view (`markHasConversation`).
// Nothing here is read from the pane's screen or a log, and nothing leaves the bridge: the mark is compared in
// memory and never served.

import { realAgentPanes } from "../tricks/panes.ts";
import { isSelf, parseAddress } from "../walky/address.ts";

/** A pane as the snapshot holds it, as far as the mark reads it. */
export interface MarkablePane {
  readonly paneId: string;
  readonly agent: string;
  readonly kind?: "agent" | "shell" | "trick";
  readonly agentSession?: { readonly kind: string; readonly value: string };
  /** The pane's status as the snapshot holds it: `blocked` is a question, a dialog or an answer box on screen. */
  readonly status?: string;
}

/**
 * The live agent pane a walky address names now, or null: the lookup the mark and the question share.
 */
export function viewPaneOf(opts: {
  readonly place: (address: string) => { readonly address: string } | null;
  readonly views: () => readonly MarkablePane[];
  readonly memberId: string | null;
}): (session: string) => MarkablePane | null {
  return (session) => {
    const placed = opts.place(session);
    const at = placed === null ? null : parseAddress(placed.address);
    if (at === null || at.kind !== "pane" || !isSelf(at.memberId, opts.memberId)) return null;
    const views = realAgentPanes(opts.views()).filter((view) => view.paneId === at.paneId);
    return views.length === 1 ? views[0]! : null;
  };
}

/** Whether a turn runs in the pane a walky address names (status `working`). */
export function viewWorking(opts: Parameters<typeof viewPaneOf>[0]): (session: string) => boolean {
  const paneOf = viewPaneOf(opts);
  return (session) => paneOf(session)?.status === "working";
}

/**
 * Whether a question, a dialog or an answer box shows in the pane a walky address names (status
 * `blocked`). A send from the view is then refused, or typed text goes plain as the person's answer.
 */
export function viewQuestion(opts: Parameters<typeof viewPaneOf>[0]): (session: string) => boolean {
  const paneOf = viewPaneOf(opts);
  return (session) => paneOf(session)?.status === "blocked";
}

/**
 * The mark of the live pane a walky address names now, or null: an address the probe does not place (the
 * instance token must still match, through `place`), a pane on another crew member, a pane id that no
 * view or more than one holds, or a pane that is no agent now.
 */
export function viewPaneMark(opts: {
  readonly place: (address: string) => { readonly address: string } | null;
  readonly views: () => readonly MarkablePane[];
  readonly memberId: string | null;
}): (session: string) => string | null {
  const paneOf = viewPaneOf(opts);
  return (session) => {
    const view = paneOf(session);
    if (view === null) return null;
    const conversation = view.agentSession === undefined ? "" : `${view.agentSession.kind}:${view.agentSession.value}`;
    return `${view.agent}\u0000${conversation}`;
  };
}

/** Whether a mark names a conversation the harness reported, so a `/clear` there shows as another mark. */
export function markHasConversation(mark: string): boolean {
  const cut = mark.indexOf("\u0000");
  return cut >= 0 && mark.length > cut + 1;
}
