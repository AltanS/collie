import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type Block, type StyledLine } from "../../blocks";
import { withUnreadDialog } from "../index";
import { promptsEqual, promptsSameIdentity } from "../prompt-model";
import { claudeAdapter, claudeBuildBlocks } from "./index";
import { detectSwitchModel, detectSwitchModelRegion } from "./switch-model";

// The "Switch model?" confirmation (switch-model.ts): the footerless screen Claude Code 2.1.286 to
// 2.1.289 paints after the `/model` picker when the conversation is cached. Four real captures
// (2.1.289, Herdr 0.9.3, 2026-10-04, fixtures/panes/README.md "Switch-model confirmation corpus"):
// the pointer on row 1 and on row 2 at 120 columns, and the same two at 50 columns. These tests pin
// what the grammar reads off each, the plan each tap sends (arrows then Enter, never a digit, ADR
// 0009 and ADR 0080), that it fails closed on every piece of missing evidence, and what
// `coreSignature` holds and refuses (ADR 0080 point 5).

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

const load = (name: string): StyledLine[] =>
  splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
const textsOf = (name: string): string[] => load(name).map(lineText);
const fromTexts = (texts: string[]): StyledLine[] => splitLines(parseAnsi(texts.join("\n")));

/** The whole pipeline the phone runs: the adapter's blocks, then the unread-card post-pass. */
const pipeline = (lines: StyledLine[]): Block[] => withUnreadDialog(claudeAdapter, lines, claudeBuildBlocks(lines));

const YES_120 = "claude--v2289-switch-model-yes.txt";
const NO_120 = "claude--v2289-switch-model-no.txt";
const YES_50 = "claude--v2289-switch-model-yes--w50.txt";
const NO_50 = "claude--v2289-switch-model-no--w50.txt";
const ALL = [YES_120, NO_120, YES_50, NO_50];

const YES_LABEL = "Yes, switch to Fable 5.1";
const NO_LABEL = "No, go back";

describe("the real captures lift as a two-row pointed list", () => {
  it.each([YES_120, YES_50])("%s: the pointer on row 1, Enter takes Yes and Down then Enter takes No", (name) => {
    const model = detectSwitchModel(load(name))!;
    expect(model.family).toBe("select");
    expect(model.question).toBe("Switch model?");
    expect(model.options.map((o) => o.label)).toEqual([YES_LABEL, NO_LABEL]);
    expect(model.options.map((o) => o.keys)).toEqual([["Enter"], ["Down", "Enter"]]);
    expect(model.options.map((o) => o.keyLabel)).toEqual(["❯", undefined]);
  });

  it.each([NO_120, NO_50])("%s: the pointer on row 2, Up then Enter takes Yes and Enter takes No", (name) => {
    const model = detectSwitchModel(load(name))!;
    expect(model.options.map((o) => o.label)).toEqual([YES_LABEL, NO_LABEL]);
    expect(model.options.map((o) => o.keys)).toEqual([["Up", "Enter"], ["Enter"]]);
    expect(model.options.map((o) => o.keyLabel)).toEqual([undefined, "❯"]);
  });

  it("no key is a digit, and every plan ends in Enter", () => {
    for (const name of ALL) {
      for (const option of detectSwitchModel(load(name))!.options) {
        expect(option.keys.some((k) => /\d/.test(k)), `${name}: ${option.label}`).toBe(false);
        expect(option.keys.at(-1), name).toBe("Enter");
      }
    }
  });

  it("the list wraps, so it never declares clamped ends", () => {
    for (const name of ALL) expect(detectSwitchModel(load(name))!.clampedEnds, name).toBeUndefined();
  });

  it("no styledSignature: the pointer is a glyph", () => {
    for (const name of ALL) expect(detectSwitchModel(load(name))!.styledSignature, name).toBeUndefined();
  });

  it("the signature is the region from the edge to the last row, pointer included", () => {
    const model = detectSwitchModel(load(YES_120))!;
    const rows = model.signature.split("\n");
    expect(rows[0]).toMatch(/^▔+ ● high · \/effort ▔$/);
    expect(rows[1]!.trim()).toBe("Switch model?");
    expect(rows.at(-2)).toBe("   ❯ 1. Yes, switch to Fable 5.1");
    expect(rows.at(-1)).toBe("     2. No, go back");
    // The bare edge of the 50-column capture opens its region the same way.
    expect(detectSwitchModel(load(YES_50))!.signature.startsWith("▔")).toBe(true);
  });

  it("the card starts at row 1: the edge, the title and the prose stay in the raw mirror above", () => {
    for (const name of ALL) {
      const lines = load(name);
      const region = detectSwitchModelRegion(lines)!;
      expect(lineText(lines[region.startLine]!).includes("1. Yes, switch to"), name).toBe(true);
      const blocks = claudeBuildBlocks(lines);
      expect(blocks.map((b) => b.kind), name).toEqual(["raw", "prompt-select"]);
      const raw = blocks[0]!;
      expect(raw.kind === "raw" && raw.lines.map(lineText).some((t) => t.includes("Switch model?")), name).toBe(true);
      expect(raw.kind === "raw" && raw.lines.map(lineText).some((t) => t.includes("Your next response")), name).toBe(
        true,
      );
    }
  });
});

describe("the screen is a dialog, so the composer stays shut and no unread card shows", () => {
  it.each(ALL)("%s", (name) => {
    const lines = load(name);
    expect(claudeAdapter.composerReady!(lines)).toBe(false);
    expect(pipeline(lines).map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
  });
});

describe("it fails closed: any piece of evidence missing and nothing is claimed", () => {
  /** A mutation of the 120-column Yes capture that must not lift, and must keep the unread card. */
  function declines(label: string, edit: (texts: string[]) => string[], base = YES_120) {
    it(label, () => {
      const lines = fromTexts(edit(textsOf(base)));
      expect(detectSwitchModelRegion(lines)).toBeNull();
      expect(claudeBuildBlocks(lines).some((b) => b.kind === "prompt-select")).toBe(false);
    });
  }
  const at = (texts: string[], needle: string) => texts.findIndex((t) => t.includes(needle));

  declines("a different title", (t) => t.map((x) => x.replace("Switch model?", "Switch models?")));
  declines("a title that is not the first row under the edge", (t) => {
    const i = at(t, "Switch model?");
    return [...t.slice(0, i), "   Heads up", ...t.slice(i)];
  });
  declines("a third row under the list", (t) => {
    const i = at(t, "2. No, go back");
    return [...t.slice(0, i + 1), "     3. Maybe later", ...t.slice(i + 1)];
  });
  declines("a third row between the two", (t) => {
    const i = at(t, "2. No, go back");
    return [...t.slice(0, i), "     3. Maybe later", ...t.slice(i)];
  });
  declines("rows renumbered so they no longer read 1 then 2", (t) =>
    t.map((x) => x.replace("1. Yes", "2. Yes").replace("2. No", "3. No")),
  );
  declines("row 1 that is not a switch", (t) => t.map((x) => x.replace("Yes, switch to Fable 5.1", "Yes, continue")));
  declines("row 1 with no model", (t) => t.map((x) => x.replace("Yes, switch to Fable 5.1", "Yes, switch to ")));
  declines("row 2 that is not the way back", (t) => t.map((x) => x.replace("No, go back", "No, stay")));
  declines("no pointer", (t) => t.map((x) => x.replace("❯ 1.", "  1.")));
  declines("two pointers", (t) => t.map((x) => x.replace("     2. No", "   ❯ 2. No")));
  declines("a pointer in the prose and none on the rows", (t) =>
    t.map((x) => x.replace("   ❯ 1.", "     1.").replace("Your next", "❯ Your next")),
  );
  declines("a pointer in the prose beside the pointed row", (t) => t.map((x) => x.replace("Your next", "❯ Your next")));
  declines("a key-hint footer under the list", (t) => [...t.slice(0, -1), "   Enter to confirm · Esc to cancel"]);
  declines("any row under the list", (t) => [...t.slice(0, -1), "   still here"]);
  declines("a `─` rule instead of the `▔` edge", (t) => t.map((x) => (x.startsWith("▔") ? "─".repeat(120) : x)));
  declines("no edge at all", (t) => t.filter((x) => !x.startsWith("▔")));
  declines("an edge that is not the widest row", (t) =>
    t.map((x) => (x.startsWith("▔") ? "▔".repeat(40) : x)),
  );
  declines("the same text scrolled up with other output under it", (t) => [
    ...t.slice(0, -1),
    "",
    "● Understood, carrying on.",
    "",
  ]);
  declines("a blank row between the two rows", (t) => {
    const i = at(t, "2. No, go back");
    return [...t.slice(0, i), "", ...t.slice(i)];
  });
  declines("the same screen at 50 columns with a `─` rule", (t) => t.map((x) => (x.startsWith("▔") ? "─".repeat(50) : x)), NO_50);

  it("a live input box under the screen declines it", () => {
    const rule = "─".repeat(120);
    const texts = [...textsOf(YES_120), rule, "❯ ", rule, "  ? for shortcuts"];
    expect(detectSwitchModelRegion(fromTexts(texts))).toBeNull();
  });

  it("the unmutated captures still lift, so the negatives above test the mutation and not the helper", () => {
    for (const name of ALL) expect(detectSwitchModelRegion(fromTexts(textsOf(name))), name).not.toBeNull();
  });
});

describe("a narrow pane wraps row 1, and the label is read across it", () => {
  it("row 1 on a continuation row at its own label column reads as one label", () => {
    const texts = textsOf(YES_50).map((t) =>
      t === "   ❯ 1. Yes, switch to Fable 5.1" || t.trimEnd() === "   ❯ 1. Yes, switch to Fable 5.1"
        ? "   ❯ 1. Yes, switch to"
        : t,
    );
    const i = texts.findIndex((t) => t.trimEnd() === "   ❯ 1. Yes, switch to");
    const wrapped = [...texts.slice(0, i + 1), "        Fable 5.1", ...texts.slice(i + 1)];
    const model = detectSwitchModel(fromTexts(wrapped))!;
    expect(model.options.map((o) => o.label)).toEqual([YES_LABEL, NO_LABEL]);
    expect(model.options.map((o) => o.keys)).toEqual([["Enter"], ["Down", "Enter"]]);
  });

  it("a continuation row at any other column is not part of the label", () => {
    const texts = textsOf(YES_50);
    const i = texts.findIndex((t) => t.trimEnd() === "   ❯ 1. Yes, switch to Fable 5.1");
    const wrapped = [...texts.slice(0, i + 1), "     Fable 5.1", ...texts.slice(i + 1)];
    expect(detectSwitchModelRegion(fromTexts(wrapped))).toBeNull();
  });
});

describe("a walked tap: the race guard sees the pointer, the verify read does not", () => {
  const pairs = [
    [YES_120, NO_120],
    [YES_50, NO_50],
  ] as const;

  it.each(pairs)("%s and %s: one dialog both ways, never the same screen", (yes, no) => {
    const a = detectSwitchModel(load(yes))!;
    const b = detectSwitchModel(load(no))!;
    expect(promptsSameIdentity(a, b)).toBe(true);
    expect(promptsSameIdentity(b, a)).toBe(true);
    expect(a.coreSignature).toBe(b.coreSignature);
    // The entry guard refuses: the byte-faithful signature carries the pointer.
    expect(a.signature).not.toBe(b.signature);
    expect(promptsEqual(a, b)).toBe(false);
    // A re-derivation of the unchanged screen is equal, so the guard is not simply always shut.
    expect(promptsEqual(a, detectSwitchModel(fromTexts(textsOf(yes)))!)).toBe(true);
  });

  it("the pointed row is the one carrying exactly Enter, and it differs between the two captures", () => {
    const enterRow = (name: string) =>
      detectSwitchModel(load(name))!.options.findIndex((o) => o.keys.length === 1 && o.keys[0] === "Enter");
    expect(enterRow(YES_120)).toBe(0);
    expect(enterRow(NO_120)).toBe(1);
    expect(enterRow(YES_50)).toBe(0);
    expect(enterRow(NO_50)).toBe(1);
  });

  it("the pointer on the same row is not a move: the identity and the walk match", () => {
    const a = detectSwitchModel(load(YES_120))!;
    const b = detectSwitchModel(load(YES_50))!;
    // Two widths of one dialog: the prose wraps differently, so the identity differs. The grammar
    // never claims they are one screen.
    expect(promptsSameIdentity(a, b)).toBe(false);
  });
});

describe("coreSignature blanks the pointer and nothing else (ADR 0080 point 5)", () => {
  const base = () => detectSwitchModel(fromTexts(textsOf(YES_120)))!;

  /** Whether the edited screen is still the same dialog as the unedited Yes capture. */
  function identity(edit: (texts: string[]) => string[]) {
    const edited = detectSwitchModel(fromTexts(edit(textsOf(YES_120))));
    return edited === null ? null : promptsSameIdentity(base(), edited);
  }

  it("holds: the pointer moved from row 1 to row 2", () => {
    const moved = detectSwitchModel(fromTexts(textsOf(NO_120)))!;
    expect(promptsSameIdentity(base(), moved)).toBe(true);
    expect(moved.coreSignature).toBe(base().coreSignature);
  });

  it("holds: trailing padding that a redraw changes", () => {
    expect(identity((t) => t.map((x) => (x.includes("Switch model?") ? x.trimEnd() : x)))).toBe(true);
    expect(identity((t) => t.map((x) => (x.trim() === "" ? "" : x)))).toBe(true);
    expect(identity((t) => t.map((x) => (x.includes("2. No, go back") ? `${x}   ` : x)))).toBe(true);
  });

  it("refuses: a changed title (it is not even the dialog, so nothing lifts)", () => {
    expect(identity((t) => t.map((x) => x.replace("Switch model?", "Switch mode?")))).toBeNull();
  });

  it("refuses: a changed row label", () => {
    expect(identity((t) => t.map((x) => (x.includes("1. Yes") ? `${x} now` : x)))).toBe(false);
    expect(identity((t) => t.map((x) => x.replace("No, go back", "No, go backwards")))).toBeNull();
  });

  it("refuses: a changed model name, in the row and in the prose", () => {
    expect(identity((t) => t.map((x) => x.replace("Fable 5.1", "Opus 5.2")))).toBe(false);
    expect(identity((t) => t.map((x) => x.replace("Switching to Fable 5.1", "Switching to Opus 5.2")))).toBe(false);
  });

  it("refuses: a changed prose row", () => {
    expect(identity((t) => t.map((x) => x.replace("use more tokens", "use fewer tokens")))).toBe(false);
  });

  it("refuses: a removed row (row 2 gone leaves nothing to lift)", () => {
    expect(identity((t) => t.filter((x) => !x.includes("2. No, go back")))).toBeNull();
  });

  it("refuses: a removed prose row", () => {
    expect(identity((t) => t.filter((x) => !x.includes("your next message.")))).toBe(false);
  });

  it("refuses: a swapped pair of rows (the numbers no longer read 1 then 2)", () => {
    const swapped = (t: string[]) => {
      const out = [...t];
      const i = out.findIndex((x) => x.includes("1. Yes"));
      [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
      return out;
    };
    expect(identity(swapped)).toBeNull();
  });

  it("holds: the edge's label spliced in, changed or gone (the 50-column pair prints it both ways)", () => {
    expect(identity((t) => t.map((x) => x.replace("● high", "● max")))).toBe(true);
    expect(identity((t) => t.map((x) => (x.startsWith("▔") ? "▔".repeat(120) : x)))).toBe(true);
    // ... while the byte-faithful signature still moves, so the entry guard refuses such a tap.
    const bare = detectSwitchModel(fromTexts(textsOf(YES_120).map((x) => (x.startsWith("▔") ? "▔".repeat(120) : x))))!;
    expect(bare.signature).not.toBe(base().signature);
  });
});
