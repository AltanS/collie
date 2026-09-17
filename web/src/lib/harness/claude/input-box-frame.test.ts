import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { detectAutocompleteRegion } from "./autocomplete";
import { namesAMenuKey } from "../menu-hints";
import { extractInputDraft, extractStatusLines, hasInputBox, inputBoxTail } from "./chrome";
import { claudeBuildBlocks } from "./index";
import { lineText } from "./markers";
import { detectMenuRegion } from "./menu";
import { detectMultiSelectRegion } from "./multi-select";
import { detectPreviewSelectRegion } from "./preview-select";
import { detectPromptSelectRegion } from "./prompt-select";
import { detectWizardRegion } from "./wizard";

// The input box is found by its own frame (ADR 0048): the lowest bare bottom border, a "❯" line and a
// top border above it, then every row below accounted for. These tests pin the safety half of that
// design: a box is never reported while a modal owns the keyboard, however the screen is carved up.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const CLAUDE_FIXTURES = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("claude--") && f.endsWith(".txt"))
  .toSorted();
const POPUP_FIXTURES = [
  "claude--autocomplete-slash-long.txt",
  "claude--autocomplete-slash-short.txt",
  "claude--autocomplete-slash-clipped.txt",
];

function load(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}
function fromTexts(texts: string[]): StyledLine[] {
  return splitLines(parseAnsi(texts.join("\n")));
}
function textRows(lines: StyledLine[]): string[] {
  const out = lines.map(lineText);
  while (out.length > 0 && out.at(-1)!.trim() === "") out.pop();
  return out;
}

const RULE = "─".repeat(40);
const box = (draft: string) => [RULE, `❯ ${draft}`, RULE];

function claimedByADialog(lines: StyledLine[]): boolean {
  return (
    detectPreviewSelectRegion(lines) !== null ||
    detectWizardRegion(lines) !== null ||
    detectMultiSelectRegion(lines) !== null ||
    detectPromptSelectRegion(lines) !== null ||
    detectMenuRegion(lines) !== null
  );
}

describe("parity with the old walk on the real corpus", () => {
  // Measured against the walk this replaced, on every Claude capture: the same 17 screens have a box,
  // the rest are refused. The one addition is the hand-built clipped-popup screen, the bug itself.
  const BOXES = new Set([
    "claude--autocomplete-slash-clipped.txt",
    "claude--autocomplete-slash-long.txt",
    "claude--autocomplete-slash-short.txt",
    "claude--done.txt",
    "claude--draft-footer-empty.txt",
    "claude--draft-footer-single.txt",
    "claude--draft-footer-wrapped.txt",
    "claude--draft-paste-placeholder.txt",
    "claude--draft-paste-split-partial.txt",
    "claude--draft-paste-split-tail.txt",
    "claude--draft-wrapped.txt",
    "claude--fresh-idle.txt",
    "claude--ghost-suggestion.txt",
    "claude--ghost-typed-over.txt",
    "claude--menu-model-picker-dismissed.txt",
    "claude--model-alias.txt",
    "claude--rename-resolved.txt",
    "claude--send-inflight.txt",
    "claude--working.txt",
  ]);

  it.each(CLAUDE_FIXTURES)("%s", (name) => {
    expect(hasInputBox(load(name))).toBe(BOXES.has(name));
  });
});

describe("canary: Claude replaces the box with a modal", () => {
  it.each(CLAUDE_FIXTURES)("%s: a screen a dialog grammar claims has no box", (name) => {
    const lines = load(name);
    if (claimedByADialog(lines)) expect(hasInputBox(lines)).toBe(false);
  });

  it("the canary is not vacuous", () => {
    expect(CLAUDE_FIXTURES.filter((name) => claimedByADialog(load(name))).length).toBeGreaterThan(20);
  });
});

describe("a stale box above a live dialog is never the composer", () => {
  const DIALOGS = CLAUDE_FIXTURES.filter((name) => claimedByADialog(load(name)));

  it.each(DIALOGS)("%s with an echoed box triple above it", (name) => {
    const original = load(name);
    const kinds = claudeBuildBlocks(original).map((b) => b.kind);
    const lines = fromTexts(["● earlier turn", ...box("please run the migration"), "", ...textRows(original)]);
    expect(hasInputBox(lines)).toBe(false);
    expect(extractInputDraft(lines)).toBeNull();
    // The dialog grammars still read the full screen: the same interactive block comes back.
    expect(claudeBuildBlocks(lines).map((b) => b.kind).at(-1)).toBe(kinds.at(-1));
  });

  // The specific dialog grammars also run over the whole screen before a box is reported. On today's
  // corpus they never decide alone: every dialog is already refused by a frame mark in the tail or by
  // its footer row. They stay as the independent layer, for a dialog whose rows carry neither.
  it("a select dialog directly under a box: its footer row refuses it", () => {
    const lines = fromTexts([...box("old"), "  1. Yes", "  2. No", "Enter to select · ↑/↓ to navigate · Esc to cancel"]);
    expect(hasInputBox(lines)).toBe(false);
  });
});

describe("the box is the lowest frame on screen, and its tail holds no frame mark", () => {
  it("two boxes: the lower one is the composer", () => {
    const lines = fromTexts(["● earlier", ...box("stale echo"), "● later", ...box("live draft"), "[Opus 5] ~/src"]);
    expect(extractInputDraft(lines)).toBe("live draft");
  });

  it.each([
    ["a bare border", [RULE]],
    ["a second box's labelled top border and prompt", [`${"─".repeat(20)} session ${"─".repeat(4)}`, "❯ next"]],
    ["a ❯ prompt line", ["❯ 1. Yes"]],
  ])("a tail holding %s refuses the box", (_label, rows) => {
    expect(hasInputBox(fromTexts([...box("draft"), "status", ...rows, "more"]))).toBe(false);
  });

  it.each([
    ["a pointer glyph mid-row", "  Opus ❯ Sonnet"],
    ["a non-box rule", "╌╌╌╌╌╌╌╌╌╌"],
    ["a stepper header", "←  ☒ Scope  ☐ Workflow  ✔ Submit  →"],
    ["a numbered option", "  2. No, and tell Claude what to do"],
    ["a single key hint", "Esc to cancel"],
    ["a key-hint footer", "Enter to set as default · Esc to cancel"],
  ])("an unknown tail holding %s refuses the box", (_label, row) => {
    const filler = Array.from({ length: 9 }, (_, i) => `row ${i} of something`);
    expect(hasInputBox(fromTexts([...box("draft"), ...filler, row]))).toBe(false);
    // Control: the same tail without that row is an ordinary unknown tail, and the box is found.
    expect(hasInputBox(fromTexts([...box("draft"), ...filler]))).toBe(true);
  });
});

describe("a statusline row shaped like a frame mark", () => {
  // A statusline is a user command's output. A starship-style prompt opens with "❯", and a separator
  // can look like a labelled rule. Inside a bounded statusline run under a bare border, neither is a
  // frame mark.
  it.each([
    ["a ❯-led starship row", "❯ ~/src on main [Opus 5] 3%"],
    ["a labelled-rule row", "─ main ─────"],
  ])("%s under the box: the box and its draft are found", (_label, row) => {
    const lines = fromTexts(["● earlier", ...box("draft"), row, "  ← for agents"]);
    expect(hasInputBox(lines)).toBe(true);
    expect(inputBoxTail(lines)).toBe("statusline");
    expect(extractInputDraft(lines)).toBe("draft");
  });

  it("a select dialog's numbered ❯ pointer under an old box refuses", () => {
    expect(hasInputBox(fromTexts([...box("old"), "❯ 1. Yes", "  2. No"]))).toBe(false);
  });

  it("a stale box above a permission dialog refuses", () => {
    const lines = fromTexts([
      ...box("old"),
      "",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, and don't ask again this session",
      "  3. No, and tell Claude what to do differently (esc)",
      "",
      "Esc to cancel",
    ]);
    expect(hasInputBox(lines)).toBe(false);
  });

  it("a ❯-led row in an unknown tail refuses", () => {
    const filler = Array.from({ length: 9 }, (_, i) => `row ${i} of something`);
    expect(hasInputBox(fromTexts([...box("draft"), "❯ ~/src on main", ...filler]))).toBe(false);
  });

  it("a ❯-led row further than the statusline bound below the border refuses", () => {
    const filler = Array.from({ length: 8 }, (_, i) => `row ${i}`);
    expect(hasInputBox(fromTexts([...box("draft"), ...filler, "❯ ~/src on main"]))).toBe(false);
  });
});

describe("a statusline-shaped tail still carries no menu", () => {
  it("a select dialog under an old box, split by a blank above its footer, refuses", () => {
    const lines = fromTexts([
      ...box("old"),
      "▔".repeat(40),
      " Select model",
      "   1. Opus",
      "   2. Sonnet",
      "",
      " Enter to set as default · Esc to cancel",
    ]);
    expect(hasInputBox(lines)).toBe(false);
    expect(extractInputDraft(lines)).toBeNull();
  });

  it("no statusline row in the Claude corpus names a menu key or a numbered option", () => {
    let rows = 0;
    for (const name of CLAUDE_FIXTURES) {
      const lines = load(name);
      if (inputBoxTail(lines) !== "statusline") continue;
      for (const row of extractStatusLines(lines).map(lineText)) {
        rows++;
        expect(namesAMenuKey(row), `${name}: ${row}`).toBe(false);
        expect(/^\s*(?:❯\s*)?\d+\.\s+\S/.test(row), `${name}: ${row}`).toBe(false);
      }
    }
    expect(rows).toBeGreaterThan(10);
  });
});

describe("the search is bounded to the screen's final region", () => {
  // MAX_TAIL_LINES is the popup's own cap (60): every tail the old locator accepted fits inside it.
  const tail = (n: number) => Array.from({ length: n }, (_, i) => `build line ${i}`);

  it("60 rows under the box: found", () => {
    expect(hasInputBox(fromTexts(["● earlier", ...box("draft"), ...tail(60)]))).toBe(true);
  });

  it("61 rows under the box: not the live box", () => {
    expect(hasInputBox(fromTexts(["● earlier", ...box("draft"), ...tail(61)]))).toBe(false);
  });
});

describe("invariant: rows appended below a box never change the box or its draft", () => {
  const BOX_FIXTURES = CLAUDE_FIXTURES.filter((name) => hasInputBox(load(name)));
  const neutral = (n: number) => Array.from({ length: n }, (_, i) => `  compiled module ${i} in ${i * 7}ms`);

  it.each(BOX_FIXTURES)("%s", (name) => {
    const base = textRows(load(name));
    const draft = extractInputDraft(fromTexts(base));
    for (const n of [1, 3, 8, 9, 20]) {
      const lines = fromTexts([...base, ...neutral(n)]);
      expect(hasInputBox(lines), `${n} rows`).toBe(true);
      expect(extractInputDraft(lines), `${n} rows`).toBe(draft);
    }
  });
});

describe("property: popup mutations never hide the box", () => {
  // A small seeded generator, so a failure names a reproducible case.
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  const ENTRY = /^ {2}([/…]\S+)( {2,})(\S.*)$/;

  function mutate(rows: string[], column: number, next: () => number): string[] {
    const out: string[] = [];
    for (const row of rows) {
      const entry = ENTRY.exec(row);
      const roll = next();
      if (entry !== null && roll < 0.2) {
        // Clip the name from the left, keeping the column: "/typescript:x" → "…ypescript:x".
        const name = entry[1]!;
        const cut = Math.min(name.length - 2, 1 + Math.floor(next() * 6));
        out.push(`  …${name.slice(cut + 1).padEnd(name.length - 1)}${entry[2]}${entry[3]}`);
      } else if (roll < 0.35 && row.trim().length > 8) {
        // Clip the description with a trailing ellipsis.
        out.push(`${row.slice(0, Math.max(column + 3, row.length - 1 - Math.floor(next() * 12)))}…`);
      } else if (entry !== null && roll < 0.45) {
        // Drop the description: a bare entry.
        out.push(`  ${entry[1]}`);
      } else {
        out.push(row);
      }
      if (entry !== null && next() < 0.2) out.push(`${" ".repeat(column)}and a wrapped continuation row`);
    }
    return out;
  }

  it.each(POPUP_FIXTURES)("%s: 60 seeded mutations keep the box and the draft", (name) => {
    const original = load(name);
    const all = textRows(original);
    const region = detectAutocompleteRegion(original)!;
    const draft = extractInputDraft(original);
    const head = all.slice(0, region.startLine);
    const rows = all.slice(region.startLine);
    const first = ENTRY.exec(rows[0]!)!;
    const column = 2 + first[1]!.length + first[2]!.length;
    const next = rng(name.length * 7919);
    for (let k = 0; k < 60; k++) {
      const mutated = mutate(rows, column, next);
      const lines = fromTexts([...head, ...mutated]);
      expect(hasInputBox(lines), `${name} case ${k}`).toBe(true);
      expect(extractInputDraft(lines), `${name} case ${k}`).toBe(draft);
      expect(inputBoxTail(lines), `${name} case ${k}`).not.toBeNull();
    }
  });
});
