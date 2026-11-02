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

  // The 2026-10-15 field case (tracker M51 spec 10): Claude Code 2.1.300 at 119 columns, ten rows, the
  // `… +3 models` tail and the `High effort` row. The grammar reads it like the 82-column picker, so
  // the card the composer's refusal points at is on screen with its Esc action.
  it("lifts the 2.1.300 picker at 119 columns as one menu with Enter, s and Esc", () => {
    const blocks = claudeBuildBlocks(load("claude-lab--menu-model-picker-v2300--w119.txt"));
    const menus = blocks.filter((b) => b.kind === "menu");
    expect(menus).toHaveLength(1);
    const block = menus[0]!;
    if (block.kind !== "menu") throw new Error("unreachable: filtered to menu");
    const menu = block.menu;
    expect(menu.title).toBe("Select model");
    expect(menu.actions).toEqual([
      { label: "Set as default", keys: ["Enter"] },
      { label: "Use this session only", keys: ["s"] },
      { label: "Cancel", keys: ["Escape"], cancel: true },
    ]);
    expect(menu.nav).toEqual({
      upDown: true,
      leftRight: { verb: "adjust", label: "● High effort" },
    });
  });

  // 2026-10-16: Claude Code 2.1.301 prints the same footer as 2.1.300, so the picker lifts the same
  // way. The effort row is on its default here, so the Left/Right label names Medium.
  it("lifts the 2.1.301 picker at 119 columns with the 2.1.300 keys", () => {
    const blocks = claudeBuildBlocks(load("claude-lab--menu-model-picker-v2301--w119.txt"));
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "menu"]);
    const block = blocks.find((b) => b.kind === "menu")!;
    if (block.kind !== "menu") throw new Error("unreachable: filtered to menu");
    const older = detectMenu(load("claude-lab--menu-model-picker-v2300--w119.txt"))!;
    expect(block.menu.title).toBe("Select model");
    expect(block.menu.actions).toEqual(older.actions);
    expect(block.menu.nav).toEqual({
      upDown: true,
      leftRight: { verb: "adjust", label: "◐ Medium effort (default)" },
    });
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

// Claude Code 2.1.307 and later frame the focused denial's shell command on `/permissions` › Recently
// denied (Recently blocked from 2.1.314) with a dashed box, Ink's `dashed` border. The footer keeps one
// blank row above it, so the box's bottom `╌` row sits two rows over the footer. The scan took that row
// as the region top, found no title under it, and the screen stayed raw (live, 2.1.310, 2026-11-02).
// A list with no command to frame drew no box and lifted.
describe("detectMenuRegion — the dashed command frame on /permissions' denied tab", () => {
  const W = 100;
  const EDGE = "▔".repeat(W);
  const DASHED = `   ${"╌".repeat(W - 3)}`;
  const FOOTER = "   Enter to approve · r to retry · ↑/↓ to navigate · Esc to close";
  const denied = (tab: string) => [
    EDGE,
    `   Permissions  ${tab}   Allow   Ask   Deny   Auto mode   Workspace`,
    "",
    "   Commands recently denied by the auto mode classifier.",
    "",
    "   ❯ 1. ✘ Restart the staging server  [Modify Shared Resources]",
    "",
    DASHED,
    "    │ cd /srv/app; docker compose down && docker compose up -d",
    DASHED,
    "",
    FOOTER,
  ];

  it.each(["Recently denied", "Recently blocked"])("lifts the %s tab from its `▔` edge, over the frame", (tab) => {
    const screen = lines(denied(tab).join("\n"));
    const region = detectMenuRegion(screen)!;
    expect(region).not.toBeNull();
    expect(region.startLine).toBe(0);
    expect(region.model.title).toBe(`Permissions  ${tab}   Allow   Ask   Deny   Auto mode   Workspace`);
    expect(region.model.actions).toEqual([
      { label: "Approve", keys: ["Enter"] },
      { label: "Retry", keys: ["r"] },
      { label: "Close", keys: ["Escape"], cancel: true },
    ]);
    expect(region.model.nav).toEqual({ upDown: true });
    expect(claudeBuildBlocks(screen).map((b) => b.kind)).toEqual(["menu"]);
  });

  it("does not take a dashed frame as the region top with no edge or rule above it", () => {
    expect(detectMenu(lines(denied("Recently denied").slice(1).join("\n")))).toBeNull();
  });
});

// Claude Code 2.1.291 (capture lab, 2026-10-06) opens `/tasks` and the rewind picker under a plain
// `─` rule flush at column 0 and indents the panel two spaces, where 2.1.278 drew a `▔` edge and
// indented three. The rule is the region top region-top.ts has always taken first, so each panel
// lifts to the same model as its 2.1.278 sibling; only the signature, which holds the rows, differs.
describe("detectMenuRegion — the `─` rule panels of Claude Code 2.1.291", () => {
  it.each([
    ["claude-lab--tasks-panel-v2291--w82.txt", "claude-lab--tasks-panel--w82.txt", "Background"],
    ["claude-lab--menu-rewind-v2291--w82.txt", "claude-lab--menu-rewind--w82.txt", "Rewind"],
  ])("%s lifts like its 2.1.278 sibling", (name, sibling, title) => {
    const region = detectMenuRegion(load(name))!;
    expect(region).not.toBeNull();
    const top = lineText(load(name)[region.startLine]!);
    expect(top.trim()).toMatch(/^─+$/);
    expect(top.startsWith("─")).toBe(true);
    const older = detectMenuRegion(load(sibling))!;
    expect(lineText(load(sibling)[older.startLine]!).startsWith("▔")).toBe(true);
    expect(region.model.title).toBe(title);
    expect(region.model.actions).toEqual(older.model.actions);
    expect(region.model.nav).toEqual(older.model.nav);
    expect(claudeBuildBlocks(load(name)).map((b) => b.kind)).toEqual(["raw", "menu"]);
  });

  it("the wrapped /tasks footer at 40 columns still claims nothing", () => {
    // The 2.1.291 recapture breaks the footer one segment later ("… · Esc" over "to close"), so its
    // last row is no hint at all. The panel declines as the 2.1.278 capture did, and the pane shows
    // the unread-dialog card.
    expect(textRows(load("claude-lab--tasks-panel--w40.txt")).at(-1)!.trim()).toBe("to close");
    expect(detectMenu(load("claude-lab--tasks-panel--w40.txt"))).toBeNull();
  });
});
