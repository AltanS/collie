// The FIRST RUN's two "Press Enter to continue…" steps: the screens Claude Code draws after a code the
// sign-in field took, before the folder trust dialog. Captured live on Claude Code 2.1.325, 219 columns
// (2026-11-16, an empty config folder signed in for real; the address, the links and the home folder
// masked; claude--v2325-first-run-login-ok--w219.txt, claude--v2325-first-run-security-notes--w219.txt):
//
//     Welcome to Claude Code v2.1.325                   the welcome row, then the art
//     …the art…
//
//      Logged in as person@example.com                  the sign-in step: the account row, gray
//      Login successful. Press Enter to continue…       the screen's last row
//
//     …or, after Enter, the same art and
//
//      Security notes:                                   the notes step: its title,
//      1. Claude can make mistakes. …                    two numbered notes, a Learn more link,
//      Press Enter to continue…                          and the screen's last row
//
// No footer names a key in the `<key> to <verb>` form the generic menu reads (menu.ts), so before this
// grammar the screen had no card and the box read blocked: the person pressed Enter on the Keys pad.
// The screen prints exactly one key, so the card offers exactly that one, Enter, labelled with the verb
// the screen printed (ADR 0009: only the keys the screen printed). Enter on each was the operator's run
// (sign-in step, then notes step, then the folder trust dialog), the only measurement there is.
//
// Conservatism: the welcome row, no input box, the screen's last non-blank row ending in the prompt
// (alone, or after `Login successful.` on the same row), and for the bare prompt a `Security notes:`
// title above it with nothing but the notes between. Anything short of that returns null and the
// screen stays what it was (the unread-dialog card, or no card). The notes step's numbered rows are
// text, never options: a digit is never sent.
//
// Pure functions over parsed line text.

import type { StyledLine } from "../../blocks";
import type { MenuModel } from "../menu-model";
import { hasInputBox } from "./chrome";
import { isBlank, lineText } from "./markers";
import type { MenuRegion } from "./menu";
import { regionSignature } from "./prompt-select";

const WELCOME = /^Welcome to Claude Code v\S+$/u;
/** The prompt, the screen's last row: the one key and the verb it printed. */
const PROMPT = /^(?:(Login successful\.) )?Press Enter to (continue)…$/u;
const NOTES_TITLE = "Security notes:";
const ACCOUNT_ROW = /^Logged in as \S+$/u;
/** The most rows the notes step draws between its title and its prompt (two notes, wrapped). */
const MAX_NOTES_ROWS = 14;

/** The first-run "Press Enter to continue…" step at the tail of `lines`, or null. */
export function detectFirstRunContinueRegion(lines: StyledLine[]): MenuRegion | null {
  const texts = lines.map(lineText);
  let last = texts.length - 1;
  while (last >= 0 && isBlank(texts[last]!)) last--;
  if (last < 0 || hasInputBox(lines)) return null;
  if (!texts.slice(0, last).some((t) => WELCOME.test(t.trim()))) return null;

  const prompt = PROMPT.exec(texts[last]!.trim());
  if (prompt === null) return null;
  const verb = prompt[2]!;
  const signedIn = prompt[1];

  let start: number;
  let title: string;
  if (signedIn !== undefined) {
    // The sign-in step: the account row right above the prompt, when it is there, belongs to the card.
    start = last > 0 && ACCOUNT_ROW.test(texts[last - 1]!.trim()) ? last - 1 : last;
    title = signedIn;
  } else {
    // The notes step: its title above the prompt, past the notes, and nothing above the title but
    // blank rows up to the art.
    const titleAt = texts.findIndex((t, i) => i < last && t.trim() === NOTES_TITLE);
    if (titleAt < 0 || last - titleAt - 1 > MAX_NOTES_ROWS) return null;
    if (texts.findIndex((t, i) => i > titleAt && t.trim() === NOTES_TITLE) >= 0) return null;
    if (titleAt === 0 || !isBlank(texts[titleAt - 1]!)) return null;
    start = titleAt;
    title = NOTES_TITLE.slice(0, -1);
  }

  const model: MenuModel = {
    title,
    actions: [{ label: verb.charAt(0).toUpperCase() + verb.slice(1), keys: ["Enter"] }],
    nav: { upDown: false },
    // The card's own rows: a tap on a screen that has since moved on is refused at entry.
    signature: regionSignature(texts, start, last),
  };
  return { model, startLine: start };
}
