import { fixtureText } from "@/test/surface-traces";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { lineText, splitLines } from "../../blocks";
import { piAdapter } from "./index";
import { readPiFrame } from "./ask";

const raw = (name: string) => fixtureText(`pi--rpiv-v2150-${name}.txt`);
const load = (name: string) => splitLines(parseAnsi(raw(name)));

describe("Pi native editor observation", () => {
  it("declares measured preparation/writer plans on the complete checkbox card", () => {
    const card = piAdapter.buildBlocks(load("multi")).find((block) => block.kind === "multi-select");
    expect(card?.multi).toMatchObject({
      note: { state: "none", text: "" },
      editors: {
        ownerSignature: piAdapter.observeDialogEditor?.(load("multi-field-filled"))?.ownerSignature,
        answer: { focusKeys: ["Down", "Down"], clearKeys: ["ctrl+u"] },
        note: { openKeys: ["n"], clearLineKeys: ["ctrl+a", "ctrl+k", "Backspace"], closeKeys: ["Escape"] },
      },
    });
  });

  it("marks a saved first-line note summary as incomplete rather than an editable value", () => {
    const card = piAdapter.buildBlocks(load("note-saved")).find((block) => block.kind === "multi-select");
    expect(card?.multi.note).toEqual({ state: "attached", text: "row …", textComplete: false });
  });

  it("observes a focused multiline field without pretending its rows are logical lines", () => {
    const editor = piAdapter.observeDialogEditor?.(load("multi-field-filled"));
    expect(editor).toMatchObject({
      purpose: "answer", layout: "inline",
      rows: ["First line", "Second line\u00a0"],
      cursor: { row: 1, offset: 11, cell: "\u00a0" },
      keys: { start: ["ctrl+a"], end: ["ctrl+e"], up: ["Up"], left: ["Left"], right: ["Right"] },
    });
    expect(editor?.ownerSignature).toBeTruthy();
    expect(editor?.regionSignature).toContain("Which checks should the Collie probe run?");
    expect(editor?.styledSignature).toBeTruthy();
  });

  it("observes the complete boxed note and retains the question owner across native modes", () => {
    const editor = piAdapter.observeDialogEditor?.(load("note-editor"));
    expect(editor).toMatchObject({
      purpose: "question-note", layout: "boxed",
      rows: ["First note line", "Second note line "],
      cursor: { row: 1, offset: 16, cell: " " },
    });
    expect(editor?.ownerSignature).toBe(piAdapter.observeDialogEditor?.(load("multi-field-filled"))?.ownerSignature);
  });

  it("declares native single-choice answer/note plans on the existing select card", () => {
    const card = piAdapter.buildBlocks(load("single-step")).find((block) => block.kind === "preview-select");
    expect(card?.preview).toMatchObject({
      question: "How should the Collie probe describe delivery?", preview: [],
      options: [{ label: "Standard", keys: ["Enter"] }, { label: "Custom", keys: ["Down", "Enter"] }],
      field: { n: 3, text: "", focused: false, multiline: true },
      editors: { answer: { focusKeys: ["Down", "Down"], clearKeys: ["ctrl+u"], commitKeys: ["Enter"] },
        note: { openKeys: ["n"], closeKeys: ["Escape"] } },
    });
  });

  it("retains a saved note and the complete side-by-side choices/preview", () => {
    const card = piAdapter.buildBlocks(load("preview-note-saved")).find((block) => block.kind === "preview-select");
    expect(card?.preview.note).toEqual({ state: "attached", text: "Preview first note …", textComplete: false });
    expect(card?.preview.preview.join("\n")).toContain("Plan A");
  });

  it("keeps the parked custom value read-only rather than turning it into an authored option", () => {
    const card = piAdapter.buildBlocks(load("preview-field-parked")).find((block) => block.kind === "preview-select");
    expect(card?.preview.options.map((option) => option.label)).toEqual(["Sequential", "Parallel"]);
    expect(card?.preview.field).toMatchObject({ text: "Own preview plan\nNext line ✔", focused: false, textComplete: false });
  });

  it("lifts the native partial review without inventing answers for missing questions", () => {
    const card = piAdapter.buildBlocks(load("submit-partial")).find((block) => block.kind === "multi-select");
    expect(card?.multi).toMatchObject({ phase: "review", submit: "pointer", pointer: "submit", incomplete: true,
      note: { state: "none", text: "" }, backKeys: ["Tab", "Tab", "Tab", "Tab"] });
    if (card?.multi.phase !== "review") return;
    expect(card.multi.answers?.map((answer) => answer.question)).toEqual(["Plan", "Delivery"]);
    expect(card.multi.answers?.[0]?.answer).toContain("Preview second note");
    expect(card.multi.editors?.note?.openKeys).toEqual(["n"]);
  });

  it("lifts the genuine 59-column stacked preview with measured default bindings", () => {
    const lines = load("preview-stacked--w59");
    const card = piAdapter.buildBlocks(lines).find((block) => block.kind === "preview-select");
    expect(card?.preview.options.map((option) => option.label)).toEqual(["Sequential", "Parallel"]);
    expect(card?.preview.preview.join("\n")).toContain("Plan A");
    expect(card?.preview.cancelKeys).toEqual(["Escape"]);
    expect(readPiFrame(lines)?.footer.escapeVerb).toBeNull(); // The observed footer is never fabricated.
    expect(piAdapter.modalOnScreen?.(lines)).toBe(true);
    expect(piAdapter.composerReady?.(lines)).toBe(false);
  });

  it("does not borrow hidden bindings from a torn resize paint or an unknown clipped hint", () => {
    const unknown = splitLines(parseAnsi(raw("preview-stacked--w59").replace("n to add notes", "n to erase notes")));
    for (const lines of [load("preview-resize-torn--w59"), unknown]) {
      expect(piAdapter.buildBlocks(lines).every((block) => block.kind === "raw")).toBe(true);
      expect(piAdapter.composerReady?.(lines)).toBe(false);
    }
  });

  it("keeps a clipped review's visible echoes without fabricating hidden answers or an empty global note", () => {
    const card = piAdapter.buildBlocks(load("submit-clipped--w59")).find((block) => block.kind === "multi-select");
    expect(card?.multi).toMatchObject({ phase: "review", incomplete: true, summaryClipped: true });
    if (card?.multi.phase !== "review") return;
    expect(card.multi.answers?.map((answer) => answer.question)).toEqual(["Plan", "Checks"]);
    expect(card.multi.note).toBeUndefined();
    expect(card.multi.editors?.note?.openKeys).toEqual(["n"]);
  });

  it("lifts the genuine all-answered Ready page with its global note and all four echoes", () => {
    const card = piAdapter.buildBlocks(load("submit-complete")).find((block) => block.kind === "multi-select");
    expect(card?.multi).toMatchObject({ phase: "review", incomplete: false,
      note: { state: "attached", text: "Complete phone global\nSecond complete global", textComplete: false } });
    if (card?.multi.phase !== "review") return;
    expect(card.multi.answers?.map((answer) => answer.question)).toEqual(["Plan", "Checks", "Delivery", "Optional"]);
    expect(card.multi.summaryClipped).toBeUndefined();
  });

  it("recognizes a standalone checkbox's literal Submit rather than requiring a Next step", () => {
    const card = piAdapter.buildBlocks(load("multi-standalone")).find((block) => block.kind === "multi-select");
    expect(card?.multi).toMatchObject({ phase: "checkbox", steps: null, advanceLabel: "Submit" });
  });

  it("observes a single-choice input without a checkbox or Next sentinel", () => {
    expect(piAdapter.observeDialogEditor?.(load("single-field-filled"))).toMatchObject({
      purpose: "answer", layout: "inline", rows: ["Current custom", "Second custom line\u00a0"],
      cursor: { row: 1, offset: 18, cell: "\u00a0" },
    });
  });

  it("distinguishes single-field logical blank tails from the dialog's unpainted padding", () => {
    expect(piAdapter.observeDialogEditor?.(load("single-field-empty"))?.rows).toEqual(["\u00a0"]);
    expect(piAdapter.observeDialogEditor?.(load("single-field-blank-tail"))).toMatchObject({
      rows: ["Current custom", "Second custom line", "", ""], cursor: { row: 0, offset: 0, cell: "C" },
    });
  });

  it("observes a global note while review controls sit below the outer frame", () => {
    expect(piAdapter.observeDialogEditor?.(load("global-note-editor"))).toMatchObject({
      purpose: "global-note", layout: "boxed",
      rows: ["Global first line", "Global second line "],
      cursor: { row: 1, offset: 18, cell: " " },
    });
  });

  it("keeps complete note bounds even when the note pushes the choices off screen", () => {
    const editor = piAdapter.observeDialogEditor?.(load("note-editor-long"));
    expect(editor?.rows).toEqual([...Array.from({ length: 11 }, () => "row"), "LAST "]);
    expect(editor?.cursor).toEqual({ row: 11, offset: 4, cell: " " });
    expect(editor?.ownerSignature).toBe(piAdapter.observeDialogEditor?.(load("note-editor"))?.ownerSignature);
  });

  it.each(["top", "bottom"])("declines a note whose %s border declares hidden rows", (side) => {
    const lines = load("note-editor");
    const note = lines.findIndex((line) => lineText(line).trim() === "Notes:");
    const border = note + (side === "top" ? 1 : 4);
    for (const segment of lines[border]!.segments) {
      if (segment.text.includes("─")) segment.text = `${"─".repeat(55)} ${side === "top" ? "↑" : "↓"} 4 more ${"─".repeat(55)}`;
    }
    expect(piAdapter.observeDialogEditor?.(lines)).toBeNull();
  });

  it.each(["multi", "multi-next", "single"])("does not claim an unfocused input in %s", (name) => {
    expect(piAdapter.observeDialogEditor?.(load(name))).toBeNull();
  });
});
