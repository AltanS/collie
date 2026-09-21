import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { menusEqual, menusSameIdentity } from "../menu-model";
import { detectEffort } from "./effort";
import { claudeBuildBlocks } from "./index";
import { detectMenu } from "./menu";

// The `/effort` slider's own grammar. What it adds over the generic menu is the pair the generic one
// cannot produce: the CURRENT VALUE, read from the `▲`'s column against the label row, and the `s`
// key, whose footer segment says "for" where the shared parser demands "to". Everything else —
// the model, the renderer, the identity comparator, the race guard — is inherited unchanged.
//
// The load-bearing assertions here are the position-independent ones: the value follows the marker
// (test "value"), it reads correctly at a second capture width (test "width"), and the detector
// claims nothing else in the corpus (test "declines").

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const FIXTURE = "claude--menu-effort-slider.txt";
// The second capture width. It is WIDER, not narrower, and that is a finding rather than a
// preference: captured 2026-09-21 at 40, 60, 70, 75, 80 and 120 columns, Claude lays the slider out
// as a flex row, so under about 86 columns the scale and the footer both wrap and there is no single
// label row left to read. 120 is the nearest width in the capture lab's own set at which the screen
// still renders whole. The wrapped shape is not in the corpus — it belongs to the capture lab's own
// table, not to the six suites that glob `claude--*` — so the case for it below is hand-built from
// what the 60-column pane really showed.
const WIDE_FIXTURE = "claude--menu-effort-slider--w120.txt";

function lines(text: string): StyledLine[] {
  return splitLines(parseAnsi(text));
}
function raw(name: string): string {
  return readFileSync(join(PANES_DIR, name), "utf8");
}
function load(name: string): StyledLine[] {
  return lines(raw(name));
}
function textOf(line: StyledLine): string {
  return line.segments.map((s) => s.text).join("");
}

const EXPECTED_ACTIONS = [
  { label: "Confirm", keys: ["Enter"] },
  { label: "This session only", keys: ["s"] },
  { label: "Cancel", keys: ["Escape"], cancel: true },
];

describe("detectEffort — the /effort slider", () => {
  it("lifts the slider as a menu with all three footer keys and the arrow nav", () => {
    const model = detectEffort(load(FIXTURE));
    expect(model).not.toBeNull();
    expect(model!.title).toBe("Effort");
    // In footer order, with the `s` key the shared parser drops because this screen writes
    // "s for this session only" rather than "s to …".
    expect(model!.actions).toEqual(EXPECTED_ACTIONS);
    // No highlight on this screen, so Up/Down mean nothing; the arrows carry the value.
    expect(model!.nav).toEqual({ upDown: false, leftRight: { verb: "adjust", label: "xhigh" } });
    expect(model!.signature).not.toBe("");
  });

  it("is the arm that produces the block, not the generic menu", () => {
    const paneLines = load(FIXTURE);
    const blocks = claudeBuildBlocks(paneLines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "menu"]);
    const block = blocks[1]!;
    if (block.kind !== "menu") throw new Error("expected a menu block");
    // The generic detector claims this screen too, but with two actions and no nav. Deep-equality
    // against the Effort model is what proves which arm ran.
    expect(block.menu).toEqual(detectEffort(paneLines)!);
    expect(block.menu.actions).toEqual(EXPECTED_ACTIONS);
    expect(block.menu.nav.leftRight).toEqual({ verb: "adjust", label: "xhigh" });
  });

  it("emits no digit key", () => {
    for (const fixture of [FIXTURE, WIDE_FIXTURE]) {
      const model = detectEffort(load(fixture))!;
      expect(model).not.toBeNull();
      for (const key of model.actions.flatMap((a) => a.keys)) {
        expect(/\d/.test(key), key).toBe(false);
      }
    }
  });
});

describe("detectEffort — the value tracks the marker", () => {
  it("reads whichever label the ▲ stands over, and only the value changes", () => {
    const before = detectEffort(load(FIXTURE))!;
    expect(before.nav.leftRight!.label).toBe("xhigh");

    // Move the marker to the column of `low`, keeping the row's length: the scale row is the only
    // edit, so anything but the value changing would be the detector reading something else. The
    // edit is made on the PARSED row, because in the capture the `▲` is its own styled segment and a
    // regex over the raw bytes would have to step through the escapes around it.
    const paneLines = load(FIXTURE);
    const at = paneLines.findIndex((l) => textOf(l).includes("▲"));
    expect(at).toBeGreaterThan(0);
    const scale = textOf(paneLines[at]!);
    const marker = scale.indexOf("▲");
    // `low` is centred at column 11.5 and the scale starts at column 10, so one glyph in.
    const moved = scale.slice(0, 10) + "─▲" + scale.slice(12, marker) + "─" + scale.slice(marker + 1);
    expect(moved.length).toBe(scale.length);
    const movedLines = [...paneLines];
    movedLines[at] = lines(moved)[0]!;
    const after = detectEffort(movedLines)!;
    expect(after).not.toBeNull();
    expect(after.nav.leftRight!.label).toBe("low");

    expect(after.title).toBe(before.title);
    expect(after.actions).toEqual(before.actions);
    expect(after.nav.leftRight!.verb).toBe(before.nav.leftRight!.verb);
    expect(after.signature).not.toBe(before.signature);

    // The pairing that makes Left/Right safe and Enter careful: same screen, different render.
    expect(menusSameIdentity(before, after)).toBe(true);
    expect(menusEqual(before, after)).toBe(false);
  });
});

describe("detectEffort — a second capture width", () => {
  it("reads its own value at 120 columns, where the labels sit at other columns", () => {
    const model = detectEffort(load(WIDE_FIXTURE));
    expect(model).not.toBeNull();
    expect(model!.title).toBe("Effort");
    // What that screen showed: a fresh isolated config, `/effort` opened without touching the
    // arrows, marker over `high`. The 82-column capture reads `xhigh`, so the two files disagree on
    // the value and agree on everything else — which is the point of having both.
    expect(model!.nav.leftRight).toEqual({ verb: "adjust", label: "high" });
    expect(model!.actions).toEqual(EXPECTED_ACTIONS);

    // Position-independence, stated as a fact about the two files rather than assumed: the labels
    // are at different columns in each, and the detector names both values correctly.
    const labelRowOf = (name: string): string =>
      load(name)
        .map(textOf)
        .find((t) => /\blow\b/.test(t) && /\bhigh\b/.test(t))!;
    expect(labelRowOf(FIXTURE).indexOf("high")).not.toBe(labelRowOf(WIDE_FIXTURE).indexOf("high"));

    const blocks = claudeBuildBlocks(load(WIDE_FIXTURE));
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "menu"]);
  });

  it("declines when the marker stands between two labels", () => {
    // A near-tie is not a close call to be resolved, it is evidence that this is not the layout we
    // measured. The marker here sits on the midpoint between `low` and `medium`. A marker occupies a
    // whole column and a centre can fall on a half, so the two distances land within half a cell of
    // each other rather than dead equal — which is the near-tie the bail is written for.
    const paneLines = load(FIXTURE);
    const at = paneLines.findIndex((l) => textOf(l).includes("\u25b2"));
    const scale = textOf(paneLines[at]!);
    const spans = [...textOf(paneLines[at + 1]!).matchAll(/\S+/g)];
    const centre = (i: number): number => spans[i]!.index + spans[i]![0].length / 2;
    const midpoint = Math.round((centre(0) + centre(1)) / 2);
    const tie = Math.abs(Math.abs(centre(0) - midpoint) - Math.abs(centre(1) - midpoint));
    expect(tie).toBeLessThan(1);

    const marker = scale.indexOf("\u25b2");
    const moved =
      scale.slice(0, midpoint) +
      "\u25b2" +
      scale.slice(midpoint + 1, marker) +
      "\u2500" +
      scale.slice(marker + 1);
    expect(moved.length).toBe(scale.length);
    const movedLines = [...paneLines];
    movedLines[at] = lines(moved)[0]!;
    expect(detectEffort(movedLines)).toBeNull();
  });

  it("leaves the captured reads alone — their margins are 8 cells and more", () => {
    expect(detectEffort(load(FIXTURE))!.nav.leftRight!.label).toBe("xhigh");
    expect(detectEffort(load(WIDE_FIXTURE))!.nav.leftRight!.label).toBe("high");
  });

  it("never reads the scale's own wrapped continuation as the label row", () => {
    // The hazard between those two widths: a pane wide enough for the footer but too narrow for the
    // scale. The row under the marker is then more rule glyphs, and a detector that counted them as
    // labels would report `──┆` as the operator's current effort.
    const wrappedScale = [
      "─".repeat(78),
      "  Effort",
      "",
      "   Faster                       Smarter",
      "   ─────────────▲──────────────────────────",
      "   ───────       ────────┆     ──────",
      "   low   medium   high   xhigh   max   ultracode",
      "",
      "  ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel",
    ].join("\n");
    expect(detectEffort(lines(wrappedScale))).toBeNull();
  });
});

describe("detectEffort — what it declines", () => {
  it("claims no other pane fixture, of any adapter", () => {
    const claimed = readdirSync(PANES_DIR)
      .filter((n) => n.endsWith(".txt"))
      .filter((n) => detectEffort(load(n)) !== null)
      .toSorted();
    expect(claimed).toEqual(
      [FIXTURE, WIDE_FIXTURE, "claude-lab--menu-effort-slider--w82.txt"].toSorted(),
    );
  });
});

describe("detectEffort — the nearest lookalike", () => {
  it("does not take the /model picker, which the generic menu keeps", () => {
    // The closest thing on screen to this grammar: the picker's `◐ Medium effort ←/→ to adjust` row
    // names the same arrows with the same verb. It carries no `▲`, and its arrow phrase is a REGION
    // row rather than the footer, so the Effort arm declines and the generic one still owns it.
    const paneLines = load("claude--menu-model-picker.txt");
    expect(detectEffort(paneLines)).toBeNull();

    const blocks = claudeBuildBlocks(paneLines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "menu"]);
    const block = blocks[1]!;
    if (block.kind !== "menu") throw new Error("expected a menu block");
    // Byte for byte the model the generic detector produces — the new arm above it stole nothing.
    expect(block.menu).toEqual(detectMenu(paneLines)!);
  });
});
