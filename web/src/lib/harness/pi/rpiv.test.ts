import { fixtureText } from "@/test/surface-traces";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../../ansi";
import { lineText, splitLines } from "../../blocks";
import { previewCoreEqual, previewsEqual } from "../preview-model";
import { multiSelectEquals, multiSelectIdentity } from "../multi-select-model";
import { canonicalStyledLines, encodeStyledRegion } from "../../styled-region";
import { piAdapter } from "./index";

const raw = (name: string) => fixtureText(`pi--rpiv-v2150-${name}.txt`);
const load = (name: string) => splitLines(parseAnsi(raw(name)));
const question = (name: string) => piAdapter.buildBlocks(load(name)).find((b) => b.kind === "preview-select");

describe("RPIV questions through the Pi adapter", () => {
  it("keeps ambiguous visual rows read-only while still showing the complete checkbox choices", () => {
    const soft = load("multi-field-wrap-soft");
    const hard = load("multi-field-wrap-hard");
    expect(encodeStyledRegion(canonicalStyledLines(soft))).toBe(encodeStyledRegion(canonicalStyledLines(hard)));
    for (const lines of [soft, hard]) {
      const card = piAdapter.buildBlocks(lines).find((block) => block.kind === "multi-select");
      expect(card?.multi).toMatchObject({ field: { textComplete: false }, editors: { answer: { clearKeys: ["ctrl+u"] } } });
      expect(piAdapter.modalOnScreen?.(lines)).toBe(true);
      expect(piAdapter.composerReady?.(lines)).toBe(false);
    }
  });

  it.each([
    ["multi-field-empty", "", true, false, 1, "on"],
    ["multi-field-filled", "First line\nSecond line", true, true, 2, "on"],
    ["multi-next", "First line\nSecond line", false, true, 2, "below"],
  ] as const)("reads the complete custom answer and automatic tick in %s", (name, text, focused, checked, lines, pointer) => {
    const card = piAdapter.buildBlocks(load(name)).find((b) => b.kind === "multi-select");
    expect(card).toMatchObject({ multi: { field: { n: 3, text, focused, checked, lines, pointer, autoChecked: true, multiline: true } } });
  });

  it("does not replace a literal non-breaking space away from the cursor", () => {
    const lines = splitLines(parseAnsi(raw("multi-field-filled").replace("First line", "First\u00a0line")));
    const card = piAdapter.buildBlocks(lines).find((block) => block.kind === "multi-select");
    expect(card).toMatchObject({ multi: { field: { text: "First\u00a0line\nSecond line" } } });
  });

  it("models real RPIV checkboxes as arrow/Space toggles with an explicit Next row", () => {
    const card = piAdapter.buildBlocks(load("multi")).find((b) => b.kind === "multi-select");
    expect(card).toMatchObject({
      kind: "multi-select",
      multi: {
        phase: "checkbox", question: "Which checks should the Collie probe run?", toggle: "walk",
        options: [
          { n: 1, label: "Unit tests", description: "Verify local behavior.", checked: false },
          { n: 2, label: "Integration tests", description: "Verify the real interaction.", checked: false },
        ],
        pointer: "option", pointerRow: 1, advanceLabel: "Next", cancelKeys: ["Escape"],
      },
    });
    const ticked = piAdapter.buildBlocks(load("multi-ticked")).find((b) => b.kind === "multi-select");
    expect(ticked).toMatchObject({ multi: { options: [{ checked: true }, { checked: false }] } });
  });

  it("keeps the preview and derives walked choices and tab navigation", () => {
    const card = piAdapter.buildBlocks(load("preview")).find((b) => b.kind === "preview-select");
    expect(card).toMatchObject({
      kind: "preview-select",
      preview: {
        question: "Which implementation should the Collie probe use?",
        options: [
          { n: 1, label: "Sequential", description: "Keep the steps ordered.", keys: ["Enter"], pointed: true },
          { n: 2, label: "Parallel", description: "Run independent work together.", keys: ["Down", "Enter"], pointed: false },
        ],
        note: { state: "none", text: "" },
        navigation: { back: ["Tab", "Tab", "Tab", "Tab"], next: ["Tab"] },
        cancelKeys: ["Escape"],
      },
    });
    expect(card?.preview.preview.join("\n")).toContain("Plan A");
  });

  it("keeps preview identity across an actual pointer and preview change", () => {
    const before = piAdapter.buildBlocks(load("preview")).find((b) => b.kind === "preview-select");
    const after = piAdapter.buildBlocks(load("preview-moved")).find((b) => b.kind === "preview-select");
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    if (!before || !after) return;
    expect(previewCoreEqual(before.preview, after.preview)).toBe(true);
    expect(after.preview.options[1]?.keys).toEqual(["Enter"]);
  });
  it("turns the real question into choices and Cancel rather than raw terminal text", () => {
    expect(question("single")).toMatchObject({
      kind: "preview-select",
      preview: {
        caption: "Color",
        question: "Which color should the Collie probe choose?",
        options: [
          { label: "Red", description: "Warm and loud.", keys: ["Enter"] },
          { label: "Green", description: "Calm and natural.", keys: ["Down", "Enter"] },
          { label: "Blue", description: "Cool and deep.", keys: ["Down", "Down", "Enter"] },
        ],
        cancelKeys: ["Escape"],
      },
    });
  });

  it("keeps the same question identity when the actual pointer moves", () => {
    const first = question("single");
    const moved = question("single-moved");
    expect(first).toBeDefined();
    expect(moved).toBeDefined();
    if (first === undefined || moved === undefined) return;
    expect(previewCoreEqual(first.preview, moved.preview)).toBe(true);
    expect(previewsEqual(first.preview, moved.preview)).toBe(false);
    expect(first.preview.options[0]?.pointed).toBe(true);
    expect(moved.preview.options[1]?.pointed).toBe(true);
    expect(moved.preview.options[0]?.keys).toEqual(["Up", "Enter"]);
    expect(moved.preview.options[1]?.keys).toEqual(["Enter"]);
  });

  it("keeps review identity across the real Submit/Cancel walk without ignoring note drift", () => {
    const before = piAdapter.buildBlocks(load("submit-global-note")).find((block) => block.kind === "multi-select");
    const after = piAdapter.buildBlocks(load("submit-global-note-cancel")).find((block) => block.kind === "multi-select");
    expect(before?.multi.phase).toBe("review");
    expect(after?.multi.phase).toBe("review");
    if (before?.multi.phase !== "review" || after?.multi.phase !== "review") return;
    expect(before.multi.pointer).toBe("submit");
    expect(after.multi.pointer).toBe("cancel");
    expect(multiSelectIdentity(before.multi, after.multi)).toBe(true);
    expect(multiSelectEquals(before.multi, after.multi)).toBe(false);
    expect(multiSelectIdentity(before.multi, { ...after.multi, note: { state: "attached", text: "Changed at the desk" } })).toBe(false);
  });

  it("recognizes the question as a modal, not an ordinary reply editor", () => {
    expect(piAdapter.modalOnScreen?.(load("single"))).toBe(true);
    expect(piAdapter.composerReady?.(load("single"))).toBe(false);
  });

  it.each([
    ["output below the dialog", (text: string) => `${text}\nscratch shell output`],
    ["an unpainted quotation", (text: string) => splitLines(parseAnsi(text)).map(lineText).join("\n")],
    ["an unknown footer key", (text: string) => text.replace("Ctrl+] to collapse", "unknown-key to collapse")],
  ])("does not offer choices for %s", (_name, mutate) => {
    const blocks = piAdapter.buildBlocks(splitLines(parseAnsi(mutate(raw("single")))));
    expect(blocks.every((b) => b.kind === "raw")).toBe(true);
  });
});
