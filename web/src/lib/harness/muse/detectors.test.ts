import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { detectApproval } from "./approval";
import { detectCheckbox } from "./checkbox";
import { detectQuestion } from "./question";
import { detectTrust } from "./trust";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

function lines(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

describe("detector disjointness — each dialog lifts under exactly one grammar", () => {
  const cases: [string, "approval" | "question" | "checkbox" | "trust"][] = [
    ["muse--approval-ls.txt", "approval"],
    ["muse--approval-ls-moved.txt", "approval"],
    ["muse--ask-color.txt", "question"],
    ["muse--ask-color-moved.txt", "question"],
    ["muse--ask-toppings.txt", "checkbox"],
    ["muse--ask-toppings-checked.txt", "checkbox"],
    ["muse--ask-toppings-review.txt", "checkbox"],
    ["muse--ask-drinks.txt", "checkbox"],
    ["muse--trust-prompt.txt", "trust"],
  ];
  it.each(cases)("%s lifts only as %s", (name, kind) => {
    const ls = lines(name);
    expect(detectApproval(ls) !== null, "approval").toBe(kind === "approval");
    expect(detectQuestion(ls) !== null, "question").toBe(kind === "question");
    expect(detectCheckbox(ls) !== null, "checkbox").toBe(kind === "checkbox");
    expect(detectTrust(ls) !== null, "trust").toBe(kind === "trust");
  });

  it("neutral captures lift under no grammar", () => {
    for (const name of [
      "muse--fresh-idle.txt",
      "muse--draft-single.txt",
      "muse--draft-wrapped.txt",
      "muse--draft-paste-token.txt",
      "muse--working.txt",
      "muse--done.txt",
      "muse--ask-color-notes-open.txt",
      "muse--ask-color-notes-typed.txt",
      "muse--ask-toppings-notes-open.txt",
    ]) {
      const ls = lines(name);
      expect(detectApproval(ls), `${name}/approval`).toBeNull();
      expect(detectQuestion(ls), `${name}/question`).toBeNull();
      expect(detectCheckbox(ls), `${name}/checkbox`).toBeNull();
      expect(detectTrust(ls), `${name}/trust`).toBeNull();
    }
  });

  it("declines garbage, blanks, and torn tails", () => {
    for (const text of ["", "\n\n", "❯ half a box with no rule", "1. not a menu\n2. no footer\n"]) {
      const ls = splitLines(parseAnsi(text));
      expect(detectApproval(ls)).toBeNull();
      expect(detectQuestion(ls)).toBeNull();
      expect(detectCheckbox(ls)).toBeNull();
      expect(detectTrust(ls)).toBeNull();
    }
  });
});

describe("moved twins — the pointer moves the signature, not the identity", () => {
  it("approval: same options, signature moves, core stable", () => {
    const a = detectApproval(lines("muse--approval-ls.txt"))!;
    const b = detectApproval(lines("muse--approval-ls-moved.txt"))!;
    expect(a.options).toEqual(b.options);
    expect(a.signature).not.toBe(b.signature);
    expect(a.coreSignature).toBe(b.coreSignature);
  });

  it("question: same options, signature moves, core stable", () => {
    const a = detectQuestion(lines("muse--ask-color.txt"))!;
    const b = detectQuestion(lines("muse--ask-color-moved.txt"))!;
    expect(a.options.map((o) => o.label)).toEqual(b.options.map((o) => o.label));
    expect(a.signature).not.toBe(b.signature);
    expect(a.coreSignature).toBe(b.coreSignature);
  });

  it("checkbox flip: signature stable (glyphs normalised), options carry the state", () => {
    const a = detectCheckbox(lines("muse--ask-toppings.txt"))!;
    const b = detectCheckbox(lines("muse--ask-toppings-checked.txt"))!;
    expect(a.phase).toBe("checkbox");
    expect(b.phase).toBe("checkbox");
    if (a.phase !== "checkbox" || b.phase !== "checkbox") return;
    expect(a.signature).toBe(b.signature);
    expect(a.options.map((o) => o.checked)).toEqual([false, false, false, false]);
    expect(b.options.map((o) => o.checked)).toEqual([false, true, false, false]);
  });
});

describe("checkbox region span — through the static footer", () => {
  it("ends at the footer, not the Submit row (the bridge only binds inside its tail window)", () => {
    // Live 409 regression: ending at Submit stranded 6 rows below the match (2 footer + Voice +
    // ❯ + rule + statusline) and every first write came back `not_in_tail`.
    const m = detectCheckbox(lines("muse--ask-toppings.txt"))!;
    expect(m.phase).toBe("checkbox");
    if (m.phase !== "checkbox") return;
    const regionRows = m.regionSignature.split("\n");
    expect(regionRows.at(-2)).toMatch(/^  Enter to toggle/);
    expect(regionRows.at(-1)).toBe("  interrupt");
    // The identity half spans the same rows, pointer + flips normalised out.
    expect(m.signature.split("\n").length).toBe(regionRows.length);
  });
});

describe("checkbox pointer reporting", () => {
  it("reports advance on the Submit row via a synthetic move", () => {
    const raw = readFileSync(join(PANES_DIR, "muse--ask-toppings.txt"), "utf8");
    // Move the › from row 1 to the Submit row (plain-text surgery on the parsed shape).
    const moved = raw.replace("› 1. [ ]", "  1. [ ]").replace("  5. Submit answer", "› 5. Submit answer");
    expect(moved).not.toBe(raw);
    const m = detectCheckbox(splitLines(parseAnsi(moved)));
    expect(m?.phase).toBe("checkbox");
    if (m?.phase !== "checkbox") return;
    expect(m.pointer).toBe("advance");
    expect(m.pointerRow).toBeNull();
  });

  it("reports the pointed option row", () => {
    const m = detectCheckbox(lines("muse--ask-toppings.txt"))!;
    expect(m.phase).toBe("checkbox");
    if (m.phase !== "checkbox") return;
    expect(m.pointer).toBe("option");
    expect(m.pointerRow).toBe(1);
  });
});

describe("review pointer reporting", () => {
  it("reports cancel via a synthetic move", () => {
    const raw = readFileSync(join(PANES_DIR, "muse--ask-toppings-review.txt"), "utf8");
    const moved = raw
      .replace("> Submit answers", "  Submit answers")
      .replace("  Interrupt turn", "> Interrupt turn");
    expect(moved).not.toBe(raw);
    const m = detectCheckbox(splitLines(parseAnsi(moved)));
    expect(m?.phase).toBe("review");
    if (m?.phase !== "review") return;
    expect(m.pointer).toBe("cancel");
  });
});
