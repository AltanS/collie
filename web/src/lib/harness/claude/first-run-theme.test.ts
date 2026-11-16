import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type Block, type StyledLine } from "../../blocks";
import { withUnreadDialog } from "../index";
import { promptsEqual, promptsSameIdentity } from "../prompt-model";
import { detectFirstRunThemeRegion, THEME_LABELS } from "./first-run-theme";
import { claudeAdapter, claudeBuildBlocks } from "./index";

// The first run's theme step (first-run-theme.ts): Claude Code 2.1.325 with an empty config folder,
// three captures (lab 2026-11-15): the pointer on `Dark mode` at 61 and at 40 columns, and after one
// Down at 61 columns. The keys were measured live on 2026-11-16: Down and Up move one row and clamp at
// both ends, Enter accepts the pointed row, digits and Esc do nothing.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const load = (name: string): StyledLine[] => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
const textsOf = (name: string): string[] => load(name).map(lineText);
const fromTexts = (texts: string[]): StyledLine[] => splitLines(parseAnsi(texts.join("\n")));
const pipeline = (lines: StyledLine[]): Block[] => withUnreadDialog(claudeAdapter, lines, claudeBuildBlocks(lines));

const W61 = "claude--v2325-first-run-theme--w61.txt";
const W40 = "claude--v2325-first-run-theme--w40.txt";
const MOVED = "claude--v2325-first-run-theme-moved--w61.txt";
const QUESTION = "Choose the text style that looks best with your terminal";

const model = (lines: StyledLine[]) => detectFirstRunThemeRegion(lines)?.model ?? null;

describe("the first-run theme step lifts as a pointed list", () => {
  it.each([W61, W40])("%s: seven rows by their own text, the pointer on Dark mode", (name) => {
    const m = model(load(name))!;
    expect(m.family).toBe("select");
    expect(m.question).toBe(QUESTION);
    expect(m.caption).toBeUndefined();
    expect(m.clampedEnds).toBe(true);
    expect(m.options.map((o) => o.label)).toEqual(THEME_LABELS);
    expect(m.options.map((o) => o.keys)).toEqual([
      ["Up", "Enter"],
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
      ["Down", "Down", "Down", "Enter"],
      ["Down", "Down", "Down", "Down", "Enter"],
      ["Down", "Down", "Down", "Down", "Down", "Enter"],
    ]);
    expect(m.options.map((o) => o.keyLabel)).toEqual([undefined, "❯", undefined, undefined, undefined, undefined, undefined]);
  });

  it("the moved capture: the pointer on Light mode, the walk counts from there", () => {
    const m = model(load(MOVED))!;
    expect(m.options.map((o) => o.label)).toEqual(THEME_LABELS);
    expect(m.options[0]!.keys).toEqual(["Up", "Up", "Enter"]);
    expect(m.options[1]!.keys).toEqual(["Up", "Enter"]);
    expect(m.options[2]!.keys).toEqual(["Enter"]);
    expect(m.options[2]!.keyLabel).toBe("❯");
  });

  it("no plan sends a digit or Esc, and every plan ends in Enter", () => {
    for (const name of [W61, W40, MOVED]) {
      for (const option of model(load(name))!.options) {
        expect(option.keys.some((k) => /\d|Escape/u.test(k)), `${name}: ${option.label}`).toBe(false);
        expect(option.keys.at(-1)).toBe("Enter");
      }
    }
  });

  it("the moved pointer is the same dialog but not the same screen: a stale tap is refused at entry", () => {
    const before = model(load(W61))!;
    const after = model(load(MOVED))!;
    expect(promptsSameIdentity(before, after)).toBe(true);
    expect(promptsEqual(before, after)).toBe(false);
  });

  it("the diff preview under the list is not an option, and the card starts at Let's get started.", () => {
    for (const name of [W61, W40]) {
      const region = detectFirstRunThemeRegion(load(name))!;
      expect(textsOf(name)[region.startLine]!.trim()).toBe("Let's get started.");
      expect(region.model.options.some((o) => /greet|console|Syntax/u.test(o.label))).toBe(false);
      expect(region.model.coreSignature).not.toContain("Syntax");
    }
  });

  it.each([W61, W40, MOVED])("%s: the pipeline shows the card, not the unread-dialog card", (name) => {
    const blocks = pipeline(load(name));
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    expect(blocks.some((b) => b.kind === "unread-dialog")).toBe(false);
  });
});

describe("a screen that differs is not lifted", () => {
  const texts = textsOf(W61);
  const at = (needle: string): number => texts.findIndex((t) => t.includes(needle));
  const edit = (row: number, text: string): StyledLine[] => fromTexts(texts.map((t, i) => (i === row ? text : t)));
  const without = (row: number): StyledLine[] => fromTexts(texts.filter((_, i) => i !== row));

  it("the capture itself lifts (control)", () => {
    expect(model(fromTexts(texts))).not.toBeNull();
  });

  it("no anchor row", () => {
    expect(model(without(at("Let's get started.")))).toBeNull();
  });

  it("another question", () => {
    expect(model(edit(at("Choose the text style"), " Choose a colour for your prompt"))).toBeNull();
  });

  it("a label that is not the theme list's", () => {
    expect(model(edit(at("Light mode (ANSI"), "     Light mode (high contrast)"))).toBeNull();
  });

  it("a missing row", () => {
    expect(model(without(at("Dark mode (colorblind")))).toBeNull();
  });

  it("no pointer, or two", () => {
    expect(model(edit(at("✔ Dark mode"), "   ✔ Dark mode"))).toBeNull();
    expect(model(edit(at("Light mode (ANSI"), " ❯   Light mode (ANSI colors only)"))).toBeNull();
  });

  it("no preview under the list", () => {
    expect(model(fromTexts(texts.slice(0, at("Light mode (ANSI") + 1)))).toBeNull();
  });

  it("output under the preview", () => {
    expect(model(fromTexts([...texts.slice(0, at("Syntax theme") + 1), "", " something else"]))).toBeNull();
  });

  it("the /theme command in a session (a footer, no Let's get started.)", () => {
    for (const name of ["claude--v2325-theme-command--w61.txt", "claude--v2325-theme-command--w40.txt"]) {
      expect(model(load(name)), name).toBeNull();
    }
  });
});
