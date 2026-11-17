import { LiveDecisionCard } from "@/components/hill-view";
import { useHillAnswerHeld, useHillClosed, useHillOpen } from "@/lib/hill/store";
import { closeInSession, useSessionLater } from "@/lib/hill/session-later";
import type { HillDecision } from "@/lib/hill/wire";
import { bareAddress } from "@/lib/walky";

// A TRICK PROPOSAL IN THE SESSION THAT PROPOSED IT (package I, 2026-11-17). `collie trick propose` in an
// agent's pane makes a proposal card of Collie's own (bridge/tricks/proposals.ts), tied to that session:
// its `replyTo` is the session's walky address (bridge/hill/service.ts `postAny`, the card's `tellOf`).
// This draws that card in the session's chat view, where the docked cards sit, so the person answers it
// where they talk to the agent. It is the SAME card the Hill and Settings, Tricks draw (`LiveDecisionCard`)
// with the same guards: every right, warning and line of code before a yes, no yes until the code was on
// screen to its end, the confirm tap, nothing recommended or focused, and the one answer route
// (`POST /api/hill/answer`, the write right, a request id and a receipt), whose yes approves exactly the
// bytes of the code hash the card showed and switches the trick on. One component for every harness.
//
// "Not now" here closes the card in this session only (lib/hill/session-later.ts) and sends nothing:
// Settings, Tricks keeps it under "Waiting for your yes". The Dismiss button is not drawn here.
//
// Only a NEW trick's or a new version's proposal (`ref.type === "proposal"`) shows here; no agent text
// can make one, because only the bridge's own code posts a card of Collie's own.

/** The proposal's decline intent (bridge/tricks/proposal-card.ts PROPOSAL_LATER and PROPOSAL_KEEP). */
export const PROPOSAL_DECLINE = "later";

/** Whether `decision` is a proposal card tied to the session at walky address `self`. */
export function isSessionProposal(decision: HillDecision, self: string): boolean {
  const { from } = decision;
  if (from.kind !== "collie" || from.ref?.type !== "proposal" || decision.replyTo === null) return false;
  return bareAddress(decision.replyTo) === bareAddress(self);
}

/** The cards one session shows: open ones not closed here, and closed ones while this phone holds their answer. */
export function sessionProposals(open: readonly HillDecision[], closed: readonly HillDecision[], self: string, later: readonly string[]): HillDecision[] {
  return [...open.filter((d) => isSessionProposal(d, self) && !later.includes(d.id)), ...closed.filter((d) => isSessionProposal(d, self))].toSorted((a, b) => a.at - b.at);
}

/** One card: an answered card stays with what its answer did while this phone holds the receipt. */
function SessionTrickCard({ decision }: { decision: HillDecision }) {
  const answer = useHillAnswerHeld(decision.id);
  if (decision.state !== "open" && answer === null) return null;
  return (
    <div data-slot="session-trick-card" data-card={decision.id} className="max-h-[60dvh] overflow-y-auto px-3 pb-1">
      <LiveDecisionCard decision={decision} localDecline={{ intent: PROPOSAL_DECLINE, run: () => closeInSession(decision.id) }} />
    </div>
  );
}

/** The proposal cards of the session at walky address `self`, oldest first. Nothing while none waits. */
export function SessionTrickCards({ self }: { self: string }) {
  const open = useHillOpen();
  const closed = useHillClosed();
  const later = useSessionLater();
  const cards = sessionProposals(open, closed, self, later);
  if (cards.length === 0) return null;
  return (
    <>
      {cards.map((decision) => (
        <SessionTrickCard key={decision.id} decision={decision} />
      ))}
    </>
  );
}
