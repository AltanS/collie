import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { lineText, splitLines, type Block, type StyledLine } from "../blocks";
import { buildBlocks } from "./index";

const ESC = String.fromCharCode(27);
const BRIGHT = `${ESC}[38;2;250;250;249mbright${ESC}[0m`;
const DARK_BODY = `${ESC}[38;2;111;114;122mbody${ESC}[0m`;

function linesOf(ansi: string): StyledLine[] {
  return splitLines(parseAnsi(ansi));
}

// Since M34 a pane whose adapter cannot find its composer is the unread-dialog card's screen
// (.adr/0053) rather than a raw block. These cases are about the native DISPLAY pass, so the muse
// ones run on a plausible pane — a rule, the `❯` row, a rule, a status row — instead of a bare
// two-word fragment. The rows below the body are chrome the pass never touches.
const RULE = "─".repeat(40);
const MUSE_TAIL = `\n${RULE}\n❯ \n${RULE}\n  muse-spark · max · /tmp`;

/** The mirrored lines, off whichever block carries them. The card hands its region through by
 *  reference, so identity assertions below mean the same thing for either kind. */
function mirrorLines(block: Block): StyledLine[] {
  return block.lines;
}

describe("buildBlocks native display pass", () => {
  it("marks bright foregrounds on muse panes", () => {
    const [block] = buildBlocks(linesOf(`${DARK_BODY}\n${BRIGHT}${MUSE_TAIL}`), { agent: "muse" });
    expect(block!.kind).toBe("raw");
    const segments = mirrorLines(block!)
      .slice(0, 2)
      .flatMap((line) => line.segments);
    expect(segments.map((s) => s.lightDarkFg ?? false)).toEqual([false, true]);
  });

  it("leaves muse panes without a bright foreground identical", () => {
    const lines = linesOf(`${DARK_BODY}${MUSE_TAIL}`);
    const [block] = buildBlocks(lines, { agent: "muse" });
    expect(block!.kind).toBe("raw");
    // The BODY row, by reference: the display pass allocates nothing when it marks nothing. The
    // composer rows below it are the pane's own chrome, and the row-chrome trim does rewrite those.
    expect(mirrorLines(block!)[0]).toBe(lines[0]);
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

  it("marks nothing on adapter panes: adapters keep the inverted mirror", () => {
    // A bare fragment with no composer on it: codex declares a cancel key, so the post-pass answers
    // with the card and the raw block is gone. The CLAIM here is about the lines, and the card
    // carries the same ones — so read them off whichever block came back.
    const lines = linesOf(BRIGHT);
    const [block] = buildBlocks(lines, { agent: "codex" });
    expect(mirrorLines(block!).flatMap((line) => line.segments).some((s) => s.lightDarkFg)).toBe(
      false,
    );
  });

  it("trims Muse row chrome on muse panes", () => {
    const gutter = `${ESC}[38;2;170;171;175m  ${ESC}[0m`;
    const [block] = buildBlocks(linesOf(`${gutter}${DARK_BODY}   ${MUSE_TAIL}`), { agent: "muse" });
    expect(block!.kind).toBe("raw");
    expect(mirrorLines(block!)[0]!.segments.map((s) => s.text)).toEqual(["body"]);
  });

  it.each([["codex"], ["opencode"]])(
    "trims nothing on %s panes: row text stays byte-faithful",
    (agent) => {
      const gutter = `${ESC}[38;2;170;171;175m  ${ESC}[0m`;
      // Same as above: on codex the composer-less fragment comes back as the card, which hands its
      // region through by reference — so the byte-faithfulness claim is asserted on that reference.
      const lines = linesOf(`${gutter}${DARK_BODY}   `);
      const [block] = buildBlocks(lines, { agent });
      expect(mirrorLines(block!)).toEqual(lines);
    },
  );

  // The card renders its region ITSELF, so the display passes have to have run before the pass that
  // builds it (harness/index.ts). Otherwise a Muse pane with no composer on it shows an un-trimmed,
  // un-marked mirror inside the card while the same pane's raw mirror is trimmed and marked.
  it("hands a muse card the decorated, trimmed lines", () => {
    const gutter = `${ESC}[38;2;170;171;175m  ${ESC}[0m`;
    // No composer on this screen, so the M34 post-pass answers with the card (.adr/0053).
    const lines = linesOf(`${gutter}${DARK_BODY}   \n${gutter}${BRIGHT}   `);
    expect(lines.map(lineText)).toEqual(["  body   ", "  bright   "]);

    const [block] = buildBlocks(lines, { agent: "muse" });
    expect(block!.kind).toBe("unread-dialog");
    // Trimmed: the grey gutter and the trailing pad are gone from the card's own region.
    expect(mirrorLines(block!).map(lineText)).toEqual(["body", "bright"]);
    // Decorated: the bright foreground is marked for the light-gated property, the body is not.
    expect(
      mirrorLines(block!)
        .flatMap((line) => line.segments)
        .map((s) => s.lightDarkFg ?? false),
    ).toEqual([false, true]);
  });

  it("leaves an opencode pane to the inverting mirror: no trim, no marks", () => {
    // opencode is not a native mirror (see display.ts): on its dark background answer the
    // body is rgb(238,238,238), 1.13:1 raw on the native ground against 17.32:1 inverted.
    // So its lines come back untouched and the inversion filter does the work.
    const gutter = `${ESC}[38;2;170;171;175m  ${ESC}[0m`;
    const lines = linesOf(`${gutter}${BRIGHT}`);
    const [block] = buildBlocks(lines, { agent: "opencode" });
    expect(block!.kind).toBe("raw");
    if (block!.kind === "raw") {
      expect(block.lines).toBe(lines);
      expect(block.lines[0]!.segments[1]).not.toHaveProperty("lightDarkFg", true);
    }
  });
});
