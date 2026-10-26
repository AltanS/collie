import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { promptsEqual, promptsSameIdentity } from "../prompt-model";
import { detectAskSelect, detectAskSelectRegion } from "./ask";
import { ompBuildBlocks } from "./index";
import { ompModalOnScreen } from "./modal";

// The omp `ask` tool's single-select questions and batch review (.adr/0077). Its footer prints the commit
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
it("a current OMP Ask offers selectable answers even with its hide hint", () => {
  const lines = load("omp--v18-10-ask-single.txt");
  const model = detectAskSelect(lines);
  expect(model?.question).toBe("Pick a colour");
  expect(model?.options.map((option) => [option.label, option.keys])).toEqual([
    ["Red", ["Enter"]],
    ["Blue", ["Down", "Enter"]],
    [OTHER, ["Down", "Down", "Enter"]],
    ["Cancel", ["Escape"]],
  ]);
  expect(ompModalOnScreen(lines)).toBe(true);
});

it("answers the current question in an OMP batch with the verified pointer walk", () => {
  const model = detectAskSelect(load("omp--v18-10-ask-batch.txt"));
  expect(model?.question).toBe("Where should the note go?");
  expect(model?.options.find((option) => option.label === "Below")).toMatchObject({
    description: "Place it below the example.",
    keys: ["Down", "Enter"],
  });
  const moved = detectAskSelect(load("omp--v18-10-ask-batch-moved.txt"));
  expect(moved?.options.find((option) => option.label === "Below")?.keys).toEqual(["Enter"]);
  expect(moved?.coreSignature).toBe(model?.coreSignature);
  expect(moved?.styledSignature).not.toBe(model?.styledSignature);
  expect(detectAskSelect(load("omp--v18-10-ask-batch-second.txt"))?.question)
    .toBe("Which alternative should we keep?");
});

it("shows every batch answer and submits the review with Enter alone", () => {
  const model = detectAskSelect(load("omp--v18-10-ask-batch-review.txt"));
  expect(model?.question).toContain("1. Location: Below");
  expect(model?.question).toContain("2. Alternative: Above");
  expect(model?.question).toContain("3. Confirm: Separate");
  expect(model?.options).toEqual([
    { label: "Submit", keys: ["Enter"], keyLabel: "⏎" },
    { label: "Cancel", keys: ["Escape"], keyLabel: "Esc" },
  ]);
});

it("expands truncated questions before offering answers, then preserves the full text", () => {
  const collapsed = detectAskSelect(load("omp--v18-10-ask-long.txt"));
  expect(collapsed?.options).toEqual([
    { label: "Expand", keys: ["ctrl+o"], keyLabel: "Ctrl+O" },
    { label: "Cancel", keys: ["Escape"], keyLabel: "Esc" },
  ]);
  const expanded = detectAskSelect(load("omp--v18-10-ask-long-expanded.txt"));
  expect(expanded?.question).toContain("Choose the placement that makes the review clearest.");
  expect(expanded?.options.find((option) => option.label === "Above")?.description)
    .toContain("ownership, review status, or publication date.");
  expect(expanded?.options.find((option) => option.label === "Below")?.keys).toEqual(["Down", "Enter"]);
  expect(ompModalOnScreen(load("omp--v18-10-ask-long.txt"))).toBe(true);
});

it("lets a revisited batch question replace its earlier answer", () => {
  const model = detectAskSelect(load("omp--v18-10-ask-revisited.txt"));
  expect(model?.options.find((option) => option.label === "Below")?.keys).toEqual(["Down", "Enter"]);
  expect(model?.options.find((option) => option.label === "Above")?.description)
    .toContain("ownership, review status, or publication date.");
});

it("refuses a stale tap when only the active question tab changes", () => {
  const lines = load("omp--v18-10-ask-batch.txt");
  const tabs = lines[1]!;
  const active = tabs.segments.find((segment) => segment.bg !== undefined && segment.bold)!;
  const changed = structuredClone(lines);
  for (const segment of changed[1]!.segments) {
    if (segment.text.trim() === "Location") {
      segment.bg = undefined;
      segment.bold = false;
    } else if (segment.text.trim() === "Alternative") {
      segment.bg = active.bg;
      segment.bold = true;
    }
  }
  const before = detectAskSelect(lines)!;
  const after = detectAskSelect(changed)!;
  expect(after.question).toBe(before.question);
  expect(after.signature).toBe(before.signature);
  expect(after.styledSignature).not.toBe(before.styledSignature);
  expect(promptsSameIdentity(before, after)).toBe(false);
  expect(promptsEqual(before, after)).toBe(false);
});

it("declines a batch without an unambiguous styled current tab", () => {
  const lines = load("omp--v18-10-ask-batch.txt");
  expect(detectAskSelect(lines)).not.toBeNull();
  expect(detectAskSelect(fromTexts(lines.map(lineText)))).toBeNull();
  const active = lines[1]!.segments.find((segment) => segment.bg !== undefined && segment.bold)!;
  const ambiguous = structuredClone(lines);
  for (const segment of ambiguous[1]!.segments) {
    if (segment.text.trim() === "Alternative") {
      segment.bg = active.bg;
      segment.bold = true;
    }
  }
  expect(detectAskSelect(ambiguous)).toBeNull();
});

it("never submits an incomplete review or a question with two saved single-choice answers", () => {
  const review = load("omp--v18-10-ask-batch-review.txt");
  expect(detectAskSelect(review)).not.toBeNull();
  expect(detectAskSelect(review.filter((line) => !lineText(line).includes("2. Alternative:")))).toBeNull();
  const revisited = load("omp--v18-10-ask-revisited.txt");
  expect(detectAskSelect(revisited)).not.toBeNull();
  const doubled = structuredClone(revisited);
  for (const line of doubled) {
    for (const segment of line.segments) segment.text = segment.text.replace("○", "◉");
  }
  expect(detectAskSelect(doubled)).toBeNull();
});

it("declines unknown controls after the current footer instead of guessing their meaning", () => {
  const lines = textsOf("omp--v18-10-ask-single.txt");
  expect(detectAskSelect(fromTexts(lines))).not.toBeNull();
  expect(detectAskSelect(fromTexts(lines.map((line) => line.replace("Alt+H hide", "Alt+H hide · x accept all")))))
    .toBeNull();
});

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

describe("the 18.8.0 dialog with option descriptions (#372) lifts, each description on its option", () => {
  const DESCRIBED = "omp--v18-8-ask-single-described.txt";
  // Staging's description wraps onto a second row at the same indent, six columns in.
  const STAGING =
    "Deploy to the staging cluster first, run the full smoke suite against it, wait for the error-budget " +
    "dashboard to stay green for an hour, and only then promote the same build to production with the existing " +
    "pipeline. This keeps the rollback path short and matches the last three releases.";

  it("the description rows leave the list of options alone and join into each option's description", () => {
    const model = detectAskSelect(load(DESCRIBED))!;
    expect(model.question).toBe("Which deploy target should the release use?");
    expect(model.options.map((o) => o.label)).toEqual(["Staging (Recommended)", "Production", "Skip", OTHER, "Cancel"]);
    expect(model.options.map((o) => o.keys)).toEqual([
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
      ["Down", "Down", "Down", "Enter"],
      ["Escape"],
    ]);
    expect(model.options.map((o) => o.keyLabel)).toEqual(["❯", "", "", "", "Esc"]);
    expect(model.options.map((o) => o.description)).toEqual([
      STAGING,
      "Ship straight to production.",
      "Do not deploy now.",
      undefined,
      undefined,
    ]);
  });

  it("a saved note's mark and the description both reach the card, the mark first as on screen", () => {
    const texts = textsOf(DESCRIBED);
    const noted = texts.map((t, i) => (i === 29 ? t.replace("○ Production        ", "○ Production  ✎ note") : t));
    const model = detectAskSelect(fromTexts(noted))!;
    expect(model.options[1]!.label).toBe("Production");
    expect(model.options[1]!.description).toBe("✎ note · Ship straight to production.");
  });
});

// omp 18.12.6 (omp-gang tester 04, case 9): the model gave each option a `preview`, drawn behind a rail under
// the description. The grammar declined every preview row, so the Surface read `unreadable` and a plain send
// was refused `unconfirmed`. Now the rows belong to their option, and the card shows them after `Preview:`.
describe("omp 18.12.6 Ask with option previews lifts, each preview on its option", () => {
  const PREVIEWED = "omp--v18-12-6-ask-previews--w120.txt";
  const texts = (): string[] => textsOf(PREVIEWED);
  const pad = (s: string) => `│${s.padEnd(118)}│`;
  const at = (needle: string): number => texts().findIndex((t) => t.includes(needle));

  it("the capture: three options with descriptions and previews, Other, and the walk to each", () => {
    const model = detectAskSelect(load(PREVIEWED))!;
    expect(model.question).toBe("Which of these would be most useful for your work right now?");
    expect(model.options.map((o) => o.label)).toEqual(["Code refactoring", "Bug investigation", "New feature development", OTHER, "Cancel"]);
    expect(model.options.map((o) => o.keys)).toEqual([
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
      ["Down", "Down", "Down", "Enter"],
      ["Escape"],
    ]);
    expect(model.options.map((o) => o.keyLabel)).toEqual(["❯", "", "", "", "Esc"]);
    expect(model.options.map((o) => o.description)).toEqual([
      "Improving structure and maintainability · Preview: Clean up technical debt",
      "Tracking down and fixing issues · Preview: Debug existing problems",
      "Building new capabilities · Preview: Implement fresh functionality",
      undefined,
      undefined,
    ]);
    // The echo block above the panel is no part of it: the card starts at the panel's title.
    const region = detectAskSelectRegion(load(PREVIEWED))!;
    expect(textsOf(PREVIEWED)[region.startLine]).toMatch(/^╭─ Ask ─+╮$/);
    expect(model.signature).not.toContain("Ask 1 questions");
  });

  it("omp's plan mode asks the same shape (\"Gather task for plan mode\", 14-turn-queue): four choices, Other, Cancel", () => {
    const plan = "omp--v18-12-6-ask-plan-mode--w120.txt";
    const model = detectAskSelect(load(plan))!;
    expect(model.question).toBe("What work should I plan?");
    expect(model.options.map((o) => o.label)).toEqual([
      "Feature or enhancement",
      "Bug fix or repair",
      "Refactor or cleanup",
      "Integration or migration",
      OTHER,
      "Cancel",
    ]);
    expect(model.options.map((o) => o.keys)).toEqual([["Enter"], ["Down", "Enter"], ["Down", "Down", "Enter"], ["Down", "Down", "Down", "Enter"], ["Down", "Down", "Down", "Down", "Enter"], ["Escape"]]);
    expect(model.options[1]!.description).toBe("Fix broken behavior or correct implementation · Preview: Describe the bug and expected behavior");
    // The echo block above the panel (`╭─── Ask 1 questions`, `[task] · options:4`) and the status row are outside it.
    expect(model.signature).not.toContain("options:4");
    expect(ompBuildBlocks(load(plan)).at(-1)!.kind).toBe("prompt-select");
  });

  it("the footer's Alt+H hide segment is accepted, and the pipeline lifts one prompt-select", () => {
    const blocks = ompBuildBlocks(load(PREVIEWED));
    expect(blocks.at(-1)!.kind).toBe("prompt-select");
    expect(blocks.filter((b) => b.kind !== "raw")).toHaveLength(1);
    expect(ompModalOnScreen(load(PREVIEWED))).toBe(true);
  });

  it("a pointer moved at the desk is another prompt: the race guard sees the pointer", () => {
    const moved = texts().map((t) => t.replace("│ ❯ ○ Code refactoring", "│   ○ Code refactoring").replace("│   ○ Bug investigation", "│ ❯ ○ Bug investigation"));
    const first = detectAskSelect(load(PREVIEWED))!;
    const after = detectAskSelect(fromTexts(moved))!;
    expect(after.options.map((o) => o.keys)).toEqual([["Up", "Enter"], ["Enter"], ["Down", "Enter"], ["Down", "Down", "Enter"], ["Escape"]]);
    expect(promptsEqual(first, after)).toBe(false);
    expect(first.coreSignature).toBe(after.coreSignature);
  });

  it("a multi-row preview with an empty row in it joins with breaks, and a saved note's mark leads", () => {
    const rows = texts();
    const first = at("Clean up technical debt");
    const more = [pad("       │ "), pad("       │ - keep the public API"), pad("       │ ")];
    const longer = [...rows.slice(0, first + 1), ...more, ...rows.slice(first + 1)];
    const model = detectAskSelect(fromTexts(longer))!;
    expect(model.options[0]!.description).toBe("Improving structure and maintainability · Preview: Clean up technical debt ↵  ↵ - keep the public API");
    const noted = rows.map((t) => t.replace("○ Bug investigation  ", "○ Bug investigation  ✎ note"));
    expect(detectAskSelect(fromTexts(noted))!.options[1]!.description).toBe("✎ note · Tracking down and fixing issues · Preview: Debug existing problems");
  });

  it("an option with a preview and no description shows the preview alone", () => {
    const rows = texts().filter((t) => !t.includes("Improving structure"));
    expect(detectAskSelect(fromTexts(rows))!.options[0]!.description).toBe("Preview: Clean up technical debt");
  });

  it("declines a preview under Other, under no option, after a description's successor, of blank rows only, or with a hidden character", () => {
    const rows = texts();
    const other = at("Other (type your own)");
    expect(detectAskSelect(fromTexts([...rows.slice(0, other + 1), pad("       │ a deep teal"), ...rows.slice(other + 1)]))).toBeNull();
    const body = at("Which of these");
    const divider = rows.findIndex((t, i) => i > body && /^├─+┤$/.test(t));
    expect(detectAskSelect(fromTexts([...rows.slice(0, divider + 1), pad("       │ before any option"), ...rows.slice(divider + 1)]))).toBeNull();
    const first = at("Clean up technical debt");
    expect(detectAskSelect(fromTexts([...rows.slice(0, first + 1), pad("       a description after the preview"), ...rows.slice(first + 1)]))).toBeNull();
    expect(detectAskSelect(fromTexts(rows.map((t, i) => (i === first ? pad("       │ ") : t))))).toBeNull();
    expect(detectAskSelect(fromTexts(rows.map((t, i) => (i === first ? pad("       │ Clean up \u202etechnical debt") : t))))).toBeNull();
  });

  it("a preview row that runs off the box with no right border still declines", () => {
    const rows = texts().map((t) => (t.includes("Clean up technical debt") ? t.replace(/\s*│$/, "") : t));
    // Text with no right border is read as a clipped row only by the description rule; for a preview the
    // right border is required, as for a description row.
    expect(detectAskSelect(fromTexts(rows))).toBeNull();
  });
});

describe("omp 18.12.6 free-text-only Ask (omp-gang 04-readers F3, 2026-10-26) lifts: `Other` alone, then Cancel", () => {
  const FREE = "omp--v18-12-6-ask-freetext--w120.txt";

  it("the question, the one `Other` row (a bare Enter opens the answer editor) and Cancel", () => {
    const model = detectAskSelect(load(FREE))!;
    expect(model.question).toBe("What feature or API should I plan?");
    expect(model.options).toEqual([
      { label: OTHER, keys: ["Enter"], keyLabel: "❯" },
      { label: "Cancel", keys: ["Escape"], keyLabel: "Esc" },
    ]);
    expect(model.family).toBe("select");
    expect(ompBuildBlocks(load(FREE)).at(-1)!.kind).toBe("prompt-select");
  });

  it("the card starts at the panel's title, not at the echo block above it", () => {
    const region = detectAskSelectRegion(load(FREE))!;
    expect(textsOf(FREE)[region.startLine]).toMatch(/^╭─ Ask ─+╮$/);
    expect(region.model.signature).not.toContain("Ask 1 questions");
  });

  it("a lone row that is not `Other`, and an `Other` row with no pointer, decline", () => {
    const rows = textsOf(FREE);
    expect(detectAskSelect(fromTexts(rows.map((t) => t.replace("Other (type your own)", "Something else"))))).toBeNull();
    expect(detectAskSelect(fromTexts(rows.map((t) => t.replace("│ ❯ ○", "│   ○"))))).toBeNull();
  });

  it("no row at all declines", () => {
    const rows = textsOf(FREE);
    expect(detectAskSelect(fromTexts(rows.filter((t) => !t.includes("Other (type your own)"))))).toBeNull();
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
    "omp--v18-8-ask-single-described-moved.txt",
    "omp--v18-8-ask-single-described.txt",
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

  it("with descriptions on screen, the core signature blanks the pointed option's own row", () => {
    // Description rows push every option below them down, so the pointed row is counted in body rows:
    // counted in options, the moved capture's blank lands on Staging's description, not on Production.
    const first = detectAskSelect(load("omp--v18-8-ask-single-described.txt"))!;
    const moved = detectAskSelect(load("omp--v18-8-ask-single-described-moved.txt"))!;
    expect(moved.signature).not.toBe(first.signature);
    expect(first.coreSignature).toBe(moved.coreSignature);
    expect(moved.coreSignature).not.toContain("❯");
    // Every description row stays in the core: a description changed under the tap is not the same prompt.
    const texts = textsOf("omp--v18-8-ask-single-described.txt");
    const edited = texts.map((t, i) => (i === 30 ? t.replace("Ship straight", "Ship directly") : t));
    expect(detectAskSelect(fromTexts(edited))!.coreSignature).not.toBe(detectAskSelect(fromTexts(texts))!.coreSignature);
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

  it("with an uncaptured tab footer and no styled tab strip", () => {
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

  it("with a row the body does not know: a wrapped label, a row below the padding", () => {
    const insert = (at: number, row: string) => [...single.slice(0, at), row, ...single.slice(at + 1)];
    const pad = (s: string) => `│${s.padEnd(single[201]!.length - 2)}│`;
    // A wrapped label's continuation (four columns in).
    expect(detectAskSelect(fromTexts(insert(202, pad("     continued label"))))).toBeNull();
    // Text below a blank padding row, as an option or as a description.
    expect(detectAskSelect(fromTexts(insert(206, pad("   ○ Purple"))))).toBeNull();
    expect(detectAskSelect(fromTexts(insert(206, pad("       the colour of warnings"))))).toBeNull();
  });

  it("with a description-shaped row under no option, under `Other`, off its indent, or led by an option's glyph", () => {
    const described = textsOf("omp--v18-8-ask-single-described.txt");
    expect(detectAskSelect(fromTexts(described))).not.toBeNull();
    const pad = (s: string) => `│${s.padEnd(described[26]!.length - 2)}│`;
    // Staging's option row swapped below its two description rows, which then open the body.
    const orphaned = described.map((t, i) => (i === 26 ? described[28]! : i === 28 ? described[26]! : t));
    expect(detectAskSelect(fromTexts(orphaned))).toBeNull();
    // omp prints a row at this indent under `Other` only for an answer typed earlier, which is not a
    // description.
    const underOther = [...described.slice(0, 34), pad("       a deep teal"), ...described.slice(34)];
    expect(detectAskSelect(fromTexts(underOther))).toBeNull();
    for (const indent of ["      ", "        "]) {
      const shifted = described.map((t, i) => (i === 30 ? pad(`${indent}Ship straight to production.`) : t));
      expect(detectAskSelect(fromTexts(shifted)), `${indent.length} spaces in`).toBeNull();
    }
    // A row at this indent that opens with the radio or the pointer has an option row's glyphs.
    for (const glyph of ["○", "❯"]) {
      const led = described.map((t, i) => (i === 30 ? pad(`       ${glyph} Ship straight to production.`) : t));
      expect(detectAskSelect(fromTexts(led)), `led by ${glyph}`).toBeNull();
    }
  });

  it("with glyphs and a rail inside a description row, the description stays on the option above and the pointer stays put", () => {
    const described = textsOf("omp--v18-8-ask-single-described.txt");
    const base = detectAskSelect(fromTexts(described))!;
    const pad = (s: string) => `│${s.padEnd(described[26]!.length - 2)}│`;
    // Row 30 is Production's description. Each case edits that row alone, then compares to the capture.
    const edit = (text: string) => described.map((t, i) => (i === 30 ? pad(`       ${text}`) : t));
    const cases: Array<[string, string]> = [
      ["a pointer glyph past the first column", "Ship ❯ straight to production."],
      ["a radio glyph past the first column", "Ship ○ straight to production."],
      ["another option's label as its whole text", "Skip"],
      ["a rail in the middle", "Ship straight │ to production."],
      ["omp's own Other label as its whole text", OTHER],
    ];
    for (const [name, text] of cases) {
      // Today every case lifts. Declining would also be safe, but that must be a decision, not a drift.
      const model = detectAskSelect(fromTexts(edit(text)))!;
      expect(model, name).not.toBeNull();
      expect(model.options.map((o) => o.label), name).toEqual(base.options.map((o) => o.label));
      expect(model.options.map((o) => o.keyLabel), name).toEqual(base.options.map((o) => o.keyLabel));
      expect(model.options.map((o) => o.keys), name).toEqual(base.options.map((o) => o.keys));
      expect(model.options.map((o) => o.description), name).toEqual(
        base.options.map((o) => (o.label === "Production" ? text : o.description)),
      );
      // Only the pointed row's own pointer is blanked: the description's glyph stays in the core.
      const count = (x: string) => x.split("❯").length - 1;
      expect(count(model.signature) - count(model.coreSignature), name).toBe(1);
    }
  });

  it("with descriptions on screen, a moved pointer AND a changed label still moves the core signature", () => {
    const first = detectAskSelect(load("omp--v18-8-ask-single-described.txt"))!;
    const moved = textsOf("omp--v18-8-ask-single-described-moved.txt");
    // Control: the pointer alone is ignored.
    expect(detectAskSelect(fromTexts(moved))!.coreSignature).toBe(first.coreSignature);
    const relabelled = moved.map((t) => t.replace("○ Skip", "○ Skim"));
    const after = detectAskSelect(fromTexts(relabelled))!;
    expect(after.options.map((o) => o.label)).toContain("Skim");
    expect(after.coreSignature).not.toBe(first.coreSignature);
  });

  it("when `Other` is not the last row, is missing, or is listed twice", () => {
    const moved = single.map((t, i) => (i === 203 ? single[204]! : i === 204 ? single[203]! : t));
    expect(detectAskSelect(fromTexts(moved))).toBeNull();
    expect(detectAskSelect(fromTexts(single.map((t) => t.replace(OTHER, "Something else       "))))).toBeNull();
    const twice = single.map((t, i) => (i === 203 ? single[204]! : t));
    expect(detectAskSelect(fromTexts(twice))).toBeNull();
  });

  it("with `Other` as the only row: omp 18.12.6 draws a free-text question so, and it lifts (see the free-text describe)", () => {
    const only = [...single.slice(0, 201), single[204]!, ...single.slice(205)].map((t, i) =>
      i === 201 ? t.replace("│   ○", "│ ❯ ○") : t,
    );
    expect(detectAskSelect(fromTexts(only))?.options.map((o) => o.label)).toEqual([OTHER, "Cancel"]);
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
    "omp--v18-8-ask-single-described-moved.txt",
    "omp--v18-8-ask-single-described.txt",
    "omp--v18-12-6-ask-previews--w120.txt",
    "omp--v18-12-6-ask-plan-mode--w120.txt",
    "omp--v18-12-6-ask-freetext--w120.txt",
    "omp--v18-10-ask-single.txt",
    "omp--v18-10-ask-batch.txt",
    "omp--v18-10-ask-batch-moved.txt",
    "omp--v18-10-ask-batch-second.txt",
    "omp--v18-10-ask-batch-third.txt",
    "omp--v18-10-ask-batch-review.txt",
    "omp--v18-10-ask-long.txt",
    "omp--v18-10-ask-long-expanded.txt",
    "omp--v18-10-ask-revisited.txt",
  ]);

  it("lifts only the supported Ask states in the complete corpus", () => {
    const all = readdirSync(PANES_DIR).filter((f) => f.endsWith(".txt"));
    expect(all.length).toBeGreaterThan(300);
    const lifted = all.filter((name) => detectAskSelect(load(name)) !== null);
    expect(lifted.toSorted()).toEqual([...CLAIMED].toSorted());
  });
});
