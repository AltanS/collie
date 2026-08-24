import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import {
  composerBottomText,
  composerContText,
  composerGhost,
  isBlank,
  isComposerTop,
  lineText,
  rstrip,
} from "./markers";

// The shared lexing primitives omp's chrome stripping leans on. Small and pure; what these pin is the
// exact set of near-misses the corpus actually contains — omp draws FIVE different boxes (the welcome
// panel, a tool-result box, the Ask dialog, the pickers, the composer) and the whole adapter rests on
// telling the composer apart from the other four by its borders.

// Anchored on this file's directory, NOT `new URL(..., import.meta.url)` — Vite statically rewrites
// that into a root-relative asset path. Three ".."s from harness/omp to src.
const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

/** The rstripped text of one row of a real capture, through the production parse pipeline. */
function row(name: string, i: number): string {
  const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
  return rstrip(lineText(lines[i]!));
}

/** The same row STYLED — `composerGhost` reads the segments' colours, not the joined text. */
function styledRow(name: string, i: number) {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")))[i]!;
}

describe("lineText / isBlank / rstrip", () => {
  it("joins a line's segment text, detects blank lines, and drops only trailing padding", () => {
    const [a, b] = splitLines(parseAnsi("\x1b[31mred\x1b[0m text\n"));
    expect(lineText(a!)).toBe("red text");
    expect(isBlank(lineText(b!))).toBe(true); // the trailing blank line
    expect(isBlank("   ")).toBe(true);
    // Leading whitespace SURVIVES on purpose: composerContText reads a two-space gutter, and an
    // lstrip here would erase the evidence that distinguishes a wrapped draft from boxed output.
    expect(rstrip("  ❯ Red   ")).toBe("  ❯ Red");
  });
});

describe("composerBottomText", () => {
  it("reads the draft tail omp writes INTO the bottom border", () => {
    expect(composerBottomText(row("omp--fresh-idle.txt", 27))!.trim()).toBe("");
    expect(composerBottomText(row("omp--draft-single.txt", 27))!.trim()).toBe(
      "list the files in this repo",
    );
    // A wrapped draft puts its LAST fragment here and stacks the earlier ones above.
    expect(composerBottomText(row("omp--draft-wrapped.txt", 29))!.trim()).toBe("hand");
  });

  it("rejects every other box bottom — the one-space gutter is the discriminator", () => {
    expect(composerBottomText(row("omp--menu-dismissed.txt", 20))).toBeNull(); // `╰───┴───╯`
    expect(composerBottomText(row("omp--select-menu.txt", 55))).toBeNull(); // Ask box `╰───╯`
    expect(composerBottomText(row("omp--done--tool-result.txt", 41))).toBeNull(); // tool box `╰───╯`
  });
});

describe("composerGhost — omp's inline completion suggestion", () => {
  const CORNER = "\x1b[38;2;74;80;88m";
  const SUGGEST = "\x1b[38;2;111;115;119m";
  const PAD = " ".repeat(10);

  it("claims the trailing coloured run that follows the operator's own text", () => {
    const row = `${CORNER}╰─ \x1b[0mlist the files in this repo${SUGGEST}sitory\x1b[0m${PAD}${CORNER} ─╯\x1b[0m`;
    expect(composerGhost(splitLines(parseAnsi(row))[0]!)).toBe("sitory");
  });

  it("reads it off the real capture, and leaves the plain one alone", () => {
    expect(composerGhost(styledRow("omp--draft-ghost-suggestion.txt", 27))).toBe("sitory");
    expect(composerGhost(styledRow("omp--draft-single.txt", 27))).toBe("");
    expect(composerGhost(styledRow("omp--fresh-idle.txt", 27))).toBe("");
  });

  // Both of these keep a real draft whole. A wrongly-claimed ghost SHORTENS the text the reply guard
  // verifies, so every ambiguous row must claim nothing.
  it("claims nothing when the row carries no unstyled text to anchor the run against", () => {
    const row = `${SUGGEST}╰─ list the files in this repo${PAD} ─╯\x1b[0m`;
    expect(composerGhost(splitLines(parseAnsi(row))[0]!)).toBe("");
  });

  it("claims nothing when the coloured run is not at the end of the draft", () => {
    const row = `${CORNER}╰─ \x1b[0m${SUGGEST}red\x1b[0m then plain text${PAD}${CORNER} ─╯\x1b[0m`;
    expect(composerGhost(splitLines(parseAnsi(row))[0]!)).toBe("");
  });

  it("is not a border predicate — a row that is not the bottom border has no ghost", () => {
    expect(composerGhost(splitLines(parseAnsi(`${SUGGEST}● Wrote the file\x1b[0m`))[0]!)).toBe("");
  });
});

describe("composerContText", () => {
  it("reads a wrapped draft's continuation rows", () => {
    expect(composerContText(row("omp--draft-wrapped.txt", 27))!.trim()).toMatch(
      /^list the files in this repo and then write/,
    );
    expect(composerContText(row("omp--draft-wrapped.txt", 28))!.trim()).toMatch(
      /^inside the dot git directory/,
    );
  });

  it("does not claim the row above them (that is the top border)", () => {
    expect(composerContText(row("omp--draft-wrapped.txt", 26))).toBeNull();
  });
});

describe("isComposerTop", () => {
  it("accepts the composer's top border, statusline and all", () => {
    expect(isComposerTop(row("omp--fresh-idle.txt", 26))).toBe(true);
    // The `◀ 1` variant: omp splices a transcript-scroll indicator into the same border.
    expect(isComposerTop(row("omp--done.txt", 53))).toBe(true);
  });

  it("also accepts omp's OTHER `╭─…─╮` box tops — by design", () => {
    // This predicate is deliberately loose and is never decisive on its own. chrome.ts only ever asks
    // it about a row already pinned by a matched `╰─ … ─╯` bottom border, the continuation walk, and a
    // display-width equality against that bottom border — and these panels are 100 cells wide against
    // the composer's 189, and never adjacent to a composer bottom.
    expect(isComposerTop(row("omp--menu-dismissed.txt", 1))).toBe(true); // the welcome panel
    expect(isComposerTop(row("omp--select-menu.txt", 34))).toBe(true); // the Ask dialog
  });

  it("rejects ordinary output and a bare rule", () => {
    expect(isComposerTop("● Wrote the file")).toBe(false);
    expect(isComposerTop("─".repeat(40))).toBe(false);
  });
});
