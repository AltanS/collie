import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi, type AnsiSegment } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { displayWidth } from "../../text-width";
import { dropClosingRule } from "./closing-rule";
import { claudeBuildBlocks } from "./index";
import { isHorizontalRule, isRuleRow, lineText } from "./markers";
import { detectMultiSelect } from "./multi-select";
import { detectPreviewSelect } from "./preview-select";
import { detectPromptSelect } from "./prompt-select";
import { detectResumePicker } from "./resume";
import { dropTaskChecklist } from "./task-checklist";
import { detectWizard } from "./wizard";

// Hardening against a user theme, not vanilla Claude Code behaviour. A plugin or theme that draws a
// gutter beside a dialog narrows the dialog by the gutter's width, while Claude Code still draws the
// dialog's rules at the full pane width, so each full-width rule overflows by the gutter's width and
// its last glyphs wrap onto a row of their own. The observed case is a theme plugin's question bar (a
// two-column gutter: one background-coloured cell, one blank cell). Not every theme can be
// anticipated, so this test draws synthetic gutters of 1 to 4 columns beside every vanilla picker
// fixture and expects each picker to read the same as it does with no gutter.

// Anchored on this file's own directory (see prompt-select.test.ts for why not import.meta.url).
const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures");
const PANES_DIR = join(FIXTURES_DIR, "panes");

const fixtureLines = (name: string): StyledLine[] => splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));

/** One committed row of the client/bridge binding golden (prompt-binding-regions.json). */
interface RegionRow {
  fixture: string;
  detector: string;
  region: string;
  agent?: string;
}

// SAFETY: `prompt-binding-regions.json` is this repo's own committed golden; its shape is asserted by
// prompt-binding-contract.test.ts, which reads every field used here.
const REGIONS = JSON.parse(readFileSync(join(FIXTURES_DIR, "prompt-binding-regions.json"), "utf8")) as RegionRow[];

const PICKER_DETECTORS = new Set(["wizard", "preview-select", "multi-select", "prompt-select"]);
// The captures that already carry a theme's gutter: the gutter is taken off them below instead.
const THEMED_FIXTURES = [
  "claude--v2302-wizard-long-question--w54.txt",
  "claude--v2302-preview-wrapped-rule--w141.txt",
  "claude--v2302-wizard-review-long-q--w140.txt",
];
const GUTTER_WIDTHS = [1, 2, 3, 4];
// The gutter's first cell: a background-coloured space, the way the observed theme plugin draws it.
const GUTTER_CELL = "\u001b[48;5;33m \u001b[0m";

/** The fixture's pane width: its `--w<N>` suffix, or, for a name without one, its widest row. A
 *  widest row that is not a full-width rule leaves the width uncertain, which only means fewer rules
 *  reach it and wrap (`withGutter`). */
function paneWidth(fixture: string, lines: StyledLine[]): number {
  const match = /--w(\d+)/.exec(fixture);
  if (match) return Number(match[1]);
  return Math.max(...lines.map((line) => displayWidth(lineText(line))));
}

/** The rows of `lines` the region occupies, or [] when its rows are not there contiguously. */
function regionRows(lines: StyledLine[], region: string): number[] {
  const texts = lines.map(lineText);
  const rows = region.split("\n");
  for (let at = 0; at + rows.length <= texts.length; at++) {
    if (rows.every((row, k) => texts[at + k] === row)) return rows.map((_, k) => at + k);
  }
  return [];
}

/** The dialog's rows: the bound region and, when it sits right above it, the dialog's top rule. */
function dialogRows(lines: StyledLine[], region: string): Set<number> {
  const rows = regionRows(lines, region);
  const above = rows[0]! - 1;
  if (above >= 0 && isHorizontalRule(lineText(lines[above]!))) rows.unshift(above);
  return new Set(rows);
}

/** `g` gutter cells: the coloured cell, then `g - 1` plain spaces. */
function gutterSegments(g: number): AnsiSegment[] {
  return parseAnsi(GUTTER_CELL + " ".repeat(g - 1)).filter((segment) => segment.text.length > 0);
}

/** A full-width rule redrawn at the pane's width `width + g` after a `g`-column gutter: the first
 *  `width` glyphs on its own row, the last `g` alone on the next row (the wrapped stub). */
function wrapRule(line: StyledLine, width: number, g: number): [StyledLine, StyledLine] {
  const text = lineText(line).trimEnd();
  const glyph = text.at(-1)!;
  const drawn = text + glyph.repeat(g);
  const style = line.segments.find((segment) => segment.text.includes(glyph))!;
  const gutter = gutterSegments(g);
  return [
    { ...line, segments: [...gutter, { ...style, text: drawn.slice(0, width) }] },
    { ...line, segments: [...gutter, { ...style, text: drawn.slice(width) }] },
  ];
}

/** `lines` as a pane `g` columns wider shows them beside a `g`-column gutter that covers the dialog. */
function withGutter(lines: StyledLine[], region: string, width: number, g: number): StyledLine[] {
  const dialog = dialogRows(lines, region);
  const out: StyledLine[] = [];
  lines.forEach((line, i) => {
    if (!dialog.has(i)) {
      out.push(line);
      return;
    }
    const text = lineText(line);
    if (isHorizontalRule(text) && displayWidth(text.trimEnd()) === width) {
      out.push(...wrapRule(line, width, g));
      return;
    }
    out.push({ ...line, segments: [...gutterSegments(g), ...line.segments] });
  });
  return out;
}

/** `line` without its first `n` columns (the themed captures' gutter is spaces, one column each). */
function dropColumns(line: StyledLine, n: number): StyledLine {
  let left = n;
  const segments: AnsiSegment[] = [];
  for (const segment of line.segments) {
    const cut = Math.min(left, segment.text.length);
    left -= cut;
    if (cut < segment.text.length) segments.push({ ...segment, text: segment.text.slice(cut) });
  }
  return { ...line, segments };
}

/** A themed capture as vanilla Claude Code draws it: each gutter row (its first cell painted)
 *  without its two gutter columns, and each wrapped rule's stub row gone. */
function withoutGutter(lines: StyledLine[]): StyledLine[] {
  const out: StyledLine[] = [];
  for (const line of lines) {
    const first = line.segments[0];
    const guttered = first?.bg !== undefined && first.text.trim() === "";
    if (!guttered) {
      out.push(line);
      continue;
    }
    const kept = dropColumns(line, 2);
    const texts = [...out.map(lineText), lineText(kept)];
    const stub = isRuleRow(texts, texts.length - 1) && !isHorizontalRule(texts.at(-1)!);
    if (!stub) out.push(kept);
  }
  return out;
}

/** The parts of a picker model the phone shows and acts on. */
interface Readable {
  phase?: string;
  question?: string;
  options?: readonly { label: string; keys?: readonly string[]; n?: number }[];
  steps?: unknown;
  answers?: unknown;
}

function project(kind: string, model: Readable) {
  return {
    kind,
    phase: model.phase ?? null,
    question: model.question ?? null,
    options: (model.options ?? []).map((option) => ({
      label: option.label,
      keys: option.keys ?? [String(option.n)],
    })),
    steps: model.steps ?? null,
    answers: model.answers ?? null,
  };
}

/** What the picker detectors read off `input`, in the order the binding contract tries them. */
function readPicker(input: StyledLine[]) {
  const lines = dropClosingRule(dropTaskChecklist(input));
  const prompt = detectPromptSelect(lines);
  if (prompt) return project("prompt-select", prompt);
  const wizard = detectWizard(lines);
  if (wizard) return project("wizard", wizard);
  const preview = detectPreviewSelect(lines);
  if (preview) return project("preview-select", preview);
  const multi = detectMultiSelect(lines);
  if (multi) return project("multi-select", multi);
  const resume = detectResumePicker(lines);
  if (resume) return project("prompt-select", resume);
  return null;
}

/** The picker block kinds the Claude adapter lifts off `lines`. */
function pickerBlocks(lines: StyledLine[]): string[] {
  return claudeBuildBlocks(lines)
    .map((block) => block.kind)
    .filter((kind) => PICKER_DETECTORS.has(kind));
}

const VANILLA = REGIONS.filter(
  (row) =>
    PICKER_DETECTORS.has(row.detector) &&
    row.fixture.startsWith("claude") &&
    row.agent === undefined &&
    !THEMED_FIXTURES.includes(row.fixture),
).filter((row, i, rows) => rows.findIndex((other) => other.fixture === row.fixture) === i);

describe("a theme's gutter beside a vanilla picker leaves the picker's reading unchanged", () => {
  for (const { fixture, region } of VANILLA) {
    for (const g of GUTTER_WIDTHS) {
      it(`${fixture} with a ${g}-column gutter`, () => {
        const lines = fixtureLines(fixture);
        const width = paneWidth(fixture, lines);
        const variant = withGutter(lines, region, width, g);
        const expected = readPicker(lines);
        expect(expected).not.toBeNull();
        expect(readPicker(variant)).toEqual(expected);
        expect(pickerBlocks(variant)).toEqual(pickerBlocks(lines));
      });
    }
  }
});

describe("a themed capture with its gutter taken off reads as the themed capture does", () => {
  for (const fixture of THEMED_FIXTURES) {
    it(fixture, () => {
      const themed = fixtureLines(fixture);
      const vanilla = withoutGutter(themed);
      expect(vanilla.length).toBeLessThan(themed.length);
      const expected = readPicker(themed);
      expect(expected).not.toBeNull();
      expect(readPicker(vanilla)).toEqual(expected);
      expect(pickerBlocks(vanilla)).toEqual(pickerBlocks(themed));
    });
  }
});
