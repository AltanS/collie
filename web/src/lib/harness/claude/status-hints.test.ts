import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { withUnreadDialog } from "../index";
import { hasInputBox, inputBoxTail, namesAModalKey } from "./chrome";
import { claudeAdapter } from "./index";

// Claude's default footer prints two hints that read like a modal's "<key> to <verb>" row but belong
// to the live composer: "esc to interrupt" while a turn runs, and "↓ to manage" while background
// tasks exist. Both used to make the box locator refuse the box, and the unread-dialog card then
// drew "Collie cannot read this dialog" over a healthy pane. The 2.1.278 lab corpus never saw them
// because it ran under a custom statusline, which replaces the default footer.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const read = (name: string) => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));

describe("Claude status hints in the footer", () => {
  it.each([
    ["claude--working-esc-to-interrupt.txt", "a turn is running"],
    ["claude--idle-background-shell.txt", "a background shell is running"],
  ])("%s keeps its input box (%s)", (fixture) => {
    const lines = read(fixture);
    expect(hasInputBox(lines)).toBe(true);
    expect(inputBoxTail(lines)).toBe("statusline");
  });

  it.each(["claude--working-esc-to-interrupt.txt", "claude--idle-background-shell.txt"])(
    "%s draws no unread-dialog card",
    (fixture) => {
      const lines = read(fixture);
      const blocks = claudeAdapter.buildBlocks(lines);
      expect(withUnreadDialog(claudeAdapter, lines, blocks).map((b) => b.kind)).not.toContain(
        "unread-dialog",
      );
    },
  );
});

describe("namesAModalKey", () => {
  it.each([
    "⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents",
    "⏵⏵ bypass permissions on · 2 monitors · ← for agents · ↓ to manage",
    "esc to interrupt",
    "Esc to interrupt",
    "↓ to manage",
    // Claude clips the footer with "…" on a narrow pane.
    "⏵⏵ bypass permissions on · esc to inter…",
    "⏵⏵ bypass permissions on · esc to…",
    "⏵⏵ bypass permissions on · ↓ to man…",
  ])("does not take %j for a modal footer", (row) => {
    expect(namesAModalKey(row)).toBe(false);
  });

  it.each([
    "Esc to cancel",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
    "Esc to close",
    // A modal footer that happens to sit beside a status hint is still a modal footer.
    "esc to interrupt · Esc to cancel",
    "↓ to manage · Enter to select",
    // Only the closed list is exempt, not the verb "interrupt" for any key.
    "ctrl+c to interrupt",
    "esc to interrupt the dialog",
  ])("still takes %j for a modal footer", (row) => {
    expect(namesAModalKey(row)).toBe(true);
  });
});
