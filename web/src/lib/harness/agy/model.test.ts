import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { lineText, splitLines } from "../../blocks";
import { buildBlocks } from "../index";
import { menusEqual, menusSameIdentity } from "../menu-model";
import { agyAdapter, antigravityAdapter } from "./index";
import { detectModelRegion } from "./model";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");
const capture = (width: number) => readFileSync(join(FIXTURES_DIR, `agy--v144-model--w${width}.txt`), "utf8");
const linesOf = (text: string) => splitLines(parseAnsi(text));

describe("AGY native model menu", () => {
  it.each([119, 50])("lifts the native %i-column menu without an unread card", (width) => {
    const lines = linesOf(capture(width));
    const region = detectModelRegion(lines)!;
    expect(region.model.title).toBe("Switch Model");
    expect(region.model.nav).toEqual({ upDown: true, leftRight: { verb: "Effort", label: "medium" } });
    expect(region.model.actions).toEqual([
      { label: "Select", keys: ["Enter"] },
      ...(width === 119 ? [{ label: "Go back", keys: ["Escape"], cancel: true }] : []),
    ]);
    for (const adapter of [agyAdapter, antigravityAdapter]) {
      expect(adapter.buildBlocks(lines).map((block) => block.kind)).toEqual(["menu"]);
      expect(adapter.composerReady!(lines)).toBe(false);
      expect(buildBlocks(lines, { agent: adapter.agent }).some((block) => block.kind === "unread-dialog")).toBe(false);
    }
    const modelFirst = linesOf(capture(width).replace(/auto {2}idle {2}(Gemini 4 Argon \([^)]+\))/, "$1  auto  idle"));
    expect(detectModelRegion(modelFirst)?.model.title).toBe("Switch Model");
  });

  it("keeps navigation identity but changes the commit signature when the highlight moves", () => {
    const original = capture(119);
    const moved = original.replace("> Gemini", "  Gemini").replace("  Gemini 3.8", "> Gemini 3.8");
    const a = detectModelRegion(linesOf(original))!.model;
    const b = detectModelRegion(linesOf(moved))!.model;
    expect(menusSameIdentity(a, b)).toBe(true);
    expect(menusEqual(a, b)).toBe(false);
  });

  it.each([
    (text: string) => text.replace("Switch Model", "Transcript"),
    (text: string) => text.replace("Search:", "Unknown:"),
    (text: string) => text.replace("> Gemini", "  Gemini"),
    (text: string) => text.replace("enter Select", "enter Delete"),
    (text: string) => text + "\nPress Y to confirm\n",
    (text: string) => text + "\n● Wrote the file\n  ⎿ done\n",
  ])("refuses incomplete or covered menus", (mutate) => {
    const plain = linesOf(capture(119)).map(lineText).join("\n");
    expect(detectModelRegion(linesOf(mutate(plain)))).toBeNull();
  });

  it("does not invent an effort control if its active paint is missing", () => {
    const plain = linesOf(capture(119)).map((line) => ({
      segments: parseAnsi(line.segments.map((s) => s.text).join("")),
    }));
    expect(detectModelRegion(plain)!.model.nav.leftRight).toBeUndefined();
  });

  it("lifts a fixed-effort model in 1.4.7 without leftRight arrows and preserves the statusline", () => {
    const adjustable = detectModelRegion(linesOf(capture(119)))!.model;
    const fixedRaw = readFileSync(join(FIXTURES_DIR, "agy--v147-model-fixed-effort--w119.txt"), "utf8");
    const fixedLines = linesOf(fixedRaw);
    const fixedRegion = detectModelRegion(fixedLines)!;
    expect(fixedRegion.model.title).toBe("Switch Model");
    expect(fixedRegion.model.nav).toEqual({ upDown: true, leftRight: undefined });
    expect(menusEqual(adjustable, fixedRegion.model)).toBe(false);
    expect(agyAdapter.extractStatusLines!(fixedLines)).toHaveLength(1);
  });

  it("accepts wrapped Keyboard footers, tab Context, esc Clear search, and 1.4.7 default statuslines without mode", () => {
    const wrapped = [
      "Switch Model",
      "",
      "  Search: gemini",
      "           ────────────────────",
      "",
      "> Gemini 4 Argon        (current)",
      "",
      "  Effort   ◂       ●━━━━━━━━━━━━━━●━━━━━━━━━━━━━━◉        ▸",
      "             \u001b[2m      low          medium      \u001b[0m\u001b[1m\u001b[38;5;1m     high       \u001b[0m",
      "",
      "Keyboard: ↑/↓ Navigate  ←/→ Effort  tab Context  enter Select",
      "  esc Clear search",
      "",
      "Gemini 4 Argon (High)  idle  ctx 100%  v1.4.7",
    ].join("\n");
    const region = detectModelRegion(linesOf(wrapped))!;
    expect(region.model.title).toBe("Switch Model");
    expect(region.model.nav).toEqual({ upDown: true, leftRight: { verb: "Effort", label: "high" } });
    expect(region.model.actions).toEqual([
      { label: "Select", keys: ["Enter"] },
      { label: "Clear search", keys: ["Escape"], cancel: true },
    ]);
  });
});

describe("AGY /effort Set Effort card (1.4.7)", () => {
  const effortCapture = (width: number) => readFileSync(join(FIXTURES_DIR, `agy--v147-effort--w${width}.txt`), "utf8");

  it.each([119, 50])("lifts the %i-column /effort slider with tappable scale values", (width) => {
    const lines = linesOf(effortCapture(width));
    const region = detectModelRegion(lines)!;
    expect(region.model.title).toBe("Set Effort");
    expect(region.model.nav).toEqual({
      upDown: false,
      leftRight: {
        verb: "Effort",
        label: "high",
        values: ["low", "medium", "high"],
      },
    });
    expect(region.model.actions).toEqual([
      { label: "Select", keys: ["Enter"] },
      { label: "Go back", keys: ["Escape"], cancel: true },
    ]);
    for (const adapter of [agyAdapter, antigravityAdapter]) {
      expect(adapter.composerReady!(lines)).toBe(false);
      expect(adapter.extractStatusLines!(lines)).toHaveLength(1);
      expect(buildBlocks(lines, { agent: adapter.agent }).some((b) => b.kind === "unread-dialog")).toBe(false);
    }
  });

  it("lifts the non-adjustable /effort notice as a dismissible card", () => {
    const nonAdjustable = [
      "Set Effort",
      "  Effort isn't adjustable for the current model",
      "",
      "Keyboard: esc Go Back",
      "GPT-OSS 120B (Medium)  idle  ctx 100%  v1.4.7",
    ].join("\n");
    const region = detectModelRegion(linesOf(nonAdjustable))!;
    expect(region.model.title).toBe("Set Effort");
    expect(region.model.nav).toEqual({ upDown: false });
    expect(region.model.actions).toEqual([{ label: "Go back", keys: ["Escape"], cancel: true }]);
  });
});
