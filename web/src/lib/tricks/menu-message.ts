// THE MESSAGE UNDER A TRICK'S GROUP in a session's settings (the `menu` place): the line a tap's receipt
// carries, said after the trick's name. One rule for the bridge, which drops a message that fails it from a
// menu tap's receipt (bridge/tricks/service.ts), and for the phone, which shows Collie's own line instead
// (components/trick-menu-group.tsx). Review 12 N1.

import { collieWordsIn } from "../agent-view/wire";
import { firstHiddenChar } from "../hidden-chars";
import { MENU_MESSAGE_MAX, menuWordsProblem } from "./schema";

/**
 * A tap's message as a group's footer says it after the trick's name: one line, cut to
 * {@link MENU_MESSAGE_MAX} characters with the cut shown. Null when it holds a hidden character, says one
 * of the agent view's Collie phrases, or reads as Collie's own words as a row label would (one of the
 * sheet's rows, a word of Collie's, a permission's first word): then the footer says Collie's own line.
 */
export function menuMessageLine(message: string): string | null {
  if (firstHiddenChar(message) !== null || collieWordsIn(message) !== null) return null;
  const line = message.replace(/\s+/gu, " ").trim();
  if (line === "" || menuWordsProblem(line) !== undefined) return null;
  const chars = [...line];
  return chars.length <= MENU_MESSAGE_MAX ? line : `${chars.slice(0, MENU_MESSAGE_MAX - 1).join("")}…`;
}
