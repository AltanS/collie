import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { blockOwnsKeyboard, dialogNounOf } from "../dialog-contract";
import { claudeAdapter, claudeBuildBlocks } from "./index";

// Claude Code 2.1.302's Heads up notice above a live box lifts as a `menu` card whose box stays live.

const PANES = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const HEADS_UP = "claude--v2302-heads-up-above-box--w142.txt";
const lines = (name: string): StyledLine[] => splitLines(parseAnsi(readFileSync(join(PANES, name), "utf8")));

/** The capture with `draft` typed into its empty box. */
function withDraft(draft: string): StyledLine[] {
  return lines(HEADS_UP).map((line) => (lineText(line).trim() === "❯" ? splitLines(parseAnsi(`❯ ${draft}`))[0]! : line));
}

describe("the notice above the box", () => {
  it("lifts the captured notice as a menu card: its text, and its three printed keys in order", () => {
    const blocks = claudeBuildBlocks(lines(HEADS_UP));
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "menu"]);
    const card = blocks[1]!;
    if (card.kind !== "menu") throw new Error("no menu");
    expect(card.menu.title).toBe(
      "Heads up · With GitHub triggers, anyone who files an issue on your public repos can put text in front of an unattended Claude session on your main PC.",
    );
    expect(card.menu.actions).toEqual([
      { label: "Learn more", keys: ["1"] },
      { label: "Knew this already", keys: ["2"] },
      { label: "Dismiss", keys: ["0"] },
    ]);
    expect(card.menu.nav).toEqual({ upDown: false });
    expect(card.menu.liveBox).toEqual({ draft: false });
    expect(card.menu.signature).toBe(card.lines.map(lineText).join("\n"));
    expect(card.lines).toHaveLength(3);
  });

  it("leaves the box live: the composer is ready and the card owns no keyboard", () => {
    const blocks = claudeBuildBlocks(lines(HEADS_UP));
    expect(claudeAdapter.composerReady?.(lines(HEADS_UP))).toBe(true);
    expect(blocks.some(blockOwnsKeyboard)).toBe(false);
    expect(dialogNounOf(blocks)).toBeNull();
  });

  it("keeps the transcript above the notice raw, and strips the box", () => {
    const raw = claudeBuildBlocks(lines(HEADS_UP))[0]!;
    if (raw.kind !== "raw") throw new Error("no raw block");
    expect(lineText(raw.lines.at(-1)!)).toContain("[-]");
  });

  it("marks the box's draft, so the card's keys wait", () => {
    const card = claudeBuildBlocks(withDraft("half a thought")).find((b) => b.kind === "menu");
    expect(card?.kind === "menu" && card.menu.liveBox).toEqual({ draft: true });
  });

  it("does not lift the rating survey over the box", () => {
    expect(claudeBuildBlocks(lines("claude-lab--survey-rating-above-box--w82.txt")).some((b) => b.kind === "menu")).toBe(false);
  });
});
