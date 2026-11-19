import { isTrickApproval, TrickApprovalMark } from "@/components/decision-card";
import { trickNameOf } from "@/components/trick-cards";
import { useLocale } from "@/hooks/use-locale";
import { PROPOSAL_USE_LABEL, trickCardDecline } from "@/lib/hill/code-card";
import type { HillDecision } from "@/lib/hill/wire";
import { t } from "@/lib/i18n";

// AN ANSWERED TRICK APPROVAL, AS ONE LINE (Altan, 2026-11-18). A proposal or a new-version card of Collie's own
// (components/session-trick-card.tsx) is tall while it waits: the facts, the code, the hold. Once it is answered it
// has nothing left to ask, so it collapses into one small line that flows in the conversation like a message and
// scrolls away with it: the tricks glyph on its 16px tile, "Collie tricks", the trick's name and what happened to
// it, for example "hadoken: switched on". It is a line, not a control: there is no sheet of the card's detail to
// open, so a tap does nothing. Only the cards `isTrickApproval` names collapse; every other Decision keeps its card.

/** Whether `decision` asks about a new version of a trick (not about a new trick): its yes is "Use the new version". */
function isNewVersion(decision: HillDecision): boolean {
  return decision.from.ref?.type === "version" || decision.options.some((option) => option.label === PROPOSAL_USE_LABEL);
}

/**
 * What happened to the trick, with its name: "hadoken: switched on", "hadoken: new version in use",
 * "hadoken: kept the old version", "hadoken: not switched on". `approved` is the person's yes (a hold that landed);
 * anything else is a decline.
 */
export function trickLineWords(decision: HillDecision, approved: boolean): string {
  const name = trickNameOf(decision);
  if (isNewVersion(decision)) return t(approved ? "hill.trickLine.use" : "hill.trickLine.keep", { name });
  return t(approved ? "hill.trickLine.on" : "hill.trickLine.later", { name });
}

/** The classes of the line, shared with the answer row (components/trick-answer-row.tsx), which wears the same look. */
export const TRICK_LINE_CLASS = "flex min-w-0 items-center gap-2 px-1.5 py-1 text-xs text-muted-foreground";

/**
 * Whether a trick approval's recorded answer was a yes (a hold that landed), from the Decision's own `answer`: the
 * decline's intent and a dismiss are no. Null while the Decision holds no answer, or for a card that is no trick approval.
 */
export function answeredAsApproved(decision: HillDecision): boolean | null {
  const decline = trickCardDecline(decision);
  if (decline === null || decision.answer === null) return null;
  return decision.answer.intent !== decline && decision.answer.intent !== "dismiss";
}

/** The one line of an answered trick approval. Draws nothing for a card that is no trick approval. */
export function TrickApprovalLine({ decision, approved }: { decision: HillDecision; approved: boolean }) {
  useLocale();
  if (!isTrickApproval(decision)) return null;
  const words = trickLineWords(decision, approved);
  return (
    <p
      role="status"
      data-slot="chat-approval-line"
      data-id={decision.id}
      data-outcome={approved ? "approved" : "declined"}
      className={TRICK_LINE_CLASS}
    >
      <TrickApprovalMark />
      <span className="shrink-0 text-foreground">{t("hill.collieTricks")}</span>
      <span aria-hidden className="text-border">
        |
      </span>
      <span title={words} className="font-content min-w-0 truncate">
        {words}
      </span>
    </p>
  );
}
