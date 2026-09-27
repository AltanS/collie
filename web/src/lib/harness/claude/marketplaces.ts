// The `/plugin` MARKETPLACES grammar: the Marketplaces tab of Claude Code's plugin manager, and the
// detail screen that one of its rows opens.
//
// Claude Code 2.1.283 paints the tab as a list under its own title, `Manage marketplaces`:
//
//       Manage marketplaces
//
//     ❯ + Add Marketplace
//
//       ● lab-market
//         /tmp/plugins-lab/lab-market
//         6 available • 6 installed • Updated 9/27/2026
//
//     Enter to select · u to update · d to remove · Esc to go back
//
// `u` marks the pointed row `[UPDATE]` and the footer becomes `Enter to apply changes · Esc to
// cancel`. Enter on a marketplace opens its detail screen: a header, the installed plugins, then the
// action rows and a footer of their own:
//
//       lab-market                                  <- the marketplace's name, the card's title
//       /tmp/plugins-lab/lab-market
//
//       6 available plugins
//       … the installed plugins, often dozens of rows …
//
//     ❯ Browse plugins (6)
//       Update marketplace (last updated 9/27/2026)
//       Remove marketplace
//
//     Enter to select · Esc to go back
//
// WHY A GRAMMAR OF ITS OWN. Both footers open with "Enter to select", which `classifyFooter` files as
// the AskUserQuestion family, so the generic menu (menu.ts) stood aside for an owner that was not
// there: the question grammars read numbered options, and these lists have none. The phone showed
// the unread-dialog card with Escape alone, and the operator could not press `u`. The detail screen
// had a second problem: once a marketplace holds a few plugins, its header sits further above the
// footer than the generic region scan reaches. So this grammar recognises both screens by their own
// words (ADR 0053: a claim is answered from the dialog, never from one phrase any screen may print),
// runs before the generic menu, and changes nothing the generic menu reads.
//
// ONLY KEYS THE SCREEN PRINTED, AND FEWER (.adr/0009). Every action comes from the footer, read across
// the rows a narrow pane wraps it onto (`readKeyHintFooter`), plus Up/Down for the `❯`. Nothing the
// screen did not print is added. Two printed keys are WITHHELD, for one reason: remove is destructive,
// and the `Press y to confirm or n to cancel` screen it opens is one the phone cannot read.
//   * the tab footer's `d to remove`;
//   * Enter on the detail screen while the `❯` sits on `Remove marketplace`, which opens the same
//     confirm. The arrows stay, so the operator can walk back up to a row Enter is offered on.
// The Keys drawer still reaches both.
//
// THE REGION IS THE WHOLE MODAL, from the `─` rule (classic renderer) or `▔` edge (full-screen
// renderer) the plugin manager opens with, down to the footer, as the generic menu draws it. Two
// things ride on that. The rule and the edge are drawn at the pane's width, so a region read at one
// width is never accepted at another; and the detail screen's region holds the marketplace's name,
// so a tap bound to one marketplace is refused on another whose action rows read the same.
//
// FAIL CLOSED. The tab needs its title, the `+ Add Marketplace` row and exactly one `❯` between the
// title and the footer. The detail screen needs `Browse plugins (N)` … `Remove marketplace` as one
// block of rows above the footer with exactly one `❯` in it, and the header's `N available plugins`
// row above that, which is where its title comes from. Both need the rule or edge a few rows above
// their title. Any piece missing returns null, and the generic menu runs as before. In Claude's
// full-screen renderer a detail screen taller than the pane is clipped at the bottom: its footer is
// not on screen, so it names no keys and this grammar reads nothing from it.
//
// Pure functions over `StyledLine[]`, tail-anchored like every other Claude grammar.

import type { StyledLine } from "../../blocks";
import { hasInputBox } from "./chrome";
import { isBlank, isBoxBorder, isHorizontalRule, lineText } from "./markers";
import type { MenuRegion } from "./menu";
import { regionSignature } from "./prompt-select";
import { isModalEdge } from "./region-top";
import { displayWidth } from "../../text-width";
import type { MenuAction, MenuModel } from "../menu-model";
import { readKeyHintFooter, type KeyHintFooter } from "../menu-hints";

/** The tab's own title, on a row of its own. */
const TAB_TITLE = "Manage marketplaces";

/** The tab's first row, pointed or not. It is always there, whatever marketplaces are configured. */
const ADD_ROW = "+ Add Marketplace";

/** How far above the footer the tab's title may sit. A handful of marketplaces is a few rows each;
 *  the bound keeps a title somewhere in the scrollback from counting. */
const TAB_SCAN_WINDOW = 60;

/** The detail screen's first and last action rows, and the one between them this grammar is for. An
 *  `Enable auto-update` / `Disable auto-update` row may sit between them too. */
const BROWSE_ROW = /^Browse plugins \(\d+\)$/;
const UPDATE_ROW = /^Update marketplace\b/;
const REMOVE_ROW = "Remove marketplace";

/** How many rows the action block may span: four actions, each wrapped onto a second row at 40
 *  columns (`Update marketplace (last updated` over `9/27/2026)`). */
const ACTION_BLOCK_ROWS = 8;

/** How far above the footer the `Remove marketplace` row may sit. Between them: blank rows, and a
 *  note that wraps onto a few rows on a narrow pane ("Auto-update enabled. Claude Code will
 *  automatically update this marketplace and its installed plugins."). */
const NOTE_WINDOW = 10;

/** The header row the title is read above: `6 available plugins`, or `1 available plugin`. */
const AVAILABLE_ROW = /^\d+ available plugins?$/;

/** How far above the action block the header may sit. The installed plugins run between them, three
 *  or four rows each on a narrow pane, so this is the bridge's own default read (COLLIE_READ_LINES). */
const HEADER_WINDOW = 200;

/** How many rows the name and its source may span: the name, the source, and the source wrapped once. */
const NAME_BLOCK_ROWS = 3;

/** How far above the title (the tab's, or the detail screen's name) the modal's rule or edge may sit:
 *  the edge, the tab row (wrapped onto two rows at 40 columns), and a blank row. */
const EDGE_ROWS = 6;

/** A `▔` edge whose label crowds out its left run: at 40 columns the full-screen renderer prints
 *  ` Plugins changed. Run /reload-plugins… ▔` after a marketplace update, and region-top.ts's edge
 *  shape wants the row to open with `▔`. The label, then one closing `▔` run. */
const CROWDED_EDGE = /^\s?\S.*\s▔+$/u;

/** The list's pointer. */
const POINTER = "❯";

/** A footer action this grammar never offers, by its verb: remove opens a confirm the phone cannot
 *  read (see the header). */
const WITHHELD = /^remove\b/i;

/** A row's text with its indent and its `❯` pointer removed. */
function optionText(text: string): string {
  const t = text.trim();
  return t.startsWith(POINTER) ? t.slice(POINTER.length).trim() : t;
}

/** Whether a row carries the list's `❯` pointer. */
function isPointed(text: string): boolean {
  return text.trimStart().startsWith(POINTER);
}

/** The row the modal opens with, a few rows above `from`: a `─` rule or box border, or a `▔` edge. */
function modalTop(texts: string[], from: number, footerLine: number): number | null {
  for (let i = from - 1; i >= 0 && from - i <= EDGE_ROWS; i--) {
    const t = texts[i]!;
    if (isHorizontalRule(t) || isBoxBorder(t) || isModalEdge(texts, i, footerLine)) return i;
    if (isCrowdedEdge(texts, i, footerLine)) return i;
  }
  return null;
}

/** A crowded `▔` edge (CROWDED_EDGE) that spans the modal: no row between it and the footer is wider,
 *  the same full-width test region-top.ts applies to an edge. */
function isCrowdedEdge(texts: string[], i: number, footerLine: number): boolean {
  const row = texts[i]!.trimEnd();
  if (!CROWDED_EDGE.test(row)) return false;
  const width = displayWidth(row);
  for (let j = i + 1; j <= footerLine; j++) {
    if (displayWidth(texts[j]!.trimEnd()) > width) return false;
  }
  return true;
}

/** The footer's actions, minus the withheld ones. */
function offered(footer: KeyHintFooter): MenuAction[] {
  return footer.actions.filter((a) => !WITHHELD.test(a.label));
}

/**
 * Detect the Marketplaces tab or a marketplace's detail screen at the tail of `lines`. Returns a
 * `menu` model and the index of the region's first row, or null when any evidence is missing.
 */
export function detectMarketplacesRegion(lines: StyledLine[]): MenuRegion | null {
  const texts = lines.map(lineText);
  const footer = readKeyHintFooter(texts);
  if (footer === null) return null;
  // A modal, never a live composer: buttons over an input box are worse than none (menu.ts).
  if (hasInputBox(lines)) return null;
  return tabRegion(texts, footer) ?? detailRegion(texts, footer);
}

/** The Marketplaces tab, in its list state or its pending-changes state. */
function tabRegion(texts: string[], footer: KeyHintFooter): MenuRegion | null {
  let titleAt = -1;
  for (let i = footer.startLine - 1, seen = 0; i >= 0 && seen < TAB_SCAN_WINDOW; i--, seen++) {
    if (texts[i]!.trim() === TAB_TITLE) {
      titleAt = i;
      break;
    }
  }
  if (titleAt < 0) return null;
  const rows = texts.slice(titleAt + 1, footer.startLine);
  if (!rows.some((t) => optionText(t) === ADD_ROW)) return null;
  if (rows.filter(isPointed).length !== 1) return null;
  const top = modalTop(texts, titleAt, footer.endLine);
  if (top === null) return null;

  const actions = offered(footer);
  if (actions.length === 0) return null;
  const model: MenuModel = {
    title: TAB_TITLE,
    actions,
    nav: { upDown: true },
    signature: regionSignature(texts, top, footer.endLine),
  };
  return { model, startLine: top };
}

/** A marketplace's detail screen. */
function detailRegion(texts: string[], footer: KeyHintFooter): MenuRegion | null {
  // 1. The last action row, with nothing but blank rows and a note between it and the footer. A
  //    pointer on the way up is some other list.
  let removeAt = -1;
  for (let i = footer.startLine - 1, seen = 0; i >= 0 && seen < NOTE_WINDOW; i--, seen++) {
    if (optionText(texts[i]!) === REMOVE_ROW) {
      removeAt = i;
      break;
    }
    if (isPointed(texts[i]!)) return null;
  }
  if (removeAt < 0) return null;

  // 2. The block: `Browse plugins (N)` above it, every row between them non-blank.
  let first = -1;
  for (let i = removeAt - 1; i >= 0 && removeAt - i < ACTION_BLOCK_ROWS; i--) {
    if (isBlank(texts[i]!)) break;
    if (BROWSE_ROW.test(optionText(texts[i]!))) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  const block = texts.slice(first, removeAt + 1);
  if (!block.some((t) => UPDATE_ROW.test(optionText(t)))) return null;
  const pointed = block.filter(isPointed);
  if (pointed.length !== 1) return null;

  // 3. The title: the marketplace's name, from the header. The region opens above it.
  const nameAt = headerName(texts, first);
  if (nameAt === null) return null;
  const top = modalTop(texts, nameAt, footer.endLine);
  if (top === null) return null;

  const onRemove = optionText(pointed[0]!) === REMOVE_ROW;
  const actions = offered(footer).filter((a) => !(onRemove && a.keys.includes("Enter")));
  if (actions.length === 0) return null;
  const model: MenuModel = {
    title: texts[nameAt]!.trim(),
    actions,
    nav: { upDown: true },
    signature: regionSignature(texts, top, footer.endLine),
  };
  return { model, startLine: top };
}

/**
 * The row holding the marketplace's name: the first row of the name-and-source block above the
 * header's `N available plugins` row. Null when that row is not within HEADER_WINDOW above the
 * actions, or when the block above it is not a short block standing on its own.
 */
function headerName(texts: string[], actionsAt: number): number | null {
  for (let i = actionsAt - 1, seen = 0; i >= 0 && seen < HEADER_WINDOW; i--, seen++) {
    if (!AVAILABLE_ROW.test(texts[i]!.trim())) continue;
    let end = i - 1;
    while (end >= 0 && isBlank(texts[end]!)) end--;
    if (end < 0 || end === i - 1) return null;
    let top = end;
    while (top > 0 && !isBlank(texts[top - 1]!)) {
      top--;
      if (end - top >= NAME_BLOCK_ROWS) return null;
    }
    return top;
  }
  return null;
}

/** The model alone (or null), the thin matcher the tests and the binding contract use. */
export function detectMarketplaces(lines: StyledLine[]): MenuModel | null {
  return detectMarketplacesRegion(lines)?.model ?? null;
}
