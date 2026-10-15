import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { fixtureRows, readScreen, rowsOf, SURFACE_FIXTURES_DIR } from "../../test/surface-corpus";
import { CLUSTER_GAP_ROWS, isKeyHintRow, isRunningRow, isSingleKeyRow, readCues } from "./cues";
import { findInputFrame, plainRows } from "./frame";
import { requireProfile } from "./profile";
import { isFree } from "./surface";

// M56 spec 04: the generic modal cues, and test (c) of the design record: transcripts that quote
// numbered lists, pointer glyphs and "Enter to confirm" text stay free, because the cues anchor to
// the bottom cluster. The three transcript fixtures in fixtures/surface/ are real idle screens with a
// quoted dialog spliced into the transcript (fixtures/panes/README.md says how each was built).

const IDLE = requireProfile("claude").idle;
const RULE = "─".repeat(60);

const TRANSCRIPTS = readdirSync(SURFACE_FIXTURES_DIR)
  .filter((name) => name.includes("transcript"))
  .toSorted();

describe("quoted dialogs in a transcript", () => {
  it("transcript: three fixtures built from real idle screens", () => {
    expect(TRANSCRIPTS).toHaveLength(3);
  });

  for (const name of TRANSCRIPTS) {
    it(`transcript: ${name} stays free`, () => {
      const rows = fixtureRows(name, SURFACE_FIXTURES_DIR);
      const read = readScreen(rows, "claude", IDLE);
      expect(read.frame).not.toBeNull();
      expect(read.cues?.strength).toBe("none");
      expect(isFree(read.surface)).toBe(true);
      // The quote is a dialog shape: read with no frame, the cues see it.
      expect(readCues(rows.slice(0, read.frame!.top - 2), null).strength).toBe("strong");
    });
  }

  it("transcript: the captured lookalike (a quoted list and Enter to select) stays free", () => {
    const read = readScreen(fixtureRows("claude-lab--transcript-dialog-lookalike--w82.txt"), "claude", IDLE);
    expect(isFree(read.surface)).toBe(true);
  });

  it("transcript: a weak shape flush on the box is a quote and stays free", () => {
    const rows = rowsOf(["● Two steps:", "  1. build", "  2. test", RULE, "❯ ", RULE, "  model · ctx 3%"].join("\n"));
    const read = readScreen(rows, "claude", IDLE);
    expect(read.cues?.strength).toBe("none");
    expect(isFree(read.surface)).toBe(true);
  });

  it("transcript: a strong shape flush on the box is never free (a dialog over a live box)", () => {
    const rows = rowsOf(["● Pick one:", " ❯ 1. Yes", "   2. No", RULE, "❯ ", RULE, "  model · ctx 3%"].join("\n"));
    expect(isFree(readScreen(rows, "claude", IDLE).surface)).toBe(false);
  });
});

describe("the bottom cluster", () => {
  it("reads a rating survey over a live box as a single-key prompt", () => {
    const read = readScreen(fixtureRows("claude-lab--survey-rating-above-box--w82.txt"), "claude", IDLE);
    expect(read.cues?.cues.map((cue) => cue.kind)).toContain("single-key");
    expect(read.surface.modal).toBe("unreadable");
  });

  it("never reads the status rows under a box for a cue", () => {
    const read = readScreen(fixtureRows("claude-lab--statusline-numbered-rows--w82.txt"), "claude", IDLE);
    expect(read.cues?.cues).toEqual([]);
    expect(isFree(read.surface)).toBe(true);
  });

  it("reads the rows under a box when they are no statusline (a popup)", () => {
    const tall = Array.from({ length: 12 }, (_, i) => (i === 0 ? "  ❯ /model   Set the model" : `    /cmd${String(i)}   Help text`));
    const rows = plainRows(["● done", RULE, "❯ /", RULE, ...tall]);
    const frame = findInputFrame(rows, IDLE)!;
    expect(frame.volatile.status).toBeNull();
    expect(readCues(rows, frame).cluster.length).toBe(12);
  });

  it(`ends the no-frame cluster at ${String(CLUSTER_GAP_ROWS)} blank rows`, () => {
    const rows = plainRows([" ❯ 1. Yes", "   2. No", "", "", "", "last line"]);
    const cues = readCues(rows, null);
    expect(cues.cluster).toEqual([5]);
    expect(cues.strength).toBe("none");
  });

  it("gives the same hash for the same rows", () => {
    const rows = plainRows(["a", "b"]);
    expect(readCues(rows, null).hash).toBe(readCues(plainRows(["a", "b"]), null).hash);
    expect(readCues(rows, null).hash).not.toBe(readCues(plainRows(["a", "c"]), null).hash);
  });
});

describe("cue shapes", () => {
  it("a pointer on a numbered row is strong", () => {
    expect(readCues(plainRows(["Proceed?", " ❯ 1. Yes", "   2. No"]), null).strength).toBe("strong");
    expect(readCues(plainRows(["⟩ 2. Always", "  3. Abort"]), null).strength).toBe("strong");
  });

  it("a key-hint footer with a listed row is strong, a key-hint alone is weak", () => {
    expect(readCues(plainRows(["  1. Red", "", "  Enter to select"]), null).strength).toBe("strong");
    expect(readCues(plainRows(["some text", "", "  Enter to select"]), null).strength).toBe("weak");
  });

  it("two key hints name a choice or a list and are strong", () => {
    expect(readCues(plainRows(["  Approve", "  Deny", "", "up/down navigate  enter select  esc cancel"]), null).strength).toBe("strong");
  });

  it("a pointed list of three rows is strong, of two rows weak", () => {
    expect(readCues(plainRows(["    ❯ Alpha", "      Beta", "      Gamma"]), null).strength).toBe("strong");
    expect(readCues(plainRows(["    ❯ Alpha", "      Beta"]), null).strength).toBe("weak");
  });

  it("a numbered list alone is weak, one numbered row is no cue", () => {
    expect(readCues(plainRows(["  1. one", "  2. two"]), null).strength).toBe("weak");
    expect(readCues(plainRows(["  1. build ok  2. tests ok"]), null).strength).toBe("none");
  });

  it("reads boxed rows like bare ones", () => {
    expect(readCues(plainRows(["┃  1 (○) Red", "┃  2 (○) Green", "┃  ↑/↓ navigate · y copy"]), null).strength).toBe("strong");
  });

  it("knows a single-key prompt and not a count or prose", () => {
    expect(isSingleKeyRow("  1: Bad    2: Fine   3: Good   0: Dismiss")).toBe(true);
    expect(isSingleKeyRow("a approve  |  s request changes  |  c comment")).toBe(true);
    expect(isSingleKeyRow("Overwrite the file? (y/n)")).toBe(true);
    expect(isSingleKeyRow("  ⎿  Reloaded: 6 plugins · 6 skills · 6 agents · 0 hooks")).toBe(false);
    expect(isSingleKeyRow("I think  a lot")).toBe(false);
  });

  it("knows a dialog's key hint and not a composer's", () => {
    expect(isKeyHintRow("Enter to select · ↑/↓ to navigate · Esc to cancel")).toBe(true);
    expect(isKeyHintRow("Use Up/Down or 1/2, then Enter. Esc quits.")).toBe(true);
    expect(isKeyHintRow("󰌑 select · n note · ↑/↓ move")).toBe(true);
    expect(isKeyHintRow("Enter:send  │  Shift+Enter:newline  │  Shift+Tab:mode")).toBe(false);
    expect(isKeyHintRow("⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt")).toBe(false);
  });

  it("knows a running sign, and an interrupt word in prose is none", () => {
    expect(isRunningRow("✽ Nucleating… (1s · thinking with medium effort)")).toBe(true);
    expect(isRunningRow("✢ Puzzling… (3m 3s · ↓ 9.2k tokens)")).toBe(true);
    expect(isRunningRow("  ⏵⏵ bypass permissions on · esc to interrupt · ← for agents")).toBe(true);
    expect(isRunningRow("✻ Brewed for 4s · done 12:27 PM")).toBe(false);
    expect(isRunningRow("  Esc to interrupt is not a key hint here")).toBe(false);
  });
});
