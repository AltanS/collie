import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import {
  composerDraft, composerPrompt, composerStatusLines, locateComposer, tailRule,
} from "./composer";

function capture(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(
    new URL(`../../../fixtures/panes/pi--omo-v5130-${name}.txt`, import.meta.url), "utf8",
  )));
}

function stock(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(
    new URL(`../../../fixtures/panes/pi--v0851-${name}.txt`, import.meta.url), "utf8",
  )));
}

function row(value: string): StyledLine {
  return { segments: parseAnsi(value) };
}

const idle = capture("idle");
const rule = lineText(idle[0]).trimEnd();
const blue = "\x1b[38;2;97;133;204m";

describe("OmO composer", () => {
  it("locates the editor when the captured idle tail has three status rows", () => {
    // Given / When
    const result = locateComposer(idle);
    // Then
    expect(result).toEqual({ layout: "omo", top: 0, bottom: 2, end: 6 });
  });

  it("returns no draft when the captured editor is empty", () => {
    expect(composerDraft(idle)).toBeNull();
  });

  it("reads the literal draft when it was typed into the real sandbox editor", () => {
    const lines = capture("draft");
    expect(composerDraft(lines)).toBe("collie composer draft probe");
    expect(composerPrompt(lines)).toBe(`${rule}\n❯ collie composer draft probe\n${rule}`);
  });

  it("binds the exact frame when terminal padding follows the prompt", () => {
    expect(composerPrompt(idle)).toBe(`${rule}\n❯\n${rule}`);
  });

  it("extracts wrapped draft text when only the editor rows change", () => {
    // Given
    const lines = [idle[0], row(`${blue}❯\x1b[0m first draft`), row("  wrapped text"),
      row("  "), row("    indented"), ...idle.slice(2)];
    // When
    const draft = composerDraft(lines);
    // Then
    expect(draft).toBe("first draft wrapped text    indented");
  });

  it("binds all draft rows when a wrapped editor changes", () => {
    const lines = [idle[0], row(`${blue}❯\x1b[0m first`), row("  second"), ...idle.slice(2)];
    expect(composerPrompt(lines)).toBe(`${rule}\n❯ first\n  second\n${rule}`);
  });

  it.each([1, 2, 3])("accepts %i styled footer rows with trailing blank padding", (count) => {
    const lines = [...idle.slice(0, 3 + count), row("  "), row("")];
    expect(tailRule(lines)).toEqual({ bottom: 2, end: 3 + count });
  });

  it("preserves the captured status rows and their styling", () => {
    expect(composerStatusLines(idle)).toEqual(idle.slice(3, 6));
  });

  it.each(["single-described", "single-described-moved", "single-other-focused", "multi"])(
    "refuses typing on the %s dialog while locating its status tail", (name) => {
      const lines = capture(name);
      expect(locateComposer(lines)).toBeNull();
      expect(composerDraft(lines)).toBeNull();
      expect(composerPrompt(lines)).toBeNull();
      expect(tailRule(lines)).toEqual({ bottom: 15, end: 19 });
      expect(composerStatusLines(lines)).toEqual(lines.slice(16, 19));
    },
  );

  it.each([
    ["ordinary appended output", [...idle, row("output after the status")]],
    ["a fourth status row", [...idle, row(`${blue}extra footer`)]],
    ["an intervening blank", [...idle.slice(0, 4), row(""), ...idle.slice(4)]],
    ["a boxed footer", [...idle.slice(0, 5), row(`${blue}╭────────╮`)]],
    ["a double-line boxed footer", [...idle.slice(0, 5), row(`${blue}╔════════╗`)]],
    ["an unstyled continuation", [...idle.slice(0, 5), row("ordinary output")]],
    ["unstyled status fields", [...idle.slice(0, 3), row("cwd • model")]],
    ["a box bottom instead of a plain rule", [idle[0], idle[1], row(`${blue}╰────────╯`), ...idle.slice(3)]],
  ])("rejects the unknown tail when it contains %s", (_name, lines) => {
    expect(tailRule(lines)).toBeNull();
    expect(locateComposer(lines)).toBeNull();
    expect(composerStatusLines(lines)).toEqual([]);
  });

  it.each([
    ["indented prompt", row(`${blue} ❯ draft`)],
    ["unstyled prompt", row("❯ draft")],
    ["dialog choice", row(`${blue} → 1. Choice`)],
  ])("refuses the editor when its prompt is a %s", (_name, prompt) => {
    expect(locateComposer([idle[0], prompt, ...idle.slice(2)])).toBeNull();
  });

  it("refuses a boxed continuation when an apparent composer encloses it", () => {
    const lines = [idle[0], idle[1], row("  │ dialog │"), ...idle.slice(2)];
    expect(locateComposer(lines)).toBeNull();
  });

  it("refuses mismatched rule styling when the frame is torn", () => {
    expect(locateComposer([row(`\x1b[31m${rule}`), ...idle.slice(1)])).toBeNull();
  });

  it("refuses a missing top rule when only the prompt remains", () => {
    expect(locateComposer(idle.slice(1))).toBeNull();
  });

  it("refuses an overlong editor when its prompt lies beyond the scan bound", () => {
    const lines = [idle[0], idle[1], ...Array.from({ length: 100 }, () => row("  text")),
      ...idle.slice(2)];
    expect(locateComposer(lines)).toBeNull();
  });

  it("refuses an empty buffer", () => {
    expect(tailRule([])).toBeNull();
    expect(locateComposer([])).toBeNull();
  });

  it("locates the stock pi editor when the draft row carries no prompt glyph", () => {
    const lines = stock("idle");
    expect(locateComposer(lines)).toEqual({ layout: "stock", top: 0, bottom: 2, end: 5 });
    expect(composerDraft(lines)).toBeNull();
    expect(composerStatusLines(lines)).toEqual(lines.slice(3, 5));
  });

  it("reads the literal draft when it was typed into a real stock pi editor", () => {
    const lines = stock("draft");
    expect(composerDraft(lines)).toBe("collie stock pi draft probe");
    expect(composerPrompt(lines)?.split("\n")[1]).toBe("collie stock pi draft probe");
  });

  it("keeps the editor when a running turn labels the top rule", () => {
    const working = row(`\x1b[38;2;80;80;80m── ⠴ Working ${"─".repeat(40)}`);
    for (const lines of [[working, ...stock("draft").slice(1)], [row(`${blue}── • Working ${"─".repeat(40)}`), ...idle.slice(1)]]) {
      expect(locateComposer(lines)).not.toBeNull();
    }
  });

  it("refuses a stock layout when a row between the rules opens with a space", () => {
    const lines = [...stock("idle").slice(0, 1), row(" Ask user · 30m"), ...stock("idle").slice(2)];
    expect(locateComposer(lines)).toBeNull();
  });
});
