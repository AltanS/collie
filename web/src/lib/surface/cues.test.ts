import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { fixtureRows, readScreen, rowsOf, SURFACE_FIXTURES_DIR } from "../../test/surface-corpus";
import { CLUSTER_GAP_ROWS, CLUSTER_MAX_ROWS, commandListAt, FOOTER_MAX_ROWS, isKeyHintRow, isRunningRow, noticeOver, ownCommandList, readCues, runningSign } from "./cues";
import { isSingleKeyRow } from "./key-row";
import { findInputFrame, plainRows, rowText } from "./frame";
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
      expect(readCues(rows.slice(0, read.frame!.top - 2), null, null).strength).toBe("strong");
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

  it("passes over the profile's notice above a live box: its key row is no single-key prompt", () => {
    const read = readScreen(fixtureRows("claude--v2302-heads-up-above-box--w142.txt"), "claude", IDLE);
    expect(read.cues?.cues.map((cue) => cue.kind)).not.toContain("single-key");
    expect(read.cues?.strength).toBe("none");
    expect(read.surface.modal).toBe("none");
  });

  it("keeps the strong cue on a notice-shaped block that is not exact", () => {
    const keys = "  1: Learn more   2: Knew this already   0: Dismiss";
    const notExact = [
      ["  on your main PC.", keys],
      ["✦ Heads up · Something new", "  1: Learn more   y: Yes   0: Dismiss"],
      ["✦ Heads up · Something new", keys, "  something else"],
      // Items joined by a separator glyph are split as the single-key cue splits them: a letter key there is no notice.
      ["✦ Heads up · Something new", "  1: Learn more · y: Yes   0: Dismiss"],
      ["✦ Heads up · Something new", "  1: Learn more • y: Yes   0: Dismiss"],
      ["✦ Heads up · Something new", "  1: Learn more │ y: Yes   0: Dismiss"],
      ["✦ Heads up · Something new", "  1: Learn more 2: Knew this   0: Dismiss"],
    ];
    for (const over of notExact) {
      const rows = rowsOf(["● done", "", ...over, RULE, "❯ ", RULE, "  model · ctx 3%"].join("\n"));
      const read = readScreen(rows, "claude", IDLE);
      expect(read.cues?.strength, over.join(" / ")).toBe("strong");
      expect(read.surface.modal).toBe("unreadable");
    }
  });

  it("reads a notice whose key items a separator glyph joins as a notice", () => {
    for (const joined of ["  1: Learn more | 2: Knew this   0: Dismiss", "  1: Learn more • 2: Knew this │ 0: Dismiss"]) {
      const rows = rowsOf(["● done", "", "✦ Heads up · Something new", joined, "", RULE, "❯ ", RULE, "  model · ctx 3%"].join("\n"));
      expect(readScreen(rows, "claude", IDLE).cues?.strength, joined).toBe("none");
    }
  });

  // The band over the box is counted from the notice's first row: a notice with three continuation rows
  // would fill six rows counted from the box, and a survey drawn above it would go unread.
  it("reads a dialog drawn above a notice of three continuation rows", () => {
    const survey = ["● How is the agent doing this session? (optional)", "  1: Bad    2: Fine    3: Good    0: Dismiss", ""];
    const notice = ["✦ Heads up · Something new", "  one", "  two", "  three", "  1: Learn more   2: Knew this already   0: Dismiss", ""];
    const read = readScreen(rowsOf(["● done", "", ...survey, ...notice, RULE, "❯ ", RULE, "  model · ctx 3%"].join("\n")), "claude", IDLE);
    expect(read.cues?.strength).toBe("strong");
    expect(read.surface.modal).toBe("unreadable");
  });

  // A turn's spinner inside the band over a notice: the notice's key row is left out of every read.
  it("reads no cue on a notice under a running turn's spinner", () => {
    const over = ["✻ Thinking… (2s · esc to interrupt)", "", "✦ Heads up · Something new", "  1: Learn more   2: Knew this already   0: Dismiss", ""];
    const rows = rowsOf(["● done", "", ...over, RULE, "❯ ", RULE, "  model · ctx 3%"].join("\n"));
    const read = readScreen(rows, "claude", IDLE);
    expect(read.surface).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
    expect(read.cues?.strength).toBe("none");
    const frame = read.frame!;
    const bare = [...rows.slice(0, frame.interior.first), ...rows.slice(frame.interior.last + 1)];
    expect(readCues(bare, null, noticeOver(rows.map(rowText), frame, IDLE)).strength).toBe("none");
    expect(readCues(bare, null, null).strength).toBe("strong");
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
    expect(readCues(rows, frame, null).cluster.length).toBe(12);
  });

  // The 2026-10-16 incident on lane 8788: the agents panel's two agent rows read as a checkbox list
  // and its "↓ to view" hint as a key hint, so a free box read unreadable.
  it("skips the named panel on a walk that holds, and reads it when the walk fails", () => {
    const panel = ["  ● main", "  ◯ general-purpose   Reading a file   2m 3s · ↓ 120.1k tokens", "  ◯ fork-name   a task   31s · ↓ 40.2k tokens"];
    const mode = "  ⏵⏵ bypass permissions on · 2 background tasks · ↓ to view";
    const held = plainRows(["● done", RULE, "❯ ", RULE, mode, "", ...panel, "", "  ↓ to manage"]);
    const heldFrame = findInputFrame(held, IDLE)!;
    expect(heldFrame.volatile.named).toHaveLength(5);
    expect(readCues(held, heldFrame, null).strength).toBe("none");
    // Too many statusline rows: the walk fails, nothing is named, and the panel is in sight again.
    const tall = Array.from({ length: IDLE.volatile.below.maxRows }, (_, i) => `  status ${String(i)}`);
    const failed = plainRows(["● done", RULE, "❯ ", RULE, ...tall, mode, "", ...panel, "", "  ↓ to manage"]);
    const failedFrame = findInputFrame(failed, IDLE)!;
    expect(failedFrame.volatile.status).toBeNull();
    expect(failedFrame.volatile.named).toEqual([]);
    expect(readCues(failed, failedFrame, null).strength).not.toBe("none");
  });

  it(`ends the no-frame cluster at ${String(CLUSTER_GAP_ROWS)} blank rows`, () => {
    const rows = plainRows([" ❯ 1. Yes", "   2. No", "", "", "", "a reply", "more reply", "last line"]);
    const cues = readCues(rows, null, null);
    expect(cues.cluster).toEqual([5, 6, 7]);
    expect(cues.strength).toBe("none");
  });

  it(`passes over a footer of up to ${String(FOOTER_MAX_ROWS)} rows set apart at the bottom, once`, () => {
    const rows = plainRows(["old", "", "", "", " ❯ 1. Yes", "   2. No", "", "", "", "", "~/proj:main"]);
    const cues = readCues(rows, null, null);
    expect(cues.cluster).toEqual([4, 5, 10]);
    expect(cues.strength).toBe("strong");
  });

  it(`reads up to ${String(CLUSTER_MAX_ROWS)} non-blank rows, and a list the cap would cut whole`, () => {
    const airy = plainRows(Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? `line ${String(i)}` : "")));
    expect(readCues(airy, null, null).cluster).toHaveLength(CLUSTER_MAX_ROWS);
    const list = ["header", "→   first [x]", ...Array.from({ length: 30 }, (_, i) => `    item${String(i)} [x]`), "", "  status"];
    const cues = readCues(plainRows(list), null, null);
    expect(cues.cluster[0]).toBe(1);
    expect(cues.strength).toBe("strong");
  });

  it("gives the same hash for the same rows", () => {
    const rows = plainRows(["a", "b"]);
    expect(readCues(rows, null, null).hash).toBe(readCues(plainRows(["a", "b"]), null, null).hash);
    expect(readCues(rows, null, null).hash).not.toBe(readCues(plainRows(["a", "c"]), null, null).hash);
  });
});

describe("cue shapes", () => {
  it("a pointer on a numbered row is strong", () => {
    expect(readCues(plainRows(["Proceed?", " ❯ 1. Yes", "   2. No"]), null, null).strength).toBe("strong");
    expect(readCues(plainRows(["⟩ 2. Always", "  3. Abort"]), null, null).strength).toBe("strong");
  });

  it("a key-hint footer with a listed row is strong, a key-hint alone is weak", () => {
    expect(readCues(plainRows(["  1. Red", "", "  Enter to select"]), null, null).strength).toBe("strong");
    expect(readCues(plainRows(["some text", "", "  Enter to select"]), null, null).strength).toBe("weak");
  });

  it("two key hints name a choice or a list and are strong", () => {
    expect(readCues(plainRows(["  Approve", "  Deny", "", "up/down navigate  enter select  esc cancel"]), null, null).strength).toBe("strong");
  });

  it("a pointed list of three rows is strong, of two rows weak", () => {
    expect(readCues(plainRows(["    ❯ Alpha", "      Beta", "      Gamma"]), null, null).strength).toBe("strong");
    expect(readCues(plainRows(["    ❯ Alpha", "      Beta"]), null, null).strength).toBe("weak");
  });

  it("a numbered list alone is weak, one numbered row is no cue", () => {
    expect(readCues(plainRows(["  1. one", "  2. two"]), null, null).strength).toBe("weak");
    expect(readCues(plainRows(["  1. build ok  2. tests ok"]), null, null).strength).toBe("none");
  });

  it("reads boxed rows like bare ones", () => {
    expect(readCues(plainRows(["┃  1 (○) Red", "┃  2 (○) Green", "┃  ↑/↓ navigate · y copy"]), null, null).strength).toBe("strong");
  });

  it("reads an icon key cap with a letter as one key", () => {
    expect(readCues(plainRows(["  some text", "", " \u{F0311} or \u{F0634} Q submit  \u{F12B7} cancel"]), null, null).strength).toBe("strong");
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

describe("the running sign on a themed Claude Code spinner (words between the ellipsis and the timer)", () => {
  it("a spinner with one ` · <words>` segment before its bracketed timer fires", () => {
    expect(isRunningRow("✢ Fiddle-faddling… · tool use (4m 32s · ↓ 4.8k tokens)")).toBe(true);
    expect(isRunningRow("✽ Flowing… · tool use (5m 41s · ↓ 4.8k tokens)")).toBe(true);
    expect(isRunningRow("✽ Flowing… · thinking (48s · ↓ 1.2k tokens)")).toBe(true);
  });

  it("look-alike rows stay off", () => {
    expect(isRunningRow("  ctx:  9%  |  sub: 5h  49% (3h06m) · 7d  87%")).toBe(false);
    expect(isRunningRow("  ◯ general-purpose  Create m56s2.txt file                   9s · ↓ 28.4k tokens")).toBe(false);
    expect(isRunningRow("● Bash(ls -la)")).toBe(false);
    expect(isRunningRow("✻ Worked for 3m 12s · done 12:40 PM")).toBe(false);
    expect(isRunningRow("✽ Flowing… · this is a sentence well over thirty one characters long (5s)")).toBe(false);
  });
});

describe("overlay shapes in the no-frame cluster", () => {
  const kinds = (rows: string[]) => readCues(plainRows(rows), null, null).cues.map((cue) => cue.kind);

  it("a title row that names only its close key is strong", () => {
    const rows = ["        Select agent                    esc", "", "        Search", "", "      ● build native", "        plan native"];
    expect(kinds(rows)).toContain("dismiss-header");
    expect(readCues(plainRows(rows), null, null).strength).toBe("strong");
    expect(kinds(["Press esc for help", "                esc", "a title esc"])).not.toContain("dismiss-header");
  });

  it("three slash commands with descriptions are strong, two are not a list", () => {
    const rows = ["┃ /agents     Switch agent   ┃", "┃ /connect    Connect        ┃", "┃ /debug      Debug info     ┃"];
    expect(kinds(rows)).toContain("command-list");
    expect(readCues(plainRows(rows), null, null).strength).toBe("strong");
    expect(readCues(plainRows(rows.slice(0, 2)), null, null).strength).toBe("none");
  });

  it("a slash query with a choice under it is strong", () => {
    expect(kinds(["╭── prompt ───────────────", "╰─ /", "❯ skill:sample   Read a sample"])).toContain("command-query");
    expect(kinds(["❯ /us", "  /usage  Show session usage"])).toContain("command-query");
    expect(kinds(["❯ /us", "  nothing matches"])).not.toContain("command-query");
  });

  it("a pointer list between two rules is strong, without the rules weak", () => {
    const list = ["  ❯ 256k (active) Default", "    500k          500000 tokens"];
    const rule = "─".repeat(40);
    expect(readCues(plainRows([rule, ...list, rule]), null, null).strength).toBe("strong");
    expect(readCues(plainRows(list), null, null).strength).toBe("weak");
  });

  it("a pointed list reads wrapped rows as part of the item above", () => {
    const rows = ["❯ resume       Resume a different", "               session", "  pin          Pin a session", "  pause        Freeze all agents"];
    expect(readCues(plainRows(rows), null, null).strength).toBe("strong");
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

describe("the typed command's own list at the box (idle.volatile.below.commandList, field case 2026-10-17)", () => {
  const LIST = IDLE.volatile.below.commandList;
  const texts = (rows: ReturnType<typeof plainRows>): string[] => rows.map(rowText);
  /** A box holding `box` over a list: `pointed` names the entry with the pointer, null for none. */
  const screen = (box: string, pointed: string | null, entries = ["/model", "/models", "/memory"]) =>
    plainRows([
      "● done",
      RULE,
      `❯ ${box}`,
      RULE,
      ...entries.map((name) => `${name === pointed ? "  ❯ " : "    "}${name.padEnd(30)}What ${name.slice(1)} does, in a second column`),
    ]);

  it("the 2.1.302 two-column list at 119 columns: the pointer on the typed /model is its own typeahead, no cue, no dialog", () => {
    const rows = fixtureRows("claude--v2302-slash-model-list--w119.txt");
    const frame = findInputFrame(rows, IDLE)!;
    expect(commandListAt(texts(rows), frame, LIST)).toMatchObject({ pointed: "/model", side: "under" });
    expect(ownCommandList(texts(rows), frame, IDLE)).not.toBeNull();
    const read = readScreen(rows, "claude", IDLE);
    expect(read.cues?.strength).toBe("none");
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
  });

  it("the 2.1.291 list with the pointed description wrapped reads the same", () => {
    const rows = fixtureRows("claude-lab--popup-slash-model-exact--w82.txt");
    const frame = findInputFrame(rows, IDLE)!;
    expect(commandListAt(texts(rows), frame, LIST)).toMatchObject({ pointed: "/model", side: "under" });
    expect(ownCommandList(texts(rows), frame, IDLE)).not.toBeNull();
  });

  it("a list while the box holds a query, not the command (/mo, /): pointed elsewhere, read as before", () => {
    for (const name of ["claude-lab--popup-slash-mo--w82.txt", "claude-lab--popup-slash-all--w82.txt", "claude-lab--popup-slash-all--w40.txt"]) {
      const rows = fixtureRows(name);
      const frame = findInputFrame(rows, IDLE)!;
      expect(commandListAt(texts(rows), frame, LIST)?.pointed, name).toMatch(/^\/\S+$/u);
      expect(ownCommandList(texts(rows), frame, IDLE), name).toBeNull();
    }
  });

  it("exact: /model is pointed at by ❯ /model, never by ❯ /models; a list with no pointer is no typeahead", () => {
    const at = (rows: ReturnType<typeof plainRows>) => ownCommandList(texts(rows), findInputFrame(rows, IDLE), IDLE) !== null;
    expect(at(screen("/model", "/model"))).toBe(true);
    expect(at(screen("/model", "/models"))).toBe(false);
    expect(at(screen("/models", "/model"))).toBe(false);
    expect(at(screen("/model", "/memory"))).toBe(false);
    expect(at(screen("/model", null))).toBe(false);
    expect(commandListAt(texts(screen("/model", null)), findInputFrame(screen("/model", null), IDLE)!, LIST)).toMatchObject({ pointed: null });
  });

  it("the captured 2.1.302 screen of a tall pane draws the list over the box, the statusline under it: the same typeahead", () => {
    const rows = fixtureRows("claude--v2302-slash-model-list-above--w119.txt");
    const frame = findInputFrame(rows, IDLE)!;
    expect(frame.volatile.status).not.toBeNull();
    expect(commandListAt(texts(rows), frame, LIST)).toEqual({
      pointed: "/model",
      side: "above",
      first: frame.top - 4,
      last: frame.top - 1,
      entries: ["/model", "/auto-mode-setup", "/typescript:structure-module"],
    });
    expect(ownCommandList(texts(rows), frame, IDLE)).not.toBeNull();
    const read = readScreen(rows, "claude", IDLE);
    expect(read.cues?.strength).toBe("none");
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
  });

  it("the harness lab's 120 x 40 tmux captures: the list under a box scrolled up the short pane is the typeahead of /model and /effort", () => {
    for (const [name, command] of [
      ["claude--v2302-slash-model-list--w120--h40.txt", "/model"],
      ["claude--v2302-slash-effort-list--w120--h40.txt", "/effort"],
      // The fix rig's 120 x 36 Herdr pane: the same list, with blank rows under it to the pane's bottom.
      ["claude--v2302-slash-model-list-padded--w120--h36.txt", "/model"],
    ] as const) {
      const rows = fixtureRows(name);
      const frame = findInputFrame(rows, IDLE)!;
      expect(ownCommandList(texts(rows), frame, IDLE), name).toMatchObject({ pointed: command, side: "under" });
      expect(readScreen(rows, "claude", IDLE).surface, name).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    }
  });

  it("over the box: the run right above the top edge, up to a blank row or a row that is no list row", () => {
    const over = (above: string[], box = "/model") => {
      const rows = plainRows(["● done", ...above, RULE, `❯ ${box}`, RULE, "  model · ctx 3%"]);
      const frame = findInputFrame(rows, IDLE)!;
      return { list: commandListAt(texts(rows), frame, LIST), own: ownCommandList(texts(rows), frame, IDLE) !== null, top: frame.top };
    };
    const list = ["  ❯ /model      Set the model", "    /models     List the models", "                and their prices"];
    expect(over(["", ...list])).toMatchObject({ list: { pointed: "/model", side: "above" }, own: true });
    // A transcript row over the list ends it; the list still stands.
    expect(over(["Some answer text", ...list]).list).toMatchObject({ pointed: "/model", first: 2 });
    // A wrapped-looking row over the first entry belongs to the transcript.
    expect(over(["", "                indented code", ...list]).list).toMatchObject({ first: 3 });
    expect(over(["", "  ❯ /models     List the models", "    /model      Set the model"]).own).toBe(false);
    expect(over(["", "  ❯ /model      Set the model", "  ❯ /models     List the models"]).list).toBeNull();
    // A gap between the list and the top edge: no list.
    expect(over([...list, ""]).list).toBeNull();
    // A dialog over the box is no list.
    expect(over(["", " Do you want to proceed?", " ❯ 1. Yes", "   2. No"]).list).toBeNull();
  });

  it("anything else under the box is no list: a dialog, a status row, a second pointer, a gap under the bottom edge", () => {
    const under = (extra: string[]) => {
      const rows = plainRows(["● done", RULE, "❯ /model", RULE, ...extra]);
      return commandListAt(texts(rows), findInputFrame(rows, IDLE)!, LIST);
    };
    expect(under(["  ❯ /model      Set the model", "    /models     List the models"])).toMatchObject({ pointed: "/model", side: "under" });
    expect(under(["  ❯ /model      Set the model", " Do you want to proceed?", " ❯ 1. Yes", "   2. No"])).toBeNull();
    expect(under(["  ❯ /model      Set the model", "  ❯ /models     List the models"])).toBeNull();
    expect(under(["  ❯ /model      Set the model", "  model · ctx 3%"])).toBeNull();
    expect(under(["", "  ❯ /model      Set the model"])).toBeNull();
    expect(under([" ❯ 1. Yes", "   2. No"])).toBeNull();
  });
});

describe("a list that leaves the lead off, under the box only, over the harness's own footer (pi and omp profiles, 1.22.5)", () => {
  const PI = requireProfile("pi").idle;
  const LIST = PI.volatile.below.commandList;
  const texts = (rows: ReturnType<typeof plainRows>): string[] => rows.map(rowText);
  const FOOTER = ["~/project (main)", "0.0%/200k (auto)                                   model • off"];
  /** pi's box between two rules holding `box`, the rows `under` it, then pi's folder and stats rows. */
  const screen = (box: string, under: string[], footer = FOOTER, above: string[] = []) => plainRows(["an earlier answer", ...above, RULE, box, RULE, ...under, ...footer]);
  const read = (rows: ReturnType<typeof plainRows>) => {
    const frame = findInputFrame(rows, PI);
    return { frame, list: frame === null ? null : commandListAt(texts(rows), frame, LIST), own: ownCommandList(texts(rows), frame, PI) !== null };
  };
  const MODEL = ["→ model          <provider/model> — Select model", "  scoped-models  Enable/disable models for Ctrl+P cycling"];

  it("the pointer on `model` under a box that holds /model is its own typeahead: the lead goes in front", () => {
    expect(read(screen("/model", MODEL))).toMatchObject({ list: { pointed: "/model", side: "under", first: 4, last: 5 }, own: true });
    // The same list under /mod or /models is no typeahead of the box's text. Its unpainted rows are
    // no footer either, so the plain rows here find no box at all; the painted capture does (fold.test.ts).
    expect(read(screen("/mod", MODEL))).toMatchObject({ frame: null, own: false });
    expect(read(screen("/models", MODEL))).toMatchObject({ frame: null, own: false });
  });

  it("a list taller than the footer bound still finds the box, and only when the list is its own", () => {
    const tall = [...MODEL, "  modelpreset    Presets", "  switch         Switch", "  (1/9)"];
    expect(read(screen("/model", tall))).toMatchObject({ frame: { interior: { text: "/model" } }, own: true });
    // The same list pointed at another command: the row under the box is no footer, so no box.
    expect(read(screen("/mod", tall)).frame).toBeNull();
  });

  it("the footer ends the list: one run to the screen's end, at most four rows, no blank row in it", () => {
    expect(read(screen("/model", MODEL, ["↑0 ↓0 $0.000 from an extension"])).own).toBe(true);
    expect(read(screen("/model", MODEL, [...FOOTER, "row three", "row four"])).own).toBe(true);
    expect(read(screen("/model", MODEL, [...FOOTER, "row three", "row four", "row five"])).own).toBe(false);
    expect(read(screen("/model", MODEL, [FOOTER[0]!, "", FOOTER[1]!])).own).toBe(false);
    // A row that is neither list nor footer between them: no list.
    expect(read(screen("/model", [...MODEL, " Do you want to proceed?"])).own).toBe(false);
  });

  it("a list over the box is never read on a profile that names only the side under it", () => {
    const rows = screen("/model", [], FOOTER, ["→ model          <provider/model> — Select model"]);
    expect(read(rows)).toMatchObject({ list: null, own: false });
  });
});

// Issue 497 (omp 18.11.3, captured 2026-10-18): with a tool running, stock omp names the tool's intent
// on its working row (`󱊷 Running sleep and echo command`) instead of `Working…`, and the Nerd Font
// preset draws no braille there. The box's top edge carries the turn's spinner and timer
// (`╭── ⠋ 13s  󰪣 Haiku 4.5 …`, pi-tui status-line/segments.ts), and the timer reads `1m` past a minute.
describe("omp 18.11's running turn (issue 497)", () => {
  const OMP = requireProfile("omp").idle;
  const RUNNING = [
    "omp--v18-11-nerd-running-tool--w130.txt",
    "omp--v18-11-nerd-running-tool--w80.txt",
    "omp--v18-11-nerd-running-tool-minute--w130.txt",
    "omp--v18-11-nerd-running-tool-minute--w80.txt",
  ];

  it.each(RUNNING)("%s: the top edge's spinner and timer are a running sign, and the Surface reads a turn", (name) => {
    const rows = fixtureRows(name);
    const frame = findInputFrame(rows, OMP)!;
    expect(frame.interior.text).toBe("");
    expect(runningSign(rows, frame, OMP.runningRows)).toBe(true);
    expect(readScreen(rows, "omp", OMP).surface).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
  });

  it("an idle box's top edge, with no spinner, is no running sign", () => {
    const rows = fixtureRows("omp--v18-11-nerd-ghost-word--w130.txt");
    expect(runningSign(rows, findInputFrame(rows, OMP)!, OMP.runningRows)).toBe(false);
  });

  it.each(["omp--v18-11-nerd-skill-pointed--w80.txt", "omp--v18-11-skill-pointed--w130.txt", "omp--v18-11-nerd-slash-model--w130.txt"])(
    "%s: the list is the typed command's own, so the Surface reads the box free",
    (name) => {
      const rows = fixtureRows(name);
      const frame = findInputFrame(rows, OMP);
      expect(ownCommandList(rows.map(rowText), frame, OMP)).not.toBeNull();
      expect(readScreen(rows, "omp", OMP).surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    },
  );
});
