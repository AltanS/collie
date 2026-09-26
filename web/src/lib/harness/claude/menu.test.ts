import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { claudeBuildBlocks } from "./index";
import { lineText } from "./markers";
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
function textRows(screen: StyledLine[]): string[] {
  const out = screen.map(lineText);
  while (out.length > 0 && out.at(-1)!.trim() === "") out.pop();
  return out;
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

// The screen that proved bail 2 was reading a phrase instead of a dialog: `/effort` prints
// "Enter to confirm", which used to file it as the folder-trust prompt and stand the generic menu
// down, leaving the operator a modal with no buttons at all (ADR 0053). Nothing here is
// Effort-specific: once the bail stops firing, the generic grammar claims the screen on the keys the
// screen itself printed.
//
// What SHIPS for this screen is not this model. A Claude-specific grammar (./effort.ts) runs ahead
// of the generic arm and reads two things the generic one cannot: the current value, from the `▲`'s
// column, and the `s` key, whose footer segment says "for" where this parser demands "to". That
// model, and the block `claudeBuildBlocks` really emits, are asserted in effort.test.ts. The case
// below is about the generic detector alone.
describe("detectMenuRegion — the /effort slider", () => {
  it("no longer stands down on the slider's footer phrase", () => {
    const model = detectMenu(load("claude--menu-effort-slider.txt"));
    expect(model).not.toBeNull();
    expect(model!.title).toBe("Effort");
    // Two actions, not three: the generic parser drops "s for this session only". The Effort grammar
    // is what puts that key back.
    expect(model!.actions).toEqual([
      { label: "Confirm", keys: ["Enter"] },
      { label: "Cancel", keys: ["Escape"], cancel: true },
    ]);
    // And no arrows: the `←/→` phrase is this screen's FOOTER, which the region scan never reaches.
    expect(model!.nav).toEqual({ upDown: false });
    for (const key of model!.actions.flatMap((a) => a.keys)) {
      expect(/^\d+$/.test(key), key).toBe(false);
    }
  });
});

// Claude Code 2.1.27x+ opens its modals with a row of U+2594 (`▔`), often with a label spliced in
// near its right end, and a tall modal puts it past the `─` rule window. The region's top is the
// nearest of a `─` rule within that window or a full-width `▔` edge within 60 rows (region-top.ts).
describe("detectMenuRegion — the `▔` modal edge of Claude Code 2.1.283", () => {
  const W = 60;
  const EDGE = "▔".repeat(W);
  const LABELLED_EDGE = `${"▔".repeat(W - 18)} ● high · /effort ▔`;
  const TWO_HINTS = "   Enter to confirm · Esc to cancel";
  const edgeRow = (name: string) => lineText(load(name)[detectMenuRegion(load(name))!.startLine]!);

  it("lifts /mcp, whose only region top is a labelled `▔` edge", () => {
    const model = detectMenu(load("claude--v2283-slash-mcp.txt"))!;
    expect(model.title).toBe("Manage MCP servers");
    expect(model.actions).toEqual([
      { label: "Confirm", keys: ["Enter"] },
      { label: "Cancel", keys: ["Escape"], cancel: true },
    ]);
    expect(model.nav).toEqual({ upDown: true });
    expect(edgeRow("claude--v2283-slash-mcp.txt").startsWith("▔")).toBe(true);
    expect(claudeBuildBlocks(load("claude--v2283-slash-mcp.txt")).map((b) => b.kind)).toEqual(["menu"]);
  });

  it("lifts /hooks, whose edge sits 37 rows above its footer, past the rule window", () => {
    const region = detectMenuRegion(load("claude--v2283-slash-hooks.txt"))!;
    expect(region.model.title).toBe("Hooks");
    expect(region.model.actions.map((a) => a.keys[0])).toEqual(["Enter", "Escape"]);
    expect(textRows(load("claude--v2283-slash-hooks.txt")).length - 1 - region.startLine).toBe(37);
  });

  it.each([
    ["claude--v2283-slash-export.txt", "Export conversation", true],
    ["claude--v2283-slash-usage.txt", "Settings  Status   Config   Usage   Stats", false],
  ])("%s: a lone `Esc to cancel` footer under the edge is one Cancel action", (name, title, upDown) => {
    const model = detectMenu(load(name))!;
    expect(model.title).toBe(title);
    expect(model.actions).toEqual([{ label: "Cancel", keys: ["Escape"], cancel: true }]);
    // Arrows only where a highlight row advertises them, and never a digit for the numbered rows.
    expect(model.nav).toEqual({ upDown });
    expect(claudeBuildBlocks(load(name)).map((b) => b.kind)).toEqual(["raw", "menu"]);
  });

  it("names the verb a lone Esc hint prints", () => {
    const model = detectMenu(lines([EDGE, "   Background", "", "   Nothing running", "", "   Esc to close"].join("\n")))!;
    expect(model.actions).toEqual([{ label: "Close", keys: ["Escape"], cancel: true }]);
  });

  it("keeps the two-segment rule under a `─` rule: a lone Esc hint there is not a menu", () => {
    const screen = [BOX_RULE, "   Status", "", "   Version: 2.1.283", "", "   Esc to cancel"].join("\n");
    expect(detectMenu(lines(screen))).toBeNull();
  });

  it("claims a lone hint only for Esc: `Enter to confirm` alone under the edge is not a menu", () => {
    expect(detectMenu(lines([EDGE, "   Title", "", "   Enter to confirm"].join("\n")))).toBeNull();
  });

  it("never reads the last row of a wrapped footer as a lone Esc hint", () => {
    // `/tasks` at 40 columns: the footer wraps, and its last row alone reads "Esc to close".
    const screen = ["▔".repeat(40), "   Background", "", "   No tasks", "", "   ↑/↓ to select · Enter to view · ", "   Esc to close"];
    expect(detectMenu(lines(screen.join("\n")))).toBeNull();
    expect(detectMenu(load("claude-lab--tasks-panel--w40.txt"))).toBeNull();
  });

  it("reads a plain `▔` edge and a labelled one alike", () => {
    for (const edge of [EDGE, LABELLED_EDGE]) {
      const filler = Array.from({ length: 40 }, (_, i) => `     item ${i}`);
      const model = detectMenu(lines([edge, "   Tall list", ...filler, "", TWO_HINTS].join("\n")));
      expect(model?.title, edge).toBe("Tall list");
    }
  });

  it("looks no further than 60 rows for the edge", () => {
    const at = (n: number) =>
      detectMenu(lines([EDGE, "   Tall list", ...Array.from({ length: n - 2 }, (_, i) => `     item ${i}`), TWO_HINTS].join("\n")));
    expect(at(60)?.title).toBe("Tall list");
    expect(at(61)).toBeNull();
  });

  it("a `─` rule inside the window is nearer than the edge, and wins", () => {
    const screen = [EDGE, "   Outer", "", BOX_RULE, "   Inner", "", TWO_HINTS];
    expect(detectMenu(lines(screen.join("\n")))?.title).toBe("Inner");
  });

  it("a U+2500 box border past the rule window ends the search: the edge above it is not this modal's", () => {
    const filler = Array.from({ length: 35 }, (_, i) => `     item ${i}`);
    expect(detectMenu(lines([EDGE, "   Old", BOX_RULE, ...filler, TWO_HINTS].join("\n")))).toBeNull();
  });

  it("a rounded search box past the rule window does not end the search (the /config shape)", () => {
    const filler = Array.from({ length: 35 }, (_, i) => `     setting ${i}   true`);
    const search = [`   ╭${"─".repeat(W - 5)}╮`, `   │ ⌕ Search settings…${" ".repeat(W - 24)}│`, `   ╰${"─".repeat(W - 5)}╯`];
    const screen = [EDGE, "   Settings  Status   Config", "", ...search, "", ...filler, "", TWO_HINTS];
    expect(detectMenu(lines(screen.join("\n")))?.title).toBe("Settings  Status   Config");
  });

  it.each([
    ["an indented `▔` row", `   ${"▔".repeat(W)}`],
    ["a `▔` run narrower than the rows under it", "▔".repeat(12)],
    ["a `▔` run inside prose", `note: ${"▔".repeat(W)}`],
    ["a `▔` row that does not close on the glyph", `${"▔".repeat(W - 10)} trailing`],
  ])("%s is not an edge", (_label, row) => {
    const filler = Array.from({ length: 35 }, (_, i) => `     a row that is wider than the short rule ${i}`);
    expect(detectMenu(lines([row, "   Title", ...filler, "", TWO_HINTS].join("\n")))).toBeNull();
  });

  it("an edge above a live input box claims nothing (the idle screen)", () => {
    const screen = [EDGE, "   Old modal title", "", "● later output", BOX_RULE, "❯ ", BOX_RULE, TWO_HINTS];
    expect(detectMenu(lines(screen.join("\n")))).toBeNull();
  });

  it("the plan dialog, which opens under a `▔` edge too, stays a prompt-select `plan`", () => {
    for (const name of ["claude--plan-approval.txt", "claude--plan-approval--three-row.txt"]) {
      const last = claudeBuildBlocks(load(name)).at(-1)!;
      expect(last.kind, name).toBe("prompt-select");
      expect(last.kind === "prompt-select" && last.prompt.family, name).toBe("plan");
    }
  });
});
