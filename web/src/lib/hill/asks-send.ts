// WHAT ONE SEND CAME TO, IN WORDS (Asks build 2, 2026-11-23): the bridge's refusal of a whole Send, an ask that closed
// before the Send reached it, and the request the phone builds from the marked answers. Pure: the hook that sends
// (hooks/use-asks-send.ts) calls these, and a test reads them without a render.

import type { HillAnswersOutcome } from "../api";
import { t } from "../i18n";
import type { MarkedAnswer } from "./answers-message";
import type { HillAnswersItem, HillAnswersRefusal, HillAnswersRequest } from "./wire";

/** The request of a Send: one entry for each marked answer, in the session's order. `text` rides only where there is some. */
export function sendRequest(rid: string, answers: readonly MarkedAnswer[]): HillAnswersRequest {
  return {
    rid,
    answers: answers.map((answer) => (answer.text === null ? { id: answer.ask.id, intent: answer.intent } : { id: answer.ask.id, intent: answer.intent, text: answer.text })),
  };
}

/** What a refused Send says, where it belongs: the whole Send (the sheet) or one ask (the ask's own screen). */
export interface RefusalWords {
  /** The id of the ask the refusal names, or null for a refusal of the whole Send. */
  ask: string | null;
  words: string;
}

/** The refusal of a Send, in plain words. A status with no readable body says only that the Send did not go. */
export function refusalWords(outcome: Extract<HillAnswersOutcome, { ok: false }>): RefusalWords {
  const refusal: HillAnswersRefusal | null = outcome.refusal;
  if (refusal === null) return { ask: null, words: outcome.status === 401 || outcome.status === 403 ? t("asks.send.denied") : t("asks.send.refused") };
  switch (refusal.code) {
    case "too_long":
      return { ask: null, words: t("asks.send.tooLong", { over: refusal.over ?? 0 }) };
    case "mixed_sessions":
      return { ask: null, words: t("asks.send.mixed") };
    case "not_answering":
      return { ask: null, words: refusal.machine === undefined ? t("asks.send.notAnsweringNoName") : t("asks.send.notAnswering", { machine: refusal.machine }) };
    case "not_typed":
      return { ask: null, words: t("asks.send.notTyped") };
    case "rid_reused":
      return { ask: null, words: t("asks.send.refused") };
    case "not_an_ask":
      return { ask: refusal.id ?? null, words: t("asks.send.notAnAsk") };
    case "bad_answer":
      return { ask: refusal.id ?? null, words: t("asks.send.badAnswer") };
    default:
      return refusal.code satisfies never;
  }
}

/**
 * What a closed-before-the-Send ask says on its own screen. The state the bridge reports after the Send decides the words
 * (the app never prints the bridge's own reason: it is a log line, not a sentence for a person).
 */
export function goneWords(item: Pick<HillAnswersItem, "state">): string {
  switch (item.state) {
    case "answered":
      return t("asks.send.goneAnswered");
    case "undeliverable":
      return t("asks.send.goneEnded");
    default:
      return t("asks.send.gone");
  }
}
