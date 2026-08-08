import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines } from "../../blocks";
import { analysePiEditor, extractInputDraft, piAdapter, piBuildBlocks } from ".";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const fixtureLines = (name: string) => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
const rawText = (lines: ReturnType<typeof fixtureLines>) => lines.map(lineText).join("\n");

const RULE = "─".repeat(100);
const FOOTER = "\x1b[38;2;102;102;102m";
const BORDER = "\x1b[38;2;80;80;80m";
const HIGH_CONTEXT = "\x1b[38;2;255;180;0m";

function meter(prefix = "", context = "0.0%/0 (auto)", highlighted = false): string {
  const right = "no-model";
  const left = `${prefix}${context}`;
  const padding = " ".repeat(RULE.length - left.length - right.length);
  const contextText = highlighted ? `${HIGH_CONTEXT}${context}\x1b[0m${FOOTER}` : context;
  return `${FOOTER}${prefix}${contextText}${padding}${right}\x1b[0m`;
}

function standard(
  input: string,
  { prefix, context, highlighted, extra = [] }: { prefix?: string; context?: string; highlighted?: boolean; extra?: string[] } = {},
) {
  return splitLines(
    parseAnsi(
      [
        ...extra,
        `${BORDER}${RULE}\x1b[0m`,
        input,
        `${BORDER}${RULE}\x1b[0m`,
        `${FOOTER}/sandbox/cwd\x1b[0m`,
        meter(prefix, context, highlighted),
      ].join("\n"),
    ),
  );
}

const replacementLine = (text: string) => splitLines(parseAnsi(text))[0]!;

describe("Pi standard editor", () => {
  it("does not claim composer readiness from rendered pane bytes", () => {
    expect(piAdapter.composerReady).toBeUndefined();
  });

  it("omits only the captured standard editor, retaining startup output and footer raw", () => {
    const lines = fixtureLines("pi--editor.txt");
    const editor = analysePiEditor(lines);
    expect(editor).toMatchObject({ draft: null });

    const kept = rawText(piBuildBlocks(lines)[0]!.lines);
    expect(kept).toContain("fd not found. Offline mode enabled");
    expect(kept).toContain("0.0%/0 (auto)");
    expect(kept).not.toContain("─".repeat(40));
  });

  it("recovers the real unsent draft, including its combining mark and grapheme", () => {
    expect(extractInputDraft(fixtureLines("pi--editor-draft.txt"))).toBe("review emoji: é 👩‍👧‍👦");
  });

  it("keeps a source-real inverse grapheme and an internal cursor-on-space", () => {
    expect(extractInputDraft(standard(`before \x1b[7m👩‍👧‍👦\x1b[0m after`))).toBe("before 👩‍👧‍👦 after");
    expect(extractInputDraft(standard(`a\x1b[7m \x1b[0mb`))).toBe("a b");
  });

  it("accepts stock active, high-context, and unknown-context footer states", () => {
    const active = standard("reply\x1b[7m \x1b[0m", {
      prefix: "↑1.2k ↓300 R2.0k W1.0k CH75.0% $0.123 ",
      context: "80.1%/128k (auto)",
      highlighted: true,
    });
    const unknown = standard("reply\x1b[7m \x1b[0m", {
      prefix: "↑1.2k ↓300 ",
      context: "?/128k (auto)",
    });

    expect(extractInputDraft(active)).toBe("reply");
    expect(extractInputDraft(unknown)).toBe("reply");
  });

  it("rejects ordinary backgrounds, weak or unequal rules, faux footers, and a disrupted tail", () => {
    const ordinaryBackground = standard(`a\x1b[38;2;1;2;3;48;2;4;5;6mX\x1b[0m`);
    const oneGlyph = standard("\x1b[7m \x1b[0m");
    oneGlyph[0] = replacementLine(`${BORDER}─\x1b[0m`);
    const unequal = standard("\x1b[7m \x1b[0m");
    unequal[2] = replacementLine(`${BORDER}${"─".repeat(39)}\x1b[0m`);
    const fauxFooter = standard("\x1b[7m \x1b[0m");
    const fauxMeter = "0.0%/0 not-pi";
    fauxFooter[4] = replacementLine(`${FOOTER}${fauxMeter}${" ".repeat(RULE.length - fauxMeter.length)}\x1b[0m`);
    const tailDisruption = standard("\x1b[7m \x1b[0m").concat(replacementLine("overlay elsewhere"));

    for (const lines of [ordinaryBackground, oneGlyph, unequal, fauxFooter, tailDisruption]) {
      expect(analysePiEditor(lines)).toBeNull();
      expect(piBuildBlocks(lines)[0]!.lines).toBe(lines);
      expect(extractInputDraft(lines)).toBeNull();
    }
  });

  it("keeps wraps, a second editor frame, autocomplete, and custom footer tails raw", () => {
    const wrapped = splitLines(
      parseAnsi(
        [
          `${BORDER}${RULE}\x1b[0m`,
          "first row",
          "\x1b[7m \x1b[0m",
          `${BORDER}${RULE}\x1b[0m`,
          `${FOOTER}/sandbox/cwd\x1b[0m`,
          meter(),
        ].join("\n"),
      ),
    );
    const secondFrame = standard("\x1b[7m \x1b[0m");
    secondFrame.unshift(...standard("\x1b[7m \x1b[0m").slice(0, 3));
    const autocomplete = standard("\x1b[7m \x1b[0m").concat(replacementLine("autocomplete option"));
    const customFooter = standard("\x1b[7m \x1b[0m");
    customFooter[4] = replacementLine(`${FOOTER}custom status tail\x1b[0m`);

    for (const lines of [wrapped, secondFrame, autocomplete, customFooter]) {
      expect(analysePiEditor(lines)).toBeNull();
      expect(piBuildBlocks(lines)[0]!.lines).toBe(lines);
    }
  });

  it("does not filter a standalone U+2500 output row unless a full editor was analysed", () => {
    const lines = splitLines(parseAnsi(`meaningful output\n${RULE}\nmore output`));
    expect(rawText(piBuildBlocks(lines)[0]!.lines)).toContain(RULE);
  });
});
