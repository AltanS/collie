// A tap on a program's own ask card as one Answer to the contract ask (M56 spec 14).
//
// The bridge's structured driver publishes a program pane's OLDEST open ask as a contract ask on the
// pane's Surface: `{ id, kind, options, channel: "program", hash }`, options numbered from 1 in the
// program's order with "Always allow" left out. The card stays the program's own card. A tap on it
// goes to `POST /api/ask/<id>` when the card is that same ask: the same id as the oldest open ask, and
// the same hash the phone computes from the card with the bridge's own function. Anything else keeps
// the program's answer route: a later ask, a text, a form, a choice of several, and "Always allow".
//
// Pure: no DOM, no fetch.

import type { AnswerResult } from "./ask";
import type { AskTapReply } from "./ask-reply";
import { programContract } from "./surface/program";
import type { Ask as ContractAsk } from "./surface/surface";
import type { Ask } from "./types";

/** The contract ask a program pane's Surface carries, and the id of the program ask it stands for. */
export interface ProgramContractAsk {
  readonly ask: ContractAsk;
  /** The id of the pane's oldest open ask: the only one the contract ask can stand for. */
  readonly oldest: string;
}

/**
 * The contract option a tap on `optionId` of the card stands for, or null when the tap must keep the
 * program's answer route: the card is not the oldest ask, the contract cannot answer its kind, the
 * hash or the number of options differs, or the option is one the contract leaves out.
 */
export function contractOptionFor(card: Ask, contract: ProgramContractAsk, optionId: string): string | null {
  if (contract.ask.channel !== "program" || card.id !== contract.oldest) return null;
  const mine = programContract(card);
  if (mine === null || mine.hash !== contract.ask.hash || mine.optionIds.length !== contract.ask.options.length) return null;
  const index = mine.optionIds.indexOf(optionId);
  return index < 0 ? null : (contract.ask.options[index]?.id ?? null);
}

/**
 * The bridge's reply to an answer, as the program's card reads it. A taken answer closes the card. A
 * question answered or closed first is too late. A question that changed asks for a fresh tap on the
 * next read. Any other refusal shows the bridge's own words.
 */
export function answerOfAskReply(reply: AskTapReply): AnswerResult {
  switch (reply.outcome) {
    case "sent":
      return reply.replayed ? { outcome: "taken", replayed: true } : { outcome: "taken" };
    case "unknown":
    case null:
      return { outcome: "unknown" };
    case "refused":
      break;
  }
  switch (reply.reason) {
    case "ask_answered":
    case "ask_gone":
      return { outcome: "too-late" };
    case "ask_changed":
    case "ask_unknown":
      return { outcome: "stale" };
    default:
      return { outcome: "refused", detail: reply.detail ?? "" };
  }
}
