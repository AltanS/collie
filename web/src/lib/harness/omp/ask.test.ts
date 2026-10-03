import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { promptsEqual } from "../prompt-model";
import { detectAskSelect, detectAskSelectRegion } from "./ask";
import { ompBuildBlocks } from "./index";
import { ompModalOnScreen } from "./modal";

// The omp `ask` tool's one-question single-select dialog (.adr/0077). Its footer prints the commit
// key (`⏎ select`, `Enter select`, or the Nerd Font keycap) and the arrows, so a tap is the pointer walk
// plus a key the screen printed. These tests pin what the grammar reads off each real capture, in all
// three keycap dialects, the walk each tap sends, and that it fails closed the moment any piece of its
// evidence is missing, including on the multi-select screens it does not lift.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

const load = (name: string): StyledLine[] =>
  splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
const textsOf = (name: string): string[] => load(name).map(lineText);
const fromTexts = (texts: string[]): StyledLine[] => splitLines(parseAnsi(texts.join("\n")));

const OTHER = "Other (type your own)";

describe("the 18.4.10 dialog (glyph keycaps) lifts as a pointed list", () => {
  it("ask-single: the pointer on Red, every other row walks Down", () => {
    const model = detectAskSelect(load("omp--v18-4-ask-single.txt"))!;
    expect(model.family).toBe("select");
    expect(model.question).toBe("Pick a color");
    // No caption: the question is in the box the card mirrors, and "Ask" says nothing a caption needs.
    expect(model.caption).toBeUndefined();
    expect(model.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue", OTHER, "Cancel"]);
    expect(model.options.map((o) => o.keys)).toEqual([
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
      ["Down", "Down", "Down", "Enter"],
      ["Escape"],
    ]);
    expect(model.options.map((o) => o.keyLabel)).toEqual(["❯", "", "", "", "Esc"]);
    expect(model.options.map((o) => o.description)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it("ask-single-moved: the pointer on Green, Red walks Up", () => {
    const model = detectAskSelect(load("omp--v18-4-ask-single-moved.txt"))!;
    expect(model.options.map((o) => o.keys)).toEqual([
      ["Up", "Enter"],
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
      ["Escape"],
    ]);
    expect(model.options.map((o) => o.keyLabel)).toEqual(["", "❯", "", "", "Esc"]);
  });

  it("the region runs from the `╭─ Ask ─╮` title to the bottom border, the transcript above stays raw", () => {
    const lines = load("omp--v18-4-ask-single.txt");
    const region = detectAskSelectRegion(lines)!;
    expect(region.startLine).toBe(198);
    const rows = region.model.signature.split("\n");
    expect(rows[0]!.startsWith("╭─ Ask ─")).toBe(true);
    expect(rows.at(-1)!.startsWith("╰─")).toBe(true);
    expect(rows).toHaveLength(12);
    // The transcript's own record of the call (`╭─── Ask 1 questions ───╮`) and the working row
    // above the dialog are not part of it.
    expect(region.model.signature).not.toContain("Ask 1 questions");
    expect(region.model.signature).not.toContain("Choosing a color");

    const blocks = ompBuildBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    expect(blocks[1]!.lines).toHaveLength(12);
    expect(blocks[0]!.lines.map(lineText).join("\n")).toContain("Ask 1 questions");
  });
});

describe("the 17.2.12 dialog (text keycaps) lifts the same way", () => {
  it("select-menu: the pointer on Red", () => {
    const model = detectAskSelect(load("omp--select-menu.txt"))!;
    expect(model.question).toBe("Pick a color");
    expect(model.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue", OTHER, "Cancel"]);
    expect(model.options.map((o) => o.keys)).toEqual([
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
      ["Down", "Down", "Down", "Enter"],
      ["Escape"],
    ]);
  });

  it("select-menu-moved: the pointer on Blue, both directions walk", () => {
    const model = detectAskSelect(load("omp--select-menu-moved.txt"))!;
    expect(model.options.map((o) => o.keys)).toEqual([
      ["Up", "Up", "Enter"],
      ["Up", "Enter"],
      ["Enter"],
      ["Down", "Enter"],
      ["Escape"],
    ]);
  });
});

describe("the Nerd Font preset (18.4.4) lifts, read from its own glyphs", () => {
  it("select-menu-other: the pointer on `Other`, whose tap is a bare Enter that opens the answer editor", () => {
    const model = detectAskSelect(load("omp--select-menu-other.txt"))!;
    expect(model.question).toBe("Pick a colour");
    expect(model.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue", OTHER, "Cancel"]);
    expect(model.options.map((o) => o.keys)).toEqual([
      ["Up", "Up", "Up", "Enter"],
      ["Up", "Up", "Enter"],
      ["Up", "Enter"],
      ["Enter"],
      ["Escape"],
    ]);
    // The badge is the `❯` the chevron stands for, not the private-use glyph the screen printed.
    expect(model.options.map((o) => o.keyLabel)).toEqual(["", "", "", "❯", "Esc"]);
  });

  it("select-menu-noted: a saved note's mark leaves the label and becomes the description", () => {
    const model = detectAskSelect(load("omp--select-menu-noted.txt"))!;
    expect(model.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue", OTHER, "Cancel"]);
    expect(model.options.map((o) => o.description)).toEqual([undefined, undefined, "✎ note", undefined, undefined]);
    expect(model.options[2]!.keys).toEqual(["Enter"]);
  });

  it("the core signature blanks the chevron, so the pointer is the only thing it ignores", () => {
    const a = detectAskSelect(load("omp--select-menu-other.txt"))!;
    expect(a.coreSignature).not.toContain("\u{F054}");
    expect(a.signature).toContain("\u{F054}");
  });
});

describe("every tap is the walk plus a key the footer printed", () => {
  const LIFTED = [
    "omp--select-menu-moved.txt",
    "omp--select-menu-noted.txt",
    "omp--select-menu-other.txt",
    "omp--select-menu.txt",
    "omp--v18-4-ask-single-moved.txt",
    "omp--v18-4-ask-single.txt",
  ];

  it.each(LIFTED)("%s: no key is a digit, and each option walks from the pointed row", (name) => {
    const model = detectAskSelect(load(name))!;
    const rows = model.options.slice(0, -1);
    const pointedAt = model.options.findIndex((o) => o.keyLabel === "❯");
    expect(pointedAt).toBeGreaterThanOrEqual(0);
    rows.forEach((option, i) => {
      expect(option.keys.some((k) => /\d/.test(k)), `${name}: ${option.label}`).toBe(false);
      expect(option.keys.at(-1)).toBe("Enter");
      const arrows = option.keys.slice(0, -1);
      expect(arrows).toHaveLength(Math.abs(i - pointedAt));
      if (i > pointedAt) expect(arrows.every((k) => k === "Down")).toBe(true);
      if (i < pointedAt) expect(arrows.every((k) => k === "Up")).toBe(true);
    });
    expect(rows[pointedAt]!.keys).toEqual(["Enter"]);
    // `Other` is always the last listed row, and the way out is Escape alone.
    expect(rows.at(-1)!.label).toBe(OTHER);
    expect(model.options.at(-1)).toEqual({ label: "Cancel", keys: ["Escape"], keyLabel: "Esc" });
  });

  it.each(LIFTED)("%s: the pipeline emits one prompt-select and keeps the rest raw", (name) => {
    const blocks = ompBuildBlocks(load(name));
    expect(blocks.at(-1)!.kind).toBe("prompt-select");
    expect(blocks.filter((b) => b.kind !== "raw")).toHaveLength(1);
  });

  it.each(LIFTED)("%s: the modal gate sees it too, so it is the same screen slice 1 drew a card on", (name) => {
    expect(ompModalOnScreen(load(name))).toBe(true);
  });
});

describe("the race guard sees the pointer and every row", () => {
  it("a pointer moved between render and tap is not the same prompt", () => {
    const first = detectAskSelect(load("omp--v18-4-ask-single.txt"))!;
    const moved = detectAskSelect(load("omp--v18-4-ask-single-moved.txt"))!;
    expect(moved.signature).not.toBe(first.signature);
    expect(promptsEqual(first, moved)).toBe(false);
    expect(promptsEqual(first, detectAskSelect(load("omp--v18-4-ask-single.txt"))!)).toBe(true);
    // The pointer is the one difference between the two captures, and the core signature is blind to it.
    expect(first.coreSignature).toBe(moved.coreSignature);
    expect(first.coreSignature).not.toContain("❯");
  });

  it("a question row is free text: text past its right border still lifts and moves the signature", () => {
    // The one row the grammar reads loosely, as resume.ts reads a first-prompt row. Nothing reads a key
    // off it, and every byte of it binds the tap.
    const texts = textsOf("omp--v18-4-ask-single.txt");
    const before = detectAskSelect(fromTexts(texts))!;
    const after = detectAskSelect(fromTexts(texts.map((t, i) => (i === 199 ? `${t} zqx` : t))))!;
    expect(after.signature).not.toBe(before.signature);
    expect(promptsEqual(before, after)).toBe(false);
  });

  it("a changed option label or question moves the signature", () => {
    const texts = textsOf("omp--v18-4-ask-single.txt");
    const before = detectAskSelect(fromTexts(texts))!;
    const relabelled = texts.map((t, i) => (i === 203 ? t.replace("Blue ", "Teal ") : t));
    expect(detectAskSelect(fromTexts(relabelled))!.signature).not.toBe(before.signature);
    const asked = texts.map((t, i) => (i === 199 ? t.replace("Pick a color", "Pick a shade") : t));
    const after = detectAskSelect(fromTexts(asked))!;
    expect(after.question).toBe("Pick a shade");
    expect(promptsEqual(before, after)).toBe(false);
  });
});

describe("fails closed", () => {
  const single = textsOf("omp--v18-4-ask-single.txt");
  const nerd = textsOf("omp--select-menu-other.txt");
  const TITLE_AT = 198;
  const FOOTER_AT = 208;

  it("positive control: the unedited captures lift, so every edit below is what declines", () => {
    expect(detectAskSelect(fromTexts(single))).not.toBeNull();
    expect(detectAskSelect(fromTexts(nerd))).not.toBeNull();
    expect(single[FOOTER_AT]).toContain("⏎ select · n note · ↑/↓ move · ⎋ cancel");
    expect(single[TITLE_AT]!.startsWith("╭─ Ask ─")).toBe(true);
  });

  it("on the multi-select dialog, in both footer dialects, and on its review screen", () => {
    for (const name of [
      "omp--v18-4-ask-multi.txt",
      "omp--v18-4-ask-multi-checked.txt",
      "omp--select-multi.txt",
      "omp--select-multi-checked.txt",
      "omp--select-multi-review.txt",
    ]) {
      const lines = load(name);
      expect(detectAskSelectRegion(lines), name).toBeNull();
      expect(ompBuildBlocks(lines).every((b) => b.kind === "raw"), name).toBe(true);
      // Not lifted, but still a modal: the unread-dialog card's Escape stands over it.
      expect(ompModalOnScreen(lines), name).toBe(true);
    }
  });

  it("on the note editor `n` opens, which is an input and not this dialog", () => {
    expect(detectAskSelect(load("omp--v18-4-ask-note-editor.txt"))).toBeNull();
  });

  it("with the pointer on no row, or on two", () => {
    expect(detectAskSelect(fromTexts(single.map((t) => t.replace("│ ❯ ○", "│   ○"))))).toBeNull();
    const two = single.map((t, i) => (i === 203 ? t.replace("│   ○", "│ ❯ ○") : t));
    expect(detectAskSelect(fromTexts(two))).toBeNull();
  });

  it("with a pointer or radio from another preset than the footer's", () => {
    // The 18.4 footer over a Nerd Font chevron: not one preset in all four places.
    const chevron = single.map((t) => t.replace("│ ❯ ○", "│ \u{F054} ○"));
    expect(detectAskSelect(fromTexts(chevron))).toBeNull();
    // The Nerd Font footer over unicode rows.
    const mixed = nerd.map((t) => t.replace("\u{F054}", "❯").replaceAll("\u{F10C}", "○"));
    expect(detectAskSelect(fromTexts(mixed))).toBeNull();
    // The `ascii` preset's pointer is uncaptured, so it is not guessed.
    expect(detectAskSelect(fromTexts(single.map((t) => t.replace("│ ❯ ○", "│ > ○"))))).toBeNull();
  });

  it("with a selected radio, which a one-question single select never shows", () => {
    expect(detectAskSelect(fromTexts(single.map((t) => t.replace("○ Green", "◉ Green"))))).toBeNull();
  });

  it("with the multi-select footer over single-select rows, in either dialect", () => {
    const newMulti = single.map((t, i) =>
      i === FOOTER_AT ? t.replace("⏎ select · n note · ↑/↓ move · ⎋ cancel", "␣ toggle · ⏎ submit · ↑/↓ move · ⎋ cancel ") : t,
    );
    expect(detectAskSelect(fromTexts(newMulti))).toBeNull();
    const oldMulti = textsOf("omp--select-menu.txt").map((t) =>
      t.replace("Enter select · n note", "Space/Enter toggle · n note"),
    );
    expect(detectAskSelect(fromTexts(oldMulti))).toBeNull();
  });

  it("with the tab segment of a multi-question dialog in the footer", () => {
    const tabs = single.map((t, i) =>
      i === FOOTER_AT ? t.replace("↑/↓ move · ⎋ cancel        ", "↑/↓ move · ⇥/←/→ · ⎋ cancel") : t,
    );
    expect(tabs[FOOTER_AT]).toContain("⇥/←/→");
    expect(detectAskSelect(fromTexts(tabs))).toBeNull();
  });

  it("with any other footer: a scroll indicator, an expand hint, a rebound key, a clipped row", () => {
    const edit = (from: string, to: string) =>
      detectAskSelect(fromTexts(single.map((t, i) => (i === FOOTER_AT ? t.replace(from, to) : t))));
    expect(edit("↑/↓ move · ⎋ cancel", "↑/↓ move · ↓ scroll · ⎋ cancel")).toBeNull();
    expect(edit("⎋ cancel", "⎋ cancel · ctrl+o expand")).toBeNull();
    expect(edit("↑/↓ move", "ctrl+p/ctrl+n move")).toBeNull();
    expect(edit("⏎ select · ", "")).toBeNull();
    expect(edit(" · ⎋ cancel", "")).toBeNull();
    expect(edit("⎋ cancel", "⎋ canc")).toBeNull();
    // The right border gone from the footer row.
    expect(detectAskSelect(fromTexts(single.map((t, i) => (i === FOOTER_AT ? t.replace(/\s*│$/, "") : t))))).toBeNull();
  });

  it("with a countdown in the title, which ticks every second", () => {
    const timed = single.map((t, i) => (i === TITLE_AT ? t.replace("╭─ Ask ──────", "╭─ Ask (30s) ") : t));
    expect(detectAskSelect(fromTexts(timed))).toBeNull();
  });

  it("without the title, the dividers, or the bottom border", () => {
    expect(detectAskSelect(fromTexts(single.map((t, i) => (i === TITLE_AT ? single[199]! : t))))).toBeNull();
    expect(detectAskSelect(fromTexts(single.map((t, i) => (i === 200 ? single[205]! : t))))).toBeNull();
    expect(detectAskSelect(fromTexts(single.map((t, i) => (i === 207 ? single[205]! : t))))).toBeNull();
    expect(detectAskSelect(fromTexts(single.slice(0, -1)))).toBeNull();
  });

  it("with an unknown row between the options: a description, a wrapped label, a row below the padding", () => {
    const insert = (at: number, row: string) => [...single.slice(0, at), row, ...single.slice(at + 1)];
    const pad = (s: string) => `│${s.padEnd(single[201]!.length - 2)}│`;
    // A description row (six columns in) under Red, in place of Green: the row count stays the same.
    expect(detectAskSelect(fromTexts(insert(202, pad("       the colour of warnings"))))).toBeNull();
    // A wrapped label's continuation (four columns in).
    expect(detectAskSelect(fromTexts(insert(202, pad("     continued label"))))).toBeNull();
    // Text below a blank padding row.
    expect(detectAskSelect(fromTexts(insert(206, pad("   ○ Purple"))))).toBeNull();
  });

  it("when `Other` is not the last row, is missing, or is listed twice", () => {
    const moved = single.map((t, i) => (i === 203 ? single[204]! : i === 204 ? single[203]! : t));
    expect(detectAskSelect(fromTexts(moved))).toBeNull();
    expect(detectAskSelect(fromTexts(single.map((t) => t.replace(OTHER, "Something else       "))))).toBeNull();
    const twice = single.map((t, i) => (i === 203 ? single[204]! : t));
    expect(detectAskSelect(fromTexts(twice))).toBeNull();
  });

  it("with `Other` as the only row", () => {
    const only = [...single.slice(0, 201), single[204]!, ...single.slice(205)].map((t, i) =>
      i === 201 ? t.replace("│   ○", "│ ❯ ○") : t,
    );
    expect(detectAskSelect(fromTexts(only))).toBeNull();
  });

  it("with more than four question rows, or none", () => {
    const tall = [...single.slice(0, 199), single[199]!, single[199]!, single[199]!, single[199]!, ...single.slice(199)];
    expect(detectAskSelect(fromTexts(tall))).toBeNull();
    const four = [...single.slice(0, 199), single[199]!, single[199]!, single[199]!, ...single.slice(199)];
    expect(detectAskSelect(fromTexts(four))!.question).toBe("Pick a color Pick a color Pick a color Pick a color");
    const none = [...single.slice(0, 199), ...single.slice(200)];
    expect(detectAskSelect(fromTexts(none))).toBeNull();
  });

  it("when the dialog is on a pane too wide for the bridge to bind it", () => {
    const widen = (t: string, i: number) =>
      i >= TITLE_AT ? t.replace(/(.)$/, (_m, last: string) => `${(last === "│" ? " " : "─").repeat(3000)}${last}`) : t;
    const wide = single.map(widen);
    expect(wide[TITLE_AT]!.length).toBeGreaterThan(3000);
    expect(detectAskSelect(fromTexts(wide))).toBeNull();
  });
});

describe("tail anchoring", () => {
  it.each(["omp--v18-4-ask-single.txt", "omp--select-menu.txt", "omp--select-menu-other.txt"])(
    "%s: a dialog scrolled up with ordinary output below it declines",
    (name) => {
      const scrolled = [...load(name), ...fromTexts(["● Wrote the file", "  ⎿  done"])];
      expect(detectAskSelect(scrolled)).toBeNull();
      expect(ompBuildBlocks(scrolled).every((b) => b.kind === "raw")).toBe(true);
    },
  );

  it("trailing blank rows below the border do not move the tail", () => {
    const padded = [...load("omp--v18-4-ask-single.txt"), ...fromTexts(["", "   ", ""])];
    expect(detectAskSelect(padded)).not.toBeNull();
  });
});

describe("the grammar claims nothing else in the corpus", () => {
  const CLAIMED = new Set([
    "omp--select-menu-moved.txt",
    "omp--select-menu-noted.txt",
    "omp--select-menu-other.txt",
    "omp--select-menu.txt",
    "omp--v18-4-ask-single-moved.txt",
    "omp--v18-4-ask-single.txt",
  ]);

  it("lifts exactly the six one-question single-select captures, out of every capture in the corpus", () => {
    const all = readdirSync(PANES_DIR).filter((f) => f.endsWith(".txt"));
    expect(all.length).toBeGreaterThan(300);
    const lifted = all.filter((name) => detectAskSelect(load(name)) !== null);
    expect(lifted.toSorted()).toEqual([...CLAIMED].toSorted());
  });
});
