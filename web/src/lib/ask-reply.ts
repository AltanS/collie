// The phone's side of Ask v1 (M56 spec 08), the pure half: read the bridge's reply to an answer, and
// find the ask option a tap on a dialog card stands for. The card is drawn from the screen text the
// phone holds; the ask comes from the bridge's read. They name the same dialog only when the kind
// fits and the label at the tapped row is the label of the same option; otherwise the phone sends
// nothing and reads the screen again.
//
// Pure: no DOM, no network.

import { asJsonBoolean, asJsonObject, asJsonString, type JsonValue } from "./json";
import { readAsk, readSurface } from "./send-protocol";
import { ASK_OUTCOMES, ASK_REASONS, type AskOutcome, type AskReason } from "./surface/ask";
import type { Ask, Surface } from "./surface/surface";

/** What the dialog handlers need of a reply. The receipt's reads and keys are for the log. */
export interface AskTapReply {
  readonly outcome: AskOutcome | null;
  readonly reason: AskReason | null;
  /** The ask the bridge reads on the pane now, with its new id, after a changed or unknown ask. */
  readonly ask: Ask | null;
  readonly surface: Surface | null;
  readonly detail: string | null;
  readonly replayed: boolean;
}

function pick<const T extends string>(value: JsonValue | undefined, allowed: readonly T[]): T | null {
  return allowed.find((word) => word === value) ?? null;
}

/** A reply to `POST /api/ask/<id>`, field by field, or null when it is not one. */
export function readAskTapReply(body: JsonValue | undefined): AskTapReply | null {
  const node = asJsonObject(body);
  if (node === undefined) return null;
  const receipt = asJsonObject(node.receipt);
  if (receipt === undefined) return null;
  const outcome = pick(receipt.outcome, ASK_OUTCOMES);
  if (outcome === null) return null;
  return {
    outcome,
    reason: pick(receipt.reason, ASK_REASONS),
    ask: node.ask === undefined ? null : readAsk(node.ask),
    surface: node.surface === undefined ? null : readSurface(node.surface),
    detail: asJsonString(node.detail) ?? null,
    replayed: asJsonBoolean(node.replayed) ?? false,
  };
}

/** The card a tap came from: a single-choice dialog or a footer-driven menu, and the row tapped. */
export interface CardTap {
  readonly card: "prompt-select" | "menu";
  /** The row's index in the card's own list (options, or footer actions). */
  readonly index: number;
  readonly label: string;
}

/**
 * The ask option a tap stands for, or null when the bridge's ask is not the dialog on the card: the
 * kind does not fit (a prompt card is a permission or a question, a menu card is a menu), or the
 * option at that row has another label.
 */
export function askOptionFor(ask: Ask, tap: CardTap): string | null {
  const fits = tap.card === "menu" ? ask.kind === "menu" : ask.kind === "permission" || ask.kind === "question";
  if (!fits || tap.index < 0) return null;
  const option = ask.options[tap.index];
  return option !== undefined && option.label === tap.label ? option.id : null;
}
