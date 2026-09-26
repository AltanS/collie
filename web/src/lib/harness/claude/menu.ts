// The GENERIC menu grammar — the LAST-RESORT detector for a modal screen no specific grammar owns.
//
// Claude Code paints a growing family of full-screen pickers (`/model`, and whatever ships next)
// that are not AskUserQuestion dialogs: they have no numbered-menu recipe, no `Enter to select`
// footer, and — the part that bit us — no input box at the tail. Before this grammar existed, none
// of the specific detectors claimed the `/model` picker, so Collie showed no buttons, `dialogPresent`
// stayed false, and a composer send typed the user's message straight INTO the picker.
//
// What makes a generic claim safe is that the screen NAMES ITS OWN KEYS: the footer is a
// `·`-separated list of "<key> to <verb>" hints ("Enter to set as default · s to use this session
// only · Esc to cancel"). We up-level exactly those hints into buttons, plus the arrow navigation the
// region advertises. We invent nothing.
//
// DIGITS ARE NEVER SYNTHESISED (.adr/0009). Live-probed 2026-08-05: pressing a digit in the `/model`
// picker confirms instantly AND writes the choice to the user's default for new sessions. A digit is
// therefore an unrecoverable, unprompted-for side effect on a screen whose semantics we do not know —
// so this grammar only ever emits keys the screen itself printed, plus the arrows that move a
// highlight.
//
// Pure functions over `StyledLine[]`, tail-anchored exactly like prompt-select.ts: the footer must be
// the LAST non-blank line, so a picker that has scrolled up simply doesn't match.
//
// THIS FILE IS THE REFERENCE IMPLEMENTATION OF THE GENERIC MODAL CONTRACT, not its definition. The
// model (../menu-model.ts) and the harness-agnostic derivation — footer-hint parsing, the key
// whitelist, label capitalisation, the arrow-row grammar and key constants (../menu-hints.ts) — are
// shared, so another adapter implements menus by supplying its OWN conventions only: where its region
// starts (Claude: the nearest rule/border above the footer, or the `▔` modal edge newer builds open a
// modal with, ./region-top.ts), what its tail is, and how it knows an input box is on screen (Claude:
// ./chrome). See HARNESS_CONTRIBUTING.md → "Menus (generic modals)".

import type { StyledLine } from "../../blocks";
import { hasInputBox } from "./chrome";
import { classifyFooter, isBlank, lineText } from "./markers";
import { regionSignature } from "./prompt-select";
import { findRegionTop } from "./region-top";
import type { MenuAction, MenuModel, MenuNav } from "../menu-model";
import { capitaliseMenuLabel, MENU_ARROW_ROW, parseKeyHintFooter, parseSingleHint, readKeyHintFooter } from "../menu-hints";

/** The detection result buildBlocks needs: the model plus `startLine`, the index of the region's
 *  opening rule. Everything above it stays raw. */
export interface MenuRegion {
  model: MenuModel;
  startLine: number;
}

// The pointer glyph marking the currently-highlighted row — its presence is what makes Up/Down
// meaningful (without a highlight there is nothing to move).
const POINTER = "❯";

// A footer of ONE hint that names Esc: "Esc to cancel", "Esc to close". parseKeyHintFooter refuses a
// single segment, because one "<key> to <verb>" phrase is too little to call a screen a menu. Claude
// Code 2.1.283's info panels (`/status`, `/usage`) and its `/export` and `/login` pickers print
// nothing else, so they fell to the unread-dialog card. The claim is taken only under a `▔` modal
// edge (region-top.ts), a mark Claude draws for its own modals and nothing else, and only when the
// hint is the WHOLE footer: the last row of a WRAPPED footer ("↑/↓ to select · Enter to view ·" over
// "Esc to close", /tasks at 40 columns) is never read as all of it (readKeyHintFooter joins the rows
// a footer wrapped onto, and a group that starts above the last row is not a lone hint).
/** The one Cancel action a single-hint "Esc to <verb>" footer names, or null. */
function escOnlyFooter(footer: string): MenuAction | null {
  const hint = parseSingleHint(footer);
  if (hint === null || hint.key !== "Escape") return null;
  return { label: capitaliseMenuLabel(hint.verb), keys: ["Escape"], cancel: true };
}

/**
 * Detect a generic menu at the tail of `lines`. Returns the model + its start line, or null.
 *
 * Ordered bails, cheapest and most decisive first:
 *   1. the last non-blank line must parse as a key-hint footer, or be a single "Esc to <verb>" hint
 *      (escOnlyFooter), which step 4 accepts only under a `▔` modal edge;
 *   2. `classifyFooter` must NOT claim it — the known dialog families keep their own grammars, which
 *      encode verified keystroke recipes this one cannot reproduce. The whole screen goes to that
 *      call, not the footer alone: a claim here means "somebody else owns this", so it has to be
 *      answerable from the dialog, never from one phrase any screen may print (ADR 0053);
 *   3. there must be NO input box at the tail — a normal prompt screen whose statusline happens to
 *      read like hints is not a modal, and claiming it would put fake buttons under a live composer;
 *   4. the region's top must be found (region-top.ts): the nearest `─` rule / box border within
 *      REGION_SCAN_WINDOW above the footer, or a full-width `▔` modal edge within MODAL_EDGE_WINDOW,
 *      and it must carry a non-blank title line under it.
 *
 * Pure; the caller owns pane access.
 */
export function detectMenuRegion(lines: StyledLine[]): MenuRegion | null {
  const texts = lines.map(lineText);

  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0) return null;

  const footer = texts[fi]!;
  if (classifyFooter(footer, texts) !== null) return null;
  let actions = parseKeyHintFooter(footer);
  const escOnly = actions.length === 0 ? escOnlyFooter(footer) : null;
  if (actions.length === 0 && escOnly === null) return null;
  if (hasInputBox(lines)) return null;

  // The region's top: the nearest rule/border above the footer, or the `▔` edge a newer Claude opens
  // its modal with. The picker draws one full-width row across the screen where its modal begins,
  // which is the only structural boundary it offers.
  const region = findRegionTop(texts, fi);
  if (region === null) return null;
  const top = region.line;
  if (escOnly !== null) {
    if (!region.edge || (readKeyHintFooter(texts)?.startLine ?? fi) < fi) return null;
    actions = [escOnly];
  }

  // Title = the first non-blank line under the rule. A rule with nothing but the footer beneath it
  // is not a menu we can name, so bail rather than render an untitled panel.
  let title = "";
  for (let i = top + 1; i < fi; i++) {
    if (!isBlank(texts[i]!)) {
      title = texts[i]!.trim();
      break;
    }
  }
  if (title === "") return null;

  // Affordances advertised INSIDE the region (never assumed): a highlighted row means Up/Down do
  // something; an "←/→ to adjust" row means Left/Right do, and names what.
  const nav: MenuNav = { upDown: false };
  for (let i = top + 1; i < fi; i++) {
    const t = texts[i]!;
    if (t.includes(POINTER)) nav.upDown = true;
    if (nav.leftRight === undefined) {
      const arrow = MENU_ARROW_ROW.exec(t);
      if (arrow) nav.leftRight = { verb: arrow[2]!.trim(), label: arrow[1]!.trim() };
    }
  }

  return {
    model: { title, actions, nav, signature: regionSignature(texts, top, fi) },
    startLine: top,
  };
}

/** Detect a generic menu at the tail of `lines`, returning just the model (or null) — the thin
 *  matcher the race guard re-derives with, and the one tests assert on. */
export function detectMenu(lines: StyledLine[]): MenuModel | null {
  return detectMenuRegion(lines)?.model ?? null;
}
