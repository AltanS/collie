import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { buildBlocks } from "..";
import { detectPreviewSelect, detectPreviewSelectRegion } from "./preview-select";
import { detectPromptSelect } from "./prompt-select";
import { detectWizard } from "./wizard";
import { lineText } from "./markers";

// Anchored on this file's own directory (see prompt-select.test.ts for why not import.meta.url).
const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

// The detector is developed and gated entirely against the byte-faithful preview-variant captures
// (see NOTES_NOTES.md for the live-verified choreography they encode). Every fixture runs through
// the real parseAnsi → splitLines pipeline exactly as the renderer does.

function fixtureText(name: string): string {
  return readFileSync(join(PANES_DIR, name), "utf8");
}

function fixtureLines(name: string): StyledLine[] {
  return splitLines(parseAnsi(fixtureText(name)));
}

describe("detectPreviewSelect — the preview-variant fixtures", () => {
  it("single-question dialog → options, pointer, preview pane, no note, no steps", () => {
    const model = detectPreviewSelect(fixtureLines("claude--select-preview.txt"));
    expect(model).not.toBeNull();
    expect(model!.question).toBe("Which widget design should we use?");
    expect(model!.options.map((o) => o.label)).toEqual(["Boxy", "Rounded", "Minimal"]);
    expect(model!.options.map((o) => o.n)).toEqual([1, 2, 3]);
    // The ❯ pointer sits on row 1 — the row whose preview is on screen (and what Enter would pick).
    expect(model!.options.map((o) => o.pointed)).toEqual([true, false, false]);
    expect(model!.options.every((o) => !o.chosen)).toBe(true);
    // The right-hand pane, borders included, split from the labels at the Notes column.
    expect(model!.preview.length).toBeGreaterThan(3);
    expect(model!.preview.join("\n")).toContain("WIDGET");
    expect(model!.preview.join("\n")).not.toContain("Rounded"); // labels never leak into the pane
    expect(model!.note).toEqual({ state: "none", text: "" });
    expect(model!.steps).toBeNull();
  });

  it("note input focused → note.state 'editing' (placeholder line + ctrl+g footer)", () => {
    const model = detectPreviewSelect(fixtureLines("claude--select-preview-note-input.txt"));
    expect(model).not.toBeNull();
    expect(model!.note).toEqual({ state: "editing", text: "" });
  });

  it("committed note → note.state 'attached' with the visible text", () => {
    const model = detectPreviewSelect(fixtureLines("claude--select-preview-note-attached.txt"));
    expect(model).not.toBeNull();
    expect(model!.note).toEqual({ state: "attached", text: "prefer subtle shadows" });
  });

  it("wizard step → stepper chips (bg-highlighted current), question, options", () => {
    const model = detectPreviewSelect(fixtureLines("claude--wizard-preview-q1.txt"));
    expect(model).not.toBeNull();
    expect(model!.question).toBe("Which card layout should we use?");
    expect(model!.options.map((o) => o.label)).toEqual(["Grid", "List"]);
    expect(model!.steps).not.toBeNull();
    expect(model!.steps!.map((s) => s.label)).toEqual(["Card layout", "Dark mode"]);
    expect(model!.steps!.map((s) => s.answered)).toEqual([false, false]);
    // The current chip is marked by styling only (the bg-highlight run), same as wizard.ts.
    expect(model!.steps!.map((s) => s.current)).toEqual([true, false]);
    expect(model!.note).toEqual({ state: "none", text: "" });
  });

  it("wizard step with a note attached", () => {
    const model = detectPreviewSelect(fixtureLines("claude--wizard-preview-note-attached.txt"));
    expect(model).not.toBeNull();
    expect(model!.note).toEqual({ state: "attached", text: "keep cards compact" });
  });

  it("keeps a literal contiguous region signature for every preview fixture", () => {
    for (const name of [
      "claude--select-preview.txt",
      "claude--select-preview-note-input.txt",
      "claude--select-preview-note-attached.txt",
      "claude--wizard-preview-q1.txt",
      "claude--wizard-preview-note-attached.txt",
    ]) {
      const lines = fixtureLines(name);
      const screenText = lines.map(lineText).join("\n");
      const model = detectPreviewSelect(lines);
      expect(model).not.toBeNull();
      expect(screenText.includes(model!.regionSignature)).toBe(true);
    }
  });
});

describe("detectPreviewSelect — core signature (pointer/note-independent identity)", () => {
  // A minimal synthetic preview dialog; `pointer` / `note` / `subject` / `label3` vary independently
  // so we can assert exactly which changes the core signature is (in)sensitive to.
  function synth(opts: { pointer?: number; note?: string; subject?: string; label3?: string }): string {
    const pointer = opts.pointer ?? 1;
    const labels = ["Boxy", "Rounded", opts.label3 ?? "Minimal"];
    const pane = ["┌────┐", "│ MK │", "└────┘"];
    const col = 30;
    const rows = labels.map(
      (l, i) => `${pointer === i + 1 ? "❯" : " "} ${i + 1}. ${l}`.padEnd(col) + (pane[i] ?? ""),
    );
    return [
      ...(opts.subject ? [opts.subject] : []),
      " ☐ Design",
      "",
      "Which widget design should we use?",
      "",
      ...rows,
      "",
      " ".repeat(col) + `Notes: ${opts.note ?? "press n to add notes"}`,
      "",
      "─".repeat(50),
      "  Chat about this",
      "",
      "Enter to select · n to add notes · Esc to cancel",
    ].join("\n");
  }
  const sig = (s: string) => detectPreviewSelect(splitLines(parseAnsi(s)))!.coreSignature;

  it("is STABLE across a pointer move and a note change (the legit in-flight changes)", () => {
    const base = sig(synth({}));
    expect(sig(synth({ pointer: 2 }))).toBe(base); // our own digit moves the pointer
    expect(sig(synth({ pointer: 3 }))).toBe(base);
    expect(sig(synth({ note: "prefer subtle shadows" }))).toBe(base); // the note flow transitions this
  });

  it("DIFFERS when the subject above the dialog or an option label changes", () => {
    const base = sig(synth({}));
    expect(sig(synth({ subject: "Editing foo.ts" }))).not.toBe(base); // different subject = different dialog
    expect(sig(synth({ label3: "Compact" }))).not.toBe(base); // left-column label change
  });
});

describe("detectPreviewSelect — false-positive / cross-grammar isolation", () => {
  for (const name of [
    "claude--working.txt",
    "claude--fresh-idle.txt",
    "claude--done.txt",
    "claude--select-menu.txt", // the standard select must stay prompt-select territory
    "claude--wizard-q1.txt", // the standard wizard must stay wizard territory
    "claude--wizard-submit.txt",
  ]) {
    it(`${name} produces zero preview detections`, () => {
      expect(detectPreviewSelect(fixtureLines(name))).toBeNull();
    });
  }

  for (const name of [
    "claude--select-preview.txt",
    "claude--select-preview-note-input.txt",
    "claude--wizard-preview-q1.txt",
  ]) {
    it(`${name} is claimed by NEITHER prompt-select NOR the wizard grammar`, () => {
      // The preview layout's footer sits a whole pane below the option rows, so the T2/T7
      // footer-gap guards must keep rejecting it — this block is the only claimant.
      expect(detectPromptSelect(fixtureLines(name))).toBeNull();
      expect(detectWizard(fixtureLines(name))).toBeNull();
    });
  }

  it("a preview dialog that is NOT at the tail does not match", () => {
    const withTail = fixtureText("claude--select-preview.txt") + "\n● Wrote the file\n  ⎿  done\n";
    expect(detectPreviewSelect(splitLines(parseAnsi(withTail)))).toBeNull();
  });

  it("empty and whitespace-only buffers do not match", () => {
    expect(detectPreviewSelect(splitLines(parseAnsi("")))).toBeNull();
    expect(detectPreviewSelect(splitLines(parseAnsi("\n\n   \n")))).toBeNull();
  });
});

describe("detectPreviewSelectRegion + buildBlocks — render boundary and gating", () => {
  it("single-question region starts at the first option row (question stays raw above)", () => {
    const lines = fixtureLines("claude--select-preview.txt");
    const region = detectPreviewSelectRegion(lines);
    expect(region).not.toBeNull();
    expect(lineText(lines[region!.startLine]!)).toMatch(/❯\s*1\.\s+Boxy/);
    expect(region!.model).toEqual(detectPreviewSelect(lines));
  });

  it("wizard-step region starts at the stepper header (the question renders natively)", () => {
    const lines = fixtureLines("claude--wizard-preview-q1.txt");
    const region = detectPreviewSelectRegion(lines);
    expect(region).not.toBeNull();
    expect(lineText(lines[region!.startLine]!)).toContain("✔ Submit");
  });

  it("buildBlocks lifts the tail into a preview-select block for Claude", () => {
    const blocks = buildBlocks(fixtureLines("claude--select-preview.txt"), { agent: "claude" });
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "preview-select"]);
  });

  it("buildBlocks keeps the pure raw mirror for every other agent", () => {
    for (const agent of ["codex", "opencode", "pi", undefined]) {
      const blocks = buildBlocks(fixtureLines("claude--select-preview.txt"), { agent });
      expect(blocks.map((b) => b.kind)).toEqual(["raw"]);
    }
  });
});

describe("detectPreviewSelect — wrapped option labels", () => {
  // The left column is only ~30 wide, so Claude Code wraps a longer option label onto unnumbered
  // continuation rows. That makes the NUMBERED rows non-adjacent — which the detector used to
  // treat as an unknown layout and bail on, dropping a real dialog to the raw mirror.
  it("joins a wrapped label and still reads the rest of the dialog", () => {
    const model = detectPreviewSelect(fixtureLines("claude--wizard-preview-wrapped-label.txt"));
    expect(model).not.toBeNull();
    expect(model!.options.map((o) => o.label)).toEqual([
      "Grid of equal-width cards with a fixed gutter (Recommended)",
      "List",
    ]);
    expect(model!.options.map((o) => o.n)).toEqual([1, 2]);
    expect(model!.options.map((o) => o.pointed)).toEqual([true, false]);
    expect(model!.question).toBe("Which card layout should we use?");
    expect(model!.steps!.map((s) => s.label)).toEqual(["Card layout", "Dark mode"]);
    // The wrapped rows are label text, not preview content — they must not leak across the column.
    expect(model!.preview.join("\n")).not.toContain("Recommended");
    expect(model!.preview.join("\n")).toContain("Card 1");
  });

  it("lifts to a preview-select block instead of falling through to raw", () => {
    const blocks = buildBlocks(fixtureLines("claude--wizard-preview-wrapped-label.txt"), {
      agent: "claude",
    });
    expect(blocks.map((b) => b.kind)).toContain("preview-select");
  });

  // A wrapped label on the LAST option puts continuation rows BELOW the final numbered row, where
  // the detector previously demanded a blank left column.
  function synthWrapped(opts: { tail?: string; pointer?: number } = {}): string {
    const col = 30;
    const pane = ["┌────┐", "│ MK │", "│ MK │", "└────┘"];
    const pointer = opts.pointer ?? 1;
    const rows = [
      `${pointer === 1 ? "❯" : " "} 1. Boxy`.padEnd(col) + pane[0],
      `${pointer === 2 ? "❯" : " "} 2. Rounded corners on every`.padEnd(col) + pane[1],
      `     ${opts.tail ?? "edge of the card"}`.padEnd(col) + pane[2],
      " ".repeat(col) + pane[3],
    ];
    return [
      " ☐ Design",
      "",
      "Which widget design should we use?",
      "",
      ...rows,
      "",
      " ".repeat(col) + "Notes: press n to add notes",
      "",
      "─".repeat(50),
      "  Chat about this",
      "",
      "Enter to select · n to add notes · Esc to cancel",
    ].join("\n");
  }
  const model = (s: string) => detectPreviewSelect(splitLines(parseAnsi(s)));

  it("handles a wrapped label on the FINAL option", () => {
    const m = model(synthWrapped());
    expect(m).not.toBeNull();
    expect(m!.options.map((o) => o.label)).toEqual(["Boxy", "Rounded corners on every edge of the card"]);
  });

  it("folds the wrapped tail into the core signature", () => {
    // The tail is part of the dialog's identity: two dialogs differing only in a wrapped
    // continuation row must not compare equal, or the race guard would let a keystroke land on a
    // dialog the user never saw.
    const base = model(synthWrapped())!.coreSignature;
    expect(model(synthWrapped({ tail: "side of the card" }))!.coreSignature).not.toBe(base);
    // …while our own pointer move still leaves it untouched.
    expect(model(synthWrapped({ pointer: 2 }))!.coreSignature).toBe(base);
  });
});

describe("detectPreviewSelect — the label column is the discriminator", () => {
  // A wrapped line hangs UNDER its label. That column is the only thing separating "more of the
  // option above" from "a new option" / "not label text at all", and both directions can bite.
  function pane(gutterRows: string[], col: number, pane_: string[]): string {
    const rows = gutterRows.map((g, i) => g.padEnd(col) + (pane_[i] ?? ""));
    return [
      " ☐ Design",
      "",
      "Which widget design should we use?",
      "",
      ...rows,
      "",
      " ".repeat(col) + "Notes: press n to add notes",
      "",
      "─".repeat(50),
      "  Chat about this",
      "",
      "Enter to select · n to add notes · Esc to cancel",
    ].join("\n");
  }
  const model = (s: string) => detectPreviewSelect(splitLines(parseAnsi(s)));

  it("does not mint a phantom option from a number inside a wrapped label", () => {
    // "…and 3. Backfill later" wraps so the continuation row parses as a numbered row, and its
    // number is exactly k+1 — so the 1..k check would pass and render a third button that types a
    // stray "3" into the terminal.
    const m = model(
      pane(
        ["❯ 1. Boxy", "  2. Ship the migration in", "     the second phase and", "     3. Backfill later"],
        30,
        ["┌────┐", "│ MK │", "│ MK │", "└────┘"],
      ),
    );
    expect(m).not.toBeNull();
    expect(m!.options).toHaveLength(2);
    expect(m!.options[1]!.label).toBe("Ship the migration in the second phase and 3. Backfill later");
  });

  it("bails when left-column content below the list isn't label text", () => {
    // A layout where the Notes column and the preview pane DON'T coincide: the box is drawn 2
    // columns left of `Notes:`, so preview rows land in the left slice. Folding those into the last
    // option would put box-drawing garbage on a button that still types a digit.
    const rows = ["❯ 1. Boxy".padEnd(32) + "┌──────┐", "  2. List".padEnd(32) + "│ AAAA │",
                  " ".repeat(32) + "│ AAAA │", " ".repeat(32) + "└──────┘"];
    const text = [
      " ☐ Design", "", "Which widget design should we use?", "", ...rows, "",
      " ".repeat(34) + "Notes: press n to add notes", "",
      "─".repeat(50), "  Chat about this", "",
      "Enter to select · n to add notes · Esc to cancel",
    ].join("\n");
    expect(model(text)).toBeNull();
  });

  it("keeps the chosen tick when it lands on the wrapped label's first row", () => {
    // A revisited question paints ✔ at the end of the row it marks — the middle of the joined
    // string. An end-anchored test would miss it AND leave the tick sitting inside the button text.
    const m = model(
      pane(["❯ 1. Grid of equal-width ✔", "     cards with a gutter", "  2. List"], 30,
           ["┌────┐", "│ MK │", "└────┘"]),
    );
    expect(m).not.toBeNull();
    expect(m!.options[0]!.label).toBe("Grid of equal-width cards with a gutter");
    expect(m!.options[0]!.chosen).toBe(true);
  });

  it("bails past 9 options — a two-key digit is unsendable", () => {
    const labels = Array.from({ length: 10 }, (_, i) => `${i === 0 ? "❯" : " "} ${i + 1}. Option`);
    expect(model(pane(labels, 30, ["┌────┐"]))).toBeNull();
  });
});

describe("detectPreviewSelect — the label column comes from a real option row", () => {
  it("a bare 'N.' with no label cannot shift the column that discriminates", () => {
    // OPTION_LABEL_START matches "  12." but parseOptionRow does not (no label). Deriving labelCol
    // from such a line widens it, so a wrapped continuation then reads as a new option — a phantom
    // button that types a digit no option in the terminal carries.
    const col = 30;
    const pane = ["┌────┐", "│ MK │", "│ MK │", "└────┘"];
    const rows = [
      "  12.".padEnd(col) + pane[0],
      "❯ 1. Alpha".padEnd(col) + pane[1],
      "  2. Rename now and".padEnd(col) + pane[2],
      "     3. Backfill later".padEnd(col) + pane[3],
    ];
    const text = [
      " ☐ Design",
      "",
      "Which widget design should we use?",
      "",
      ...rows,
      "",
      " ".repeat(col) + "Notes: press n to add notes",
      "",
      "─".repeat(50),
      "  Chat about this",
      "",
      "Enter to select · n to add notes · Esc to cancel",
    ].join("\n");
    const m = detectPreviewSelect(splitLines(parseAnsi(text)));
    expect(m).not.toBeNull();
    expect(m!.options).toHaveLength(2);
    expect(m!.options[1]!.label).toBe("Rename now and 3. Backfill later");
  });
});
