// gentle-pi's `ask_user_choice` with descriptions longer than the pane (issue 746), built from the
// 200-column capture `pi--v130-gentle-choice.txt`. No capture of the reporter's screen exists, so the
// wrap is drawn the way the source draws it, not captured:
//
//   - gentle-pi 4.7.0 `lib/native-choice-list.ts`: each row is a pi-tui `Text` with one column of
//     padding, `→ label` or `  label`, then `\n   description` (the same rows as 4.2.0);
//   - pi-tui 1.5.0 `Text.render` and `wrapTextWithAnsi`: the content is wrapped at the width minus the
//     padding, a wrapped row does not start with the space it broke on and keeps no indent, and the
//     active colour is carried onto it. So the first description row stands four columns in and every
//     later one at column 1, the padding column.
//
// The question, the labels and the descriptions are a probe; nothing comes from the report.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PANES_DIR } from "./surface-corpus";

const WIDTH = 200;
/** The width pi-tui wraps the content at: the pane minus one column of padding on each side. */
const CONTENT = WIDTH - 2;
const MUTED = "\x1b[0m\x1b[38;2;157;157;157m";
const RESET = "\x1b[0m";

export const WRAPPED_CHOICES = [
  {
    label: "Red",
    description:
      "Warm and loud, the colour the probe paints its own header with when nothing else is set, and the one most people pick first; it reads well on a dark theme and on a light one, but it is the busiest of the three and it pulls the eye away from the rest of the screen",
  },
  {
    label: "Green",
    description:
      "Calm and natural, the quiet choice for a long session: it keeps the header readable without asking for attention, it sits well beside the status colours the terminal already uses for success, and it is the colour the probe falls back to when the theme it reads has no accent of its own to lend; a theme that does lend one keeps it, and a theme that lends two keeps the first and leaves the second for the status row under the editor",
  },
  {
    label: "Blue",
    description:
      "Cool and deep, the colour of the old probe, kept for people who liked it; it is the darkest of the three, so on a dark theme it needs the bold weight to stay readable, and the probe turns that weight on by itself when it sees a dark background",
  },
] as const;

function pad(row: string, visible: number): string {
  return row + " ".repeat(Math.max(0, WIDTH - visible));
}

/** pi-tui's greedy word wrap of `   text` at `width`: the first row carries the three spaces, a break
 *  falls between words and drops the space it broke on, and a later row starts at its first word. */
function wrapDescription(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = "   ";
  for (const word of text.split(" ")) {
    const fresh = row === "" || row === "   ";
    const next = fresh ? row + word : `${row} ${word}`;
    if (next.length > width && !fresh) {
      rows.push(row);
      row = word;
    } else row = next;
  }
  rows.push(row);
  return rows;
}

function optionRows(label: string, description: string, pointed: boolean): string[] {
  const head = pointed ? pad(` ${MUTED}→ ${label}${RESET}`, 3 + label.length) : pad(`   ${label}`, 3 + label.length);
  const [first, ...rest] = wrapDescription(description, CONTENT);
  const body = first!.slice(3);
  return [
    head,
    pad(`    ${MUTED}${body}${RESET}`, 4 + body.length),
    ...rest.map((r) => pad(` ${MUTED}${r}${RESET}`, 1 + r.length)),
  ];
}

/** The screen with the pointer on option `pointer` (0-based), CRLF rows as Herdr reads them. */
export function wrappedChoiceScreen(pointer = 0): string {
  const capture = readFileSync(join(PANES_DIR, "pi--v130-gentle-choice.txt"), "utf8").split("\r\n");
  // The capture: top rule, title, three options with one description row each, footer, bottom rule.
  const [top, title] = capture;
  const footer = capture[8]!;
  const bottom = capture[9]!;
  const options = WRAPPED_CHOICES.flatMap((c, i) => optionRows(c.label, c.description, i === pointer));
  return [top!, title!, ...options, footer, bottom, ""].join("\r\n");
}
