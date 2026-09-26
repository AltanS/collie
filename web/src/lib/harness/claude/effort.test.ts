import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { buildBlocks } from "../index";
import { menusEqual, menusSameIdentity } from "../menu-model";
import { detectEffort, detectEffortRegion } from "./effort";
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
// The third capture width, taken live on 2026-09-22 and CROPPED to the dialog (the transcript it
// opened over was the operator's own work). It is the whole-scale reference: six levels on one label
// row, a `┆` divider in the track, and a second label row under it that the grammar ignores.
const SCALE_FIXTURE = "claude--menu-effort-slider--w132.txt";
// The three NARROW captures, taken live on 2026-09-22 at 40, 60 and 80 columns. 80 renders whole;
// below about 70 Claude wraps the dialog three ways at once — each label word breaks onto a second
// row in its own column, the track splits, and the footer runs over two or three rows. All three
// show the marker over `medium`.
const WRAPPED_FIXTURES = [
  "claude--menu-effort-slider--w40.txt",
  "claude--menu-effort-slider--w60.txt",
  "claude--menu-effort-slider--w80.txt",
];
// Six more real captures, taken live on 2026-09-22 with a NON-default level selected — `low` and
// `ultracode` — at 40, 60 and 80 columns. Four lift, and lift exactly as the medium-selected
// fixtures above do at the same width: the level read is a position against the marker, not a
// vocabulary, so a different selected word is not a different grammar. Two decline, each for its
// own reason (see the `LOW_ULTRACODE_DECLINES` cases below); those two are deliberately NOT in
// `EFFORT_FIXTURES`, because `detectEffort` returns null on both of them.
const LOW_ULTRACODE_LIFTS: Array<{ name: string; label: string }> = [
  { name: "claude--menu-effort-slider--w60-low.txt", label: "low" },
  { name: "claude--menu-effort-slider--w80-low.txt", label: "low" },
  { name: "claude--menu-effort-slider--w80-ultracode.txt", label: "ultracode" },
  // The 60-column `ultracode` render: the dialog repaints flush-left and unwrapped, and the footer
  // is broken by the TERMINAL at column 0 rather than by Claude's flex wrap. `readKeyHintFooter`
  // reads that soft wrap as one block, so all three keys and the `←/→` phrase survive the join.
  { name: "claude--menu-effort-slider--w60-ultracode.txt", label: "ultracode" },
];
// Claude Code 2.1.283 opens the slider under a `▔` modal edge that carries a label
// (`▔▔▔…▔ ● high · /effort ▔`), with no `─` rule anywhere above the title. Before region-top.ts read
// that edge, the scan found no top and the live screen fell to the unread-dialog card; every older
// capture above passed because a plain `▔` row or a transcript rule sat inside the window.
const EDGE_FIXTURE = "claude--v2283-slash-effort.txt";
// The scale that screen printed, left to right.
const SCALE = ["low", "medium", "high", "xhigh", "max", "ultracode"];
// Every capture of this screen in the corpus.
const EFFORT_FIXTURES = [
  FIXTURE,
  WIDE_FIXTURE,
  SCALE_FIXTURE,
  ...WRAPPED_FIXTURES,
  ...LOW_ULTRACODE_LIFTS.map((f) => f.name),
  "claude-lab--menu-effort-slider--w82.txt",
  EDGE_FIXTURE,
];

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
    expect(model!.nav).toEqual({
      upDown: false,
      leftRight: { verb: "adjust", label: "xhigh", values: SCALE },
    });
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
    expect(block.menu.nav.leftRight).toEqual({ verb: "adjust", label: "xhigh", values: SCALE });
  });

  it("emits no digit key", () => {
    for (const fixture of EFFORT_FIXTURES) {
      const model = detectEffort(load(fixture))!;
      expect(model).not.toBeNull();
      for (const key of model.actions.flatMap((a) => a.keys)) {
        expect(/\d/.test(key), key).toBe(false);
      }
    }
  });
});

describe("detectEffort — the `▔` modal edge of Claude Code 2.1.283", () => {
  it("lifts the slider whose only region top is a labelled `▔` edge", () => {
    const region = detectEffortRegion(load(EDGE_FIXTURE));
    expect(region).not.toBeNull();
    expect(region!.model.title).toBe("Effort");
    expect(region!.model.actions).toEqual(EXPECTED_ACTIONS);
    expect(region!.model.nav).toEqual({
      upDown: false,
      leftRight: { verb: "adjust", label: "high", values: SCALE },
    });
    expect(textOf(load(EDGE_FIXTURE)[region!.startLine]!).startsWith("▔")).toBe(true);
    expect(claudeBuildBlocks(load(EDGE_FIXTURE)).map((b) => b.kind)).toEqual(["menu"]);
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
    expect(model!.nav.leftRight).toEqual({ verb: "adjust", label: "high", values: SCALE });
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
    // The row under the marker on a narrow pane is more rule glyphs, and a detector that counted
    // them as labels would report `──┆` as the operator's current effort. The track row is stepped
    // over by name, so the labels below it are what the grammar reads — and because the track
    // wrapped, so did they, which is why the row under them completes two of the six.
    const wrappedScale = [
      "▔".repeat(78),
      "  Effort",
      "",
      "   Faster                       Smarter",
      "   ─────────────▲──────────────────────────",
      "   ───────       ────────┆     ──────",
      "   low    mediu     high    xhigh    max    ultracod",
      "          m                                 e",
      "",
      "  ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel",
    ].join("\n");
    const model = detectEffort(lines(wrappedScale));
    expect(model).not.toBeNull();
    expect(model!.nav.leftRight!.values).toEqual(SCALE);
    expect(model!.nav.leftRight!.label).toBe("medium");
  });
});

describe("detectEffort — the wrapped dialog", () => {
  // Claude Code 2.1.278 wraps `/effort` below about 70 columns. Three real captures pin it: the
  // level is still read, and the levels are rebuilt from their wrapped halves.
  it.each(WRAPPED_FIXTURES)("reads %s as six whole levels with the marker over medium", (name) => {
    const model = detectEffort(load(name));
    expect(model).not.toBeNull();
    expect(model!.title).toBe("Effort");
    expect(model!.nav).toEqual({
      upDown: false,
      leftRight: { verb: "adjust", label: "medium", values: SCALE },
    });
    // The footer wraps onto three rows at 40 and two at 60, so all three keys are read only if the
    // rows were rejoined first.
    expect(model!.actions).toEqual(EXPECTED_ACTIONS);
    expect(model!.signature).not.toBe("");
  });

  it.each(WRAPPED_FIXTURES)("is the Effort arm that produces %s's block", (name) => {
    const paneLines = load(name);
    const blocks = claudeBuildBlocks(paneLines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "menu"]);
    const block = blocks[1]!;
    if (block.kind !== "menu") throw new Error("expected a menu block");
    // Deep-equality against the Effort model, not merely `kind === "menu"`: at 60 columns the
    // GENERIC grammar also claims this screen, with no level and no values, so a kind check alone
    // would pass on the fallback.
    expect(block.menu).toEqual(detectEffort(paneLines)!);
    expect(block.menu.nav.leftRight!.values).toEqual(SCALE);
    expect(block.menu.nav.leftRight!.label).toBe("medium");
  });

  it("never lets the description row into the scale", () => {
    // `xhigh + workflows` sits under the labels on every capture. On the wide ones it is the row
    // directly beneath them, and it is refused because its tokens do not line up under the heads;
    // on the narrow ones it is further down still. Either way it is never a level.
    for (const name of EFFORT_FIXTURES) {
      const values = detectEffort(load(name))!.nav.leftRight!.values!;
      expect(values, name).not.toContain("xhigh + workflows");
      expect(values, name).not.toContain("workflows");
    }
  });

  it("does not merge a row whose token starts outside every head span", () => {
    // The continuation rule is alignment, not adjacency: one fragment starting outside every head
    // label's column span refuses the whole row, and the head row stands alone. This fragment sits
    // in the gutter between `low` and `medium`, so nothing merges, and the head row's own words
    // still read as the scale.
    const screen = [
      "▔".repeat(60),
      "  Effort",
      "",
      "   ─────────▲────────────────────────────",
      "   low    medium    high    xhigh    max",
      "        x",
      "",
      "  ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel",
    ].join("\n");
    const model = detectEffort(lines(screen));
    expect(model).not.toBeNull();
    expect(model!.nav.leftRight!.values).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("refuses the description row even when its words land inside the head spans", () => {
    // The hole an "inside the head's span" window left open. On a wide pane the row directly under
    // the labels is `xhigh + workflows`, and a window refuses it only by luck of where those three
    // words happen to land. Here they are moved so `xhigh` sits INSIDE the `max` span and
    // `+ workflows` inside the `ultracode` one, which a window would have merged into the levels
    // `maxxhigh` and `ultracode+workflows`. Exact start-column equality refuses the row instead, so
    // the six head words still read as the scale.
    const paneLines = load("claude--menu-effort-slider--w80.txt");
    const labelAt = paneLines.findIndex(
      (l) => /\blow\b/.test(textOf(l)) && /\bultracode\b/.test(textOf(l)),
    );
    expect(labelAt).toBeGreaterThan(0);
    const heads = [...textOf(paneLines[labelAt]!).matchAll(/\S+/g)];
    const maxAt = heads.find((m) => m[0] === "max")!.index;
    const ultraAt = heads.find((m) => m[0] === "ultracode")!.index;
    const shifted =
      " ".repeat(maxAt + 1) + "xhigh" + " ".repeat(ultraAt + 2 - (maxAt + 6)) + "+ workflows";
    expect(shifted.indexOf("xhigh")).toBe(maxAt + 1);
    expect(shifted.indexOf("+")).toBe(ultraAt + 2);
    const moved = [...paneLines];
    moved[labelAt + 1] = lines(shifted)[0]!;

    const model = detectEffort(moved);
    expect(model).not.toBeNull();
    expect(model!.nav.leftRight!.values).toEqual(SCALE);
    expect(model!.nav.leftRight!.label).toBe("medium");
  });

  it("refuses a whole fragment row when one fragment is a column off", () => {
    // Five fragments land exactly on their heads and the sixth is one column late. A partial merge
    // would print five rebuilt levels beside one bare head, so the row is refused whole. The track
    // did not wrap on this capture, so the heads stand alone — and at 80 columns they are already
    // the six whole words.
    const paneLines = load("claude--menu-effort-slider--w80.txt");
    const labelAt = paneLines.findIndex(
      (l) => /\blow\b/.test(textOf(l)) && /\bultracode\b/.test(textOf(l)),
    );
    const starts = [...textOf(paneLines[labelAt]!).matchAll(/\S+/g)].map((m) => m.index);
    let row = "";
    for (const [i, start] of starts.entries()) {
      row = row.padEnd(i === starts.length - 1 ? start + 1 : start, " ") + "x";
    }
    const moved = [...paneLines];
    moved[labelAt + 1] = lines(row)[0]!;

    const model = detectEffort(moved);
    expect(model).not.toBeNull();
    expect(model!.nav.leftRight!.values).toEqual(SCALE);
  });

  it("declines a WRAPPED screen whose fragment row does not line up, rather than showing the heads", () => {
    // The fail-closed half of the rule. At 60 columns the head row is `low mediu hig xhigh max
    // ultracod` — truncated words that all pass LABEL_WORD. Shift the fragment row one column and the
    // merge is refused; falling back to those heads would put an invented scale on the card, so the
    // screen is declined instead. The wrapped TRACK row is what says the labels must be wrapped too.
    const paneLines = load("claude--menu-effort-slider--w60.txt");
    const labelAt = paneLines.findIndex(
      (l) => /\blow\b/.test(textOf(l)) && /\bxhigh\b/.test(textOf(l)),
    );
    expect(labelAt).toBeGreaterThan(0);
    const fragments = textOf(paneLines[labelAt + 1]!);
    expect(fragments.trim()).not.toBe("");
    const moved = [...paneLines];
    moved[labelAt + 1] = lines(" " + fragments)[0]!;
    expect(detectEffort(moved)).toBeNull();
  });

  it("declines when a merge would make a label that is not one word", () => {
    // The last guard on the rebuild: a fragment row that lines up but carries punctuation would
    // produce a level nobody printed, so the screen is declined rather than guessed at.
    const screen = [
      "▔".repeat(60),
      "  Effort",
      "",
      "   ─────────▲────────────────────────────",
      "   low    medium    high    xhigh    max",
      "   a/b    c",
      "",
      "  ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel",
    ].join("\n");
    expect(detectEffort(lines(screen))).toBeNull();
  });
});

describe("detectEffort — a level other than medium selected", () => {
  // Real captures, taken live on 2026-09-22, of `low` and `ultracode` selected at 40, 60 and 80
  // columns — the same widths WRAPPED_FIXTURES pins for the default `medium`. Four of the six lift;
  // this block is the four that do, and it is what proves the read is a MARKER POSITION rather than
  // a word list: `low` lifts wrapped (60) and whole (80), and `ultracode` lifts at 60 and 80, each
  // with the same six values and the same three actions the medium-selected captures carry.
  it.each(LOW_ULTRACODE_LIFTS)("reads $name with the marker over $label", ({ name, label }) => {
    const model = detectEffort(load(name));
    expect(model).not.toBeNull();
    expect(model!.title).toBe("Effort");
    expect(model!.nav).toEqual({
      upDown: false,
      leftRight: { verb: "adjust", label, values: SCALE },
    });
    expect(model!.actions).toEqual(EXPECTED_ACTIONS);
    expect(model!.signature).not.toBe("");
  });

  it.each(LOW_ULTRACODE_LIFTS)("is the Effort arm that produces $name's block", ({ name, label }) => {
    const paneLines = load(name);
    const blocks = claudeBuildBlocks(paneLines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "menu"]);
    const block = blocks[1]!;
    if (block.kind !== "menu") throw new Error("expected a menu block");
    expect(block.menu).toEqual(detectEffort(paneLines)!);
    expect(block.menu.nav.leftRight!.values).toEqual(SCALE);
    expect(block.menu.nav.leftRight!.label).toBe(label);
  });
});

describe("detectEffort — a level other than medium selected, and the widths that decline", () => {
  // The other two captures of the same pair (2026-09-22), each declining for its own reason. Both
  // are 40 columns, and neither reason is the footer: one screen draws no marker and the other is a
  // render glitch.
  it("declines at 40 columns with low selected: no ▲ is drawn at all when the marker would sit leftmost, Claude marks low by colour only, so the pipeline falls through to the unread-dialog card", () => {
    const paneLines = load("claude--menu-effort-slider--w40-low.txt");
    expect(detectEffort(paneLines)).toBeNull();

    const blocks = buildBlocks(paneLines, { agent: "claude" });
    expect(blocks.map((b) => b.kind)).toEqual(["unread-dialog"]);
  });

  it("declines at 40 columns with ultracode selected: a genuine Claude Code 2.1.278 render glitch (labels truncated to `xhigh      m`, no marker, no divider) leaves nothing this grammar can read", () => {
    const paneLines = load("claude--menu-effort-slider--w40-ultracode.txt");
    expect(detectEffort(paneLines)).toBeNull();
  });
});

describe("detectEffort — what it declines", () => {
  it("claims no other pane fixture, of any adapter", () => {
    const claimed = readdirSync(PANES_DIR)
      .filter((n) => n.endsWith(".txt"))
      .filter((n) => detectEffort(load(n)) !== null)
      .toSorted();
    expect(claimed).toEqual(EFFORT_FIXTURES.toSorted());
  });
});

describe("detectEffort — the printed scale", () => {
  // The whole reason `values` exists: the screen printed every level on one row, so the card can
  // offer them all instead of naming one between two arrows (.adr/0054).
  it("carries the scale in row order on every capture, with the value one of it", () => {
    for (const fixture of EFFORT_FIXTURES) {
      const leftRight = detectEffort(load(fixture))!.nav.leftRight!;
      expect(leftRight.values, fixture).toEqual(SCALE);
      expect(leftRight.values, fixture).toContain(leftRight.label);
    }
  });

  it("reads the 132-column capture as six levels with the marker over medium", () => {
    const model = detectEffort(load(SCALE_FIXTURE))!;
    expect(model.nav.leftRight!.values).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
    expect(model.nav.leftRight!.label).toBe("medium");
    // The second label row ("xhigh + workflows") is NOT part of the scale: only the first non-blank
    // row under the marker is the label row, and that rule is what keeps the description out.
    expect(model.nav.leftRight!.values).not.toContain("xhigh + workflows");
    expect(model.actions).toEqual(EXPECTED_ACTIONS);
  });

  // A capture whose scale differs is a different screen, not a moved marker — so the scale is part
  // of menu identity while the label stays out of it.
  it("puts the scale inside menu identity and keeps the label out", () => {
    const a = detectEffort(load(SCALE_FIXTURE))!;
    const widened = {
      ...a,
      nav: { ...a.nav, leftRight: { ...a.nav.leftRight!, values: [...SCALE, "ludicrous"] } },
    };
    expect(menusSameIdentity(a, widened)).toBe(false);
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
    // And the generic grammar prints no scale: that screen shows the current value alone, so the
    // card keeps the plain arrows.
    expect(block.menu.nav.leftRight!.values).toBeUndefined();
  });
});
