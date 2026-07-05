import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { buildBlocks, splitLines, type StyledLine } from "../blocks";
import { detectPreviewSelect, detectPreviewSelectRegion } from "./preview-select";
import { detectPromptSelect } from "./prompt-select";
import { detectWizard } from "./wizard";
import { lineText } from "./markers";

// Anchored on this file's own directory (see prompt-select.test.ts for why not import.meta.url).
const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

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
