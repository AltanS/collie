import { kidsOf } from "@/lib/tricks/layout";
import type { View, ViewNode } from "@/lib/tricks/schema";

import type { HillDecision } from "./wire";

// A SINGLE CARD OF CODE (review 7 R1, the single card). Collie's own proposal card or new-version card
// whose code fits one card is held to the group's rule (components/decision-group.tsx): its view never
// folds, and its yes waits until the mark after its last line was on screen. Its decline needs nothing
// opened. Like a group's marks, this is a display check on the phone only: the bridge checks the opened
// cards of a group, but it does not check this for a single card (bridge/hill/service.ts takes the
// answer as it takes any other). A Decision with no code in its view (an agent's, a trick's, or
// Collie's own without code) folds as before.

/** The decline of each kind of Collie's own card with code: the option that needs nothing read. */
const DECLINE = {
  // bridge/tricks/proposal-card.ts PROPOSAL_LATER and PROPOSAL_KEEP, a new trick and a new version alike.
  proposal: "later",
  // bridge/tricks/version-card.ts "Keep the old version".
  version: "keep",
} as const;

/** Whether a node is code (a `diff` or a `code` node) or holds one at any depth. */
function holdsCode(node: ViewNode): boolean {
  return node.kind === "diff" || node.kind === "code" || kidsOf(node).some(holdsCode);
}

/** Whether a view holds code: a `diff` or a `code` node, at any depth. */
export function viewHasCode(view: View): boolean {
  return view.some(holdsCode);
}

/** A single card of code: its decline, and the key its opened mark is kept under. */
export interface SingleCodeCard {
  decline: string;
  /** The code's hash from the card's ref: a card about other code is a new key. */
  key: string;
}

/** The single card of code `decision` is, or null: not Collie's, a group, no view, no code, or another kind. */
export function singleCodeCard(decision: HillDecision): SingleCodeCard | null {
  const { from } = decision;
  if (from.kind !== "collie" || from.ref === undefined || decision.group !== undefined || decision.view === undefined) return null;
  if (from.ref.type !== "proposal" && from.ref.type !== "version") return null;
  if (!viewHasCode(decision.view)) return null;
  return { decline: DECLINE[from.ref.type], key: `one:${from.ref.hash}` };
}
