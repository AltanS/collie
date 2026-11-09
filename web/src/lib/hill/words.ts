// THE HILL IN WORDS (M96): every sentence the hill's card, rows and entry say about a decision, as
// pure functions of the wire's shapes, so the card draws words and a test reads them without a render.

import { t } from "@/lib/i18n";

import type { HillDecision, HillPriority, HillReceipt, HillState } from "./wire";

export function priorityWord(priority: HillPriority): string {
  return t(`hill.priority.${priority}`);
}

/** A closed decision's state, in plain words. An open one has none to say. */
export function stateWord(state: Exclude<HillState, "open">): string {
  return t(`hill.state.${state}`);
}

/**
 * How old a decision is, in the compact units the ask card's countdown uses: "40 s", "2 min", "3 h",
 * "2 d", rounded down. A moment in the future (a phone clock behind the bridge's) reads as "0 s".
 */
export function ageWords(at: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - at) / 1000));
  if (secs < 60) return `${secs} s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h`;
  return `${Math.floor(hrs / 24)} d`;
}

/** The session an answer goes to, by name: the resolved target, or the poster itself when there is none. */
export function targetLabel(decision: Pick<HillDecision, "target" | "from">): string {
  return decision.target?.label ?? decision.from.label;
}

/** "Your answer goes to collie lead on bluefin", or without the machine when the bridge names none. */
export function targetLine(target: NonNullable<HillDecision["target"]>): string {
  return target.host === null ? t("hill.targetLocal", { label: target.label }) : t("hill.target", { label: target.label, host: target.host });
}

/** The bridge's plain-words reason, in the phone's language where it is one the phone knows. */
function reasonWords(reason: string | null): string | null {
  if (reason === null || reason.trim() === "") return null;
  if (reason === "text is required") return t("hill.reason.textRequired");
  if (reason === "not an option of this decision") return t("hill.reason.notAnOption");
  return reason;
}

/**
 * What the card says after the bridge answered, in words. `label` names the session the answer went
 * to. `ok` speaks of the delivery, a dismiss has nothing to deliver; `gone` names why the decision is
 * closed; the bridge's `unknown` reads as the delivery that was not confirmed.
 */
export function receiptWords(receipt: HillReceipt, intent: string, label: string): string {
  switch (receipt.code) {
    case "ok":
      if (intent === "dismiss" || receipt.delivery === "none") return t("hill.receipt.dismissed");
      if (receipt.delivery === "typed") return t("hill.receipt.typed", { label });
      if (receipt.delivery === "held") return t("hill.receipt.held", { label });
      return t("hill.receipt.unknown");
    case "unknown":
      return t("hill.receipt.unknown");
    case "rejected": {
      const why = reasonWords(receipt.reason);
      return why === null ? t("hill.receipt.rejected") : t("hill.receipt.rejectedWhy", { reason: why });
    }
    case "gone":
      if (receipt.reason === "target session ended") return t("hill.receipt.goneEnded");
      if (receipt.reason === "the decision is answered") return t("hill.receipt.goneAnswered");
      return t("hill.receipt.gone");
    case "denied":
      return t("hill.receipt.denied");
    default:
      return receipt.code satisfies never;
  }
}

/**
 * The receipt line of an answered row under Answered: what was chosen, then where it went, joined by
 * a middle dot. "Yes, Edge first · typed to collie lead". A words-only answer shows its words; a
 * dismiss and a delivery with nothing to type show the choice alone.
 */
export function answerLine(decision: Pick<HillDecision, "answer" | "target" | "from">): string {
  const answer = decision.answer;
  if (answer === null) return "";
  const chosen = answer.label ?? answer.text ?? "";
  const where = deliveryWords(answer.delivery, targetLabel(decision));
  return [chosen, where].filter((part) => part !== "").join(" · ");
}

function deliveryWords(delivery: NonNullable<HillDecision["answer"]>["delivery"], label: string): string {
  switch (delivery) {
    case "typed":
      return t("hill.delivery.typed", { label });
    case "held":
      return t("hill.delivery.held", { label });
    case "unknown":
      return t("hill.delivery.unknown");
    case "none":
      return "";
    default:
      return delivery satisfies never;
  }
}
