import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import {
  detectTabs,
  detectTabsRegion,
} from "./tabs";
import {
  wizardsEqual,
  WIZARD_BACK_KEYS,
  WIZARD_CANCEL_KEYS,
  WIZARD_NEXT_KEYS,
  WIZARD_SUBMIT_KEYS,
} from "../wizard-model";

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

function loadLines(name: string): StyledLine[] {
  const content = readFileSync(join(PANES_DIR, name), "utf8");
  return splitLines(parseAnsi(content));
}

// ---------------------------------------------------------------------------------------------
// 1. Questionnaire Single-Select Question Page
// ---------------------------------------------------------------------------------------------

describe("tabs.ts — questionnaire single-select question page", () => {
  it("lifts plain questionnaire question page (pi--v110-tabs-single.txt)", () => {
    const lines = loadLines("pi--v110-tabs-single.txt");
    const region = detectTabsRegion(lines);
    expect(region).not.toBeNull();
    expect(region!.startLine).toBe(0);

    const model = region!.model;
    expect(model.phase).toBe("question");
    if (model.phase !== "question") return;

    expect(model.question).toBe("Choose an authentication method:");
    expect(model.steps).toHaveLength(3);
    expect(model.steps[0]).toEqual({
      label: "Auth",
      answered: false,
      current: true,
    });
    expect(model.steps[1]).toEqual({
      label: "Features",
      answered: false,
      current: false,
    });
    expect(model.steps[2]).toEqual({
      label: "Deploy",
      answered: false,
      current: false,
    });

    expect(model.options).toHaveLength(3);
    expect(model.options[0]).toEqual({
      label: "OAuth 2.0 / OIDC",
      description: "Standard token-based auth",
      keys: ["1", "Enter"],
      chosen: false,
      escape: false,
    });
    expect(model.options[1]).toEqual({
      label: "Session cookies",
      description: "Server-side stateful sessions",
      keys: ["2", "Enter"],
      chosen: false,
      escape: false,
    });
    expect(model.options[2]).toEqual({
      label: "API keys",
      description: "Simple pre-shared credentials",
      keys: ["3", "Enter"],
      chosen: false,
      escape: false,
    });

    // "Type something." is omitted from options
    expect(model.options.some((o) => o.label.includes("Type something"))).toBe(false);
  });

  it("lifts recorded answer question page with chosen ' ✓' (pi--v110-tabs-single-recorded.txt)", () => {
    const lines = loadLines("pi--v110-tabs-single-recorded.txt");
    const model = detectTabs(lines)!;
    expect(model).not.toBeNull();
    expect(model.phase).toBe("question");
    if (model.phase !== "question") return;

    // Step 0 is marked answered (▣) in the tab bar
    expect(model.steps[0]).toEqual({
      label: "Auth",
      answered: true,
      current: true,
    });
    expect(model.steps[1]!.answered).toBe(false);

    // Option 1 has trailing ' ✓', parsed as chosen: true with clean label
    expect(model.options[0]).toEqual({
      label: "OAuth 2.0 / OIDC",
      description: "Standard token-based auth",
      keys: ["1", "Enter"],
      chosen: true,
      escape: false,
    });
    expect(model.options[1]!.chosen).toBe(false);
    expect(model.options[2]!.chosen).toBe(false);
  });

  it("lifts compact tab bar question page (pi--v110-tabs-compact.txt)", () => {
    const lines = loadLines("pi--v110-tabs-compact.txt");
    const model = detectTabs(lines)!;
    expect(model).not.toBeNull();
    expect(model.phase).toBe("question");
    if (model.phase !== "question") return;

    expect(model.question).toBe("Choose auth:");
    expect(model.steps).toHaveLength(9);
    for (let i = 0; i < 9; i++) {
      expect(model.steps[i]).toEqual({
        label: String(i + 1),
        answered: false,
        current: i === 0,
      });
    }

    expect(model.options).toHaveLength(2);
    expect(model.options[0]).toEqual({
      label: "OAuth",
      keys: ["1", "Enter"],
      chosen: false,
      escape: false,
    });
    expect(model.options[1]).toEqual({
      label: "Keys",
      keys: ["2", "Enter"],
      chosen: false,
      escape: false,
    });
  });

  it("exports wizard navigation key constants", () => {
    expect(WIZARD_BACK_KEYS).toEqual(["Left"]);
    expect(WIZARD_NEXT_KEYS).toEqual(["Right"]);
    expect(WIZARD_SUBMIT_KEYS).toEqual(["1"]);
    expect(WIZARD_CANCEL_KEYS).toEqual(["2"]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Questionnaire Review Phase
// ---------------------------------------------------------------------------------------------

describe("tabs.ts — questionnaire review phase", () => {
  it("lifts complete review page (pi--v110-review-complete.txt)", () => {
    const lines = loadLines("pi--v110-review-complete.txt");
    const region = detectTabsRegion(lines);
    expect(region).not.toBeNull();
    expect(region!.startLine).toBe(0);

    const model = region!.model;
    expect(model.phase).toBe("review");
    if (model.phase !== "review") return;

    // All steps are answered, none is current (highlight sits on Review chip)
    expect(model.steps).toHaveLength(3);
    expect(model.steps.every((s) => s.answered)).toBe(true);
    expect(model.steps.every((s) => !s.current)).toBe(true);

    // Answers from 'N. header  answer' rows
    expect(model.answers).toEqual([
      { question: "Auth", answer: "OAuth 2.0 / OIDC" },
      { question: "Features", answer: "Audit logs" },
      { question: "Deploy", answer: "Cloudflare Workers" },
    ]);

    expect(model.incomplete).toBe(false);
    expect(model.submitKeys).toEqual(["Enter"]);
    expect(model.submitAction).toBe("submit");
    expect(model.submitLabel).toBeUndefined();
    expect(model.cancelKeys).toEqual(["Escape"]);
  });

  it("lifts incomplete review page and keeps Submit plan (pi--v110-review-incomplete.txt)", () => {
    const lines = loadLines("pi--v110-review-incomplete.txt");
    const model = detectTabs(lines)!;
    expect(model).not.toBeNull();
    expect(model.phase).toBe("review");
    if (model.phase !== "review") return;

    expect(model.steps[0]).toEqual({
      label: "Auth",
      answered: true,
      current: false,
    });
    expect(model.steps[1]).toEqual({
      label: "Features",
      answered: false,
      current: false,
    });
    expect(model.steps[2]).toEqual({
      label: "Deploy",
      answered: false,
      current: false,
    });

    expect(model.answers).toEqual([
      { question: "Auth", answer: "OAuth 2.0 / OIDC" },
      { question: "Features", answer: "— not answered" },
      { question: "Deploy", answer: "— not answered" },
    ]);

    // An incomplete Review keeps Submit, which sends Enter: pi jumps to the first unanswered tab.
    expect(model.incomplete).toBe(true);
    expect(model.submitKeys).toEqual(["Enter"]);
    expect(model.submitAction).toBe("goToFirstUnanswered");
    expect(model.cancelKeys).toEqual(["Escape"]);
  });

  it("lifts synthetic compact review with 9 items", () => {
    const rule = "\u001b[38;2;235;203;139m────────────────────────────────────────────────────────────────────────\u001b[0m";
    // Tab bar with 9 compact chips (all answered) and Review chip active
    const bar = "  \u001b[38;2;79;79;79m←\u001b[0m  ▣  1   ▣  2   ▣  3   ▣  4   ▣  5   ▣  6   ▣  7   ▣  8   ▣  9   \u001b[48;2;29;29;29m ✓ \u001b[0m  \u001b[38;2;79;79;79m→\u001b[0m";
    const answerRows = Array.from({ length: 9 }, (_, i) => `  ${i + 1}. Item${i + 1}       Answer for item ${i + 1}`);
    const raw = [
      rule,
      bar,
      "",
      "  Review your answers",
      "",
      ...answerRows,
      "",
      "  ✓ All answered — Enter to submit",
      "",
      "  ←→ tabs • Enter submit • Esc cancel",
      rule,
      "⎇ main",
    ].join("\n");

    const lines = splitLines(parseAnsi(raw));
    const model = detectTabs(lines)!;
    expect(model).not.toBeNull();
    expect(model.phase).toBe("review");
    if (model.phase !== "review") return;

    expect(model.steps).toHaveLength(9);
    expect(model.answers).toHaveLength(9);
    expect(model.answers[0]).toEqual({ question: "Item1", answer: "Answer for item 1" });
    expect(model.answers[8]).toEqual({ question: "Item9", answer: "Answer for item 9" });
    expect(model.incomplete).toBe(false);
    expect(model.submitKeys).toEqual(["Enter"]);
    expect(model.cancelKeys).toEqual(["Escape"]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Contract & Identity (wizardsEqual)
// ---------------------------------------------------------------------------------------------

describe("tabs.ts — wizardsEqual contract", () => {
  it("identical derivations are equal", () => {
    const a = detectTabs(loadLines("pi--v110-tabs-single.txt"))!;
    const b = detectTabs(loadLines("pi--v110-tabs-single.txt"))!;
    expect(wizardsEqual(a, b)).toBe(true);

    const revA = detectTabs(loadLines("pi--v110-review-complete.txt"))!;
    const revB = detectTabs(loadLines("pi--v110-review-complete.txt"))!;
    expect(wizardsEqual(revA, revB)).toBe(true);
  });

  it("fresh vs recorded question differs (step answered and chosen mark changed)", () => {
    const fresh = detectTabs(loadLines("pi--v110-tabs-single.txt"))!;
    const recorded = detectTabs(loadLines("pi--v110-tabs-single-recorded.txt"))!;
    expect(wizardsEqual(fresh, recorded)).toBe(false);
  });

  it("complete vs incomplete review differs", () => {
    const complete = detectTabs(loadLines("pi--v110-review-complete.txt"))!;
    const incomplete = detectTabs(loadLines("pi--v110-review-incomplete.txt"))!;
    expect(wizardsEqual(complete, incomplete)).toBe(false);
  });

  it("question phase vs review phase differs", () => {
    const q = detectTabs(loadLines("pi--v110-tabs-single.txt"))!;
    const r = detectTabs(loadLines("pi--v110-review-complete.txt"))!;
    expect(wizardsEqual(q, r)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Refusals & Boundary Conditions
// ---------------------------------------------------------------------------------------------

describe("tabs.ts — refusals", () => {
  it("refuses when editor is open on tabs page (pi--v110-tabs-editor-open.txt)", () => {
    expect(detectTabs(loadLines("pi--v110-tabs-editor-open.txt"))).toBeNull();
  });

  it("refuses when editor is open on standalone question (pi--v110-single-editor-open.txt)", () => {
    expect(detectTabs(loadLines("pi--v110-single-editor-open.txt"))).toBeNull();
  });

  it("refuses questionnaire multi-select page (pi--v110-tabs-multi.txt)", () => {
    // Multi pages carry checkboxes [ ] and Space tick in footer; handled by multi grammar
    expect(detectTabs(loadLines("pi--v110-tabs-multi.txt"))).toBeNull();
  });

  it("refuses standalone single questions (no tab bar)", () => {
    expect(detectTabs(loadLines("pi--v110-single.txt"))).toBeNull();
    expect(detectTabs(loadLines("pi--v110-single-desc.txt"))).toBeNull();
    expect(detectTabs(loadLines("pi--v110-single-moved.txt"))).toBeNull();
    expect(detectTabs(loadLines("pi--v110-single-narrow.txt"))).toBeNull();
  });

  it("refuses standalone multi-select questions (no tab bar)", () => {
    expect(detectTabs(loadLines("pi--v110-multi.txt"))).toBeNull();
    expect(detectTabs(loadLines("pi--v110-multi-ticked.txt"))).toBeNull();
    expect(detectTabs(loadLines("pi--v110-multi-moved.txt"))).toBeNull();
    expect(detectTabs(loadLines("pi--v110-multi-pointer-other.txt"))).toBeNull();
  });

  it("refuses pi core selector (/model)", () => {
    expect(detectTabs(loadLines("pi--v110-core-selector.txt"))).toBeNull();
  });

  it("refuses composer fixtures", () => {
    const composers = [
      "pi--v110-idle.txt",
      "pi--v110-idle-default-footer.txt",
      "pi--v110-draft.txt",
      "pi--v110-draft-multiline.txt",
      "pi--v110-narrow-idle.txt",
      "pi--v110-slash-palette.txt",
      "pi--v110-working.txt",
    ];
    for (const name of composers) {
      expect(detectTabs(loadLines(name))).toBeNull();
    }
  });

  it("refuses scrolled-up dialog with output below status row", () => {
    const base = loadLines("pi--v110-tabs-single.txt");
    const scrolled = [
      ...base,
      ...splitLines(parseAnsi("user typed text\nmore output")),
    ];
    expect(detectTabs(scrolled)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Mutation Tests
// ---------------------------------------------------------------------------------------------

describe("tabs.ts — mutations", () => {
  it("refuses tab bar with two active chips (two segments with bg)", () => {
    const lines = loadLines("pi--v110-tabs-single.txt");
    const tabLine = lines[1]!;
    // Add bg to Features chip as well
    const mutatedLine = {
      ...tabLine,
      segments: tabLine.segments.map((seg) => {
        if (seg.text.includes("Features")) {
          return Object.assign({}, seg, { bg: "rgb(29,29,29)" });
        }
        return seg;
      }),
    };
    const mutated = [...lines];
    mutated[1] = mutatedLine;
    expect(detectTabs(mutated)).toBeNull();
  });

  it("refuses tab bar where both question chip and review chip are active", () => {
    const lines = loadLines("pi--v110-tabs-single.txt");
    const tabLine = lines[1]!;
    const mutatedLine = {
      ...tabLine,
      segments: tabLine.segments.map((seg) => {
        if (seg.text.includes("Review")) {
          return Object.assign({}, seg, { bg: "rgb(29,29,29)" });
        }
        return seg;
      }),
    };
    const mutated = [...lines];
    mutated[1] = mutatedLine;
    expect(detectTabs(mutated)).toBeNull();
  });

  it("refuses tab bar with no active chips", () => {
    const lines = loadLines("pi--v110-tabs-single.txt");
    const tabLine = lines[1]!;
    const mutatedLine = {
      ...tabLine,
      segments: tabLine.segments.map((seg) => {
        const copy = Object.assign({}, seg);
        delete copy.bg;
        return copy;
      }),
    };
    const mutated = [...lines];
    mutated[1] = mutatedLine;
    expect(detectTabs(mutated)).toBeNull();
  });

  it("refuses corrupted tab bar missing arrows", () => {
    const lines = loadLines("pi--v110-tabs-single.txt");
    const mutatedLine = {
      ...lines[1]!,
      segments: lines[1]!.segments.map((s) =>
        Object.assign({}, s, { text: s.text.replace("←", " ").replace("→", " ") }),
      ),
    };
    const mutated = [...lines];
    mutated[1] = mutatedLine;
    expect(detectTabs(mutated)).toBeNull();
  });

  it("refuses question page with >9 options", () => {
    const rule = "\u001b[38;2;235;203;139m────────────────────────────────────────────────────────────────────────\u001b[0m";
    const bar = "  \u001b[38;2;79;79;79m←\u001b[0m  \u001b[48;2;29;29;29m ▢  Auth \u001b[0m  ▢  Other   ✓ Review  \u001b[38;2;79;79;79m→\u001b[0m";
    const opts = Array.from({ length: 10 }, (_, i) => `  ${i + 1}. Option ${i + 1}`);
    opts.push("  11. Type something.");
    const footer = "  ←→ tabs • ↑↓ navigate • Enter select • type a number or text • Esc cancel";
    const raw = [
      rule,
      bar,
      "",
      " Pick an option:",
      "",
      ...opts,
      "",
      footer,
      rule,
      "⎇ main",
    ].join("\n");
    const lines = splitLines(parseAnsi(raw));
    expect(detectTabs(lines)).toBeNull();
  });

  it("refuses question page with non-sequential numbering", () => {
    const lines = loadLines("pi--v110-tabs-single.txt");
    const mutated = [...lines];
    // Option 2 changed to 9
    mutated[7] = {
      segments: [{ text: "  9. Session cookies", bold: false, dim: false, italic: false, underline: false, strike: false, style: {}, muted: false }],
    };
    expect(detectTabs(mutated)).toBeNull();
  });

  it("refuses question page when checkboxes are present", () => {
    const lines = loadLines("pi--v110-tabs-single.txt");
    const mutated = [...lines];
    mutated[5] = {
      segments: [{ text: "> [ ] 1. OAuth 2.0 / OIDC", bold: false, dim: false, italic: false, underline: false, strike: false, style: {}, muted: false }],
    };
    expect(detectTabs(mutated)).toBeNull();
  });

  it("refuses review page when heading is missing", () => {
    const lines = loadLines("pi--v110-review-complete.txt");
    const mutated = [...lines];
    mutated[3] = {
      segments: [{ text: "  Some other text here", bold: false, dim: false, italic: false, underline: false, strike: false, style: {}, muted: false }],
    };
    expect(detectTabs(mutated)).toBeNull();
  });

  it("refuses review page when rows count does not match chips count", () => {
    const lines = loadLines("pi--v110-review-complete.txt");
    // Remove the 3rd answer row (Deploy)
    const mutated = [...lines.slice(0, 7), ...lines.slice(8)];
    expect(detectTabs(mutated)).toBeNull();
  });

  it("refuses review page when rows are out of tab order", () => {
    const lines = loadLines("pi--v110-review-complete.txt");
    const mutated = [...lines];
    // Swap row 1 (Auth) and row 2 (Features)
    const row1 = lines[5]!;
    const row2 = lines[6]!;
    mutated[5] = row2;
    mutated[6] = row1;
    expect(detectTabs(mutated)).toBeNull();
  });

  it("refuses review page when header does not match tab chip", () => {
    const lines = loadLines("pi--v110-review-complete.txt");
    const mutated = [...lines];
    // Change Auth to Database
    mutated[5] = {
      segments: [{ text: "  1. Database    OAuth 2.0 / OIDC", bold: false, dim: false, italic: false, underline: false, strike: false, style: {}, muted: false }],
    };
    expect(detectTabs(mutated)).toBeNull();
  });

  it("refuses review page with malformed answer row missing separator", () => {
    const lines = loadLines("pi--v110-review-complete.txt");
    const mutated = [...lines];
    mutated[5] = {
      segments: [{ text: "  1. Auth", bold: false, dim: false, italic: false, underline: false, strike: false, style: {}, muted: false }],
    };
    expect(detectTabs(mutated)).toBeNull();
  });
});
