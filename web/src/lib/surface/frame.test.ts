import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi, type AnsiSegment } from "../ansi";
import { lineText, splitLines, type StyledLine } from "../blocks";
import { cropRawColumns, type ColumnRange } from "../column-range";
import { MAX_AUTOCOMPLETE_LINES } from "../harness/claude/autocomplete";
import { displayWidth } from "../text-width";
import { findInputFrame, frameAt, plainRows, type Frame, type FrameRow, type FrameRun } from "./frame";
import { readAboveNotice } from "./notice";
import { requireProfile } from "./profile";

// M56 spec 03: one module finds the input frame from a profile's `idle` anchors, and the phone's
// chrome reader, the bridge's session-name read and the bridge's tap binding all call it.
//
// Two pinned contracts:
//  - `input-frame-regions.json` pins the frame of every Claude fixture (null where there is none).
//    It was written from this module on the day it replaced the three searches, after a one-off run
//    over all 665 fixtures showed it gives the same top, prompt row and bottom as the old chrome.ts
//    walk on every one, and the same draft wherever the old reader found a box (worklog, spec 03).
//    Regenerate it only on purpose: COLLIE_REGEN_INPUT_FRAMES=1 bunx vitest run src/lib/surface/frame.test.ts
//  - `prompt-binding-regions.json` pins the dialog region each detector binds to. No input frame may
//    sit on or under a pinned dialog region: a dialog replaces the composer.

const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "fixtures");
const PANES_DIR = join(FIXTURES_DIR, "panes");
const GOLDEN = join(FIXTURES_DIR, "input-frame-regions.json");
const IDLE = requireProfile("claude").idle;

const fixtureNames = readdirSync(PANES_DIR)
  .filter((name) => name.endsWith(".txt"))
  .toSorted();
const isClaudeFixture = (name: string): boolean => name.startsWith("claude--") || name.startsWith("claude-lab--");

const rowsCache = new Map<string, StyledLine[]>();
function fixtureRows(name: string): StyledLine[] {
  const hit = rowsCache.get(name);
  if (hit !== undefined) return hit;
  const rows = splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
  rowsCache.set(name, rows);
  return rows;
}

interface PinnedFrame {
  top: number;
  prompt: number;
  bottom: number;
  label: string | null;
  text: string;
  placeholder: boolean;
  status: { first: number; last: number } | null;
  footer: { first: number; last: number } | null;
}

interface GoldenRow {
  fixture: string;
  frame: PinnedFrame | null;
}

function pin(frame: Frame | null): PinnedFrame | null {
  if (frame === null) return null;
  return {
    top: frame.top,
    prompt: frame.interior.prompt,
    bottom: frame.bottom,
    label: frame.label,
    text: frame.interior.text,
    placeholder: frame.placeholder,
    status: frame.volatile.status,
    footer: frame.volatile.footer,
  };
}

if (process.env.COLLIE_REGEN_INPUT_FRAMES === "1") {
  const rows: GoldenRow[] = fixtureNames
    .filter(isClaudeFixture)
    .map((fixture) => ({ fixture, frame: pin(findInputFrame(fixtureRows(fixture), IDLE)) }));
  writeFileSync(GOLDEN, `${JSON.stringify(rows, null, 1)}\n`);
}

// SAFETY: the golden is this repo's own committed file, written by the block above; every field the
// cases below read is compared against a fresh frame, so a drifted shape fails here.
const PINNED = JSON.parse(readFileSync(GOLDEN, "utf8")) as GoldenRow[];

describe("pinned input frames", () => {
  it("pins a row for every Claude fixture and for nothing else", () => {
    expect(PINNED.map((row) => row.fixture)).toEqual(fixtureNames.filter(isClaudeFixture));
  });

  it("the pinned set is not vacuous: most idle captures carry a frame, dialogs do not", () => {
    const framed = PINNED.filter((row) => row.frame !== null).length;
    expect(framed).toBeGreaterThan(80);
    expect(PINNED.length - framed).toBeGreaterThan(150);
  });

  for (const { fixture, frame } of PINNED) {
    it(`pinned: ${fixture} gives its pinned frame`, () => {
      expect(pin(findInputFrame(fixtureRows(fixture), IDLE))).toEqual(frame);
    });
  }
});

interface RegionRow {
  fixture: string;
  detector: string;
  region: string;
  bindColumns?: ColumnRange;
}

// SAFETY: the dialog-region golden is committed and checked field by field by
// harness/prompt-binding-contract.test.ts.
const REGIONS = JSON.parse(readFileSync(join(FIXTURES_DIR, "prompt-binding-regions.json"), "utf8")) as RegionRow[];

/** The non-blank rows, as the binding check counts them (trailing space cut, blank rows dropped). */
function nonBlankIndex(texts: readonly string[]): number[] {
  const index: number[] = [];
  texts.forEach((text, row) => {
    if (text.replace(/\s+$/, "").length > 0) index.push(row);
  });
  return index;
}

describe("pinned dialog regions", () => {
  for (const { fixture, region, bindColumns } of REGIONS) {
    it(`pinned: no input frame sits on or under the ${fixture} dialog`, () => {
      const raw = readFileSync(join(PANES_DIR, fixture), "utf8");
      const read = bindColumns === undefined ? raw : cropRawColumns(raw, bindColumns);
      const rows = splitLines(parseAnsi(read));
      const texts = rows.map(lineText);
      const kept = nonBlankIndex(texts).map((row) => ({ row, text: texts[row]!.replace(/\s+$/, "") }));
      const want = region
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line.length > 0);
      let start = -1;
      for (let i = 0; i + want.length <= kept.length; i++) {
        if (want.every((line, k) => kept[i + k]!.text === line)) start = i;
      }
      expect(start, "the pinned region is in its fixture").toBeGreaterThanOrEqual(0);
      const firstRow = kept[start]!.row;
      for (const profile of [IDLE]) {
        const frame = findInputFrame(rows, profile);
        // A notice the profile names sits ABOVE the live box by design (ADR 0109): its card owns no keyboard.
        if (frame !== null && readAboveNotice(texts, frame.top, profile.notices ?? [], profile.noticeGaps ?? [])?.first === firstRow) continue;
        if (frame !== null) expect(frame.bottom, "a frame found on a dialog sits wholly above it").toBeLessThan(firstRow);
      }
    });
  }
});

// Muse, Oh My Pi's Claude theme, pi's OmO extension and Hermes's classic CLI paint Claude's own input
// box: a column-0 ❯ row between two bare U+2500 rules. The anchors are shape only, so the Claude profile finds a frame
// there, and that is right: the frame says "a box is drawn", and the profile is picked by the binary
// (the README contract: version and harness from the binary, never from the screen), so the Claude
// profile is never applied to those panes. Every other non-Claude fixture yields null.
const DRAWS_THE_SAME_BOX = (name: string): boolean =>
  name.startsWith("muse--") ||
  name.startsWith("omp--v18-4-claude") ||
  name.startsWith("pi--omo-") ||
  name.startsWith("hermes--") ||
  name === "pi--prose-quoted-omo-dialog-above-editor.txt";

describe("non-Claude fixtures", () => {
  it("yield null with the Claude profile, except the harnesses that draw the same box", () => {
    const found = fixtureNames.filter((name) => !isClaudeFixture(name) && findInputFrame(fixtureRows(name), IDLE) !== null);
    expect(found.filter((name) => !DRAWS_THE_SAME_BOX(name))).toEqual([]);
    // The exception stays honest: each family it names still draws the box.
    for (const family of ["muse--", "omp--v18-4-claude", "pi--omo-", "hermes--"]) {
      expect(found.some((name) => name.startsWith(family)), family).toBe(true);
    }
  });

  it("the other harnesses outnumber the exception", () => {
    const others = fixtureNames.filter((name) => !isClaudeFixture(name) && !DRAWS_THE_SAME_BOX(name));
    expect(others.length).toBeGreaterThan(300);
  });
});

// ── Perturbations ───────────────────────────────────────────────────────────
//
// For each Claude fixture with a pinned frame: move the box one row, drop one border, add one
// status row, and re-wrap the screen at another width. The module must find the same interior or
// return null. It never returns a wrong one: the interior is compared to the pinned draft (or
// placeholder), with whitespace ignored because a re-wrap moves line breaks.

function plainRun(text: string): AnsiSegment {
  return { text, style: {}, muted: false };
}

function styled(...segments: AnsiSegment[]): StyledLine {
  return { segments };
}

function blankRow(): StyledLine {
  return styled();
}

/** The cells of a row as single-grapheme runs, each keeping its run's style. */
function cells(line: StyledLine): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  for (const segment of line.segments) {
    for (const ch of segment.text) out.push({ ...segment, text: ch });
  }
  return out;
}

function width(runs: readonly AnsiSegment[]): number {
  return runs.reduce((sum, run) => sum + displayWidth(run.text), 0);
}

/** A row cut into rows of at most `cols` cells, character by character (what a terminal does to output). */
function hardWrap(line: StyledLine, cols: number): StyledLine[] {
  const all = cells(line);
  if (width(all) <= cols) return [line];
  const rows: StyledLine[] = [];
  let current: AnsiSegment[] = [];
  let used = 0;
  for (const cell of all) {
    const w = displayWidth(cell.text);
    if (used + w > cols && current.length > 0) {
      rows.push(styled(...current));
      current = [];
      used = 0;
    }
    current.push(cell);
    used += w;
  }
  rows.push(styled(...current));
  return rows;
}

/** Word-wrap a run of cells into rows of at most `cols` cells; a word wider than a row is cut. */
function wordWrap(runs: readonly AnsiSegment[], cols: number): AnsiSegment[][] {
  const words: AnsiSegment[][] = [];
  let word: AnsiSegment[] = [];
  for (const cell of runs) {
    if (cell.text.trim() === "") {
      if (word.length > 0) words.push(word);
      word = [];
    } else {
      word.push(cell);
    }
  }
  if (word.length > 0) words.push(word);
  const rows: AnsiSegment[][] = [];
  let current: AnsiSegment[] = [];
  for (const w of words) {
    const pieces = width(w) <= cols ? [w] : hardWrap(styled(...w), cols).map((piece) => piece.segments);
    for (const piece of pieces) {
      const gap = current.length > 0 ? 1 : 0;
      if (width(current) + gap + width(piece) > cols && current.length > 0) {
        rows.push(current);
        current = [];
      }
      if (current.length > 0) current.push(plainRun(" "));
      current.push(...piece);
    }
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

/** The screen re-drawn at `cols` columns: the edges at the new width, the draft re-wrapped under the
 *  same marker, and every other row cut at the new width. */
function rewrap(rows: readonly StyledLine[], frame: Frame, cols: number): StyledLine[] {
  const prompt = new RegExp(IDLE.frame.prompt.pattern, "du");
  const out: StyledLine[] = [];
  for (let i = 0; i < frame.top; i++) out.push(...hardWrap(rows[i]!, cols));

  const label = frame.label;
  const topText =
    label === null ? "─".repeat(cols) : `${"─".repeat(Math.max(1, cols - displayWidth(label) - 4))} ${label} ──`;
  out.push(styled(plainRun(topText)));
  for (let i = frame.interior.first; i < frame.interior.prompt; i++) out.push(blankRow());

  const promptCells = cells(rows[frame.interior.prompt]!);
  const promptText = lineText(rows[frame.interior.prompt]!).trimEnd();
  const holeStart = prompt.exec(promptText)?.indices?.groups?.draft?.[0] ?? promptText.length;
  // Cells are graphemes and `holeStart` is UTF-16 units: walk the cells to the same offset.
  let offset = 0;
  let split = 0;
  while (split < promptCells.length && offset < holeStart) {
    offset += promptCells[split]!.text.length;
    split++;
  }
  const marker = promptCells.slice(0, split);
  const draft: AnsiSegment[] = promptCells.slice(split);
  for (let i = frame.interior.prompt + 1; i <= frame.interior.last; i++) {
    const trimmed = cells(rows[i]!);
    if (lineText(rows[i]!).trim() === "") continue;
    draft.push(plainRun(" "), ...trimmed);
  }
  const wrapped = wordWrap(draft, Math.max(1, cols - width(marker)));
  if (wrapped.length === 0) out.push(styled(...marker));
  wrapped.forEach((line, k) => out.push(styled(...(k === 0 ? marker : [plainRun(" ".repeat(IDLE.frame.continuationIndent))]), ...line)));

  out.push(styled(plainRun("─".repeat(cols))));
  for (let i = frame.bottom + 1; i < rows.length; i++) out.push(...hardWrap(rows[i]!, cols));
  return out;
}

const squash = (text: string): string => text.replace(/\s+/gu, "");

interface Perturbation {
  name: string;
  rows: StyledLine[];
  /** True when nothing structural changed, so the frame must still be found. */
  mustFind: boolean;
}

function perturbations(rows: readonly StyledLine[], frame: Frame): Perturbation[] {
  const at = (i: number, ...insert: StyledLine[]): StyledLine[] => [...rows.slice(0, i), ...insert, ...rows.slice(i)];
  const without = (i: number): StyledLine[] => [...rows.slice(0, i), ...rows.slice(i + 1)];
  const bottomWidth = displayWidth(lineText(rows[frame.bottom]!).trimEnd());
  const cols = bottomWidth >= 60 ? bottomWidth - 20 : bottomWidth + 20;
  const list: Perturbation[] = [
    { name: "box moved down one row", rows: at(frame.top, blankRow()), mustFind: true },
    { name: "a blank row under the box", rows: at(frame.bottom + 1, blankRow()), mustFind: true },
    { name: "top edge dropped", rows: without(frame.top), mustFind: false },
    { name: "bottom edge dropped", rows: without(frame.bottom), mustFind: false },
    { name: "one more status row", rows: at(frame.bottom + 1, styled(plainRun("  one more status row"))), mustFind: true },
    { name: `re-wrapped at ${String(cols)} columns`, rows: rewrap(rows, frame, cols), mustFind: false },
  ];
  if (frame.top > 0) list.push({ name: "box moved up one row", rows: without(frame.top - 1), mustFind: true });
  return list;
}

describe("perturbed fixtures", () => {
  const framed = PINNED.filter((entry): entry is { fixture: string; frame: PinnedFrame } => entry.frame !== null);

  it("perturb: every perturbed idle fixture gives the same interior or null, never a wrong one", () => {
    let checked = 0;
    let found = 0;
    const wrong: string[] = [];
    for (const { fixture, frame: pinned } of framed) {
      const rows = fixtureRows(fixture);
      const frame = findInputFrame(rows, IDLE)!;
      for (const perturbed of perturbations(rows, frame)) {
        checked++;
        const result = findInputFrame(perturbed.rows, IDLE);
        if (result === null) {
          if (perturbed.mustFind) wrong.push(`${fixture}: ${perturbed.name}: lost the frame`);
          continue;
        }
        found++;
        if (squash(result.interior.text) !== squash(pinned.text) || result.placeholder !== pinned.placeholder) {
          wrong.push(`${fixture}: ${perturbed.name}: ${JSON.stringify(result.interior.text)} (placeholder ${String(result.placeholder)})`);
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(framed.length * 5);
    expect(found).toBeGreaterThan(checked / 2);
  });

  it("perturb: a re-wrap at another width keeps most frames", () => {
    let kept = 0;
    for (const { fixture } of framed) {
      const rows = fixtureRows(fixture);
      const frame = findInputFrame(rows, IDLE)!;
      const rewrapped = perturbations(rows, frame).find((p) => p.name.startsWith("re-wrapped"))!;
      if (findInputFrame(rewrapped.rows, IDLE) !== null) kept++;
    }
    expect(kept).toBeGreaterThan(framed.length * 0.9);
  });

  it("perturb: dropping the bottom edge never closes a frame on a different interior", () => {
    for (const { fixture, frame: pinned } of framed) {
      const rows = fixtureRows(fixture);
      const dropped = [...rows.slice(0, pinned.bottom), ...rows.slice(pinned.bottom + 1)];
      const result = findInputFrame(dropped, IDLE);
      if (result !== null) expect(squash(result.interior.text), fixture).toBe(squash(pinned.text));
    }
  });
});

// ── The module itself ───────────────────────────────────────────────────────

const RULE = "─".repeat(40);
const dim = (text: string): AnsiSegment => ({ ...plainRun(text), dim: true });
const lines = (...texts: string[]): StyledLine[] => texts.map((text) => styled(plainRun(text)));

describe("findInputFrame", () => {
  it("finds the edges, the prompt row and the draft", () => {
    const frame = findInputFrame(lines("output", "", RULE, "❯ hello there", RULE, "  status"), IDLE)!;
    expect(frame.top).toBe(2);
    expect(frame.bottom).toBe(4);
    expect(frame.interior).toEqual({ first: 3, prompt: 3, last: 3, text: "hello there" });
    expect(frame.placeholder).toBe(false);
    expect(frame.label).toBeNull();
    expect(frame.volatile.status).toEqual({ first: 5, last: 5 });
    expect(frame.anchorsHit).toEqual(["top", "prompt", "draft", "bottom"]);
  });

  it("folds a wrapped draft back into one line", () => {
    const frame = findInputFrame(lines(RULE, "❯ a long draft that", "  wraps onto two rows", RULE), IDLE)!;
    expect(frame.interior.text).toBe("a long draft that wraps onto two rows");
    expect(frame.interior.last).toBe(2);
  });

  it("reads the label on the top edge", () => {
    const frame = findInputFrame(lines("──────── my-session ──", "❯ ", RULE), IDLE)!;
    expect(frame.label).toBe("my-session");
    expect(frame.anchorsHit).toContain("label");
  });

  it("marks a placeholder by its text and by its faint runs, and an empty box as neither", () => {
    expect(findInputFrame(lines(RULE, "❯ Press up to edit queued messages", RULE), IDLE)!.placeholder).toBe(true);
    const ghost = [styled(plainRun(RULE)), styled(plainRun("❯ "), dim("run the tests")), styled(plainRun(RULE))];
    const frame = findInputFrame(ghost, IDLE)!;
    expect(frame.placeholder).toBe(true);
    expect(frame.anchorsHit).toContain("placeholder-sgr");
    const mixed = [styled(plainRun(RULE)), styled(plainRun("❯ "), dim("run"), plainRun(" typed")), styled(plainRun(RULE))];
    expect(findInputFrame(mixed, IDLE)!.placeholder).toBe(false);
    expect(findInputFrame(lines(RULE, "❯", RULE), IDLE)!.placeholder).toBe(false);
    expect(findInputFrame(lines(RULE, "❯", RULE), IDLE)!.interior.text).toBe("");
  });

  it("marks a placeholder by its colours alone: a whole hole in the placeholder colour, no faint attribute (issue 510)", () => {
    // Muse paints the empty box's tip — and the model's prompt suggestion, whose words no text list
    // can name — in rgb(175,177,179) with no SGR 2, where typed text is rgb(31,35,40)
    // (muse--tip-loop.txt and muse--draft-single.txt). The profile names the colour, so a hole
    // painted in nothing else is a placeholder; one typed-colour run leaves it a draft.
    const MUSE = requireProfile("muse").idle;
    const GHOST = "rgb(175,177,179)";
    const TYPED = "rgb(31,35,40)";
    const box = (...rows: FrameRow[]): FrameRow[] => [{ segments: [{ text: RULE }] }, ...rows, { segments: [{ text: RULE }] }];
    const promptRow = (...runs: FrameRun[]): FrameRow => ({ segments: [{ text: "❯ ", fg: "rgb(236,177,0)" }, ...runs] });

    const hint = findInputFrame(box(promptRow({ text: "Run the test suite and fix any failures", fg: GHOST })), MUSE)!;
    expect(hint.placeholder).toBe(true);
    expect(hint.anchorsHit).toContain("placeholder-fg");
    expect(hint.interior.text).toBe("Run the test suite and fix any failures");

    const wrapped = findInputFrame(
      box(promptRow({ text: "Run the test suite and", fg: GHOST }), { segments: [{ text: "  fix any failures", fg: GHOST }] }),
      MUSE,
    )!;
    expect(wrapped.placeholder).toBe(true);

    const mixed = findInputFrame(box(promptRow({ text: "Run the test suite", fg: GHOST }, { text: "x", fg: TYPED })), MUSE)!;
    expect(mixed.placeholder).toBe(false);
    const typedUnder = findInputFrame(
      box(promptRow({ text: "Run the test suite and", fg: GHOST }), { segments: [{ text: "  then ship it", fg: TYPED }] }),
      MUSE,
    )!;
    expect(typedUnder.placeholder).toBe(false);
    const nearMiss = findInputFrame(box(promptRow({ text: "Run the test suite", fg: "rgb(175,176,180)" })), MUSE)!;
    expect(nearMiss.placeholder).toBe(false);
  });

  it("a faint marker in front of a real draft is not a placeholder", () => {
    const frame = findInputFrame([styled(plainRun(RULE)), styled(dim("❯ "), plainRun("real draft")), styled(plainRun(RULE))], IDLE)!;
    expect(frame.placeholder).toBe(false);
  });

  it("returns null for a half box, a dialog's cursor row and an indented edge", () => {
    expect(findInputFrame(lines(RULE, "❯ "), IDLE)).toBeNull();
    expect(findInputFrame(lines(RULE, " ❯ 1. Yes", "   2. No", RULE), IDLE)).toBeNull();
    expect(findInputFrame(lines(RULE, "❯ ", `  ${RULE}`), IDLE)).toBeNull();
    expect(findInputFrame(lines("short", "❯ ", "────"), IDLE)).toBeNull();
  });

  it("an indented rule or prompt inside the box is draft text", () => {
    const frame = findInputFrame(lines(RULE, "❯ pasted:", `  ${RULE}`, "  ❯ ls -la", RULE), IDLE)!;
    expect(frame.interior.text).toBe(`pasted: ${RULE} ❯ ls -la`);
  });

  it("tries only the lowest bottom edge", () => {
    // A box higher up is an echo; the lowest rule decides, and here it does not close.
    expect(findInputFrame(lines(RULE, "❯ old", RULE, "output", RULE), IDLE)).toBeNull();
  });

  it("stops at the tail bound", () => {
    const tail = Array.from({ length: IDLE.frame.maxTailRows }, (_, i) => `tail ${String(i)}`);
    expect(findInputFrame(lines(RULE, "❯ ", RULE, ...tail), IDLE)).not.toBeNull();
    expect(findInputFrame(lines(RULE, "❯ ", RULE, ...tail, "one more"), IDLE)).toBeNull();
  });

  it("knows shell mode's bang but not an ordinary !word", () => {
    expect(findInputFrame(lines(RULE, "! ls", RULE), IDLE)!.interior.text).toBe("ls");
    expect(findInputFrame(lines(RULE, "!important", RULE), IDLE)).toBeNull();
  });

  it("walks the statusline run and a footer divided off by a blank row", () => {
    const frame = findInputFrame(lines(RULE, "❯ ", RULE, "  model", "  hint", "", "● main", "◯ agent"), IDLE)!;
    expect(frame.volatile.status).toEqual({ first: 3, last: 4 });
    expect(frame.volatile.footer).toEqual({ first: 6, last: 7 });
    const tall = Array.from({ length: IDLE.volatile.below.maxRows + 1 }, (_, i) => `  status ${String(i)}`);
    const unwalked = findInputFrame(lines(RULE, "❯ ", RULE, ...tall), IDLE)!;
    expect(unwalked.volatile.status).toBeNull();
    expect(unwalked.volatile.footer).toBeNull();
  });

  // The 2026-10-16 incident on lane 8788: Claude Code 2.1.301's agents panel under the box, with a
  // hint row under the panel, did not walk, so the cues read the panel as a dialog.
  it("steps over the profile's named footer rows: the agents panel and its hints walk as a footer", () => {
    const status = ["  CTX:8%", "  [model] ~/project", "  ⏵⏵ bypass permissions on · 2 background tasks · ↓ to view · ← 11 agents"];
    const panel = ["  ● main", "  ◯ general-purpose   Reading a file     2m 3s · ↓ 120.1k tokens", "❯ ◯ fork-name   a task    31s · ↓ 40.2k tokens"];
    const frame = findInputFrame(lines(RULE, "❯ ", RULE, ...status, "", ...panel, "", "  ↓ to manage"), IDLE)!;
    expect(frame.volatile.status).toEqual({ first: 3, last: 5 });
    expect(frame.volatile.footer).toEqual({ first: 7, last: 11 });
    expect(frame.volatile.named.map((hit) => [hit.row, hit.name])).toEqual([
      [5, "tasks-view-hint"],
      [7, "agents-panel-main"],
      [8, "agents-panel-agent"],
      [9, "agents-panel-agent"],
      [11, "agents-panel-manage-hint"],
    ]);
  });

  it("a named run is at most footerMaxRows tall: a taller panel names nothing and walks as before", () => {
    const max = IDLE.volatile.below.footerMaxRows;
    const agentRows = (n: number) => Array.from({ length: n }, (_, i) => `  ◯ agent-${String(i)}   working    ${String(i)}s · ↓ 1k tokens`);
    const fits = findInputFrame(lines(RULE, "❯ ", RULE, "  model", "", "  ● main", ...agentRows(max - 1)), IDLE)!;
    expect(fits.volatile.status).toEqual({ first: 3, last: 3 });
    expect(fits.volatile.footer).toEqual({ first: 5, last: 4 + max });
    expect(fits.volatile.named).toHaveLength(max);
    const tall = findInputFrame(lines(RULE, "❯ ", RULE, "  model", "", "  ● main", ...agentRows(max)), IDLE)!;
    expect(tall.volatile.named).toEqual([]);
    expect(tall.volatile.status).toBeNull();
    // A panel straight under the box, with no statusline: the panel alone is the footer.
    const bare = findInputFrame(lines(RULE, "❯ ", RULE, "", "  ● main", "  ◯ agent   working   1s · ↓ 1k tokens"), IDLE)!;
    expect(bare.volatile.status).toBeNull();
    expect(bare.volatile.footer).toEqual({ first: 4, last: 5 });
  });

  it("a named run never makes rows that do not walk a statusline, and a failed walk names nothing", () => {
    const tall = Array.from({ length: IDLE.volatile.below.maxRows + 1 }, (_, i) => `  status ${String(i)}`);
    const frame = findInputFrame(lines(RULE, "❯ ", RULE, ...tall, "", "  ● main", "  ◯ agent   working   1s · ↓ 1k tokens"), IDLE)!;
    expect(frame.volatile.status).toBeNull();
    expect(frame.volatile.footer).toBeNull();
    expect(frame.volatile.named).toEqual([]);
  });

  it("no second footer walks over the named run: a dialog between the statusline and the panel fails the walk", () => {
    const panel = ["", "  ● main", "  ◯ agent   working   1s · ↓ 1k tokens"];
    const frame = findInputFrame(lines(RULE, "❯ ", RULE, "  ⏵⏵ auto mode on", "", " ❯ 1. Yes", "   2. No", ...panel), IDLE)!;
    expect(frame.volatile.status).toBeNull();
    expect(frame.volatile.footer).toBeNull();
    expect(frame.volatile.named).toEqual([]);
  });

  it("names a run only when it opens with the list's first entry and keeps the list's order", () => {
    const status = ["  ⏵⏵ auto mode on · 1 shell · ↓ to view", ""];
    // No `● main`: a list of `◯` rows under the box is not the panel.
    const popup = findInputFrame(lines(RULE, "❯ ", RULE, ...status, "  ◯ one", "  ◯ two"), IDLE)!;
    expect(popup.volatile.named).toEqual([]);
    // `● main` again under an agent row, or an agent row under the manage hint, breaks the order.
    expect(findInputFrame(lines(RULE, "❯ ", RULE, ...status, "  ● main", "  ◯ one", "  ● main"), IDLE)!.volatile.named).toEqual([]);
    expect(findInputFrame(lines(RULE, "❯ ", RULE, ...status, "  ● main", "  ↓ to manage", "  ◯ one"), IDLE)!.volatile.named).toEqual([]);
    // The view hint counts only on the mode row, the last statusline row.
    const ok = findInputFrame(lines(RULE, "❯ ", RULE, ...status, "  ● main", "  ◯ one"), IDLE)!;
    expect(ok.volatile.named.map((hit) => hit.name)).toEqual(["tasks-view-hint", "agents-panel-main", "agents-panel-agent"]);
    expect(findInputFrame(lines(RULE, "❯ ", RULE, "  pick one · ↓ to view", "", "  ● main", "  ◯ one"), IDLE)!.volatile.named.map((hit) => hit.name)).toEqual([
      "agents-panel-main",
      "agents-panel-agent",
    ]);
  });

  it("names the band over the top edge as volatile, bounded by the profile", () => {
    const above = Array.from({ length: 10 }, (_, i) => `row ${String(i)}`);
    const frame = findInputFrame(lines(...above, RULE, "❯ ", RULE), IDLE)!;
    expect(frame.volatile.above).toEqual({ first: 10 - IDLE.volatile.above.maxRows, last: 9 });
    expect(findInputFrame(lines(RULE, "❯ ", RULE), IDLE)!.volatile.above).toBeNull();
  });

  it("is stable: the same rows give the same frame, and a copy of them too", () => {
    for (const name of fixtureNames.filter(isClaudeFixture).slice(0, 40)) {
      const rows = fixtureRows(name);
      const copy: StyledLine[] = JSON.parse(JSON.stringify(rows));
      expect(findInputFrame(copy, IDLE)).toEqual(findInputFrame(rows, IDLE));
      expect(findInputFrame(rows, IDLE)).toEqual(findInputFrame(rows, IDLE));
    }
  });

  it("frameAt refuses a row that is no bottom edge", () => {
    const rows = plainRows([RULE, "❯ draft", RULE]);
    expect(frameAt(rows, 1, IDLE)).toBeNull();
    expect(frameAt(rows, 2, IDLE)?.interior.text).toBe("draft");
    expect(frameAt(rows, 9, IDLE)).toBeNull();
  });
});

describe("the Claude profile's frame bounds", () => {
  it("reach as far as the tallest thing drawn under a live box, the completion popup", () => {
    expect(IDLE.frame.maxTailRows).toBe(MAX_AUTOCOMPLETE_LINES);
  });

  it("bound the statusline run and the footer by the numbers ADR 0004 set", () => {
    expect(IDLE.volatile.below).toMatchObject({ maxRows: 8, footerMaxRows: 8 });
  });

  it("name the agents panel rows and hints as footer rows, and nothing else", () => {
    expect((IDLE.volatile.below.footerRows ?? []).map((row) => row.name)).toEqual([
      "agents-panel-main",
      "agents-panel-agent",
      "agents-panel-more",
      "agents-panel-manage-hint",
      "tasks-view-hint",
    ]);
  });
});

// M56 spec 14: the interior walk, for a harness whose box has side rows (and no rule on top) or no
// bottom row at all. The rows below are the OpenCode shape the profile reads.
describe("the interior walk (M56 spec 14)", () => {
  const OC = requireProfile("opencode").idle;
  const BOTTOM = `  ╹${"▀".repeat(30)}`;
  const box = (...rows: string[]): string[] => ["  ┃", ...rows, "  ┃", "  ┃  Build · Model Provider", BOTTOM, "   /work/dir                       1K (1%) · $0.00  ctrl+p"];

  it("finds a draft row and an empty box", () => {
    const frame = findInputFrame(lines("reply", "", ...box("  ┃  hello there")), OC)!;
    expect(frame.interior.text).toBe("hello there");
    expect(frame.top).toBe(2);
    const empty = findInputFrame(lines("reply", "", ...box("  ┃")), OC)!;
    expect(empty.interior.text).toBe("");
    expect(empty.placeholder).toBe(false);
  });

  it("joins the continuation rows of a wrapped draft", () => {
    const frame = findInputFrame(lines("", ...box("  ┃  first line", "  ┃  second line")), OC)!;
    expect(frame.interior.text).toBe("first line second line");
  });

  it("marks the placeholder by its prefix", () => {
    expect(findInputFrame(lines("", ...box("  ┃  Ask anything… \"Fix broken tests\"")), OC)!.placeholder).toBe(true);
  });

  it("does not take a quoted box far above the real one for part of it", () => {
    const frame = findInputFrame(lines("  ┃  quoted", "", "text", ...box("  ┃  real")), OC)!;
    expect(frame.interior.text).toBe("real");
  });

  it("finds no box in rows that only start with the side mark", () => {
    expect(findInputFrame(lines("  ┃  a", "  ┃  b", "output"), OC)).toBeNull();
  });
});

// M56 spec 14: a box with a blank prompt row and rules for edges (pi), the same shape as the gap
// between a notice and the real box, told apart by the row the harness draws under it.
describe("the interior walk on rules with no prompt glyph (M56 spec 14)", () => {
  const PI = requireProfile("pi").idle;
  const footer = ["/tmp/work (main)", "0.0%/200k (auto)    model • low"];

  it("finds an empty box, a draft and a padded draft", () => {
    expect(findInputFrame(lines("reply", RULE, "", RULE, ...footer), PI)!.interior.text).toBe("");
    expect(findInputFrame(lines("reply", RULE, "hello there", RULE, ...footer), PI)!.interior.text).toBe("hello there");
    expect(findInputFrame(lines(RULE, "  line one", "  line two", RULE, ...footer), PI)!.interior.text).toBe("line one line two");
  });

  it("reads the Working label on the top rule", () => {
    const frame = findInputFrame(lines("reply", "── ⠴ Working ──────────────", "", RULE, ...footer), PI)!;
    expect(frame.label).toBe("⠴ Working");
  });

  it("refuses a rule pair whose bottom has no status line under it", () => {
    // The real box lost its bottom rule: the gap between the notice and the box top is not a box.
    expect(findInputFrame(lines(RULE, "Update Available", RULE, "", RULE, "typed draft", ...footer), PI)).toBeNull();
  });

  it("takes a painted status line an extension draws in pi's place, never a plain one (issue 485)", () => {
    // `ctx.ui.setFooter`: the row under the box starts with the model, not a path, in pi's own paint.
    const custom = "GLM 5.3 (full — primary) │ nvidia #6 · 40/40 │ ~/fleet-v2/personal";
    const painted = (text: string): StyledLine => styled({ ...plainRun(text), fg: "#7e8197" });
    const box = [...lines("reply", RULE, ""), ...lines(RULE)];
    expect(findInputFrame([...box, painted(custom), styled(dim("  thinking: high · bypass (F9)"))], PI)!.interior.text).toBe("");
    expect(findInputFrame([...box, styled(dim(custom))], PI)).not.toBeNull();
    expect(findInputFrame([...box, ...lines(custom)], PI)).toBeNull();
    // The torn read stays refused with that footer too: the plain draft row is what sits under the gap.
    expect(findInputFrame([...lines(RULE, "Update Available", RULE, "", RULE, "typed draft"), painted(custom)], PI)).toBeNull();
  });

  it("reads stock pi 1.3.0 under its own custom-footer example, empty and with a draft (issue 485)", () => {
    expect(findInputFrame(fixtureRows("pi--v130-custom-footer-idle.txt"), PI)!.interior.text).toBe("");
    expect(findInputFrame(fixtureRows("pi--v130-custom-footer-draft.txt"), PI)!.interior.text).toBe("hello from the probe");
    // Without the flag the profile read neither: the footer row starts with `↑`, not a path.
    const strict: typeof PI = { ...PI, frame: { ...PI.frame, underPainted: false } };
    expect(findInputFrame(fixtureRows("pi--v130-custom-footer-idle.txt"), strict)).toBeNull();
  });

  it("takes a painted row only as a footer: straight under the box, one run to the screen's end (issue 485)", () => {
    const custom = "GLM 5.3 (full — primary) │ nvidia #6 · 40/40";
    const painted = (text: string): StyledLine => styled({ ...plainRun(text), fg: "#7e8197" });
    const box = [...lines("reply", RULE, ""), ...lines(RULE)];
    // A blank row between the rule and the painted row: pi sets a picker's list apart that way.
    expect(findInputFrame([...box, ...lines(""), painted(custom)], PI)).toBeNull();
    // A gap inside the run: the run does not reach the screen's end.
    expect(findInputFrame([...box, painted(custom), ...lines(""), painted(custom)], PI)).toBeNull();
    // Taller than the status bound (`idle.volatile.below.maxRows`) is a list, not a footer.
    const rows = (n: number): StyledLine[] => Array.from({ length: n }, (_, i) => painted(`• item ${i}`));
    expect(findInputFrame([...box, ...rows(PI.volatile.below.maxRows)], PI)).not.toBeNull();
    expect(findInputFrame([...box, ...rows(PI.volatile.below.maxRows + 1)], PI)).toBeNull();
  });

  it("never reads a picker cut by the pane's bottom as a box, though pi paints its list rows (issue 485)", () => {
    // OmO's /tree on a short pane: the header between the top rule and an inner rule, a blank row,
    // then painted list rows to the last row (fixtures README, "Derived, not captured"). Any painted
    // row read it as a box holding the header, so a Replace from the phone typed into the tree's search.
    expect(findInputFrame(fixtureRows("pi--omo-v5130-panel-picker-tree-cut.txt"), PI)).toBeNull();
    for (const [name, end] of [["pi--omo-v5130-picker-tree.txt", 12], ["pi--v110-stock-picker-tree.txt", 33]] as const) {
      expect(findInputFrame(fixtureRows(name).slice(0, end), PI), name).toBeNull();
    }
  });

  it("cuts the text a side panel draws on the prompt row", () => {
    const row = `❯${" ".repeat(40)}facts 4 queued`;
    expect(findInputFrame(lines(RULE, row, RULE, ...footer), PI)!.interior.text).toBe("");
  });

  it("stops at 30 rows: a taller rule pair is a dialog, not a draft", () => {
    const body = Array.from({ length: 35 }, (_, i) => `item ${String(i)}`);
    expect(findInputFrame(lines(RULE, ...body, RULE, ...footer), PI)).toBeNull();
  });
});

// M56 spec 14: OMP lets the person pick the border style, so its profile names five frame shapes.
describe("frame alternates (M56 spec 14)", () => {
  const OMP = requireProfile("omp").idle;
  const status = " π · ⬢ no-model · 🗑 sandbox · ⑂ master";
  const top = " π > ◒ Haiku 4.5 > 📁 ~/work > ⑂ master ?1 ▶──4%──────────";

  it("finds the open box: a status row on top, the prompt row `╰─`, and indented rows after it", () => {
    const frame = findInputFrame(lines("reply", "", top, "╰─ first line", "   second line"), OMP)!;
    expect(frame.interior.text).toBe("first line second line");
    expect(frame.top).toBe(2);
    expect(findInputFrame(lines("reply", "", top, "╰─"), OMP)!.interior.text).toBe("");
  });

  it("finds the old open box with `│` rows and the prompt row last", () => {
    const rows = lines("reply", "╭── π  > ⬢ Auto > ⑂ master ▶────────", "│  wrapped draft row", "╰─ end");
    expect(findInputFrame(rows, OMP)!.interior.text).toBe("wrapped draft row end");
  });

  it("finds the rule pair with a `❯` prompt row, the rule line with no bottom rule, and the borderless box", () => {
    expect(findInputFrame(lines("reply", RULE, "❯ hello", RULE, status), OMP)!.interior.text).toBe("hello");
    expect(findInputFrame(lines("reply", RULE, "❯ hello", "", status), OMP)!.interior.text).toBe("hello");
    expect(findInputFrame(lines("reply", RULE, "", "❯ hello", status), OMP)!.interior.text).toBe("hello");
    expect(findInputFrame(lines("reply", RULE, "", RULE, status), OMP)!.interior.text).toBe("");
  });

  it("cuts the right-hand hint off the prompt row", () => {
    const hint = `❯${" ".repeat(60)}⇧⇥ to change thinking effort`;
    expect(findInputFrame(lines("reply", RULE, hint, RULE, status), OMP)!.interior.text).toBe("");
  });

  it("finds no box in a plain transcript", () => {
    expect(findInputFrame(lines("a", "   indented", "b"), OMP)).toBeNull();
  });

  // Hermes draws no rule under its input below 64 columns, and its rule spans the pane. Its open box
  // walks up from the screen's last row over draft rows only: a box edge or a rule of 64 cells or more
  // ends the walk with no box. A wide pane caught without its bottom rule is no box, and neither is a
  // picker between a reply's short rule and the prompt.
  it("walks Hermes's open box over draft rows only", () => {
    const HERMES = requireProfile("hermes").idle;
    expect(findInputFrame(lines("reply", "─".repeat(60), "❯ hello", "world"), HERMES)!.interior.text).toBe("hello world");
    expect(findInputFrame(lines("reply", "─".repeat(63), "❯ hello"), HERMES)!.interior.text).toBe("hello");
    expect(findInputFrame(lines("reply", "─".repeat(64), "❯ hello"), HERMES)).toBeNull();
    expect(findInputFrame(lines(RULE, "╭─ ⚙ Model Picker ─╮", "╰──────────────────╯", "─".repeat(80), "❯ hello"), HERMES)).toBeNull();
    expect(findInputFrame(lines("reply", "─".repeat(80), "❯ hello", "─".repeat(80)), HERMES)!.interior.text).toBe("hello");
  });

  // Hermes's input is at most eight rows (`_estimate_tui_input_height`, max_height=8); a longer
  // draft scrolls inside them and its prompt row leaves the screen, so no taller box is read. The
  // edges walk counts the rows under the prompt row (7), the open box's walk all of its rows (8).
  it("reads Hermes's box up to its eight input rows, wide and narrow", () => {
    const HERMES = requireProfile("hermes").idle;
    const draft = (n: number): string[] => ["❯ r1", ...Array.from({ length: n - 1 }, (_, i) => `r${String(i + 2)}`)];
    const eight = "r1 r2 r3 r4 r5 r6 r7 r8";
    expect(findInputFrame(lines("reply", "─".repeat(80), ...draft(8), "─".repeat(80)), HERMES)!.interior.text).toBe(eight);
    expect(findInputFrame(lines("reply", "─".repeat(60), ...draft(8)), HERMES)!.interior.text).toBe(eight);
    expect(findInputFrame(lines("reply", "─".repeat(80), ...draft(9), "─".repeat(80)), HERMES)).toBeNull();
    expect(findInputFrame(lines("reply", "─".repeat(60), ...draft(9)), HERMES)).toBeNull();
  });
});

// Issue 497 (omp 18.11.3, the box composer, captured 2026-10-18): the box draws its right border on
// every draft row, a wrapped row ends in `│` or `─╯` with fewer than eight spaces before it, and the
// word completion paints a ghost suffix after the cursor. The draft reads as typed all the same.
describe("omp 18.11's box composer (issue 497)", () => {
  const OMP = requireProfile("omp").idle;
  const squeeze = (text: string): string => text.replace(/\s+/gu, "");
  const WRAP =
    "Collie wrap probe: the quick brown fox jumps over the lazy dog while the phone sends a long single line that must wrap " +
    "across two rows of the omp box at one hundred and thirty columns wide, ending here.";
  const TWO = "First line of a two-line draft. Second line of the same draft.";
  const PATH =
    "look at /tmp/c497/uploads/w1-mx7k2p-1a2b3c4d-and-a-long-tail-so-the-path-fills-the-row-to-the-right-border-" +
    "0123456789abcdef0123456789abcdef.png please";
  const DRAFTS = [
    { fixture: "omp--v18-11-nerd-box-wrapped--w130.txt", typed: WRAP },
    { fixture: "omp--v18-11-nerd-box-wrapped--w80.txt", typed: WRAP },
    { fixture: "omp--v18-11-nerd-box-two-lines--w130.txt", typed: TWO },
    { fixture: "omp--v18-11-nerd-box-two-lines--w80.txt", typed: TWO },
    { fixture: "omp--v18-11-nerd-box-path-text--w130.txt", typed: PATH },
    { fixture: "omp--v18-11-nerd-box-path-text--w80.txt", typed: PATH },
    { fixture: "omp--v18-11-nerd-ghost-word--w130.txt", typed: "please push" },
    { fixture: "omp--v18-11-nerd-ghost-word--w80.txt", typed: "please push" },
    { fixture: "omp--v18-11-ghost-word--w130.txt", typed: "please push" },
  ];

  it.each(DRAFTS)("$fixture: the draft reads as typed, no right border and no ghost word in it", ({ fixture, typed }) => {
    const frame = findInputFrame(fixtureRows(fixture), OMP);
    expect(frame).not.toBeNull();
    expect(frame!.placeholder).toBe(false);
    expect(squeeze(frame!.interior.text)).toBe(squeeze(typed));
  });

  // The ghost rule, on one prompt row built as omp paints it: `╰─ `, the draft in the text colour, the
  // word completion in the titanium theme's `dim` (#6b7280), padding, and the border in the accent.
  const TEXT = "rgb(229,229,231)";
  const GHOST = "rgb(107,114,128)";
  const BORDER = "rgb(0,180,255)";
  const TOP: FrameRow = { segments: [{ text: "╭── π > ◒ Haiku 4.5 ▶────────────────────────╮", fg: BORDER }] };
  const box = (...runs: FrameRun[]): FrameRow[] => [
    { segments: [{ text: "an answer" }] },
    { segments: [] },
    TOP,
    { segments: [{ text: "╰─ ", fg: BORDER }, ...runs, { text: "        " }, { text: "─╯", fg: BORDER }] },
  ];
  const read = (rows: FrameRow[], idle = OMP): string | undefined => findInputFrame(rows, idle)?.interior.text;

  it("cuts the word completion after the draft: the profile's colour, letters only, straight after a draft letter", () => {
    expect(read(box({ text: "please push", fg: TEXT }, { text: "ed", fg: GHOST }))).toBe("please push");
    expect(read(box({ text: "please push" }, { text: "ed", fg: GHOST }))).toBe("please push");
  });

  it("keeps a run that misses any test, so the box reads more than was typed and the send stops", () => {
    const kept: [string, FrameRun[], string][] = [
      ["another colour (an older theme's dim)", [{ text: "please push", fg: TEXT }, { text: "ed", fg: "rgb(111,115,119)" }], "please pushed"],
      ["the colour with the dim attribute", [{ text: "please push", fg: TEXT }, { text: "ed", fg: GHOST, dim: true }], "please pushed"],
      ["the colour in italics", [{ text: "please push", fg: TEXT }, { text: "ed", fg: GHOST, italic: true }], "please pushed"],
      ["a run with punctuation", [{ text: "please push", fg: TEXT }, { text: "ed!", fg: GHOST }], "please pushed!"],
      ["a run with a space in it", [{ text: "please push", fg: TEXT }, { text: "ed now", fg: GHOST }], "please pushed now"],
      ["a run after a space", [{ text: "please ", fg: TEXT }, { text: "push", fg: GHOST }], "please push"],
      ["a run in the draft's own style", [{ text: "please push", fg: GHOST }, { text: "ed", fg: GHOST }], "please pushed"],
      ["a run with text after it", [{ text: "please push", fg: TEXT }, { text: "ed", fg: GHOST }, { text: " now", fg: TEXT }], "please pushed now"],
      ["the whole draft", [{ text: "pushed", fg: GHOST }], "pushed"],
    ];
    for (const [name, runs, text] of kept) expect(read(box(...runs)), name).toBe(text);
  });

  it("keeps a run in the colour that ends a row the draft goes on past", () => {
    const rows: FrameRow[] = [
      { segments: [{ text: "an answer" }] },
      TOP,
      { segments: [{ text: "│  ", fg: BORDER }, { text: "please push", fg: TEXT }, { text: "ed", fg: GHOST }, { text: "     " }, { text: "│", fg: BORDER }] },
      { segments: [{ text: "╰─ ", fg: BORDER }, { text: "the branch", fg: TEXT }, { text: "     " }, { text: "─╯", fg: BORDER }] },
    ];
    expect(read(rows)).toBe("please pushed the branch");
  });

  it("keeps the run on a profile that names no ghost colour", () => {
    const { inlineHint, ...bare } = OMP;
    void inlineHint;
    expect(read(box({ text: "please push", fg: TEXT }, { text: "ed", fg: GHOST }), bare)).toBe("please pushed");
  });
});
