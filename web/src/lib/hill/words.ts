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

/**
 * "Your answer goes to collie lead on bluefin", or without the machine when the bridge names none.
 * A trick's decision names the trick too: "... goes to m96-hill on bluefin and to the Look trick", or
 * alone "... goes to the Look trick" when the answer is typed nowhere. Null when there is nothing to say.
 */
export function targetLine(decision: Pick<HillDecision, "target" | "from">): string | null {
  const { target, from } = decision;
  if (from.kind !== "trick") {
    if (target === null) return null;
    return target.host === null ? t("hill.targetLocal", { label: target.label }) : t("hill.target", { label: target.label, host: target.host });
  }
  if (target === null) return t("hill.targetTrick", { trick: from.label });
  if (target.host === null) return t("hill.targetBothLocal", { label: target.label, trick: from.label });
  return t("hill.targetBoth", { label: target.label, host: target.host, trick: from.label });
}

/** The delivery part of an `ok` receipt: where the answer went, or "Dismissed" when it went nowhere. */
function okWords(receipt: HillReceipt, intent: string, label: string): string {
  if (intent === "dismiss" || receipt.delivery === "none") return t("hill.receipt.dismissed");
  if (receipt.delivery === "typed") return t("hill.receipt.typed", { label });
  if (receipt.delivery === "held") return t("hill.receipt.held", { label });
  return t("hill.receipt.unknown");
}

/** A trick took the answer: "Recorded by Look" alone, or after where it was sent, "Sent to m96-hill · recorded by Look". */
function okWithTrick(receipt: HillReceipt, intent: string, label: string, trickName: string): string {
  if (intent === "dismiss" || receipt.delivery === "none") return t("hill.receipt.recorded", { trick: trickName });
  return `${okWords(receipt, intent, label)} · ${t("hill.delivery.recorded", { trick: trickName })}`;
}

/**
 * What an `ok` answer to a Decision of Collie's own did (crew slice 3). Nothing was typed anywhere:
 * Collie acted itself, so the line says the outcome. A trick's new version: "Now running the new
 * version." for use and always, "Kept the old version." for keep.
 */
export function collieOkWords(from: HillDecision["from"], intent: string): string {
  if (intent === "dismiss") return t("hill.receipt.dismissed");
  if (from.ref?.type === "version") return intent === "keep" ? t("hill.receipt.versionKept") : t("hill.receipt.versionUsed");
  return t("hill.receipt.collieDone");
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
 * closed; the bridge's `unknown` reads as the delivery that was not confirmed. `trickName` is set for
 * a trick's decision: the receipt then also says whether the trick took the answer.
 */
export function receiptWords(receipt: HillReceipt, intent: string, label: string, trickName: string | null = null): string {
  switch (receipt.code) {
    case "ok":
      // A dismiss that closed the card while the session's machine was away: nothing reached the session.
      if (receipt.machine !== undefined) return t("hill.receipt.dismissedOffline", { machine: receipt.machine });
      if (trickName !== null && receipt.trick === "failed") return t("hill.receipt.trickFailed", { trick: trickName });
      if (trickName !== null && receipt.trick === "ran") return okWithTrick(receipt, intent, label, trickName);
      return okWords(receipt, intent, label);
    case "unknown":
      return t("hill.receipt.unknown");
    case "rejected": {
      if (receipt.machine !== undefined) return t("hill.receipt.offline", { machine: receipt.machine });
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
 * dismiss and a delivery with nothing to type show the choice alone. A trick's decision adds what the
 * trick did: "Yes · recorded by Look", "Yes · typed to m96-hill · Look did not take it".
 */
export function answerLine(decision: Pick<HillDecision, "answer" | "target" | "from">): string {
  const answer = decision.answer;
  if (answer === null) return "";
  const chosen = answer.label ?? answer.text ?? "";
  const where = deliveryWords(answer.delivery, targetLabel(decision));
  const trick = trickWords(answer.trick, decision.from);
  return [chosen, where, trick].filter((part) => part !== "").join(" · ");
}

function trickWords(trick: NonNullable<HillDecision["answer"]>["trick"], from: HillDecision["from"]): string {
  if (from.kind !== "trick") return "";
  switch (trick) {
    case "ran":
      return t("hill.delivery.recorded", { trick: from.label });
    case "failed":
      return t("hill.delivery.trickFailed", { trick: from.label });
    case "none":
      return "";
    default:
      return trick satisfies never;
  }
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
