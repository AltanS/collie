// Relative imports and no layout code: the bridge reads this module too (bridge/hill/service.ts groupRule).
import type { View, ViewNode } from "../tricks/schema";
import type { HillDecision, HillGroupAnswer } from "./wire";

// A SINGLE CARD OF CODE (review 7 R1, the single card). Collie's own proposal card or new-version card
// whose code fits one card: its view never folds on the Hill, and its yes is a hold of 1.5 seconds
// (components/hold-to-approve.tsx, ADR 0156). Its decline is a plain tap. The yes carries
// `{ digest: <the ref's hash> }`, and the bridge refuses a yes without it, as it does for a group (C-A2,
// review 8). A Decision with no code in its view (an agent's, a trick's, or Collie's own without code)
// folds as before.

/**
 * What a yes to Collie's own card of code carries: the digest the phone was given, and the legacy `opened` with every
 * card number for a bridge of edge.1 to edge.4 (wire.ts {@link HillGroupAnswer}). A group names cards 1 to n, a
 * single card names card 1. Undefined for a card with no code: it gets no yes.
 */
export function trickYesAnswer(decision: HillDecision): HillGroupAnswer | undefined {
  const group = decision.group;
  if (group !== undefined) return { digest: group.digest, opened: group.parts.map((_, i) => i + 1) };
  const single = singleCodeCard(decision);
  return single === null ? undefined : { digest: single.digest, opened: [1] };
}

/** The decline of each kind of Collie's own card with code: the option that needs nothing read. */
const DECLINE = {
  // bridge/tricks/proposal-card.ts PROPOSAL_LATER and PROPOSAL_KEEP, a new trick and a new version alike.
  proposal: "later",
  // bridge/tricks/version-card.ts "Keep the old version".
  version: "keep",
} as const;

/** Whether a node is code (a `diff` or a `code` node) or holds one at any depth. */
function holdsCode(node: ViewNode): boolean {
  // The kids as tricks/layout.ts `kidsOf` reads them: a node from the wire may carry any value there.
  const kids = "kids" in node && Array.isArray(node.kids) ? node.kids : [];
  return node.kind === "diff" || node.kind === "code" || kids.some(holdsCode);
}

/** Whether a view holds code: a `diff` or a `code` node, at any depth. */
export function viewHasCode(view: View): boolean {
  return view.some(holdsCode);
}

/** A single card of code: its decline, and the key its state is kept under. */
export interface SingleCodeCard {
  decline: string;
  /** The code's hash from the card's ref: a card about other code is a new key. */
  key: string;
  /** The ref's hash, sent as the answer's `digest`. */
  digest: string;
}

/** The single card of code `decision` is, or null: not Collie's, a group, no view, no code, or another kind. */
export function singleCodeCard(decision: HillDecision): SingleCodeCard | null {
  const { from } = decision;
  if (from.kind !== "collie" || from.ref === undefined || decision.group !== undefined || decision.view === undefined) return null;
  if (from.ref.type !== "proposal" && from.ref.type !== "version") return null;
  if (!viewHasCode(decision.view)) return null;
  return { decline: DECLINE[from.ref.type], key: `one:${from.ref.hash}`, digest: from.ref.hash };
}

/**
 * The decline of a trick card of Collie's own (a new trick or a new version, with code or without), or null
 * for any other card. Its other options are the yes, a hold of 1.5 seconds (ADR 0156).
 */
export function trickCardDecline(decision: HillDecision): string | null {
  const { from } = decision;
  if (from.kind !== "collie" || from.ref === undefined) return null;
  if (from.ref.type !== "proposal" && from.ref.type !== "version") return null;
  return decision.group?.decline ?? DECLINE[from.ref.type];
}

/**
 * The label of the yes of a proposal for a new version (bridge/tricks/proposal-card.ts `PROPOSAL_USE`): the
 * same intent as a new trick's "Switch it on", so the label is what tells the two apart. A bridge test pins it.
 */
export const PROPOSAL_USE_LABEL = "Use the new version";

/** What a yes of a trick card does, for its hold's words: switch a new trick on, use a new version, or use it and stop asking. */
export type TrickYesKind = "on" | "use" | "always";

/** What the yes `option` of the trick card `decision` does. */
export function trickYesKind(decision: HillDecision, option: { intent: string; label: string }): TrickYesKind {
  if (decision.from.ref?.type === "version") return option.intent === "always" ? "always" : "use";
  return option.label === PROPOSAL_USE_LABEL ? "use" : "on";
}
