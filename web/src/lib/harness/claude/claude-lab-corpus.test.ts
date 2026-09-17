import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines, type StyledLine } from "../../blocks";
import { detectAutocompleteRegion } from "./autocomplete";
import { extractInputDraft, extractStatusLines, hasInputBox, inputBoxTail, stripChrome } from "./chrome";
import { claudeBuildBlocks } from "./index";
import table from "./claude-lab-corpus.json";

// THE CAPTURE-LAB CORPUS GATE (tracker M31 spec 05).
//
// 64 captures taken from a real Claude Code 2.1.274 session in a throwaway Herdr session, at widths
// from 40 to 200 columns, promoted into fixtures/panes as `claude-lab--*.txt`. Two more the lab
// recommended, the 82-column Edit-permission screens, were NOT promoted — see the README section
// for this corpus: nothing on either screen names Claude, so agy's adapter claims their numbered
// options and the cross-adapter fail-closed contract cannot hold while they are on disk. The table beside this
// file (`claude-lab-corpus.json`) carries, per capture, the reading a CORRECT locator would produce
// — written from the screen, not from what the code does — plus, where today's locator does not
// produce it, one field naming the gap.
//
// The three things this file is for:
//
//   (a) CRITICAL. On every capture the lab marked `dialogLive`, the locator reports NO box. A live
//       dialog owns the keyboard; a box found under one is a send typed into a modal. Zero such
//       screens is the named success criterion of the whole milestone, and this is where it is
//       checked mechanically.
//   (b) On every capture with a real box and no recorded gap, the locator finds that box, with the
//       expected draft and the expected tail label.
//   (c) A capture WITH a recorded gap is asserted to behave the way it behaves TODAY. That is
//       deliberate. When a fix lands, one of these assertions goes red, and the intended repair is
//       to DELETE the `knownStall` / `knownTailGap` / `actualToday` fields from that entry so it
//       joins (b). A red line here is the signal, not a failure to paper over.
//
// The two gap fields mean different things:
//   `knownStall`    — the locator reports no box on a screen that has one. A send stalls there.
//   `knownTailGap`  — the box and the draft are read correctly, only the tail LABEL differs, so the
//                     rows stay on the raw mirror instead of becoming a list. No send stalls.
//
// WHY THE PREFIX IS `claude-lab--` AND NOT `claude--`. Six suites glob `claude--*.txt` and check the
// whole Claude corpus against a hand-curated table: the box/no-box parity list in
// input-box-frame.test.ts, the reading table in chrome.test.ts, the neutral cohort in
// conformance.test.ts, prompt-binding-contract.test.ts, and the two cross-adapter fail-closed
// cohorts. Each of those rows was a per-fixture judgement. Pouring 66 machine-promoted captures into
// them at once would have tripled every table in one mechanical edit and buried the real signals
// those tables exist to raise. This corpus carries its own table and its own gate instead. The
// fixtures are ordinary Claude captures and any of them may be promoted into `claude--` by hand,
// one at a time, when a suite there wants it.

interface Reading {
  hasInputBox: boolean;
  draft: string | null;
  tail: string | null;
}

interface Entry {
  fixture: string;
  cols: number;
  rows: number;
  state: string;
  notes: string;
  expected: Reading & { dialogLive: boolean };
  knownStall?: string;
  knownTailGap?: string;
  actualToday?: Reading;
}

// SAFETY: the JSON is generated from the lab manifest and hand-edited only in the shapes `Entry`
// names; the lockstep test below re-checks the one field the rest of the file depends on (`fixture`)
// against the directory, and every other field is asserted per entry.
const ENTRIES: Entry[] = table.entries as Entry[];
const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const LAB_FIXTURES = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("claude-lab--") && f.endsWith(".txt"))
  .toSorted();

function load(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}
function read(lines: StyledLine[]): Reading {
  return { hasInputBox: hasInputBox(lines), draft: extractInputDraft(lines), tail: inputBoxTail(lines) };
}

describe("the table and the fixture directory stay in lockstep", () => {
  it("every promoted fixture has a table entry, and every entry has a fixture", () => {
    expect(ENTRIES.map((e) => e.fixture).toSorted()).toEqual(LAB_FIXTURES);
  });

  it("the corpus is not vacuous", () => {
    expect(ENTRIES.length).toBe(64);
    expect(new Set(ENTRIES.map((e) => e.cols))).toEqual(new Set([40, 41, 60, 82, 83, 120, 200]));
    expect(new Set(ENTRIES.map((e) => e.state)).size).toBeGreaterThan(25);
  });
});

describe("CRITICAL: no box is ever reported while a dialog is live", () => {
  const LIVE = ENTRIES.filter((e) => e.expected.dialogLive);

  it("the check is not vacuous", () => {
    expect(LIVE.length).toBeGreaterThan(12);
  });

  it.each(LIVE.map((e) => [e.fixture, e] as const))("%s", (_name, entry) => {
    const lines = load(entry.fixture);
    expect(hasInputBox(lines)).toBe(false);
    expect(extractInputDraft(lines)).toBeNull();
  });
});

describe("a real box is found, with its draft and its tail", () => {
  const CLEAN = ENTRIES.filter(
    (e) => e.expected.hasInputBox && e.knownStall === undefined && e.knownTailGap === undefined,
  );

  it("the check is not vacuous", () => {
    expect(CLEAN.length).toBeGreaterThan(40);
  });

  it.each(CLEAN.map((e) => [e.fixture, e] as const))("%s", (_name, entry) => {
    const { hasInputBox: box, draft, tail } = entry.expected;
    expect(read(load(entry.fixture))).toEqual({ hasInputBox: box, draft, tail });
  });
});

describe("the gaps this corpus found, pinned as they behave today", () => {
  // Deleting an entry's gap fields when the fix lands is the intended signal. See the header.
  const GAPS = ENTRIES.filter((e) => e.knownStall !== undefined || e.knownTailGap !== undefined);

  it("every gap carries a reason and the reading it pins", () => {
    for (const entry of GAPS) {
      const reason = entry.knownStall ?? entry.knownTailGap!;
      expect(reason.length, entry.fixture).toBeGreaterThan(40);
      expect(entry.actualToday, entry.fixture).toBeDefined();
    }
  });

  it.each(GAPS.map((e) => [e.fixture, e] as const))("%s", (_name, entry) => {
    expect(read(load(entry.fixture))).toEqual(entry.actualToday);
    // A stall really is a stall: the truth table says there is a box and the locator says there is not.
    if (entry.knownStall !== undefined) {
      expect(entry.expected.hasInputBox).toBe(true);
      expect(entry.actualToday!.hasInputBox).toBe(false);
    }
    // A tail gap is only a label: the box and the draft still read correctly.
    if (entry.knownTailGap !== undefined) {
      expect(entry.actualToday!.hasInputBox).toBe(entry.expected.hasInputBox);
      expect(entry.actualToday!.draft).toBe(entry.expected.draft);
      expect(entry.actualToday!.tail).not.toBe(entry.expected.tail);
    }
  });
});

describe("every promoted fixture parses through the public surface", () => {
  it.each(LAB_FIXTURES)("%s", (name) => {
    const lines = load(name);
    expect(lines.length).toBeGreaterThan(0);
    expect(() => {
      hasInputBox(lines);
      inputBoxTail(lines);
      extractInputDraft(lines);
      extractStatusLines(lines);
      stripChrome(lines);
      detectAutocompleteRegion(lines);
      claudeBuildBlocks(lines);
    }).not.toThrow();
    // The block pipeline always answers with at least one block, whatever it made of the screen.
    expect(claudeBuildBlocks(lines).length).toBeGreaterThan(0);
  });
});
