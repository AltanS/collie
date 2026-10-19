// Muse's BELOW-BOX pickers as generic menus (MUSE-14; Muse Code 1.4.10, live 2026-10-19).
//
// `/model`, `/export` and their kin do not paint over the transcript the way the four dialogs do.
// The composer frame stays (Voice rule, a BARE `❯`, the bottom rule) and the picker takes the
// statusline's place UNDER it:
//
//     ── Voice input (⌥ + v to start) ──…
//     ❯
//     ─────────────────────────────
//       Choose model
//
//       muse-wonder-1.0
//     ⟩ muse-wonder-full-1.0
//       muse-spark-1.3
//
//       ↑↓ move · enter confirm · esc go back    ← last row; no statusline under it
//
// The footer grammar is Muse's own — `·`-separated "<key> <verb>", NOT Claude's "<key> to <verb>"
// (menu-hints.ts), so Claude's parser reads zero actions here and this module supplies only the
// Muse-specific half: the region geometry and the footer tokens. The model is the shared
// MenuModel, so the phone guard (menusEqual for a committing key, menusSameIdentity for arrows)
// and the bridge's menu plan work unchanged.
//
// MEASURED, AND ONLY THIS, IS CLAIMED (captures muse--menu-model{,-moved}.txt, muse--menu-export.txt):
//
//   * the exact frame above — Voice rule, strictly bare `❯`, bottom rule, each directly over the
//     next. A draft in the box, or a missing Voice rule, is a shape no capture shows a picker in,
//     so it declines rather than generalising;
//   * a title row directly under the rule, a blank under it, then 2+ option rows (unpointed
//     `  …`, exactly one pointed `⟩ …` at column 0) down to the footer as the last non-blank row;
//   * footer segments whose key tokens are exactly `↑↓` (verb `move` → nav only, never an action),
//     `enter` (→ Enter) and `esc` (→ Escape, cancel), one of each. ANY other segment declines the
//     whole screen: that is what keeps `/effort`/`/hud` (`type to filter`, `enter/space toggle`)
//     and `/settings` (`tab/enter change`) out until their own grammars are measured.
//
// DELIBERATELY DECLINED (each needs its own captures before it can lift): a `filter` row under the
// title — the field is focused from open and typed keys filter instead of answering (MUSE-16,
// fixture muse--menu-effort-filter.txt); numbered options (`/permissions` — digits never probed,
// .adr/0009); `[ ]`/`[x]` rows (`/skills` — multi-select semantics); a `↓ N more` scroll row
// (walk geometry across a scrolling window is unmeasured); dash-separated and full-screen
// footers (`/theme`, `/subagents`, …) and footerless screens (`/rewind`) — none of those even
// reach the footer parse.
//
// The signature spans title → footer, pointer glyph included: the glyph is TEXT here (not
// style-only), so a moved highlight changes the signature and refuses a stale committing tap,
// while menusSameIdentity (title + actions + nav) still lets the next arrow through. Proven on
// the real capture pair in menu.test.ts — Down moved `⟩` from muse-wonder-full-1.0 to
// muse-spark-1.3; Escape restored the idle tail with model and effort unchanged.

import { lineText, type StyledLine } from "../../blocks";
import { capitaliseMenuLabel, SEGMENT_SPLIT } from "../menu-hints";
import type { MenuAction, MenuModel } from "../menu-model";
import {
  isBottomRule,
  isVoiceRule,
  lastNonBlankIndex,
  promptRowText,
  regionSignature,
  rstrip,
} from "./markers";

/** The detection result buildBlocks needs: the model plus the Voice-rule row the lift starts at. */
export interface MenuRegion {
  model: MenuModel;
  startLine: number;
}

// One footer segment: "<key token> <verb phrase>". The token has no spaces by construction —
// `type to filter` tokenises as `type`, which is not a measured key, so the segment declines.
const SEGMENT = /^(\S+)\s+(.+)$/;

const POINTED = /^⟩ \S/;
const UNPOINTED = /^ {2}\S/;
// Option-row shapes another grammar owns, or none does yet: numbered (permissions), checkbox
// (skills), a scroll-window marker, and the filter field itself.
const FOREIGN_ROW = /^(?:\d+\.\s|\[[ xX]\]\s|↓ \d+ more(?:\s|$)|filter$)/;

// How many option rows a claimed picker may show. The captures hold 2 and 4; the bound only
// stops a transcript-shaped run under a coincidental frame from being read as one long list.
const MAX_OPTION_ROWS = 40;

/**
 * Parse the Muse footer into its actions plus the nav claim, or null when any segment is not one
 * of the three measured hints. `↑↓ move` yields NO action — the arrows it advertises are the
 * nav, sent one at a time through menusSameIdentity, never as a button.
 */
function parseMenuFooter(text: string): MenuAction[] | null {
  const segments = text.trim().split(SEGMENT_SPLIT);
  if (segments.length < 2) return null;
  const actions: MenuAction[] = [];
  let move = false;
  let enter = false;
  let esc = false;
  for (const segment of segments) {
    const m = SEGMENT.exec(segment.trim());
    if (m === null) return null;
    const token = m[1]!;
    const verb = m[2]!.trim();
    if (verb === "") return null;
    if (token === "↑↓") {
      if (move || verb !== "move") return null;
      move = true;
    } else if (token === "enter") {
      if (enter) return null;
      enter = true;
      actions.push({ label: capitaliseMenuLabel(verb), keys: ["Enter"] });
    } else if (token === "esc") {
      if (esc) return null;
      esc = true;
      actions.push({ label: capitaliseMenuLabel(verb), keys: ["Escape"], cancel: true });
    } else {
      return null;
    }
  }
  return move && enter && esc ? actions : null;
}

/** Whether an option row carries a shape this grammar declines, pointer glyph aside. */
function isForeignRow(row: string): boolean {
  return FOREIGN_ROW.test(row.trim().replace(/^⟩\s+/, ""));
}

/**
 * Detect a below-box picker at the tail, or null. Bottom-up; every step can only REJECT, and
 * each index must sit exactly where the captures put it — no scanning for a plausible frame
 * further up, because a quoted picker in the transcript would have one.
 */
export function detectMenuRegion(lines: StyledLine[]): MenuRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const footer = lastNonBlankIndex(texts);
  if (footer < 0) return null;
  const actions = parseMenuFooter(texts[footer]!);
  if (actions === null) return null;

  // The title, found by the frame it hangs from: bottom rule directly above it, a strictly
  // bare `❯` above that (a live modal's box holds neither draft nor placeholder tip), Voice
  // rule above that, and a blank directly below it. The title row alone is just another
  // 2-space row — only the frame at these exact offsets makes it one, so the search tries
  // each candidate row in reach and lets the frame decide. That is also what excludes
  // `/effort`: its candidate title has the `filter` row, not a blank, directly under it.
  let title = -1;
  for (let i = footer - 3; i >= 3 && footer - i <= MAX_OPTION_ROWS + 8; i--) {
    if (!UNPOINTED.test(texts[i]!) || isForeignRow(texts[i]!)) continue;
    if (texts[i + 1]!.trim() !== "") continue;
    if (!isBottomRule(texts[i - 1]!)) continue;
    if (promptRowText(texts[i - 2]!)?.trim() !== "") continue;
    if (!isVoiceRule(texts[i - 3]!)) continue;
    title = i;
    break;
  }
  if (title < 0) return null;
  const voice = title - 3;

  // Between title and footer, the option rows: at least two, exactly one pointed, every
  // non-blank row in one of the two measured shapes and none carrying another grammar's
  // prefix. Blank rows inside the span are stepped over — both captures paint one directly
  // above the footer, and the blank carries no key evidence (the footer parse and the frame
  // anchor the claim); conformance.ts splices a body row in above the footer and still
  // expects the lift, with a moved signature.
  let pointed = 0;
  let optionCount = 0;
  for (let i = title + 2; i < footer; i++) {
    const row = texts[i]!;
    if (row.trim() === "") continue;
    if (POINTED.test(row)) pointed++;
    else if (!UNPOINTED.test(row)) return null;
    if (isForeignRow(row)) return null;
    optionCount++;
  }
  if (pointed !== 1 || optionCount < 2 || optionCount > MAX_OPTION_ROWS) return null;

  const signature = regionSignature(texts, title, footer);
  if (signature === "") return null;
  return {
    model: {
      title: texts[title]!.trim(),
      actions,
      nav: { upDown: true },
      signature,
    },
    // The lift starts at the Voice rule so the card carries its own frame and the rows kept
    // raw above it are transcript alone — a bare `❯` and a rule left there would read as a
    // live composer the picker has in fact replaced.
    startLine: voice,
  };
}

/** The model alone, for callers that only ask whether a picker owns the screen. */
export function detectMenu(lines: StyledLine[]): MenuModel | null {
  return detectMenuRegion(lines)?.model ?? null;
}
