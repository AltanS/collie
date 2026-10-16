// A program's ask in the contract's form (M56 spec 14). The bridge's structured driver mints the
// contract ask from it, and the phone reads the same form to find which contract option a tap on
// the program's own card stands for. One function on both sides, so the hash cannot drift.
//
// Pure: no DOM, no Bun API, no harness name.

import { shortHash, type AskKind } from "./surface";

/** The fields of a program ask the contract reads. The bridge's and the phone's ask types both fit. */
export interface ProgramAskFields {
  readonly kind: string;
  readonly multiple?: true | undefined;
  readonly title: string;
  readonly reason?: string | undefined;
  readonly tool?: { readonly name: string; readonly summary?: string | undefined } | undefined;
  readonly options: readonly { readonly id: string; readonly label: string; readonly effect?: string | undefined }[];
}

/** A program ask as the contract shows it, with the program's option ids in the contract's order. */
export interface ProgramContract {
  readonly kind: AskKind;
  readonly hash: string;
  readonly labels: readonly string[];
  readonly optionIds: readonly string[];
}

/**
 * The contract form of a program ask, or null when the contract cannot answer it with one tap: a
 * line of text, a form, a choice of several, or a kind this build does not know. Such an ask is a
 * modal the phone answers on the program's own card (`modal: unreadable`). An `allow-always` option
 * is left out: a grant that outlives the ask needs the second tap the program's card asks for.
 */
export function programContract(ask: ProgramAskFields): ProgramContract | null {
  let kind: AskKind;
  if (ask.kind === "permission") kind = "permission";
  else if (ask.kind === "choice" && ask.multiple !== true) kind = "question";
  else return null;
  const kept = ask.options.filter((option) => option.effect !== "allow-always");
  if (kept.length === 0) return null;
  const labels = kept.map((option) => option.label);
  // Over the kind, the subject and the tool, the input shown and the option labels in order (spec 08).
  const hash = shortHash(["program", kind, ask.title, ask.tool?.name ?? "", ask.tool?.summary ?? "", ask.reason ?? "", ...labels].join("\n"));
  return { kind, hash, labels, optionIds: kept.map((option) => option.id) };
}
