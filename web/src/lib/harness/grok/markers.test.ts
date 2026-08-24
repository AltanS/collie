import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import {
  composerPromptText,
  composerStatus,
  gutterCardRange,
  isComposerHint,
  isComposerTop,
  isStatusChipRow,
  lineText,
  rstrip,
} from "./markers";
import { extractStatusLines, hasComposer, locateComposer } from "./chrome";

const ESC = "\x1b";

describe("isComposerHint", () => {
  it("accepts the captured shortcut bar", () => {
    expect(isComposerHint("  Shift+Tab:mode  │  Ctrl+.:shortcuts")).toBe(true);
    expect(isComposerHint("  c:comment  │  y:copy plan  │  a:approve  │  q:quit plan")).toBe(true);
    expect(
      isComposerHint("  Ctrl+e:expand thinking  │  Space:prompt  │  Esc:cancel  │  Ctrl+b:send to bg  │  Ctrl+.:shortcuts"),
    ).toBe(true);
    expect(isComposerHint("  a:approve  │  Tab:plan  │  Esc:back")).toBe(true);
  });

  it("rejects ordinary transcript, chips, and colon-shaped noise", () => {
    expect(isComposerHint("later output")).toBe(false);
    expect(isComposerHint("error: failed to start")).toBe(false);
    expect(isComposerHint("error:this looks like a colon")).toBe(false);
    expect(isComposerHint("foo:bar")).toBe(false);
    expect(isComposerHint("[stable]")).toBe(false);
    expect(isComposerHint("  [stable]  ")).toBe(false);
  });
});

describe("isStatusChipRow", () => {
  it("accepts exactly the captured [stable] channel chip", () => {
    expect(isStatusChipRow("                                    [stable]")).toBe(true);
    expect(isStatusChipRow("[stable]")).toBe(true);
  });

  it("rejects every other bracket run — uncaptured tags are torn transcript, not chrome", () => {
    expect(isStatusChipRow("  [↓][stop]")).toBe(false);
    expect(isStatusChipRow("[waiting]")).toBe(false);
    expect(isStatusChipRow("[ERROR]")).toBe(false);
    expect(isStatusChipRow("[1/2]")).toBe(false);
    expect(isStatusChipRow("[done][stop]")).toBe(false);
    expect(isStatusChipRow("21s ⇣20.7k [↓][stop]")).toBe(false);
    expect(isStatusChipRow("[stable] extra words")).toBe(false);
    expect(isStatusChipRow("error: [stable]")).toBe(false);
    expect(isStatusChipRow("")).toBe(false);
    expect(isStatusChipRow("[]")).toBe(false);
  });
});

describe("gutterCardRange", () => {
  it("finds the contiguous ┃ run across the captured gap of one blank row", () => {
    const texts = ["earlier output", "  ┃", "  ┃  Question", "  ┃  1 (●) Yes", "", "  Tab:next option"];
    expect(gutterCardRange(texts, 5)).toEqual({ start: 1, end: 3 });
  });

  it("accepts a footer directly under the card — a zero-row gap", () => {
    const texts = ["  ┃  Question", "  ┃  1 (●) Yes", "  Tab:next option"];
    expect(gutterCardRange(texts, 2)).toEqual({ start: 0, end: 1 });
  });

  it("refuses a non-blank gap row — that footer belongs to something else", () => {
    const texts = ["  ┃  Question", "  ┃  1 (●) Yes", "later transcript output", "  Tab:next option"];
    expect(gutterCardRange(texts, 3)).toBeNull();
  });

  it("refuses a footer floating more than a few blank rows below the card", () => {
    const texts = ["  ┃  Question", "  ┃  1 (●) Yes", "", "", "", "", "  Tab:next option"];
    expect(gutterCardRange(texts, 6)).toBeNull();
  });
});

describe("rstrip", () => {
  it("drops TRAILING whitespace only — Grok pads every box row to the pane width", () => {
    expect(rstrip("  ╭────╮   ")).toBe("  ╭────╮");
  });

  // Herdr's text snapshot may draw a scrollbar as █. Collie never parses that snapshot — only
  // format:ansi, whose pad is spaces. Special-casing █ would paper over a formatter we do not use.
  it("does not invent a text-source scrollbar strip", () => {
    expect(rstrip("  ╭────╮█")).toBe("  ╭────╮█");
  });
});

describe("live-shaped SGR (probed 2026-08-21 against herdr pane.read format:ansi)", () => {
  // Grok colours the bottom-border STATUS as its own run, with the ╰─ fill and the ─╯ closer in
  // another. Joined text is still `╰── status ─╯`; segment-trimming is not.
  function box(draft: string, status: string): string {
    const grey = (t: string) => `${ESC}[38;2;80;80;88m${t}${ESC}[0m`;
    const fg = (t: string) => `${ESC}[38;2;200;200;200m${t}${ESC}[0m`;
    const top = grey(`  ╭${"─".repeat(48)}╮`);
    const inner = grey("  │") + fg(` ❯ ${draft}`) + grey(`${" ".repeat(Math.max(0, 40 - draft.length))}│`);
    const bottom = grey(`  ╰${"─".repeat(20)} `) + fg(status) + grey(" ─╯");
    return [top, inner, bottom, "", "  Shift+Tab:mode  │  Ctrl+.:shortcuts", ""].join("\n");
  }

  it("the joined bottom border still classifies after SGR is stripped into segments", () => {
    const lines = splitLines(parseAnsi(box("", "Grok 4.6 (high) · auto")));
    const bottom = lines[2]!;
    expect(bottom.segments.length).toBeGreaterThan(1);
    expect(isComposerTop(lineText(lines[0]!))).toBe(true);
    expect(composerStatus(lineText(bottom))).toBe("Grok 4.6 (high) · auto");
    expect(hasComposer(lines)).toBe(true);
    expect(locateComposer(lines)?.bottom).toBe(2);
    expect(extractStatusLines(lines).map((r) => r.segments.map((s) => s.text).join("")).join("")).toBe(
      "Grok 4.6 (high) · auto",
    );
    const statusSegs = extractStatusLines(lines)[0]!.segments;
    expect(statusSegs.some((s) => Object.keys(s.style).length > 0)).toBe(true);
    expect(statusSegs.every((s) => !s.text.includes("╰") && !s.text.includes("╯"))).toBe(true);
  });

  it("the prompt row is │ + space + ❯ even when those glyphs are separate SGR runs", () => {
    const lines = splitLines(parseAnsi(box("hello", "Grok 4.6 (high) · auto")));
    const prompt = lines[1]!.segments.map((s) => s.text).join("");
    expect(composerPromptText(prompt)?.trim()).toBe("hello");
  });

  // The status run is opaque. Herdr's agent string is always `grok`; the TUI paints whatever the
  // current model/effort/mode is. A matcher that required "Grok 4.6" or "(high)" would miss
  // grok-4.5 (effort omitted), grok-build, xhigh, plan, and any `[model.*] name`.
  it.each([
    "Grok 4.6 (high) · auto",
    "Grok 4.6 (low) · auto",
    "Grok 4.6 (medium) · always-approve",
    "Grok 4.6 (xhigh) · plan",
    "Grok 4.5 · auto",
    "Grok Build · always-approve",
    "Reasoning X (xhigh) · auto",
    "Local Llama · ask",
    "Grok 4.6 (high)",
  ])("status %j is hoisted verbatim — no model/effort token is required", (status) => {
    const lines = splitLines(parseAnsi(box("", status)));
    expect(hasComposer(lines)).toBe(true);
    expect(composerStatus(lineText(lines[2]!))).toBe(status);
    expect(extractStatusLines(lines).map((r) => r.segments.map((s) => s.text).join("")).join("")).toBe(
      status,
    );
  });
});
