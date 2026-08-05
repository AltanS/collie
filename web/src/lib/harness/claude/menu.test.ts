import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { claudeBuildBlocks } from "./index";
import { detectMenu, detectMenuRegion } from "./menu";

// Claude's menu DETECTOR — its own conventions only (tail anchoring, the rule-bounded region, the
// input-box gate). The harness-agnostic footer/key grammar it builds on is pinned next door in
// harness/menu-hints.test.ts. The invariants that matter are all NEGATIVE ones — this is the
// LAST-RESORT detector, so what it declines to claim is more load-bearing than what it claims
// (see .adr/0009).

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
function load(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}
function lines(text: string): StyledLine[] {
  return splitLines(parseAnsi(text));
}

const BOX_RULE = "─".repeat(40); // clears the 20-glyph border threshold in markers.ts

describe("detectMenuRegion — the /model picker", () => {
  it("lifts the picker with its footer keys, title and nav", () => {
    const model = detectMenu(load("claude--menu-model-picker.txt"));
    expect(model).not.toBeNull();
    expect(model!.title).toBe("Select model");
    expect(model!.actions).toEqual([
      { label: "Set as default", keys: ["Enter"] },
      { label: "Use this session only", keys: ["s"] },
      { label: "Cancel", keys: ["Escape"], cancel: true },
    ]);
    // The `❯` row makes Up/Down meaningful; the "◐ Medium effort ←/→ to adjust" row names Left/Right
    // AND carries the value they act on, which is what the arrow cluster labels itself with.
    expect(model!.nav).toEqual({
      upDown: true,
      leftRight: { verb: "adjust", label: "◐ Medium effort" },
    });
  });

  it("emits no digit key at all", () => {
    const model = detectMenu(load("claude--menu-model-picker.txt"))!;
    for (const key of model.actions.flatMap((a) => a.keys)) {
      expect(/^\d+$/.test(key), key).toBe(false);
    }
  });

  it("starts the region at the picker's own rule, leaving the transcript above it raw", () => {
    const region = detectMenuRegion(load("claude--menu-model-picker.txt"))!;
    expect(region.startLine).toBeGreaterThan(0);
    const blocks = claudeBuildBlocks(load("claude--menu-model-picker.txt"));
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "menu"]);
  });

  // The signature is what the race guard compares. Moving the highlight is exactly the drift a stale
  // tap must not survive, so the two captures must NOT sign the same.
  it("signs a moved highlight differently", () => {
    const a = detectMenu(load("claude--menu-model-picker.txt"))!;
    const b = detectMenu(load("claude--menu-model-picker-moved.txt"))!;
    expect(b.title).toBe(a.title);
    expect(b.actions).toEqual(a.actions);
    expect(b.signature).not.toBe(a.signature);
  });

  it("is not detected once the picker is dismissed and the input box is back", () => {
    expect(detectMenu(load("claude--menu-model-picker-dismissed.txt"))).toBeNull();
  });
});

describe("detectMenuRegion — what it must decline", () => {
  it("declines a normal prompt screen whose statusline reads like key hints", () => {
    // The negative control: identical footer text, but an input box at the tail. Without the
    // input-box gate this would render fake buttons under a live composer.
    const screen = [
      "some ordinary agent output",
      BOX_RULE,
      "❯ ",
      BOX_RULE,
      "Enter to set as default · s to use this session only · Esc to cancel",
    ].join("\n");
    expect(detectMenu(lines(screen))).toBeNull();
  });

  it("declines a footer a known dialog family owns", () => {
    const screen = [
      BOX_RULE,
      "Pick one",
      "❯ 1. Yes",
      "  2. No",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    // classifyFooter claims this as `select`; the specific grammar's verified recipe must win.
    expect(detectMenu(lines(screen))).toBeNull();
  });

  it("declines a key-hint footer with no rule above it", () => {
    expect(detectMenu(lines("just output\nEnter to confirm it · Esc to cancel"))).toBeNull();
  });

  it("declines a rule whose only content below it is the footer (nothing to title)", () => {
    expect(detectMenu(lines(`${BOX_RULE}\n\nEnter to go on · Esc to cancel`))).toBeNull();
  });

  it("declines once ordinary output has scrolled below the picker (tail anchor)", () => {
    const scrolled = [...load("claude--menu-model-picker.txt"), ...lines("● Wrote the file")];
    expect(detectMenu(scrolled)).toBeNull();
  });
});
