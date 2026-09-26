import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { emittableKeys } from "../conformance";
import { parseKeyHintFooter } from "../menu-hints";
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
//   `knownRaw`      — the screen shows a dialog a correct pipeline would lift, and the pipeline
//                     returns only raw blocks today. The reason names the CANDIDATE GRAMMAR that
//                     would claim the screen; `actualToday` pins the reading beside it.
//   `knownKeyGap`   — the right KIND is lifted, and the keys it emits are not the keys the screen
//                     offers. `actualKeys` pins the set it emits today.
//
// Every entry also declares `expected.blockKind`, the kind a CORRECT pipeline would lift from that
// screen, and `expected.keys` where that kind is interactive — the keystrokes the screen itself
// offers, written from the screen and spelled the way Collie sends them (so `Esc to cancel` is
// `Escape`, and a token Herdr cannot send, like `space` or `?`, is not a key). The deletion ritual is
// the one above and applies here unchanged: when a grammar lands for a `knownRaw` or `knownKeyGap`
// screen its assertion goes red, and the repair is to DELETE `knownRaw` / `knownKeyGap` /
// `actualKeys` (and lower the pinned count in the describe below), never to edit `expected`.
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

type BlockKindName =
  | "raw"
  | "menu"
  | "prompt-select"
  | "wizard"
  | "preview-select"
  | "multi-select"
  | "autocomplete";

interface Expectation extends Reading {
  dialogLive: boolean;
  blockKind: BlockKindName;
  keys?: string[];
}

interface Entry {
  fixture: string;
  cols: number;
  rows: number;
  state: string;
  notes: string;
  expected: Expectation;
  knownStall?: string;
  knownTailGap?: string;
  knownRaw?: string;
  knownKeyGap?: string;
  actualToday?: Reading;
  actualKeys?: string[];
}

// SAFETY: the JSON is generated from the lab manifest and hand-edited only in the shapes `Entry`
// names; the lockstep test below re-checks the one field the rest of the file depends on (`fixture`)
// against the directory, and every other field is asserted per entry.
const ENTRIES: Entry[] = table.entries as Entry[];
const KINDS = new Set<string>([
  "raw",
  "menu",
  "prompt-select",
  "wizard",
  "preview-select",
  "multi-select",
  "autocomplete",
]);
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
/** The LAST non-raw block the pipeline lifted, which is the one a pane would put its buttons under. */
function lifted(lines: StyledLine[]) {
  return claudeBuildBlocks(lines)
    .toReversed()
    .find((b) => b.kind !== "raw");
}
/** The screen's own last line, the row a key-hint footer would be on. */
function lastNonBlankLine(lines: StyledLine[]): string {
  return lines.map(lineText).toReversed().find((t) => t.trim().length > 0) ?? "";
}

describe("the table and the fixture directory stay in lockstep", () => {
  it("every promoted fixture has a table entry, and every entry has a fixture", () => {
    expect(ENTRIES.map((e) => e.fixture).toSorted()).toEqual(LAB_FIXTURES);
  });

  it("every entry declares the block kind its screen shows", () => {
    for (const entry of ENTRIES) {
      expect(entry.expected.blockKind, entry.fixture).toBeDefined();
      expect(KINDS.has(entry.expected.blockKind), `${entry.fixture}: ${entry.expected.blockKind}`).toBe(true);
    }
  });

  it("the corpus is not vacuous", () => {
    expect(ENTRIES.length).toBe(66);
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

describe("the pipeline lifts the kind the screen shows", () => {
  // The kinds are written from the SCREEN, so this describe is a check and not a mirror of the code.
  // An entry carrying `knownRaw` is pinned as it behaves TODAY instead, exactly as `knownStall` is.
  const LIFTS = ENTRIES.filter((e) => e.knownRaw === undefined);
  const RAW_GAPS = ENTRIES.filter((e) => e.knownRaw !== undefined);
  const KEY_GAPS = ENTRIES.filter((e) => e.knownKeyGap !== undefined);

  it("the check is not vacuous", () => {
    expect(LIFTS.filter((e) => e.expected.blockKind !== "raw").length).toBeGreaterThan(10);
    expect(new Set(ENTRIES.map((e) => e.expected.blockKind)).size).toBeGreaterThan(2);
  });

  it("keys never contain a digit on a menu (.adr/0009)", () => {
    // Scoped to `menu`: a prompt-select's option keys ARE digits, and `emittableKeys` walks them as
    // the model's own. The ban is on a GENERIC MENU synthesising one the screen never named.
    for (const entry of ENTRIES) {
      if (entry.expected.blockKind !== "menu") continue;
      for (const key of entry.expected.keys ?? []) {
        expect(/\d/.test(key), `${entry.fixture}: ${key}`).toBe(false);
      }
    }
    expect(ENTRIES.filter((e) => e.expected.blockKind === "menu").length).toBeGreaterThan(4);
  });

  it("every interactive entry declares the keys its screen offers", () => {
    for (const entry of ENTRIES) {
      if (entry.expected.blockKind === "raw" || entry.expected.blockKind === "autocomplete") {
        expect(entry.expected.keys, entry.fixture).toBeUndefined();
        continue;
      }
      expect(entry.expected.keys, entry.fixture).toBeDefined();
      expect(entry.expected.keys, entry.fixture).toEqual(entry.expected.keys!.toSorted());
      expect(entry.expected.keys!.length, entry.fixture).toBeGreaterThan(0);
    }
  });

  it.each(LIFTS.map((e) => [e.fixture, e] as const))("%s", (_name, entry) => {
    const block = lifted(load(entry.fixture));
    if (entry.expected.blockKind === "raw") {
      expect(block, entry.fixture).toBeUndefined();
      return;
    }
    expect(block?.kind, entry.fixture).toBe(entry.expected.blockKind);
    // A key gap pins what it emits today; every other entry is held to the screen's own keys.
    const want = entry.knownKeyGap === undefined ? entry.expected.keys : entry.actualKeys;
    if (want === undefined) return;
    expect(new Set(emittableKeys(block!) ?? []), entry.fixture).toEqual(new Set(want));
  });

  it("every knownRaw carries a reason naming a candidate grammar, and pins its reading", () => {
    // Four: the seven the register in M34 spec 03 argues, plus the 40-column /tasks panel the
    // 2026-09-22 capture-lab run added, less the WebFetch dialog and the three plan-approval
    // captures the 2026-09-26 grammar work lifted. When a grammar lands, the repair is to delete that
    // entry's `knownRaw` and its `actualToday`, and to lower this number.
    expect(RAW_GAPS.length).toBe(4);
    for (const entry of RAW_GAPS) {
      expect(entry.knownRaw!.length, entry.fixture).toBeGreaterThan(40);
      expect(entry.expected.blockKind, entry.fixture).not.toBe("raw");
      expect(entry.actualToday, entry.fixture).toBeDefined();
      expect(read(load(entry.fixture)), entry.fixture).toEqual(entry.actualToday);
    }
  });

  it.each(RAW_GAPS.map((e) => [e.fixture, e] as const))("raw today: %s", (_name, entry) => {
    expect(claudeBuildBlocks(load(entry.fixture)).every((b) => b.kind === "raw"), entry.fixture).toBe(true);
  });

  it("every knownKeyGap carries a reason and a key set that really differs", () => {
    for (const entry of KEY_GAPS) {
      expect(entry.knownKeyGap!.length, entry.fixture).toBeGreaterThan(40);
      expect(entry.actualKeys, entry.fixture).toBeDefined();
      expect(entry.expected.keys, entry.fixture).toBeDefined();
      expect(new Set(entry.actualKeys!), entry.fixture).not.toEqual(new Set(entry.expected.keys!));
    }
  });
});

describe("an unread dialog is never silently raw", () => {
  // THE INVARIANT. No composer, a last line that names the screen's own keys, and nothing but raw
  // blocks: that is a modal Collie could drive and did not. Only a declared `knownRaw` is exempt.
  const REACHED = ENTRIES.filter((entry) => {
    const lines = load(entry.fixture);
    return !hasInputBox(lines) && parseKeyHintFooter(lastNonBlankLine(lines)).length > 0;
  });
  const RAW_ONLY = REACHED.filter((entry) =>
    claudeBuildBlocks(load(entry.fixture)).every((b) => b.kind === "raw"),
  );

  it("the invariant is not vacuous: a screen that names its keys IS driven", () => {
    expect(REACHED.length).toBeGreaterThan(4);
    expect(REACHED.length - RAW_ONLY.length).toBeGreaterThan(0);
    // The /effort slider is the named witness: no box, a key-hint footer, and a menu with buttons.
    expect(REACHED.map((e) => e.fixture)).toContain("claude-lab--menu-effort-slider--w82.txt");
    expect(RAW_ONLY.map((e) => e.fixture)).not.toContain("claude-lab--menu-effort-slider--w82.txt");
  });

  it("the exemptions are exactly the two agents-screen captures", () => {
    expect(RAW_ONLY.map((e) => e.fixture).toSorted()).toEqual([
      "claude-lab--agents-screen--w40.txt",
      "claude-lab--agents-screen--w82.txt",
    ]);
  });

  it.each(ENTRIES.map((e) => [e.fixture, e] as const))("%s", (_name, entry) => {
    const lines = load(entry.fixture);
    if (hasInputBox(lines)) return;
    if (parseKeyHintFooter(lastNonBlankLine(lines)).length === 0) return;
    if (!claudeBuildBlocks(lines).every((b) => b.kind === "raw")) return;
    expect(entry.knownRaw, `${entry.fixture} is an unread dialog with no declared gap`).toBeDefined();
  });
});

describe("the recorded version has a consumer", () => {
  // `claudeCodeVersion` had no consumer before this: a stale corpus was visible only to a ritual
  // nobody ran (tracker M34 spec 05). This does NOT compare against the machine's own Claude Code
  // version — CI has no Claude Code installed. That comparison is the ritual's first step
  // (`.tracker/rituals/claude-capture-lab/ritual.md`); this test only makes sure the corpus's
  // version stamp is present, well-formed, and matches the copy the README states for a human.
  it("claudeCodeVersion is a version string that matches the fixtures README's capture-lab heading", () => {
    const version = table.claudeCodeVersion;
    expect(version).toBeDefined();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);

    const readme = readFileSync(join(PANES_DIR, "README.md"), "utf8");
    const heading = readme
      .split("\n")
      .find((line) => line.startsWith("## Capture lab corpus"));
    expect(heading, "the fixtures README must carry a 'Capture lab corpus' heading").toBeDefined();
    expect(heading).toContain(version);
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
