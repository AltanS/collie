// omp's plan review (omp/plan-review.ts), against omp 18.16.0 captures from 2026-11-07 (Herdr 0.9.5,
// `herdr pane read --source recent --format ansi`, a scratch repo under ~/.cache/collie-lab, Claude Haiku
// 5.5 over OpenRouter). Before this grammar the screen stayed raw and drew the unread-dialog card, the
// likeliest source of the omp@18.16.0 rows in the trouble tally of 2026-11-07
// (experiments/trouble-dialogs/CONTEXT.md in the workspace).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { buildBlocks } from "../index";
import { promptsEqual, promptsSameIdentity, type PromptModel } from "../prompt-model";
import { ompAdapter } from "./index";
import { ompModalOnScreen } from "./modal";
import { detectPlanReview, detectPlanReviewRegion } from "./plan-review";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

const load = (name: string): StyledLine[] =>
  splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
const textsOf = (name: string): string[] => load(name).map(lineText);
const fromTexts = (texts: string[]): StyledLine[] => splitLines(parseAnsi(texts.join("\n")));

const PLAIN = "omp--v18-16-0-plan-review--w80.txt";
const MOVED = "omp--v18-16-0-plan-review-moved--w80.txt";
const CONTENTS = "omp--v18-16-0-plan-review-contents--w140.txt";
const SLIDER = "omp--v18-16-0-plan-review-slider--w140.txt";
const SLIDER_MOVED = "omp--v18-16-0-plan-review-slider-moved--w140.txt";
const REGIONS = "omp--v18-16-0-plan-review-regions--w80.txt";
const CLIPPED = "omp--v18-16-0-plan-review-slider-clipped--w80.txt";

const LIFTED = [PLAIN, MOVED, CONTENTS, SLIDER, SLIDER_MOVED];

const LABELS = [
  /^Approve and execute$/,
  /^Approve and compact context$/,
  /^Approve and keep context \(~\d+k \/ 100k\)$/,
  /^Refine plan$/,
  /^Save and quit$/,
  /^Cancel$/,
];

/** The row index of the first text matching `pattern`. */
const rowOf = (texts: string[], pattern: RegExp): number => texts.findIndex((t) => pattern.test(t));

describe("omp 18.16.0 plan review: the phone no longer shows the unread-dialog card", () => {
  // The regression this grammar answers: every capture below drew `unread-dialog` before it.
  it.each(LIFTED)("%s builds a prompt-select, not the unread-dialog card", (name) => {
    const lines = load(name);
    // The card's own gates still hold on this screen: no composer, and a modal naming its way out.
    expect(ompAdapter.composerReady!(lines)).toBe(false);
    expect(ompModalOnScreen(lines)).toBe(true);
    const kinds = buildBlocks(lines, { agent: "omp" }).map((b) => b.kind);
    expect(kinds).not.toContain("unread-dialog");
    expect(kinds).toEqual(["raw", "prompt-select"]);
  });

  it.each([REGIONS, CLIPPED])("%s declines, and names no way out, so it draws no card either", (name) => {
    const lines = load(name);
    expect(detectPlanReview(lines)).toBeNull();
    expect(buildBlocks(lines, { agent: "omp" }).map((b) => b.kind)).toEqual(["raw"]);
  });
});

describe("the plan review model", () => {
  it("offers omp's five options in order, then Cancel, under the plan family", () => {
    for (const name of LIFTED) {
      const model = detectPlanReview(load(name))!;
      expect(model.family, name).toBe("plan");
      expect(model.options).toHaveLength(LABELS.length);
      model.options.forEach((option, i) => expect(option.label, name).toMatch(LABELS[i]!));
    }
  });

  it("walks from the pointed row with the arrows the footer names, then Enter; Cancel is Escape", () => {
    const plain = detectPlanReview(load(PLAIN))!;
    expect(plain.options.map((o) => o.keys)).toEqual([
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
      ["Down", "Down", "Down", "Enter"],
      ["Down", "Down", "Down", "Down", "Enter"],
      ["Escape"],
    ]);
    expect(plain.options.map((o) => o.keyLabel)).toEqual(["❯", "", "", "", "", "Esc"]);

    const moved = detectPlanReview(load(SLIDER_MOVED))!;
    expect(moved.options.map((o) => o.keys)).toEqual([
      ["Up", "Up", "Enter"],
      ["Up", "Enter"],
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
      ["Escape"],
    ]);
  });

  it("starts the card at the prompt title, so the plan body stays in the raw mirror", () => {
    for (const name of LIFTED) {
      const texts = textsOf(name);
      const region = detectPlanReviewRegion(load(name))!;
      expect(texts[region.startLine], name).toMatch(/^│ Plan mode - next step\s*│$/);
      const raw = buildBlocks(load(name), { agent: "omp" })[0]!;
      expect(raw.lines.map(lineText)[0], name).toMatch(/^╭─ Plan Review ─/);
    }
  });

  it("names the slider's tier and its model in the question, and only when the slider is up", () => {
    expect(detectPlanReview(load(SLIDER))!.question).toBe(
      "Plan mode - next step\ncontinue with: default · Claude Haiku 5.5",
    );
    expect(detectPlanReview(load(PLAIN))!.question).toBe("Plan mode - next step");
    expect(detectPlanReview(load(CONTENTS))!.question).toBe("Plan mode - next step");
  });

  it("keeps its identity across a walk: the core signature blanks the pointer and nothing else", () => {
    for (const [a, b] of [
      [PLAIN, MOVED],
      [SLIDER, SLIDER_MOVED],
    ] as const) {
      const x = detectPlanReview(load(a))!;
      const y = detectPlanReview(load(b))!;
      expect(promptsSameIdentity(x, y), `${a} vs ${b}`).toBe(true);
      expect(promptsEqual(x, y), `${a} vs ${b}`).toBe(false);
      expect(x.coreSignature).toBe(y.coreSignature);
      expect(x.signature).not.toBe(y.signature);
    }
  });
});

describe("the plan review declines what it was not built against", () => {
  const base = textsOf(PLAIN);
  const footerAt = rowOf(base, /↑\/↓ select/);
  const keepAt = rowOf(base, /Approve and keep context/);
  const pointedAt = rowOf(base, /│ ❯ Approve and execute/);
  const titleAt = rowOf(base, /Plan mode - next step/);
  const topAt = rowOf(base, /^╭─ Plan Review/);
  const edit = (at: number, from: string | RegExp, to: string): PromptModel | null =>
    detectPlanReview(fromTexts(base.map((t, i) => (i === at ? t.replace(from, to) : t))));

  it("reads the untouched capture (the perturbations below start from a lift)", () => {
    expect(detectPlanReview(fromTexts(base))).not.toBeNull();
  });

  it("declines when omp may have disabled the keep-context row (90 percent and up)", () => {
    // omp disables the row above 95 percent, and the arrows then skip it, so the walk count is wrong.
    expect(edit(keepAt, /\(~\d+k \/ 100k\)/, "(~96k / 100k)")).toBeNull();
    expect(edit(keepAt, /\(~\d+k \/ 100k\)/, "(~90k / 100k)")).toBeNull();
    expect(edit(keepAt, /\(~\d+k \/ 100k\)/, "(~89k / 100k)")).not.toBeNull();
    // No numbers: omp had no usage to print and never disables the row then.
    expect(edit(keepAt, / \(~\d+k \/ 100k\)/, "")).not.toBeNull();
  });

  it("declines a second pointer, no pointer, a hovered row and an unknown option", () => {
    expect(edit(keepAt, "│   Approve", "│ ❯ Approve")).toBeNull();
    expect(edit(pointedAt, "│ ❯ ", "│   ")).toBeNull();
    expect(edit(keepAt, "│   Approve", "│    Approve")).toBeNull();
    expect(edit(keepAt, "Approve and keep context", "Approve and run tests")).toBeNull();
  });

  it("declines a footer that is not the options-focused one", () => {
    expect(edit(footerAt, " · ⎋ cancel", " · ⎋ close")).toBeNull();
    expect(edit(footerAt, "⏎ confirm · ", "")).toBeNull();
    // `←/→ model` without the slider rows above the options.
    expect(edit(footerAt, "⏎ confirm · ", "⏎ confirm · ←/→ model · ")).toBeNull();
  });

  it("declines without its title or its top border", () => {
    expect(edit(titleAt, "Plan mode - next step", "Plan mode - next")).toBeNull();
    expect(edit(topAt, "Plan Review", "Plan Revue")).toBeNull();
  });
});

// omp 18.18.0 under `symbolPreset: nerd` (2026-11-08, omp/keycaps.ts): the footer keycaps, the pointer and
// the slider's active marks are the preset's glyphs; every other row is the `unicode` one.
describe("omp 18.18.0 plan review under the `nerd` preset", () => {
  const NERD = "omp--v18-18-0-nerd-plan-review--w250.txt";
  const NERD_MOVED = "omp--v18-18-0-nerd-plan-review-moved--w250.txt";
  const nerd = textsOf(NERD);
  const footerAt = rowOf(nerd, /↑\/↓ select/);
  const trackAt = rowOf(nerd, /continue with/);
  const pointedAt = rowOf(nerd, /│ \u{F054} Approve and execute/u);
  const edit = (at: number, from: string, to: string): PromptModel | null =>
    detectPlanReview(fromTexts(nerd.map((t, i) => (i === at ? t.replaceAll(from, to) : t))));

  it.each([NERD, NERD_MOVED])("%s builds a prompt-select, not the unread-dialog card", (name) => {
    const kinds = buildBlocks(load(name), { agent: "omp" }).map((b) => b.kind);
    expect(kinds).toEqual(["raw", "prompt-select"]);
  });

  it("offers the five options and Cancel, the `❯` badge, and the slider's tier in the question", () => {
    const model = detectPlanReview(load(NERD))!;
    model.options.forEach((option, i) => expect(option.label).toMatch(LABELS[i]!));
    expect(model.options.map((o) => o.keyLabel)).toEqual(["❯", "", "", "", "", "Esc"]);
    expect(model.question).toBe("Plan mode - next step\ncontinue with: default · Claude Haiku 5.5");
  });

  it("keeps its identity across a walk: the core signature blanks the chevron and nothing else", () => {
    const x = detectPlanReview(load(NERD))!;
    const y = detectPlanReview(load(NERD_MOVED))!;
    expect(y.options.map((o) => o.keys)).toEqual([
      ["Up", "Enter"],
      ["Enter"],
      ["Down", "Enter"],
      ["Down", "Down", "Enter"],
      ["Down", "Down", "Down", "Enter"],
      ["Escape"],
    ]);
    expect(promptsSameIdentity(x, y)).toBe(true);
    expect(x.coreSignature).toBe(y.coreSignature);
    expect(x.signature).not.toBe(y.signature);
  });

  it("reads the untouched capture (the controls below start from a lift)", () => {
    expect(detectPlanReview(fromTexts(nerd))).not.toBeNull();
  });

  it.each([
    ["the unicode confirm keycap in the nerd footer", footerAt, "\u{F0311}", "⏎"],
    ["the unicode regions keycap in the nerd footer", footerAt, "\u{F0312}", "⇥"],
    ["the unicode cancel keycap in the nerd footer", footerAt, "\u{F12B7}", "⎋"],
    ["the unicode pointer under the nerd footer", pointedAt, "\u{F054}", "❯"],
    ["the unicode slider marks under the nerd footer", trackAt, "\u{E0B2}", "◀"],
  ])("%s declines: a screen omp never draws", (_name, at, from, to) => {
    expect(edit(at, from, to)).toBeNull();
  });
});
