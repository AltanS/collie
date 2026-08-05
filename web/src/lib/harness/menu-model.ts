// The MENU MODEL — the harness-NEUTRAL payload of a `menu` Block.
//
// A "menu" is the generic modal contract: a full-screen picker no specific dialog grammar owns
// (Claude's `/model` picker and its kin), driven ENTIRELY by the keys the screen printed in its own
// footer. Any adapter can produce one; the renderer (components/menu-block.tsx) and the race guard
// (lib/menu-action.ts) are written against these types alone, never against a harness's internals.
//
// Types only — no detection, no keys, no harness conventions. The shared derivation helpers live in
// menu-hints.ts; Claude's reference detector is harness/claude/menu.ts; the ban on synthesised digits
// is .adr/0009. This module imports nothing, so `lib/blocks.ts` can re-export it without a cycle.

/** One footer-named action, up-levelled into a tappable button. */
export interface MenuAction {
  /** The footer's own verb phrase, sentence-capitalised ("set as default" → "Set as default"). */
  label: string;
  /** The keys to send — always exactly the key the footer named, never a digit an adapter inferred. */
  keys: string[];
  /** The Esc segment: renders as the de-emphasised/ghost control rather than a peer action. */
  cancel?: boolean;
}

/** What an `←/→ to <verb>` row advertises: the verb, and the value the arrows act on. */
export interface MenuLeftRight {
  /** The verb the row named — "adjust" in "◐ Medium effort ←/→ to adjust". */
  verb: string;
  /**
   * The row's leading text, trimmed — "◐ Medium effort". This is the CURRENT VALUE of whatever the
   * arrows adjust, so it changes every time one is pressed; detection re-runs each poll, so the UI
   * label tracks it. Never compare it for menu identity (lib/menu-action.ts).
   */
  label: string;
}

/** The arrow affordances the screen advertises (absent = it showed no sign of them). Never assumed:
 *  an adapter sets these only where the screen itself said the arrows do something. */
export interface MenuNav {
  /** A highlighted row exists, so Up/Down move the selection. */
  upDown: boolean;
  /** The `←/→ to <verb>` row's verb + current value, when the screen carries one. */
  leftRight?: MenuLeftRight;
}

/** A recognised generic menu: its title, the keys it named, and its freshness signature. */
export interface MenuModel {
  /** The screen's own heading — e.g. "Select model". */
  title: string;
  actions: MenuAction[];
  nav: MenuNav;
  /**
   * A byte-signature of the region the menu was derived from. The race guard compares it so a tap on
   * a stale render (the highlight has since moved, or a different picker is up) can't fire its key at
   * the screen that replaced it. Herdr's `revision` is a stub, so this is the load-bearing check —
   * it MUST be non-empty and MUST change when the region's text changes.
   */
  signature: string;
}
