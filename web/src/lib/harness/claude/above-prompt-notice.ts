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

import { lineText, type StyledLine } from "../../blocks";
import { findInputFrame } from "../../surface/frame";
import { readAboveNotice } from "../../surface/notice";
import type { MenuModel } from "../menu-model";
import { extractInputDraft, inputBoxTail } from "./chrome";
import { CLAUDE_IDLE } from "./markers";

/** A notice found above the box: its rows, `startLine` to `endLine` inclusive, and its card. */
export interface AbovePromptNoticeRegion {
  startLine: number;
  endLine: number;
  model: MenuModel;
}

/**
 * The notice over Claude's input box, or null. Only a box whose tail is the statusline run counts, so
 * the rows the view keeps above the box are exactly the rows above the notice.
 */
export function detectAbovePromptNotice(lines: StyledLine[]): AbovePromptNoticeRegion | null {
  if (inputBoxTail(lines) !== "statusline") return null;
  const frame = findInputFrame(lines, CLAUDE_IDLE);
  if (frame === null) return null;
  const texts = lines.map(lineText);
  const notice = readAboveNotice(texts, frame.top, CLAUDE_IDLE.notices ?? []);
  if (notice === null) return null;
  return {
    startLine: notice.first,
    endLine: notice.last,
    model: {
      title: notice.text,
      actions: notice.keys.map((key) => ({ label: key.label, keys: [key.key] })),
      nav: { upDown: false },
      signature: texts.slice(notice.first, notice.last + 1).join("\n"),
      liveBox: { draft: extractInputDraft(lines) !== null },
    },
  };
}
