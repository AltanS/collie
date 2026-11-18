import { useLayoutEffect } from "react";

import { isTrickApproval, TrickApprovalMark } from "@/components/decision-card";
import { answeredAsApproved, trickLineWords, TRICK_LINE_CLASS } from "@/components/trick-approval-line";
import { useWalkyOpen } from "@/components/walky-log";
import { useLocale } from "@/hooks/use-locale";
import { clockTime } from "@/lib/format";
import { noteAnswerRow } from "@/lib/hill/answer-rows";
import { answeredDecisionId } from "@/lib/hill/answer-turn";
import { useHillClosed, useHillOpen } from "@/lib/hill/store";
import type { HillDecision } from "@/lib/hill/wire";
import { t } from "@/lib/i18n";
import { signerOf, verifiedWord, type WalkyRow } from "@/lib/walky";
import { cn } from "@/lib/utils";

// THE ANSWER TO A TRICK APPROVAL, AS ONE ROW IN CHAT (Altan, 2026-11-18). Collie types the person's tap into the agent's
// session as their own WalkyTalky message, and Chat drew that as a "Message from <device>" card with an "operator" chip.
// For a card of Collie's own about a trick (a proposal, a new version) the person sees the result as one row in the look
// of the answered card's line (components/trick-approval-line.tsx): the tricks glyph, "Collie tricks", the trick's name
// and what happened to it, then the time and where the message was signed, muted at the right. The agent still gets the
// full text; only what the phone draws changed. Which turn is the answer, and why the card is built from the Hill's own
// Decision and not from the words: lib/hill/answer-turn.ts.
//
// Where the card opened the Messages sheet on this message (`useWalkyOpen`), the row is that one button, same target, with
// the 44px floor; where there is no sheet it is a plain line. While it is mounted it notes its decision, so the card's own
// collapsed line (components/session-trick-card.tsx) is not drawn twice.

/**
 * The trick approval a typed answer is about, or undefined: the row is an operator message whose first line is the
 * poster's form of `answerMessage` (lib/hill/answer-turn.ts), and the Hill holds that Decision, a card of Collie's own
 * about a trick, with its answer recorded. Any other row, and an answer whose Decision this phone does not hold, keep the card.
 */
export function useAnsweredTrickCard(row: WalkyRow | null): HillDecision | undefined {
  const open = useHillOpen();
  const closed = useHillClosed();
  if (row === null || row.kind !== "operator") return undefined;
  const id = answeredDecisionId(row.body);
  if (id === null) return undefined;
  const decision = closed.find((candidate) => candidate.id === id) ?? open.find((candidate) => candidate.id === id);
  return decision !== undefined && isTrickApproval(decision) && answeredAsApproved(decision) !== null ? decision : undefined;
}

export function TrickAnswerRow({ row, decision }: { row: WalkyRow; decision: HillDecision }) {
  useLocale();
  const open = useWalkyOpen();
  const approved = answeredAsApproved(decision) === true;
  useLayoutEffect(() => noteAnswerRow(decision.id), [decision.id]);
  const words = trickLineWords(decision, approved);
  const body = (
    <>
      <TrickApprovalMark />
      <span className="shrink-0 text-foreground">{t("hill.collieTricks")}</span>
      <span aria-hidden className="text-border">
        |
      </span>
      <span title={words} className="font-content min-w-0 truncate">
        {words}
      </span>
      <span data-slot="trick-answer-meta" className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
        <span className="tabular-nums">{clockTime(row.at)}</span>
        <span aria-hidden>·</span>
        <span data-slot="walky-verified" className="max-w-32 truncate">
          {verifiedWord(row.receipt, signerOf(row))}
        </span>
      </span>
      {open !== null && <span className="sr-only">{t("walky.card.open", { sheet: t("walky.sheet.title") })}</span>}
    </>
  );
  const common = {
    "data-slot": "trick-answer-row",
    "data-id": decision.id,
    "data-message": row.id,
    "data-outcome": approved ? "approved" : "declined",
  };
  if (open === null) {
    return (
      <p role="status" {...common} className={TRICK_LINE_CLASS}>
        {body}
      </p>
    );
  }
  return (
    <button
      type="button"
      {...common}
      onClick={() => open(row.id)}
      className={cn(TRICK_LINE_CLASS, "min-h-11 w-full text-left transition-colors active:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring")}
    >
      {body}
    </button>
  );
}
