// The generic-menu tap — the same guard as its siblings (lib/dialog-guard.ts), with the one
// judgement call this grammar forces:
//
//   - ACTION keys (Enter / s / whatever the footer named) COMMIT. In the `/model` picker, Enter
//     writes the user's default for new sessions. These take the full `commits` comparison — a
//     highlight that moved between render and tap changes the signature, so a stale tap is refused.
//   - NAV keys (Up/Down/Left/Right) only move a highlight. They take the same fresh read but compare
//     the menu's IDENTITY (title + the keys it offers, and NOT the ←/→ row's live label) — because
//     moving the highlight is precisely what changes the signature, so a signature check would make
//     the second arrow tap in a row always fail. Nothing is committed, so identity is enough.
//
// Both semantics live in harness/menu-model.ts (menusEqual / menusSameIdentity) and are wired to this
// kind by harness/dialog-contract.ts; `nav` just picks which one the guard runs.

import { type MenuModel } from "./blocks";
import { sendGuardedKeys } from "./dialog-guard";
import type { ActionResult } from "./harness/guard";

/** The menu identity comparators, part of the neutral contract (harness/menu-model.ts). Re-exported
 *  under their original names so existing call sites and tests keep one import site. */
export { menusEqual, menusSameIdentity } from "./harness/menu-model";

/**
 * Run the guard and, if it passes, send `keys`. `nav: true` selects the identity-only comparison for
 * a non-committal arrow key (see the header). Pure of any UI — the caller maps the result to a
 * status message and a revalidation.
 */
export async function submitMenuKeys(args: {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered menu was detected against. */
  detectedRevision: number;
  menu: MenuModel;
  keys: string[];
  /** True for Up/Down/Left/Right: compare identity only, since the tap's own effect is the change. */
  nav?: boolean;
  /** The session the pane lives in (undefined = primary) — scopes the read + keystroke. */
  session?: string;
  /** Live pane-write permission, rechecked after the freshness guard and before the send. */
  canWrite: () => boolean;
  /** The pane's agent — which adapter re-derives the fresh screen. No adapter = the guard refuses. */
  agent?: string;
}): Promise<ActionResult> {
  return sendGuardedKeys(
    { ...args, kind: "menu", model: args.menu },
    args.keys,
    args.nav ? "identity" : "commits",
  );
}
