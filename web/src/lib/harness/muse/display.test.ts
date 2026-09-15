import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { BRIGHT_FG_LUMINANCE, decorateMuseDisplay, luminance } from "./display";

const ESC = String.fromCharCode(27);

// Palette values below are observed, not invented: captured from a live `muse` TUI under a pty
// (issue #220), plus the live pane.read bytes. Herdr 0.9.0 answers OSC 10/11 from its theme, so
// a light Herdr theme yields the light row and a dark one the dark row; older Herdr answered
// neither and yields the fallback ramp. All three rows are pinned, so the decorator stays
// correct under any theme and any mux.
const FALLBACK_BODY = "111;114;122";
const FALLBACK_SECONDARY = "94;97;104";
const FALLBACK_HINT = "75;77;82";
const DARK_BODY = "117;120;129";
const LIGHT_BODY = "56;58;66";
const LIGHT_HINT = "175;176;180";
const ACCENT_PINK = "189;72;186";
const ACCENT_ORANGE = "193;132;1";
const NEAR_WHITE = "250;250;249";

function fg(rgb: string, text: string): string {
  return `${ESC}[38;2;${rgb}m${text}${ESC}[0m`;
}

function linesOf(ansi: string): StyledLine[] {
  return splitLines(parseAnsi(ansi));
}

function marked(lines: StyledLine[]): StyledLine[] {
  return lines.filter((line) => line.segments.some((segment) => segment.lightDarkFg));
}

describe("decorateMuseDisplay", () => {
  it("marks near-white foregrounds, which a native light mirror would lose on white", () => {
    const lines = linesOf(fg(NEAR_WHITE, "Worked for 1m 21s"));
    const [line] = decorateMuseDisplay(lines);
    expect(line!.segments).toHaveLength(1);
    expect(line!.segments[0]).toMatchObject({ text: "Worked for 1m 21s", lightDarkFg: true });
  });

  it.each([
    ["fallback body", FALLBACK_BODY],
    ["fallback secondary", FALLBACK_SECONDARY],
    ["fallback hint", FALLBACK_HINT],
    ["dark-terminal body", DARK_BODY],
    ["light-terminal body", LIGHT_BODY],
    ["light-terminal hint", LIGHT_HINT],
    ["pink accent", ACCENT_PINK],
    ["orange accent", ACCENT_ORANGE],
  ])("leaves Muse's %s alone: dark and mid tones render raw on light", (_label, rgb) => {
    const lines = linesOf(fg(rgb, "Do you trust this workspace?"));
    expect(marked(decorateMuseDisplay(lines))).toHaveLength(0);
  });

  it("leaves bare spans alone: the light container's own dark default carries them", () => {
    const lines = linesOf("plain inherited text");
    expect(marked(decorateMuseDisplay(lines))).toHaveLength(0);
  });

  it("leaves explicit fg+bg pairs alone: the pair is self-sufficient on any ground", () => {
    const chip = `${ESC}[38;2;${NEAR_WHITE}m${ESC}[48;2;20;20;22m● white on a dark chip${ESC}[0m`;
    expect(marked(decorateMuseDisplay(linesOf(chip)))).toHaveLength(0);
  });

  it("skips muted rule glyphs even in white: the renderer re-resolves decorative chrome", () => {
    const rule = fg(NEAR_WHITE, "─".repeat(12));
    expect(marked(decorateMuseDisplay(linesOf(rule)))).toHaveLength(0);
  });

  it("changes not one byte of text", () => {
    const ansi = [fg(FALLBACK_BODY, "body"), fg(NEAR_WHITE, "bright"), "bare"].join("\n");
    const lines = linesOf(ansi);
    const decorated = decorateMuseDisplay(lines);
    expect(decorated.map(lineText)).toEqual(lines.map(lineText));
  });

  it("returns the same array when a screen carries no bright foreground", () => {
    const lines = linesOf([fg(FALLBACK_BODY, "body"), fg(ACCENT_ORANGE, "link"), "bare"].join("\n"));
    expect(decorateMuseDisplay(lines)).toBe(lines);
  });

  it("marks bright 256-colour ramp entries, which the parser emits as rgb()", () => {
    const ansi = `${ESC}[38;5;231mnear white${ESC}[0m`;
    expect(marked(decorateMuseDisplay(linesOf(ansi)))).toHaveLength(1);
  });

  it.each([
    ["bright white 97m", "97"],
    ["white 37m", "37"],
    ["bright yellow 93m", "93"],
    ["yellow 33m", "33"],
    ["38;5;15", "38;5;15"],
  ])("marks indexed %s: its dark slot value is unreadable on white", (_label, code) => {
    const ansi = `${ESC}[${code}mbright${ESC}[0m`;
    expect(marked(decorateMuseDisplay(linesOf(ansi)))).toHaveLength(1);
  });

  it.each([
    ["red 31m", "31"],
    ["bright black 90m", "90"],
    ["bright red 91m", "91"],
    ["38;5;1", "38;5;1"],
  ])("leaves indexed %s alone: dark slots render raw", (_label, code) => {
    const ansi = `${ESC}[${code}mdark${ESC}[0m`;
    expect(marked(decorateMuseDisplay(linesOf(ansi)))).toHaveLength(0);
  });

  // The pinned slot set in display.ts names MEMBERSHIP, not values: the values live in index.css,
  // and a retune that moved a slot across the luminance line must fail here, loudly, rather than
  // silently whitening (or needlessly darkening) indexed spans in native mirrors.
  it("pins the bright indexed set against the stylesheet's slot values", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "..", "..", "index.css"), "utf8");
    const slots = [...css.matchAll(/--ansi-(\d+):\s*#([0-9a-fA-F]{3,8});/g)].map((m) => ({
      slot: Number(m[1]),
      hex: m[2]!.length <= 4 ? m[2]!.split("").map((c) => c + c).join("") : m[2]!,
    }));
    expect(slots).toHaveLength(16);
    const bright = new Set(
      slots
        .filter(({ hex }) => {
          const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
          return luminance(r, g, b) > BRIGHT_FG_LUMINANCE;
        })
        .map(({ slot }) => slot),
    );
    expect(bright).toEqual(new Set([3, 7, 11, 15]));
  });
});
