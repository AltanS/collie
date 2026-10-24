// A belt tap that lands in a large screen's column that is not the focused one (ADR 0120).
//
// Every column draws its pane's belt, and only the focused column owns a composer. A pill tapped in
// another column acts on THAT pane, and makes its column the focused one: the tap navigates sideways
// to the pane (`nav.side`) and leaves its intent here, keyed on the pane's full address. The composer
// that mounts for that pane takes the intent once and runs it through its own handler, with every
// gate that handler already has, so a pill in a column can never do what the same pill on the focused
// pane would refuse. The focus moves first and the act follows, which is also what a pill that needs
// the composer (a dock, Type, a command) needs.
//
// One intent per pane, and short-lived: an intent not taken within a few seconds (the navigation
// failed, the pane closed) is dropped rather than fired at a later visit.

export type BeltIntent =
  /** One of Collie's own pills, by its `GeneralAction.id` (actions-row.tsx). */
  | { readonly kind: "action"; readonly id: string }
  /** A harness command from the belt's harness section, sent as the pill sends it. */
  | { readonly kind: "run"; readonly text: string }
  /** The belt's Stop, already confirmed by its second tap in the column (the arm stays in the column). */
  | { readonly kind: "stop" }
  /** The pinned Files pill: the pane's Changes view, opened from the pane so Back returns to it. */
  | { readonly kind: "changes" }
  /** The pinned Agents mark: the pane's running subagents. */
  | { readonly kind: "agents" };

/** How long an intent waits for its composer. */
export const INTENT_TTL_MS = 5000;

const pending = new Map<string, { intent: BeltIntent; at: number }>();

/** Leave an intent for the pane at `address` (`paneScopeKey`). A newer one replaces it. */
export function queueBeltIntent(address: string, intent: BeltIntent, now: number = Date.now()): void {
  pending.set(address, { intent, at: now });
}

/** Take the pane's intent, once. Null when there is none or it waited too long. */
export function takeBeltIntent(address: string, now: number = Date.now()): BeltIntent | null {
  const entry = pending.get(address);
  if (entry === undefined) return null;
  pending.delete(address);
  return now - entry.at > INTENT_TTL_MS ? null : entry.intent;
}

/** Test seam. */
export function __resetBeltIntents(): void {
  pending.clear();
}
