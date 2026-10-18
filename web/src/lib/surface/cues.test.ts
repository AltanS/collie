import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { lineText, type StyledLine } from "../blocks";
import { fixtureRows, perturbations, readScreen, rowsOf, SURFACE_FIXTURES_DIR } from "../../test/surface-corpus";
import { CLUSTER_GAP_ROWS, CLUSTER_MAX_ROWS, FOOTER_MAX_ROWS, isKeyHintRow, isRunningRow, isSingleKeyRow, readCues, runningSign } from "./cues";
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

  // The 2026-10-16 incident on lane 8788: the agents panel's two agent rows read as a checkbox list
  // and its "↓ to view" hint as a key hint, so a free box read unreadable.
  it("skips the named panel on a walk that holds, and reads it when the walk fails", () => {
    const panel = ["  ● main", "  ◯ general-purpose   Reading a file   2m 3s · ↓ 120.1k tokens", "  ◯ fork-name   a task   31s · ↓ 40.2k tokens"];
    const mode = "  ⏵⏵ bypass permissions on · 2 background tasks · ↓ to view";
    const held = plainRows(["● done", RULE, "❯ ", RULE, mode, "", ...panel, "", "  ↓ to manage"]);
    const heldFrame = findInputFrame(held, IDLE)!;
    expect(heldFrame.volatile.named).toHaveLength(5);
    expect(readCues(held, heldFrame).strength).toBe("none");
    // Too many statusline rows: the walk fails, nothing is named, and the panel is in sight again.
    const tall = Array.from({ length: IDLE.volatile.below.maxRows }, (_, i) => `  status ${String(i)}`);
    const failed = plainRows(["● done", RULE, "❯ ", RULE, ...tall, mode, "", ...panel, "", "  ↓ to manage"]);
    const failedFrame = findInputFrame(failed, IDLE)!;
    expect(failedFrame.volatile.status).toBeNull();
    expect(failedFrame.volatile.named).toEqual([]);
    expect(readCues(failed, failedFrame).strength).not.toBe("none");
  });

  it(`ends the no-frame cluster at ${String(CLUSTER_GAP_ROWS)} blank rows`, () => {
    const rows = plainRows([" ❯ 1. Yes", "   2. No", "", "", "", "a reply", "more reply", "last line"]);
    const cues = readCues(rows, null);
    expect(cues.cluster).toEqual([5, 6, 7]);
    expect(cues.strength).toBe("none");
  });

  it(`passes over a footer of up to ${String(FOOTER_MAX_ROWS)} rows set apart at the bottom, once`, () => {
    const rows = plainRows(["old", "", "", "", " ❯ 1. Yes", "   2. No", "", "", "", "", "~/proj:main"]);
    const cues = readCues(rows, null);
    expect(cues.cluster).toEqual([4, 5, 10]);
    expect(cues.strength).toBe("strong");
  });

  it(`reads up to ${String(CLUSTER_MAX_ROWS)} non-blank rows, and a list the cap would cut whole`, () => {
    const airy = plainRows(Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? `line ${String(i)}` : "")));
    expect(readCues(airy, null).cluster).toHaveLength(CLUSTER_MAX_ROWS);
    const list = ["header", "→   first [x]", ...Array.from({ length: 30 }, (_, i) => `    item${String(i)} [x]`), "", "  status"];
    const cues = readCues(plainRows(list), null);
    expect(cues.cluster[0]).toBe(1);
    expect(cues.strength).toBe("strong");
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

  it("reads an icon key cap with a letter as one key", () => {
    expect(readCues(plainRows(["  some text", "", " \u{F0311} or \u{F0634} Q submit  \u{F12B7} cancel"]), null).strength).toBe("strong");
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

describe("the running sign on live captures (Claude Code 2.1.301, Codex 0.163.0, 2026-10-16)", () => {
  // The rows of the fixtures claude--v2301-*--w100.txt and codex--v0163-working-*--w120.txt, as read.
  // 2.1.301 prints no interrupt hint while it runs: the live row is a spinner with `…` and a timer.
  it("a live row fires: a spinner glyph, a verb with an ellipsis, a bracketed timer", () => {
    expect(isRunningRow("* Wibbling… (4s · ↓ 304 tokens)")).toBe(true);
    expect(isRunningRow("✽ Germinating… (4s · thinking with high effort)")).toBe(true);
    expect(isRunningRow("· Germinating… (7s · thinking with high effort)")).toBe(true);
    expect(isRunningRow("• Working (8s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close")).toBe(true);
  });

  it("a finished turn's row never fires, whatever follows it", () => {
    expect(isRunningRow("✻ Worked for 6s · done 12:36 PM · 1 shell still running")).toBe(false);
    expect(isRunningRow("✻ Churned for 1s · done 12:37 PM")).toBe(false);
    expect(isRunningRow("✻ Cogitated for 1s · done 12:38 PM")).toBe(false);
    expect(isRunningRow("✻ Crunched for 12s")).toBe(false);
    expect(isRunningRow("✻ Waiting for 1 background agent to finish")).toBe(false);
    expect(isRunningRow("  Worked for 5s • 12:42 PM")).toBe(false);
  });

  it("the first second of a turn, before its timer shows, and the queued message's hint do not fire", () => {
    expect(isRunningRow("✶ Wibbling…")).toBe(false);
    expect(isRunningRow("  ctrl+enter to send now")).toBe(false);
    expect(isRunningRow("  ◯ general-purpose  Create m56s2.txt file                   9s · ↓ 28.4k tokens")).toBe(false);
  });
});

describe("overlay shapes in the no-frame cluster", () => {
  const kinds = (rows: string[]) => readCues(plainRows(rows), null).cues.map((cue) => cue.kind);

  it("a title row that names only its close key is strong", () => {
    const rows = ["        Select agent                    esc", "", "        Search", "", "      ● build native", "        plan native"];
    expect(kinds(rows)).toContain("dismiss-header");
    expect(readCues(plainRows(rows), null).strength).toBe("strong");
    expect(kinds(["Press esc for help", "                esc", "a title esc"])).not.toContain("dismiss-header");
  });

  it("three slash commands with descriptions are strong, two are not a list", () => {
    const rows = ["┃ /agents     Switch agent   ┃", "┃ /connect    Connect        ┃", "┃ /debug      Debug info     ┃"];
    expect(kinds(rows)).toContain("command-list");
    expect(readCues(plainRows(rows), null).strength).toBe("strong");
    expect(readCues(plainRows(rows.slice(0, 2)), null).strength).toBe("none");
  });

  it("a slash query with a choice under it is strong", () => {
    expect(kinds(["╭── prompt ───────────────", "╰─ /", "❯ skill:sample   Read a sample"])).toContain("command-query");
    expect(kinds(["❯ /us", "  /usage  Show session usage"])).toContain("command-query");
    expect(kinds(["❯ /us", "  nothing matches"])).not.toContain("command-query");
  });

  it("a pointer list between two rules is strong, without the rules weak", () => {
    const list = ["  ❯ 256k (active) Default", "    500k          500000 tokens"];
    const rule = "─".repeat(40);
    expect(readCues(plainRows([rule, ...list, rule]), null).strength).toBe("strong");
    expect(readCues(plainRows(list), null).strength).toBe("weak");
  });

  it("a pointed list reads wrapped rows as part of the item above", () => {
    const rows = ["❯ resume       Resume a different", "               session", "  pin          Pin a session", "  pause        Freeze all agents"];
    expect(readCues(plainRows(rows), null).strength).toBe("strong");
  });

  it("never counts over a found frame, where a quote must stay free", () => {
    const rows = rowsOf(
      ["● The picker said:", "  Select agent                    esc", "  /agents   Switch agent", "  /connect  Connect", "  /debug    Debug", RULE, "❯ ", RULE, "  model · ctx 3%"].join("\n"),
    );
    const read = readScreen(rows, "claude", IDLE);
    expect(read.frame).not.toBeNull();
    expect(read.cues?.strength).toBe("none");
    expect(isFree(read.surface)).toBe(true);
  });
});

describe("running signs and the prompt row", () => {
  // The prompt row holds the operator's draft. A profile's running rows are not read there, so a draft
  // that types a harness's own interrupt hint is still a draft; only `runningPrompt` reads that row.
  const plain = (text: string): StyledLine => ({ segments: [{ text, style: {}, muted: false }] });
  const cases = [
    { fixture: "grok--draft-single.txt", harness: "grok", phrase: "Esc:cancel" },
    { fixture: "oc--draft-single.txt", harness: "opencode", phrase: "esc interrupt" },
  ];
  for (const { fixture, harness, phrase } of cases) {
    it(`running: a ${harness} draft that types \`${phrase}\` is not a running turn`, () => {
      // Given: the captured draft with its text replaced by the harness's own running hint.
      const idle = requireProfile(harness).idle;
      const rows = fixtureRows(fixture);
      const captured = findInputFrame(rows, idle)!;
      const prompt = captured.interior.prompt;
      const typed = lineText(rows[prompt]!).replace(captured.interior.text, phrase.padEnd(captured.interior.text.length));
      const screen = rows.map((row, i) => (i === prompt ? plain(typed) : row));
      // When: the frame is found again and its turn read.
      const frame = findInputFrame(screen, idle)!;
      // Then: the box holds the phrase, the profile's pattern would match that row, and the turn is idle.
      expect(frame.interior.text).toBe(phrase);
      expect(idle.runningRows!.some((source) => new RegExp(source, "u").test(typed.trimEnd()))).toBe(true);
      expect(runningSign(screen, frame, idle)).toBe(false);
      expect(readScreen(screen, harness, idle).surface.turn).toBe("idle");
    });
  }

  it("running: Kiro's busy prompt row reads running, also with one more row under the box", () => {
    // Given: the captured running Kiro screen, whose busy line stands on the prompt row, and the same
    // screen with one more row under the box, so the prompt row is no longer the box's last row.
    const idle = requireProfile("kiro").idle;
    const rows = fixtureRows("kiro--v3-running-w120.txt");
    const grown = perturbations(rows).find((p) => p.name === "one more status row at the bottom")!.rows;
    // When: both screens' frames are found.
    const frame = findInputFrame(rows, idle)!;
    const grownFrame = findInputFrame(grown, idle)!;
    // Then: both read running, and on the grown screen only the prompt sign carries it.
    expect(runningSign(rows, frame, idle)).toBe(true);
    expect(runningSign(grown, grownFrame, idle)).toBe(true);
    expect(runningSign(grown, grownFrame, { runningRows: idle.runningRows })).toBe(false);
  });
});
