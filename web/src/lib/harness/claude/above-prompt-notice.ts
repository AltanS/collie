// Claude Code's built-in "Heads up" notice (the `you-should-know` plugin, measured on 2.1.302): a
// head row, its wrapped text and one row of keys, drawn ABOVE the input box while the box keeps focus.
//
//   ✦ Heads up · With GitHub triggers, anyone who files an issue on your public repos can put text …
//     on your main PC.
//     1: Learn more   2: Knew this already   0: Dismiss
//
// Its keys act only when the box's whole value is one printed digit: the plugin fires after a moment
// and clears the box, with no Enter. So the box stays live under it, and this card is a `menu` whose
// model says so (`liveBox`): it owns no keyboard, and its buttons are the printed digits alone, in the
// printed order (ADR 0009: a key comes only from what the row prints). The shape itself is read once,
// by surface/notice.ts, the same reader the Surface and the bridge's send gate use.
//
// The session rating survey is the second shape the profile names (ADR 0109 addendum, 2026-10-19):
//
//   ● How is Claude doing this session? (optional)
//     1: Bad    2: Fine   3: Good   0: Dismiss
//
// often with the update row (`✔ Update installed · Restart to update`, or `/restart to apply` where
// Claude Code offers the command) between its keys and the box.

import { lineText, type StyledLine } from "../../blocks";
import { readCuesFor } from "../../surface/cues";
import { findInputFrame } from "../../surface/frame";
import { readAboveNotice } from "../../surface/notice";
import type { MenuModel } from "../menu-model";
import { extractInputDraft, inputBoxTail } from "./chrome";
import { CLAUDE_IDLE } from "./markers";

/**
 * The bridge binds a tap only to a region that ends inside the last this-many non-blank rows of its
 * fresh read (`DEFAULT_PROMPT_TAIL_LINES` in bridge/prompt-binding.ts), the footer run the profile
 * names under the box (`Frame.volatile.named`) not counted. A card whose region could not bind there
 * would only ever be refused, so it does not lift.
 */
const BRIDGE_TAIL_ROWS = 6;

/** A notice found above the box: its rows, `startLine` to `endLine` inclusive, and its card. */
export interface AbovePromptNoticeRegion {
  startLine: number;
  endLine: number;
  model: MenuModel;
}

/**
 * The notice over Claude's input box, or null. Only a box whose tail is the statusline run counts, so
 * the rows the view keeps above the box are exactly the rows above the notice.
 *
 * The card's binding region (`signature`) runs from the notice's head down through the box's bottom
 * edge: the bridge's fresh read must find the box as empty as it was, so a draft typed after the card
 * was drawn refuses the tap instead of taking a digit at its end.
 */
export function detectAbovePromptNotice(lines: StyledLine[]): AbovePromptNoticeRegion | null {
  if (inputBoxTail(lines) !== "statusline") return null;
  const frame = findInputFrame(lines, CLAUDE_IDLE);
  if (frame === null) return null;
  const texts = lines.map(lineText);
  const notice = readAboveNotice(texts, frame.top, CLAUDE_IDLE.notices ?? [], CLAUDE_IDLE.noticeGaps ?? []);
  if (notice === null) return null;
  // A dialog stacked over the notice holds the keys (the bridge reads the screen `unreadable`): no card.
  if (readCuesFor(lines, frame, CLAUDE_IDLE).strength === "strong") return null;
  // The footer run the profile names (Claude Code's agents panel) is not counted, from its first named
  // row down, as the bridge cuts it. A generic footer, any short run after a blank row, is counted.
  const underEnd = frame.volatile.named[0]?.row ?? texts.length;
  const rowsUnder = texts.slice(frame.bottom + 1, underEnd).filter((text) => text.trim().length > 0).length;
  if (rowsUnder >= BRIDGE_TAIL_ROWS) return null;
  const draft = extractInputDraft(lines) !== null;
  // The body's rows, counted from the head row the card's lines start on; left out when there is none.
  const liveBox: NonNullable<MenuModel["liveBox"]> =
    notice.body === null ? { draft } : { draft, body: { start: notice.body.first - notice.first, end: notice.body.last - notice.first } };
  return {
    startLine: notice.first,
    endLine: notice.last,
    model: {
      title: notice.text,
      actions: notice.keys.map((key) => ({ label: key.label, keys: [key.key] })),
      nav: { upDown: false },
      signature: texts.slice(notice.first, frame.bottom + 1).join("\n"),
      liveBox,
    },
  };
}
