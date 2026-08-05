// The SHARED menu derivation helpers — the harness-agnostic half of the generic modal contract
// (menu-model.ts). Any adapter that wants menu buttons builds its MenuModel with these; only the
// harness-SPECIFIC conventions (where the region starts, what counts as its tail, how the input box
// is detected) belong in the adapter. Claude's reference detector: harness/claude/menu.ts.
//
// The invariants these encode, which the conformance suite (conformance.ts) re-checks against every
// adapter's fixture corpus:
//
//   * ONLY KEYS THE SCREEN NAMED. A menu is claimed on the strength of the screen naming its own
//     keys in a `·`-separated "<key> to <verb>" footer. Every emitted action key comes from that
//     footer; the only keys added are the ARROWS the screen advertised. Nothing is inferred.
//   * NO DIGITS, EVER (.adr/0009). Live-probed in Claude's `/model` picker: a digit confirms AND
//     writes the choice to the user's default for new sessions. A digit is a valid Herdr key, so
//     nothing downstream would reject one — the ban has to live in `menuKeyFor`.
//   * SIGNATURE FRESHNESS. The model carries a byte-signature of its region and every send re-derives
//     and compares it (lib/menu-action.ts). An adapter that returns an empty or constant signature
//     silently disables the race guard.
//   * LAST RESORT. Menu detection runs AFTER every specific grammar the adapter has, and must not
//     claim a screen with a live input box — a normal prompt whose statusline reads like hints is not
//     a modal, and claiming it would put fake buttons under a live composer.
//
// Pure functions over strings; no React, no pane access, no harness imports.

import type { MenuAction } from "./menu-model";

// The footer's segment separator: a middle dot with space on both sides. Anchored on the spaces so a
// dot inside a value ("Haiku 4.5 · Fastest") in a BODY row can't be mistaken for a footer — only the
// footer line is ever split, and its hints are always spaced.
const SEGMENT_SPLIT = /\s+·\s+/;

// One hint segment: "<key token> to <verb phrase>". Non-greedy on the key so "Enter to set as
// default" yields "Enter" / "set as default" rather than swallowing the first "to".
const HINT = /^(.+?)\s+to\s+(.+)$/i;

/** An "<value> ←/→ to <verb>" row. Group 1 is everything left of the arrows — the value being
 *  adjusted; group 2 is the verb. Exported so an adapter scans its region rows with the same grammar. */
export const MENU_ARROW_ROW = /^(.*?)\s*←\/→\s+to\s+(.+)$/;

/** Herdr keys for the Up/Down highlight nav, when `nav.upDown` is set. */
export const MENU_UP_KEYS = ["Up"];
export const MENU_DOWN_KEYS = ["Down"];
/** Herdr keys for the `←/→` adjust nav, when `nav.leftRight` is set. */
export const MENU_LEFT_KEYS = ["Left"];
export const MENU_RIGHT_KEYS = ["Right"];

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
export function capitaliseMenuLabel(phrase: string): string {
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
    const action: MenuAction = { label: capitaliseMenuLabel(m[2]!), keys: [key] };
    if (key === "Escape") action.cancel = true;
    actions.push(action);
  }
  return actions;
}
