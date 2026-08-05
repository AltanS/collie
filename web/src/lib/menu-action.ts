// The generic-menu race guard — prompt-action's philosophy applied to the last-resort menu grammar
// (harness/claude/menu.ts). A menu button types into a REAL terminal on a screen whose semantics we
// only know from its own footer, so the guard here is the STRICTEST of the family, not the loosest:
// before any key goes out we re-fetch the pane, check the revision, and require the freshly-derived
// menu to be signature-identical to the one the user tapped.
//
// The split below is the one judgement call:
//   - ACTION keys (Enter / s / whatever the footer named) COMMIT. In the `/model` picker, Enter
//     writes the user's default for new sessions. These take the full signature check — a highlight
//     that moved between render and tap changes the signature, so a stale tap is refused outright.
//   - NAV keys (Up/Down/Left/Right) only move a highlight. They take the same fresh read but compare
//     only the menu's IDENTITY (title + the keys it offers), not the signature — because moving the
//     highlight is precisely what changes the signature, so a signature check would make the second
//     arrow tap in a row always fail. Nothing is committed, so identity is enough.

import { sendKeys } from "./api";
import { type MenuModel } from "./blocks";
import { detectMenu } from "./harness/claude/menu";
import { entryGuard, type ActionResult } from "./harness/guard";

/** Whether two derivations are the SAME on-screen menu — the decisive check for a committing key.
 *  `signature` (the region's text, highlight included) is what makes it decisive; the title/action
 *  comparison stays as a cheap fast-path and to keep the intent explicit. */
export function menusEqual(a: MenuModel, b: MenuModel): boolean {
  return a.signature === b.signature && menusSameIdentity(a, b);
}

/** Whether two derivations are the same menu SCREEN, ignoring which row is highlighted. The weaker
 *  comparison the non-committal arrow keys use — a moved highlight is the expected outcome of the
 *  previous arrow tap, not evidence the screen changed underneath us. */
export function menusSameIdentity(a: MenuModel, b: MenuModel): boolean {
  return (
    a.title === b.title &&
    a.nav.upDown === b.nav.upDown &&
    a.nav.leftRight === b.nav.leftRight &&
    a.actions.length === b.actions.length &&
    a.actions.every(
      (x, i) =>
        x.label === b.actions[i]!.label &&
        x.keys.length === b.actions[i]!.keys.length &&
        x.keys.every((k, j) => k === b.actions[i]!.keys[j]),
    )
  );
}

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
}): Promise<ActionResult> {
  const { paneId, menu, keys, session } = args;

  const guarded = await entryGuard(
    args,
    menu,
    detectMenu,
    args.nav ? menusSameIdentity : menusEqual,
    (model) => model.signature,
  );
  if (!guarded.ok) return guarded.result;

  try {
    const res = await sendKeys(paneId, keys, session, guarded.region);
    if (!res.ok && res.code === "prompt_changed") return { status: "changed" };
    if (!res.ok) return { status: "error", error: res.error };
    return { status: "sent" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
