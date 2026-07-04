import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi, type AnsiSegment } from "./ansi";
import { buildBlocks, splitLines, type StyledLine } from "./blocks";

// Anchored on this file's directory (not `new URL(import.meta.url)`, which Vite rewrites to an asset).
const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const fixtureLines = (name: string): StyledLine[] =>
  splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
const blockText = (lines: StyledLine[]) =>
  lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");

// splitLines is the seam between the ANSI parse and the renderer. Its load-bearing invariant (find
// depends on it): joining every line's text with "\n" reproduces the original visible string
// character-for-character. These tests pin that byte-fidelity across empty lines, trailing newlines,
// and segments that carry newlines mid-run — plus that styling survives a split.

const ESC = "\x1b";

/** Minimal styled segment for constructing inputs directly (bypassing the parser). */
const seg = (text: string, extra: Partial<AnsiSegment> = {}): AnsiSegment => ({
  text,
  style: {},
  muted: false,
  ...extra,
});

/** Reconstruct the visible string the way find's coordinate space does: lines joined by "\n". */
const joinLines = (lines: { segments: AnsiSegment[] }[]) =>
  lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");

describe("splitLines — exact text preservation", () => {
  it("keeps a single newline-free line intact and reuses the segment object (no clone)", () => {
    const s = seg("hello world");
    const lines = splitLines([s]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.segments[0]).toBe(s); // same reference — the no-allocation fast path
    expect(joinLines(lines)).toBe("hello world");
  });

  it("yields a single empty line for no segments", () => {
    const lines = splitLines([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.segments).toEqual([]);
    expect(joinLines(lines)).toBe("");
  });

  it("represents a trailing newline as a terminating empty line", () => {
    // Parser emits one segment per newline-terminated run: "a\n", "b\n".
    const lines = splitLines([seg("a\n"), seg("b\n")]);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.segments.map((s) => s.text).join(""))).toEqual(["a", "b", ""]);
    expect(lines[2]!.segments).toEqual([]); // the trailing blank carries no segment
    expect(joinLines(lines)).toBe("a\nb\n");
  });

  it("preserves interior empty lines (adjacent newlines)", () => {
    const lines = splitLines(parseAnsi("a\n\nb"));
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.segments.map((s) => s.text).join(""))).toEqual(["a", "", "b"]);
    expect(lines[1]!.segments).toEqual([]);
    expect(joinLines(lines)).toBe("a\n\nb");
  });

  it("splits a single segment that spans multiple newlines into one line each", () => {
    const lines = splitLines([seg("foo\nbar\nbaz")]);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.segments.map((s) => s.text).join(""))).toEqual(["foo", "bar", "baz"]);
    expect(joinLines(lines)).toBe("foo\nbar\nbaz");
  });

  it("drops empty pieces from a leading newline but still opens a blank first line", () => {
    const lines = splitLines([seg("\nx")]);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.segments).toEqual([]);
    expect(lines[1]!.segments.map((s) => s.text)).toEqual(["x"]);
    expect(joinLines(lines)).toBe("\nx");
  });

  it("keeps a styled segment's style/flags on both sides when split across a newline", () => {
    const styled = seg("red1\nred2", {
      fg: "#cd3131",
      bold: true,
      muted: false,
      style: { color: "#cd3131", fontWeight: 600 },
    });
    const lines = splitLines([styled]);
    expect(lines).toHaveLength(2);
    const [a, b] = [lines[0]!.segments[0]!, lines[1]!.segments[0]!];
    expect([a.text, b.text]).toEqual(["red1", "red2"]);
    // Both halves carry the original style metadata (cloned, not the same reference).
    for (const half of [a, b]) {
      expect(half.fg).toBe("#cd3131");
      expect(half.bold).toBe(true);
      expect(half.style).toEqual({ color: "#cd3131", fontWeight: 600 });
    }
    expect(joinLines(lines)).toBe("red1\nred2");
  });
});

describe("splitLines — round-trips the parser's visible text (find coordinate space)", () => {
  const cases = [
    "hello world",
    "line1\nline2\nline3",
    "a\n\nb", // interior blank
    "done\n", // trailing newline
    "\nleading", // leading newline
    `${ESC}[31mred\nstill red${ESC}[0m\nplain`, // styling across newlines
    "line one\r\nline two\r\n", // CRLF (parser normalises the \r away)
  ];
  for (const input of cases) {
    it(`join(splitLines) === visible text for ${JSON.stringify(input)}`, () => {
      const segments = parseAnsi(input);
      const visible = segments.map((s) => s.text).join("");
      expect(joinLines(splitLines(segments))).toBe(visible);
    });
  }
});

describe("buildBlocks", () => {
  it("wraps all lines in a single raw block spanning the full range", () => {
    const lines = splitLines(parseAnsi("a\nb\nc"));
    const blocks = buildBlocks(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("raw");
    expect(blocks[0]!.lines).toBe(lines); // the same line array — covers every line
    expect(blocks[0]!.lines).toHaveLength(3);
  });

  it("still emits one raw block (with one empty line) for empty input", () => {
    const blocks = buildBlocks(splitLines(parseAnsi("")));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("raw");
    expect(blocks[0]!.lines).toEqual([{ segments: [] }]);
  });
});

describe("buildBlocks — Claude grammars (ctx.agent === 'claude')", () => {
  it("splits a tail menu into [raw before, prompt-select], keeping the question above the buttons", () => {
    const lines = fixtureLines("claude--select-menu.txt");
    const blocks = buildBlocks(lines, { agent: "claude" });
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);

    const raw = blocks[0]!;
    const prompt = blocks[1]!;
    if (raw.kind !== "raw" || prompt.kind !== "prompt-select") throw new Error("unexpected block kinds");
    // The question stays in the raw block above (not duplicated inside the button group).
    expect(blockText(raw.lines)).toContain("Which color theme should the dashboard use?");
    // The typed payload carries the detected model + the raw region it replaced.
    expect(prompt.prompt.family).toBe("select");
    expect(prompt.prompt.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue", "Chat about this"]);
    expect(blockText(prompt.lines)).toContain("Enter to select"); // the replaced footer lives here
  });

  it("strips trailing input-box chrome when there is no menu (single raw block)", () => {
    const lines = fixtureLines("claude--fresh-idle.txt");
    const blocks = buildBlocks(lines, { agent: "claude" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("raw");
    const kept = blockText(blocks[0]!.lines);
    expect(kept).toContain("Welcome back Altan!");
    expect(kept).not.toContain("← for agents"); // the input-box statusline/hint is gone
    expect(blocks[0]!.lines.length).toBeLessThan(lines.length);
  });

  it("leaves a non-Claude agent as a single untouched raw block (conservative gating)", () => {
    const lines = fixtureLines("claude--select-menu.txt");
    const blocks = buildBlocks(lines, { agent: "codex" });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("raw");
    expect(blocks[0]!.lines).toBe(lines); // untouched — same reference
  });
});
