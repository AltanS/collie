// The blind road's menu sign knows the Nerd Font pointer (issue 866). A form drawn in a Nerd Font symbol set
// puts U+F054 (nf-fa-chevron_right) in front of its highlighted row, in place of `❯`. Over an input box's
// bottom edge, on a pane with no reader profile, the shared menu cues are what read the rows over the box,
// and a pointer they did not know left the form unread: the first send typed `y` and pressed Enter into it.
// Neutral rows of our own, in the shape of such a form: a bordered list of three items, a second question,
// a Submit row, then a status row and the edge of an input box under it.

import { describe, expect, test } from "bun:test";
import { NO_PROFILE, ScreenPane, rig, useScratchDir } from "./protocol.override-reach.rig.ts";

useScratchDir();

const WIDTH = 89;
const NERD_POINTER = "\u{F054}";
/** Nerd Font radio glyphs, on and off (nf-fa-dot_circle_o, nf-fa-circle_o). */
const RADIO_ON = "\u{F192}";
const RADIO_OFF = "\u{F10C}";

const inBox = (text: string): string => `│ ${text.padEnd(WIDTH - 4)} │`;

/** The form with `pointer` in front of its highlighted row, over a status row and an input box's edge. */
function form(pointer: string): string {
  return [
    " ".repeat(WIDTH),
    "",
    " Some earlier output from the tool, one line of it.",
    " and a second line.",
    `╭─ Form · 1 of 2 done ${"─".repeat(WIDTH - 23)}╮`,
    inBox("Pick a size"),
    inBox(`${pointer} ${RADIO_ON} Small: the quick one`),
    inBox(`  ${RADIO_OFF} Large: the full one`),
    inBox(`  ${RADIO_OFF} Other: write your own`),
    inBox(""),
    inBox("✓ Colours"),
    inBox("   ✓ Red   Green   Blue"),
    inBox(""),
    inBox("  Submit"),
    inBox(""),
    `╰${"─".repeat(WIDTH - 2)}╯`,
    "",
    "",
    "  some words of a status line here",
    " 1s  model-a  ~/work/app",
    "╰─",
  ].join("\n");
}

describe("the blind road reads a form whose pointer is the Nerd Font chevron as an open menu", () => {
  for (const pointer of [NERD_POINTER, "❯"]) {
    for (const foreground of [undefined, "unknown", "program"] as const) {
      const name = pointer === NERD_POINTER ? "U+F054" : "❯";
      test(`pointer ${name}, foreground ${foreground ?? "not read"}: the first send is refused menu_open, nothing typed, no key`, async () => {
        const screen = new ScreenPane(form(pointer));
        const first = await rig(screen, { harness: NO_PROFILE, foreground }).send("y", { fromPhone: true });
        expect(first.receipt).toMatchObject({ outcome: "refused", reason: "menu_open", keys: [] });
        expect(first.receipt?.menuSign).toBeDefined();
        expect(screen.writes).toEqual([]);
        expect(screen.keys).toEqual([]);
      });
    }
  }
});
