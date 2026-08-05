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

import type { StyledLine } from "../../blocks";
import { hasInputBox } from "./chrome";
import { classifyFooter, isBlank, isBoxBorder, isHorizontalRule, lineText } from "./markers";
import { regionSignature } from "./prompt-select";

/** One footer-named action, up-levelled into a tappable button. */
export interface MenuAction {
  /** The footer's own verb phrase, sentence-capitalised ("set as default" → "Set as default"). */
  label: string;
  /** The keys to send — always exactly the key the footer named, never a digit we inferred. */
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

/** The arrow affordances the region advertises (absent = the screen showed no sign of them). */
export interface MenuNav {
  /** A `❯`-highlighted row exists, so Up/Down move the selection. */
  upDown: boolean;
  /** The `←/→ to <verb>` row's verb + current value, when the region carries one. */
  leftRight?: MenuLeftRight;
}

/** A recognised generic menu: its title, the keys it named, and its freshness signature. */
export interface MenuModel {
  /** First non-blank line below the region's opening rule — e.g. "Select model". */
  title: string;
  actions: MenuAction[];
  nav: MenuNav;
  /**
   * A byte-signature of the region [rule … footer]. The race guard compares it so a tap on a stale
   * render (the highlight has since moved, or a different picker is up) can't fire its key at the
   * screen that replaced it. Herdr's `revision` is a stub, so this is the load-bearing check.
   */
  signature: string;
}

/** The detection result buildBlocks needs: the model plus `startLine`, the index of the region's
 *  opening rule. Everything above it stays raw. */
export interface MenuRegion {
  model: MenuModel;
  startLine: number;
}

// The footer's segment separator: a middle dot with space on both sides. Anchored on the spaces so a
// dot inside a value ("Haiku 4.5 · Fastest") in a BODY row can't be mistaken for a footer — only the
// footer line is ever split, and its hints are always spaced.
const SEGMENT_SPLIT = /\s+·\s+/;

// One hint segment: "<key token> to <verb phrase>". Non-greedy on the key so "Enter to set as
// default" yields "Enter" / "set as default" rather than swallowing the first "to".
const HINT = /^(.+?)\s+to\s+(.+)$/i;

// An "←/→ to <verb>" row inside the region (the `/model` picker's "◐ Medium effort ←/→ to adjust").
// Group 1 is everything left of the arrows — the value being adjusted; group 2 is the verb.
const ARROW_ROW = /^(.*?)\s*←\/→\s+to\s+(.+)$/;

// The pointer glyph marking the currently-highlighted row — its presence is what makes Up/Down
// meaningful (without a highlight there is nothing to move).
const POINTER = "❯";

// How far above the footer to look for the region's opening rule. Generous enough for a tall picker,
// bounded so a borderless buffer can't be claimed unboundedly — no rule within the window, no match.
const REGION_SCAN_WINDOW = 30;

/**
 * Map a footer's key TOKEN to a Herdr `pane.send_keys` key, or null when it isn't one we can send.
 * The whitelist is deliberately small (CLAUDE.md / HERDR_API.md — the grammar is `+`-joined, and
 * PageUp/Home/End/Delete are rejected upstream, so they are never emitted):
 *
 *   enter · esc/escape · tab · shift+tab · a bare lowercase letter · ↑ ↓ ← → · ctrl+<letter>
 *
 * NOT digits: see the header and .adr/0009. A digit token would be a valid Herdr key, which is
 * exactly why the ban has to live here rather than being left to the key validator.
 */
export function menuKeyFor(token: string): string | null {
  const raw = token.trim();
  const lower = raw.toLowerCase();
  if (lower === "enter") return "Enter";
  if (lower === "esc" || lower === "escape") return "Escape";
  if (lower === "tab") return "Tab";
  if (lower === "shift+tab") return "shift+tab";
  if (raw === "↑") return "Up";
  if (raw === "↓") return "Down";
  if (raw === "←") return "Left";
  if (raw === "→") return "Right";
  // A bare lowercase letter, matched case-SENSITIVELY: "S" and "s" are different keystrokes, and
  // Claude prints the one it means. An uppercase token is prose ("A" in "A to Z"), not a key hint.
  if (/^[a-z]$/.test(raw)) return raw;
  const ctrl = /^ctrl\+([a-z])$/.exec(lower);
  if (ctrl) return `ctrl+${ctrl[1]}`;
  return null;
}

/** Sentence-capitalise a footer verb phrase for a button label ("cancel" → "Cancel"). */
function capitalise(phrase: string): string {
  const t = phrase.trim();
  return t.length === 0 ? t : t[0]!.toUpperCase() + t.slice(1);
}

/**
 * Parse a KEY-HINT FOOTER into its actions. Returns `[]` when the line isn't one: fewer than two
 * `·`-separated segments, or no segment whose key token maps to a sendable key. A segment that
 * parses as a hint but names a key we can't send is SKIPPED (no button) rather than failing the
 * whole footer — the remaining hints are still honest, and the raw region stays visible below them.
 */
export function parseKeyHintFooter(text: string): MenuAction[] {
  const segments = text.trim().split(SEGMENT_SPLIT);
  if (segments.length < 2) return [];
  const actions: MenuAction[] = [];
  for (const segment of segments) {
    const m = HINT.exec(segment.trim());
    if (!m) continue;
    const key = menuKeyFor(m[1]!);
    if (key === null) continue;
    const action: MenuAction = { label: capitalise(m[2]!), keys: [key] };
    if (key === "Escape") action.cancel = true;
    actions.push(action);
  }
  return actions;
}

/**
 * Detect a generic menu at the tail of `lines`. Returns the model + its start line, or null.
 *
 * Ordered bails, cheapest and most decisive first:
 *   1. the last non-blank line must parse as a key-hint footer;
 *   2. `classifyFooter` must NOT claim it — the known dialog families keep their own grammars, which
 *      encode verified keystroke recipes this one cannot reproduce;
 *   3. there must be NO input box at the tail — a normal prompt screen whose statusline happens to
 *      read like hints is not a modal, and claiming it would put fake buttons under a live composer;
 *   4. a full-width rule / box border must sit within REGION_SCAN_WINDOW above the footer, and carry
 *      a non-blank title line under it.
 *
 * Pure; the caller owns pane access.
 */
export function detectMenuRegion(lines: StyledLine[]): MenuRegion | null {
  const texts = lines.map(lineText);

  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0) return null;

  const footer = texts[fi]!;
  if (classifyFooter(footer) !== null) return null;
  const actions = parseKeyHintFooter(footer);
  if (actions.length === 0) return null;
  if (hasInputBox(lines)) return null;

  // The region's top: the nearest rule/border above the footer. The picker draws one full-width rule
  // across the screen where its modal begins, which is the only structural boundary it offers.
  let top = -1;
  for (let i = fi - 1, seen = 0; i >= 0 && seen < REGION_SCAN_WINDOW; i--, seen++) {
    if (isBoxBorder(texts[i]!) || isHorizontalRule(texts[i]!)) {
      top = i;
      break;
    }
  }
  if (top < 0) return null;

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
      const arrow = ARROW_ROW.exec(t);
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

/** Herdr keys for the Up/Down highlight nav, when `nav.upDown` is set. */
export const MENU_UP_KEYS = ["Up"];
export const MENU_DOWN_KEYS = ["Down"];
/** Herdr keys for the `←/→` adjust nav, when `nav.leftRight` is set. */
export const MENU_LEFT_KEYS = ["Left"];
export const MENU_RIGHT_KEYS = ["Right"];
