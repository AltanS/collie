import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines, type StyledLine } from "../blocks";
import { buildBlocks } from "./index";

const ESC = String.fromCharCode(27);
const BRIGHT = `${ESC}[38;2;250;250;249mbright${ESC}[0m`;
const DARK_BODY = `${ESC}[38;2;111;114;122mbody${ESC}[0m`;

function linesOf(ansi: string): StyledLine[] {
  return splitLines(parseAnsi(ansi));
}

describe("buildBlocks muse display pass", () => {
  it("marks bright foregrounds on muse panes", () => {
    const [block] = buildBlocks(linesOf(`${DARK_BODY}\n${BRIGHT}`), { agent: "muse" });
    expect(block!.kind).toBe("raw");
    const segments =
      block!.kind === "raw" ? block.lines.flatMap((line) => line.segments) : [];
    expect(segments.map((s) => s.lightDarkFg ?? false)).toEqual([false, true]);
  });

  it("leaves muse panes without a bright foreground identical", () => {
    const lines = linesOf(DARK_BODY);
    const [block] = buildBlocks(lines, { agent: "muse" });
    expect(block!.kind).toBe("raw");
    if (block!.kind === "raw") expect(block.lines).toBe(lines);
  });

  it.each([["shell"], ["Muse"], ["muse-code"], [undefined]])("leaves %s panes identical", (agent) => {
    const lines = linesOf(BRIGHT);
    const [block] = buildBlocks(lines, agent === undefined ? undefined : { agent });
    expect(block!.kind).toBe("raw");
    if (block!.kind === "raw") {
      expect(block.lines).toBe(lines);
      expect(block.lines[0]!.segments[0]).not.toHaveProperty("lightDarkFg");
    }
  });

  it("marks nothing on adapter panes: the pass is muse-only", () => {
    const lines = linesOf(BRIGHT);
    const [block] = buildBlocks(lines, { agent: "codex" });
    expect(block!.kind).toBe("raw");
    if (block!.kind === "raw") {
      expect(
        block.lines.flatMap((line) => line.segments).some((s) => s.lightDarkFg),
      ).toBe(false);
    }
  });

  it("trims Muse row chrome on muse panes", () => {
    const gutter = `${ESC}[38;2;170;171;175m  ${ESC}[0m`;
    const [block] = buildBlocks(linesOf(`${gutter}${DARK_BODY}   `), { agent: "muse" });
    expect(block!.kind).toBe("raw");
    if (block!.kind === "raw") {
      expect(block.lines[0]!.segments.map((s) => s.text)).toEqual(["body"]);
    }
  });

  it("trims nothing on non-muse panes: row text stays byte-faithful", () => {
    const gutter = `${ESC}[38;2;170;171;175m  ${ESC}[0m`;
    const lines = linesOf(`${gutter}${DARK_BODY}   `);
    const [block] = buildBlocks(lines, { agent: "codex" });
    expect(block!.kind).toBe("raw");
    if (block!.kind === "raw") expect(block.lines).toBe(lines);
  });
});
