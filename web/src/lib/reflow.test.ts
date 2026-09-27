import { describe, expect, it } from "vitest";

import { parseAnsi } from "./ansi";
import { lineText, splitLines, type StyledLine } from "./blocks";
import { reflowRawLines } from "./reflow";

const lines = (text: string): StyledLine[] => splitLines(parseAnsi(text));
const texts = (ls: StyledLine[]): string[] => ls.map(lineText);

// A wrapped prose row: long (an agent fills its ~133-column pane), ending mid-sentence.
const WRAPPED = `${"word ".repeat(24)}Send a`;
const JOINED = `${WRAPPED} screenshot of what you are seeing and I will dig in.`;

describe("reflowRawLines", () => {
  it("joins a wrapped prose row with its lowercase continuation", () => {
    const out = reflowRawLines(lines(`${WRAPPED}\nscreenshot of what you are seeing and I will dig in.`));
    expect(texts(out)).toEqual([JOINED]);
  });

  it("drops a small continuation indent when joining", () => {
    const out = reflowRawLines(lines(`${WRAPPED}\n   screenshot of what you are seeing.`));
    expect(texts(out)).toEqual([`${WRAPPED} screenshot of what you are seeing.`]);
  });

  it("cascades across three wrapped rows", () => {
    const mid = `screenshot of what you are seeing ${"and ".repeat(22)}still going`;
    const out = reflowRawLines(lines(`${WRAPPED}\n${mid}\nand on it goes.`));
    expect(texts(out)).toEqual([`${WRAPPED} ${mid} and on it goes.`]);
  });

  it("leaves short rows alone", () => {
    const input = lines("short row\nnext row here");
    expect(reflowRawLines(input)).toBe(input);
  });

  it("leaves uppercase-start continuations alone", () => {
    const input = lines(`${WRAPPED}\nScreenshot starts a new sentence.`);
    expect(reflowRawLines(input)).toBe(input);
  });

  it("leaves sentence ends alone", () => {
    const input = lines(`${"word ".repeat(24)}the end.\nand then a new line.`);
    expect(reflowRawLines(input)).toBe(input);
  });

  it("leaves fenced regions and their fences alone", () => {
    const code = `${"x".repeat(110)}=1`;
    const input = lines(`\`\`\`\n${code}\nmore code here\n\`\`\``);
    expect(reflowRawLines(input)).toBe(input);
  });

  it("leaves table rows alone", () => {
    const row = `│ ${"cell ".repeat(24)} │`;
    const input = lines(`${row}\n${row}`);
    expect(reflowRawLines(input)).toBe(input);
  });

  it("leaves blank rows alone, preserving paragraph breaks", () => {
    const input = lines(`${WRAPPED}\n\nscreenshot after a break.`);
    expect(reflowRawLines(input)).toBe(input);
  });

  it("leaves new-block starts alone", () => {
    for (const start of ["- bullet", "1. numbered", "# header", "> quote", "```", "❯ box"]) {
      const input = lines(`${WRAPPED}\n${start} plus ${"filler ".repeat(20)}tail`);
      expect(reflowRawLines(input), start).toBe(input);
    }
  });

  it("leaves mid-token breaks alone (no space near the row end)", () => {
    const input = lines(`see https://${"a".repeat(110)}\ncontinuation-of-token`);
    expect(reflowRawLines(input)).toBe(input);
  });

  it("leaves deep-indented continuations alone", () => {
    const input = lines(`${WRAPPED}\n      indented code shape`);
    expect(reflowRawLines(input)).toBe(input);
  });

  it("leaves box-led rows alone, so a task row never merges into the statusline", () => {
    const task = `└ ◇ builder shared · ${"brief text ".repeat(11)}7m 15s`;
    const input = lines(`${task}\n  muse-spark-1.3 · max · ~/proj · YOLO`);
    expect(reflowRawLines(input)).toBe(input);
  });

  it("leaves ascii-pipe tables alone", () => {
    const row = `| ${"cell ".repeat(24)} |`;
    const input = lines(`${row}\n${row}`);
    expect(reflowRawLines(input)).toBe(input);
  });

  it("joins echo and status rows despite their leading sigils", () => {
    const echo = `❯ ${"word ".repeat(24)}check the`;
    expect(texts(reflowRawLines(lines(`${echo}\n  screenshot again you will see.`)))).toEqual([
      `${echo} screenshot again you will see.`,
    ]);
    const status = `◆ ${"word ".repeat(24)}Send a`;
    expect(texts(reflowRawLines(lines(`${status}\nscreenshot of what you are seeing.`)))).toEqual([
      `${status} screenshot of what you are seeing.`,
    ]);
  });

  it("keeps both sides' spans, with one joining space between", () => {
    const out = reflowRawLines(lines(`\x1b[1m${WRAPPED}\x1b[0m\nscreenshot here.`));
    expect(out).toHaveLength(1);
    const segments = out[0]!.segments;
    expect(segments.map((s) => s.text).join("")).toBe(`${WRAPPED} screenshot here.`);
    expect(segments.some((s) => s.text === " ")).toBe(true);
    expect(segments[0]!.bold).toBe(true);
  });

  it("paints the joining space with the shared background", () => {
    const bg = "rgb(241,241,241)";
    const out = reflowRawLines(
      lines(`\x1b[48;2;241;241;241m${WRAPPED}\x1b[0m\n\x1b[48;2;241;241;241mscreenshot here.\x1b[0m`),
    );
    const space = out[0]!.segments.find((s) => s.text === " ");
    expect(space?.bg).toBe(bg);
  });
});
