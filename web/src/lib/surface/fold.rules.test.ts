import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { agentOf, fixtureRows, idleFor, PANES_DIR, readScreen, rowsOf, SURFACE_FIXTURES_DIR } from "../../test/surface-corpus";
import { findInputFrame, plainRows, rowText } from "./frame";
import { emptyFoldState, endsInsideFrame, foldSurface, type FoldContext, readFold, type ScreenInput, stepFold, SURFACE_SOURCES, type SurfaceInput, surfaceOfScreen } from "./fold";
import { requireProfile } from "./profile";
import { type Ask, isFree, modalWord } from "./surface";
import { ASK, CLAUDE, LABELS } from "../../test/surface-fold";

// The fold's own rules and the screens that broke it: the OMP widget, a running turn, foldSurface, the agents panel, and the rows around an idle box.

const IDLE_SCREEN = plainRows(["● done", "", "─".repeat(40), "❯ ", "─".repeat(40), "  model · ctx 3%"]);
const DRAFT_SCREEN = plainRows(["● done", "", "─".repeat(40), "❯ hello there", "─".repeat(40), "  model · ctx 3%"]);
const RUNNING_SCREEN = plainRows(["✻ Pondering… (4s · ↓ 120 tokens)", "", "─".repeat(40), "❯ ", "─".repeat(40), "  model · esc to interrupt"]);
const DIALOG_SCREEN = plainRows([
  "─".repeat(40),
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel",
]);

function screen(seq: number, at: number, rows: ScreenInput["rows"], revision = seq, ask: Ask | null = null): ScreenInput {
  return { seq, source: "screen", at, revision, rows, ask };
}

describe("an OMP extension widget around the open box (#468)", () => {
  // An extension draws rows with `ctx.ui.setWidget(key, lines, { placement })`. Under the box
  // (`belowEditor`) they sit below the `╰─` prompt row, so the open box no longer ends on the
  // screen's last row. Those rows are content under the box, not a read cut inside it.
  const OMP = requireProfile("omp").idle;
  const read = (name: string) => readScreen(fixtureRows(name), agentOf("omp"), OMP);
  const IDLE_FREE = { revision: 1, turn: "idle", modal: "none", composer: "empty" };
  const box = ["", " Some earlier assistant output.", "", `╭── π  model  ~/project  main ${"─".repeat(60)}`, `╰─ ${" ".repeat(86)}`];

  it("omp: the reporter's screen, a belowEditor widget row under the open box, reads idle and free, not torn", () => {
    const rows = plainRows([...box, " widget row drawn by an extension with placement: belowEditor"]);
    expect(surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows, ask: null }, OMP).surface).toEqual(IDLE_FREE);
  });

  it("omp: a captured idle box with a belowEditor widget row under it reads idle and free, not torn", () => {
    const r = read("omp--fresh-idle-widget-below.txt");
    expect(r.frame).toMatchObject({ top: 26, bottom: 27, interior: { prompt: 27, text: "" } });
    expect(r.surface).toEqual(IDLE_FREE);
    expect(isFree(r.surface)).toBe(true);
  });

  it("omp: an aboveEditor widget row over the open box reads idle and free", () => {
    const r = read("omp--fresh-idle-widget-above.txt");
    expect(r.frame).toMatchObject({ top: 27, bottom: 28 });
    expect(r.surface).toEqual(IDLE_FREE);
  });

  it("omp: up to maxTailRows rows under the box read free whatever they hold, past it only a widget run up to maxWidgetRows", () => {
    const widget = (n: number) => Array.from({ length: n }, (_, i) => ` widget row ${i + 1}`);
    const readOf = (rows: string[]) => surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows: plainRows(rows), ask: null }, OMP).surface;
    expect(OMP.frame.maxTailRows).toBe(3);
    expect(OMP.frame.maxWidgetRows).toBe(12);
    expect(readOf([...box, ...widget(3)])).toEqual(IDLE_FREE);
    expect(readOf([...box, "", ...widget(2)])).toEqual(IDLE_FREE);
    // The gang's tester 5 (2026-10-25): a belowEditor widget of four rows or more made the read torn on 18.6.1 and 18.12.6.
    for (const n of [4, 6, 11, 12]) expect(readOf([...box, ...widget(n)]), `${String(n)} rows`).toEqual(IDLE_FREE);
    expect(readOf([...box, ...widget(13)]).reason).toBe("torn");
  });

  it("omp: past maxTailRows a widget run has no blank row, and no row of the command list", () => {
    const readOf = (rows: string[]) => surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows: plainRows(rows), ask: null }, OMP).surface;
    // A blank row inside the run: the reach stays the tail bound, so this is a read cut inside the box, as before.
    expect(readOf([...box, " one", " two", " three", "", " five"]).reason).toBe("torn");
    // An entry-shaped row (two spaces, a word, two spaces, a description) is a command list's, and a list is read by the list rules.
    const listed = readOf([...box, " one", " two", "  tests  passing", " four"]);
    expect(listed.reason).toBe("torn");
    expect(isFree(listed)).toBe(false);
  });

  it("omp: a dialog's rows under the open box stay a strong cue past the old reach, so the read is never free", () => {
    const dialog = [" Allow this tool?", " ❯ 1. Yes", "   2. No", "   3. Always", " Enter to select · Esc to cancel"];
    const r = surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows: plainRows([...box, ...dialog]), ask: null }, OMP);
    expect(isFree(r.surface)).toBe(false);
    expect(r.surface.modal).not.toBe("none");
  });

  it.each([
    ["omp--v18-12-6-widget-below-3.txt", "18.12.6"],
    ["omp--v18-12-6-widget-below-4.txt", "18.12.6"],
    ["omp--v18-6-1-widget-below-6.txt", "18.6.1"],
  ])("omp %s (gang, 2026-10-25): the widget rows under the box read idle and free, the composer empty", (name) => {
    const r = readScreen(fixtureRows(name, SURFACE_FIXTURES_DIR), agentOf("omp"), OMP);
    expect(r.frame).not.toBeNull();
    expect(r.frame!.interior.text).toBe("");
    expect(r.surface).toEqual(IDLE_FREE);
    expect(isFree(r.surface)).toBe(true);
  });

  it("omp: a draft under the widget's box still reads as a draft", () => {
    const rows = plainRows([...box.slice(0, 4), "╰─ Reply with only OK.", "   Second line of the message.", " widget row"]);
    const r = surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows, ask: null }, OMP);
    expect(r.frame?.interior.text).toBe("Reply with only OK. Second line of the message.");
    expect(r.surface.composer).toBe("draft");
  });
});

describe("an OMP extension's status row under the box and under a slash list (omp gang, 2026-10-25)", () => {
  // `ctx.ui.setStatus` draws one plain row under everything else. With a list of four rows or more under
  // the box the read was unreadable and torn; the profile now names that row as the list's footer.
  const OMP = requireProfile("omp").idle;
  const read = (name: string) => readScreen(fixtureRows(name, SURFACE_FIXTURES_DIR), agentOf("omp"), OMP);

  it("omp: the box with only the status row under it reads idle and free", () => {
    const r = read("omp--v18-12-6-status-row-idle.txt");
    expect(r.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "empty" });
  });

  it.each([
    ["omp--v18-12-6-status-row-palette-4.txt", "/wx"],
    ["omp--v18-6-1-status-row-palette-4.txt", "/wx"],
    ["omp--v18-12-6-status-row-palette-10.txt", "/w"],
    // omp-gang three S2 (2026-10-26): a widget of one to six rows under the palette, with a status row or without.
    ["omp--v18-6-1-palette-widget-below-6.txt", "/wx"],
    ["omp--v18-12-6-palette-widget-below-6.txt", "/wx"],
    ["omp--v18-6-1-palette-widget-and-status.txt", "/wx"],
    ["omp--v18-12-6-palette-widget-and-status.txt", "/wx"],
    ["omp--v18-6-1-palette-tick-below.txt", "/wx"],
    ["omp--v18-12-6-palette-tick-below.txt", "/wx"],
  ])("omp %s: the typed command with its list and the status row under it reads a draft, not unreadable or torn", (name, typed) => {
    const r = read(name);
    expect(r.frame?.interior.text).toBe(typed);
    expect(r.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
  });
});

describe("a running turn on live captures (Claude Code 2.1.301, 2026-10-16)", () => {
  const read = (name: string) => readScreen(fixtureRows(name), agentOf("claude"), idleFor("claude")).surface;

  it("a finished turn's leftover row reads idle and free", () => {
    for (const name of ["claude--v2301-idle-after-turn--w100.txt", "claude--v2301-done-shell-running--w100.txt", "claude--v2301-queued-taken--w100.txt"]) {
      expect(read(name), name).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
      expect(isFree(read(name)), name).toBe(true);
    }
  });

  it("a live running row reads running, with the box empty or holding a draft", () => {
    expect(read("claude--v2301-working-quiet--w100.txt")).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
    expect(read("claude--v2301-working-draft--w100.txt")).toMatchObject({ turn: "running", modal: "none", composer: "draft" });
  });

  it("a queued message reads running with an empty box: its placeholder is faint and its hint row is no modal", () => {
    expect(read("claude--v2301-working-queued-message--w100.txt")).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
  });

  it("the first second of a turn, a spinner with no timer yet, reads idle: a send there goes ahead and is queued all the same", () => {
    expect(read("claude--v2301-spinner-no-timer--w100.txt")).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
  });
});

// Hermes draws `☤` in front of its input while the agent runs, and nowhere else in that row: the
// prompt row is the turn's sign. A streaming reply shows no spinner, so nothing else would say it.
describe("a running turn on Hermes 0.22.2 captures (2026-10-16)", () => {
  const read = (name: string) => readScreen(fixtureRows(name), agentOf("hermes"), idleFor("hermes")).surface;

  it("the `☤` prompt reads running with the box empty, so a send waits for the turn", () => {
    expect(read("hermes--running.txt")).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
  });

  it("a clarify's typed answer reads idle and free: the question's ticking panel is no turn", () => {
    for (const name of ["hermes--clarify-other.txt", "hermes--clarify-other-w60.txt", "hermes--clarify-open.txt"]) {
      expect(read(name), name).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    }
  });
});

describe("foldSurface", () => {
  const context = { idle: CLAUDE, pollMs: 1000 };

  it("reads free off an idle frame, and carries the read's revision", () => {
    const { surface } = foldSurface([screen(1, 0, IDLE_SCREEN, 41)], context);
    expect(surface).toEqual({ revision: 41, turn: "idle", modal: "none", composer: "empty" });
    expect(isFree(surface)).toBe(true);
  });

  it("reads a draft, a running turn and a lifted ask", () => {
    expect(foldSurface([screen(1, 0, DRAFT_SCREEN)], context).surface.composer).toBe("draft");
    expect(foldSurface([screen(1, 0, RUNNING_SCREEN)], context).surface.turn).toBe("running");
    const lifted = foldSurface([screen(1, 0, DIALOG_SCREEN, 1, ASK)], context).surface;
    expect(lifted.modal).toEqual({ ask: ASK });
    expect(isFree(lifted)).toBe(false);
  });

  it("reads a strong cue no reader lifted as unreadable, and a weak one as unknown with no reason", () => {
    expect(foldSurface([screen(1, 0, DIALOG_SCREEN)], context).surface).toEqual({
      revision: 1,
      turn: "unknown",
      modal: "unreadable",
      composer: "unknown",
    });
    const weak = plainRows(["● done", "", "  1. first", "  2. second"]);
    expect(foldSurface([screen(1, 0, weak)], context).surface).toEqual({ revision: 1, turn: "unknown", modal: "unknown", composer: "unknown" });
  });

  it("says no-match when there is no frame, no cue and no lift", () => {
    expect(foldSurface([screen(1, 0, plainRows(["$ ls", "a b c", "$"]))], context).surface.reason).toBe("no-match");
  });

  it("says torn when the read ends inside a frame", () => {
    const torn = plainRows(["● done", "", "─".repeat(40), "❯ half a box"]);
    expect(endsInsideFrame(torn, CLAUDE)).toBe(true);
    expect(endsInsideFrame(IDLE_SCREEN, CLAUDE)).toBe(false);
    expect(foldSurface([screen(1, 0, torn)], context).surface).toEqual({ revision: 1, turn: "unknown", modal: "unknown", composer: "unknown", reason: "torn" });
  });

  it("says unreachable when the pane could not be read", () => {
    expect(foldSurface([screen(1, 0, null)], context).surface).toEqual({ revision: 1, turn: "unknown", modal: "unknown", composer: "unreachable" });
  });

  it("reads nothing as stale: no screen read in the log", () => {
    expect(foldSurface([{ seq: 1, source: "tick", at: 0 }], context).surface).toEqual({
      revision: 0,
      turn: "unknown",
      modal: "unknown",
      composer: "unknown",
      reason: "stale",
    });
  });

  it("makes a read stale after two poll intervals, and no clock ever makes a free", () => {
    const fresh: SurfaceInput[] = [screen(1, 0, IDLE_SCREEN), { seq: 2, source: "tick", at: 2000 }];
    expect(isFree(foldSurface(fresh, context).surface)).toBe(true);
    const stale: SurfaceInput[] = [screen(1, 0, IDLE_SCREEN), { seq: 2, source: "tick", at: 2001 }];
    expect(foldSurface(stale, context).surface).toEqual({ revision: 1, turn: "unknown", modal: "unknown", composer: "unknown", reason: "stale" });
    // A stale ask stays an ask: it is never free, and the phone still shows it.
    const staleAsk: SurfaceInput[] = [screen(1, 0, DIALOG_SCREEN, 1, ASK), { seq: 2, source: "tick", at: 9000 }];
    expect(foldSurface(staleAsk, context).surface.modal).toEqual({ ask: ASK });
    // Ticks alone, however many, never turn a dialog free.
    const ticks: SurfaceInput[] = [screen(1, 0, DIALOG_SCREEN), ...Array.from({ length: 20 }, (_, i) => ({ seq: i + 2, source: "tick" as const, at: 100 * i }))];
    expect(isFree(foldSurface(ticks, context).surface)).toBe(false);
  });

  it("takes inputs in seq order, whatever order the list holds them in", () => {
    const log: SurfaceInput[] = [screen(2, 10, DRAFT_SCREEN, 2), screen(1, 5, IDLE_SCREEN, 1)];
    expect(foldSurface(log, context).surface.composer).toBe("draft");
    expect(foldSurface(log.toReversed(), context).surface).toEqual(foldSurface(log, context).surface);
  });

  it("is a pure function of the log", () => {
    const log: SurfaceInput[] = [screen(1, 0, DIALOG_SCREEN, 7), { seq: 2, source: "tick", at: 500 }];
    expect(foldSurface(log, context)).toEqual(foldSurface([...log], context));
  });

  it("has no frame, and so no free, without a profile", () => {
    const { surface } = foldSurface([screen(1, 0, IDLE_SCREEN)], { idle: null, pollMs: 1000 });
    expect(isFree(surface)).toBe(false);
    expect(surface.composer).toBe("unknown");
  });

  it("names its sources in one list: screen reads, ticks and hook edges (spec 11)", () => {
    expect([...SURFACE_SOURCES]).toEqual(["screen", "tick", "edge"]);
  });

  it("agrees with surfaceOfScreen on one read", () => {
    const input = screen(1, 0, IDLE_SCREEN);
    expect(foldSurface([input], context)).toEqual(surfaceOfScreen(input, CLAUDE));
  });

  it("finds the frame the frame module finds", () => {
    expect(foldSurface([screen(1, 0, IDLE_SCREEN)], context).frame).toEqual(findInputFrame(IDLE_SCREEN, CLAUDE));
    expect(rowsOf("a\nb")).toHaveLength(2);
  });
});

// The 2026-10-16 incident on lane 8788: 37 sends refused `unconfirmed` with `modal: unreadable` while a
// fork ran and Claude Code 2.1.301 drew its agents panel under a free box. The capture and the two
// hand-built screens are labelled idle; each must read free, and the panel must be the frame's footer.
describe("the agents panel under the box (incident 2026-10-16)", () => {
  const PANEL = ["claude--v2301-fork-running-main-idle.txt", "claude--v2301-synth-agents-panel.txt", "claude--v2301-synth-agents-panel-walk-fails.txt"];

  for (const name of PANEL) {
    it(`${name} reads free, the panel walked as the footer and no cue read`, () => {
      expect(LABELS.fixtures[name]?.state).toBe("idle");
      const read = readScreen(fixtureRows(name), "claude", CLAUDE);
      expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "empty" });
      expect(read.frame?.volatile.footer).not.toBeNull();
      expect(read.frame?.volatile.named.some((hit) => hit.name === "agents-panel-main")).toBe(true);
      expect(read.cues?.cues).toEqual([]);
    });
  }
  // The review of 2026-10-16: a dialog drawn between the statusline and the panel must never pass as
  // a second footer. Each reads unreadable or as a dialog, never free.
  const RULE40 = "─".repeat(40);
  const PANEL_ROWS = ["", "  ● main", "  ◯ general-purpose   Reading a file     2m 3s · ↓ 120.1k tokens"];
  const OVER_PANEL = {
    "a Yes/No pointer list": ["  Do you want to proceed?", " ❯ 1. Yes", "   2. No"],
    "a menu with its select hint": [" ❯ Option A", "   Option B", "  Enter to select · Esc to cancel"],
    "a list ending in the view hint": [" ❯ item one", "   item two", "  Enter to select · ↓ to view"],
  } satisfies Record<string, readonly string[]>;
  for (const [what, dialog] of Object.entries(OVER_PANEL)) {
    it(`${what} over the panel never reads free`, () => {
      const rows = rowsOf(["● done", "", RULE40, "❯ ", RULE40, "  ⏵⏵ auto mode on · 1 shell", "", ...dialog, ...PANEL_ROWS].join("\n"));
      const read = readScreen(rows, "claude", CLAUDE);
      expect(modalWord(read.surface.modal)).not.toBe("none");
      expect(isFree(read.surface)).toBe(false);
    });
  }

  it("twelve agent rows under main do not read free", () => {
    const agents = Array.from({ length: 12 }, (_, i) => `  ◯ agent-${String(i)}   working   ${String(i)}s · ↓ 1k tokens`);
    const rows = rowsOf(["● done", "", RULE40, "❯ ", RULE40, "  ⏵⏵ auto mode on · 1 shell", "", "  ● main", ...agents].join("\n"));
    expect(isFree(readScreen(rows, "claude", CLAUDE).surface)).toBe(false);
  });

  // The scratch-bridge lab on 2026-10-16 (Claude Code 2.1.301, a background agent running): the panel
  // stays under the box while the box holds a draft; only the mode row drops its two hints.
  it("the lab screens read free with an empty box and with a draft", () => {
    for (const [name, composer, state] of [
      ["claude--v2301-lab-agents-panel-empty.txt", "empty", "idle"],
      ["claude--v2301-lab-agents-panel-draft.txt", "draft", "draft"],
    ] as const) {
      expect(LABELS.fixtures[name]?.state).toBe(state);
      const read = readScreen(fixtureRows(name), "claude", CLAUDE);
      expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer });
      expect(read.frame?.volatile.named.map((hit) => hit.name)).toEqual(["agents-panel-main", "agents-panel-agent"]);
      expect(read.cues?.cues).toEqual([]);
    }
  });

  // Eleven agents: the panel shows five and "↓ 6 more". One ↓ focuses the tasks pill, two the panel.
  it("the lab's eleven-agent panel reads free, with the tasks pill focused and with the panel focused", () => {
    for (const name of ["claude--v2301-lab-agents-panel-more.txt", "claude--v2301-lab-agents-panel-tasks-pill.txt", "claude--v2301-lab-agents-panel-focused.txt"]) {
      expect(LABELS.fixtures[name]?.state).toBe("idle");
      const read = readScreen(fixtureRows(name), "claude", CLAUDE);
      expect(read.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "empty" });
      const names = read.frame?.volatile.named.map((hit) => hit.name) ?? [];
      expect(names[0]).toBe("agents-panel-main");
      expect(names.at(-1)).toBe("agents-panel-more");
      expect(read.cues?.cues).toEqual([]);
    }
  });
});

describe("rows around an idle box that 1.21.3 sent to (1.22.1 audit)", () => {
  const IDLE_FREE = { revision: 1, turn: "idle", modal: "none", composer: "empty" };
  // Derived screens in fixtures/surface/ (README there), read with their harness's own profile.
  const audit = (name: string, harness: string) => readScreen(fixtureRows(name, SURFACE_FIXTURES_DIR), agentOf(harness), idleFor(harness));

  // Issue 374's screen: a custom statusLine prints as many rows as the user wrote, and 1.21.3 found
  // the box under up to eight of them. 1.22.0's agy profile searched three.
  it("agy: an idle box over a four-row custom statusLine reads idle and free", () => {
    const read = audit("agy--statusline-four-rows.txt", "agy");
    expect(read.frame).not.toBeNull();
    expect(read.surface).toEqual(IDLE_FREE);
  });

  it("agy: up to eight statusLine rows under the box read free, a ninth row loses the box", () => {
    const AGY = requireProfile("agy").idle;
    const rule = "─".repeat(60);
    const status = (n: number) => Array.from({ length: n }, (_, i) => `status row ${String(i + 1)}`);
    const read = (n: number) => surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows: plainRows(["Done.", "", rule, ">", rule, ...status(n)]), ask: null }, AGY);
    for (let n = 0; n <= 8; n++) expect(read(n).surface, String(n)).toEqual(IDLE_FREE);
    expect(isFree(read(9).surface)).toBe(false);
  });

  // pi prints the folder first under its box. On Windows a folder outside the home folder starts with
  // its drive letter; inside it, with `~`.
  it("pi: a folder row that starts with a drive letter reads idle and free", () => {
    const read = audit("pi--v0871-idle-windows-drive.txt", "pi");
    expect(read.frame).not.toBeNull();
    expect(read.surface).toEqual(IDLE_FREE);
  });

  // A `(y/n)` in the agent's last row, flush on OMP's open box, reads as a single-key prompt and hides
  // the box (`dialogsInBox`). The box is whole, so the read is not torn: the person may check it and
  // confirm, as on pi and muse. It never reads free.
  it("omp: a (y/n) question flush on a whole box is not free and not torn", () => {
    const read = audit("omp--done-yn-question.txt", "omp");
    expect(findInputFrame(fixtureRows("omp--done-yn-question.txt", SURFACE_FIXTURES_DIR), idleFor("omp")!)).not.toBeNull();
    expect(read.surface).toEqual({ revision: 1, turn: "unknown", modal: "unreadable", composer: "unknown" });
    expect(isFree(read.surface)).toBe(false);
  });

  it("omp: a screen with no whole box under a strong cue still reads torn", () => {
    // The slash palette stands under the prompt row. With the pointer taken off its first entry it is no
    // list (`leadOpens` needs a pointed list), so no frame closes and the read ends inside one.
    const raw = readFileSync(join(PANES_DIR, "omp--slash-palette.txt"), "utf8");
    expect(raw).toContain("\u276f skill:");
    const rows = rowsOf(raw.replace("\u276f skill:", "  skill:"));
    expect(findInputFrame(rows, idleFor("omp")!)).toBeNull();
    expect(readScreen(rows, "omp", idleFor("omp")).surface.reason).toBe("torn");
  });
});

// Claude Code 2.1.302's "Heads up" notice above a live box: its keys act only on a box that holds one
// digit, so the box stays free. The rating survey over the box is a notice too since 2026-10-19 (ADR 0109).
describe("a notice above a live box (Claude Code 2.1.302)", () => {
  it("folds the heads-up notice with no modal over the box", () => {
    const read = readScreen(fixtureRows("claude--v2302-heads-up-above-box--w142.txt"), "claude", CLAUDE);
    expect(read.frame).not.toBeNull();
    expect(read.surface.modal).toBe("none");
    expect(read.surface.composer).toBe("empty");
  });

  it("reads the turn as running from the spinner above the notice, words before its timer and all", () => {
    const read = readScreen(fixtureRows("claude--v2302-heads-up-above-box--w142.txt"), "claude", CLAUDE);
    expect(read.surface.turn).toBe("running");
  });

  // Decided 2026-10-19 (ADR 0109): the 2.1.278 survey reads as a notice. Until then it read unreadable.
  it("reads the rating survey over the box as a notice: no modal, the box free", () => {
    const read = readScreen(fixtureRows("claude-lab--survey-rating-above-box--w82.txt"), "claude", CLAUDE);
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(isFree(read.surface)).toBe(true);
  });
});

// Claude Code 2.1.30x writes a named session's name into the right end of the box's top edge
// (`──── 1.23.0 ─`). Lane 8788, 2026-10-19: every send to the named pane was refused `unconfirmed`
// with `modal: "unreadable"`. The edge was not the cause: the rating survey stood on the update row
// right over the box, one run with it, and its key row read as a single-key prompt. The same day the
// survey became a notice (ADR 0109) and the update row a gap the profile names, so the screen reads free.
describe("a session name in the box's top edge (Claude Code 2.1.303, lane 8788, 2026-10-19)", () => {
  const name = (state: string) => `claude--v2303-titled-edge-${state}--w160.txt`;
  const read = (rows: ReturnType<typeof fixtureRows>) => readScreen(rows, "claude", CLAUDE);
  const textOf = (rows: ReturnType<typeof fixtureRows>) => rows.map((row) => row.segments.map((s) => s.text).join(""));
  const topOf = (rows: ReturnType<typeof fixtureRows>) => textOf(rows).findIndex((text) => text.endsWith(" 1.23.0 ─"));
  const withRow = (rows: ReturnType<typeof fixtureRows>, at: number, text: string) => rows.map((row, i) => (i === at ? rowsOf(text)[0]! : row));

  it("reads the titled edge as the box's edge, the name as its label and never as the draft", () => {
    for (const [state, turn, composer, text] of [
      ["working", "running", "empty", ""],
      ["idle", "idle", "empty", ""],
      ["draft", "idle", "draft", "ok merge the five, running the crew update now"],
    ] as const) {
      const r = read(fixtureRows(name(state)));
      expect(r.frame?.label, state).toBe("1.23.0");
      expect(r.frame?.interior.text, state).toBe(text);
      expect(r.surface, state).toEqual({ revision: 1, turn, modal: "none", composer });
    }
    expect(isFree(read(fixtureRows(name("idle"))).surface)).toBe(true);
  });

  it("reads a draft under the titled edge during a turn", () => {
    const rows = fixtureRows(name("working"));
    const r = read(withRow(rows, topOf(rows) + 1, "❯ hello there"));
    expect(r.frame?.interior.text).toBe("hello there");
    expect(r.surface).toMatchObject({ turn: "running", modal: "none", composer: "draft" });
  });

  it("the field screen: the survey on the update row over the box reads free, with or without the name", () => {
    const rows = fixtureRows(name("survey"));
    const r = read(rows);
    expect(r.surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "empty" });
    expect(isFree(r.surface)).toBe(true);
    expect(r.cues?.strength).toBe("none");
    // The same screen with a plain edge of the same width reads the same.
    const plain = withRow(rows, topOf(rows), "─".repeat(160));
    expect(read(plain).frame?.label).toBeNull();
    expect(read(plain).surface).toEqual(r.surface);
    // A blank row between the survey's key row and the update row changes nothing.
    const keys = textOf(rows).findIndex((text) => text.startsWith("  1: Bad"));
    const gapped = [...rows.slice(0, keys + 1), rowsOf("")[0]!, ...rows.slice(keys + 1)];
    expect(read(gapped).surface).toEqual(r.surface);
  });

  it("folds the heads-up notice over a titled edge with no modal over the box", () => {
    const rows = fixtureRows("claude--v2302-heads-up-above-box--w142.txt");
    const top = read(rows).frame!.top;
    const r = read(withRow(rows, top, `${"─".repeat(132)} 1.23.0 ─`));
    expect(r.frame?.top).toBe(top);
    expect(r.frame?.label).toBe("1.23.0");
    expect(r.surface).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
  });
});

// Live rerun 2026-10-23: Claude Code fires no Stop hook when the person interrupts a turn (Escape) or
// refuses a permission. The UserPromptSubmit edge's running block then held the turn `running` while
// the screen read idle: until the lost-Stop reads (three free reads over ten seconds, and never with a
// draft in the box) or the next Stop. The Stop button stayed, and a tap answered `turn_idle`. Real
// captures of 2.1.309 on Haiku; the stopped row `⎿  Interrupted · What should Claude do instead?`
// ends the blocks on the first read that shows it.
describe("a turn stopped without its Stop hook (Claude Code 2.1.309, live rerun 2026-10-23)", () => {
  const context: FoldContext = { idle: CLAUDE, pollMs: 1500, settleMs: 1500 };
  const INTERRUPTED = fixtureRows("claude--v2-1-309-interrupted--w120.txt");
  const DENIED = fixtureRows("claude--v2-1-309-permission-denied--w120.txt");
  const prompt = (seq: number, at: number): SurfaceInput => ({ seq, source: "edge", at, kind: "prompt" });
  const dialog = (seq: number, at: number): SurfaceInput => ({ seq, source: "edge", at, kind: "dialog" });
  /** The screen as plain rows, the box's empty prompt row holding `draft`. */
  const withDraft = (rows: ScreenInput["rows"], draft: string): ScreenInput["rows"] => {
    const texts = rows!.map((row) => rowText(row));
    const at = texts.findLastIndex((text) => /^❯\s*$/u.test(text));
    expect(at).toBeGreaterThan(0);
    texts[at] = `❯ ${draft}`;
    return plainRows(texts);
  };
  const run = (log: readonly SurfaceInput[], ctx: FoldContext = context) => {
    let state = emptyFoldState();
    for (const input of log) state = stepFold(state, input, ctx);
    return { state, surface: readFold(state, ctx).surface };
  };

  it("the screen alone reads both captures idle and free", () => {
    for (const rows of [INTERRUPTED, DENIED]) expect(surfaceOfScreen(screen(1, 0, rows), CLAUDE).surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "empty" });
  });

  it("after Escape: the prompt edge's block ends on the first read of the stopped row, no lost Stop", () => {
    const { state, surface } = run([prompt(1, 0), screen(2, 2000, INTERRUPTED)]);
    expect(surface).toEqual({ revision: 2, turn: "idle", modal: "none", composer: "empty" });
    expect(state.running).toBeNull();
    expect(state.lostStops).toBe(0);
  });

  it("without the profile's stopped rows the block holds the turn running: the defect", () => {
    const bare: FoldContext = { ...context, idle: { ...CLAUDE, stoppedRows: undefined } };
    expect(run([prompt(1, 0), screen(2, 2000, INTERRUPTED)], bare).surface.turn).toBe("running");
  });

  it("after a refused permission: the prompt and dialog blocks both end, the Surface reads free", () => {
    const { state, surface } = run([prompt(1, 0), dialog(2, 8000), screen(3, 21_000, DENIED)]);
    expect(surface).toEqual({ revision: 3, turn: "idle", modal: "none", composer: "empty" });
    expect(isFree(surface)).toBe(true);
    expect(state.dialog).toBeNull();
  });

  it("a draft in the box no longer keeps the turn running (the lost-Stop reads need an empty box)", () => {
    const { surface } = run([prompt(1, 0), screen(2, 2000, withDraft(INTERRUPTED, "my draft text"))]);
    expect(surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
  });

  it("a block younger than the settle time stays: the row may still stand from the turn before", () => {
    const young = run([prompt(1, 0), screen(2, 500, INTERRUPTED)]);
    expect(young.state.running).not.toBeNull();
    expect(young.surface).toMatchObject({ turn: "unknown", reason: "contested" });
    expect(run([prompt(1, 0), screen(2, 500, INTERRUPTED), screen(3, 2000, INTERRUPTED)]).surface.turn).toBe("idle");
  });

  it("the row over a new turn's running sign ends nothing: the screen reads running", () => {
    const texts = INTERRUPTED.map((row) => rowText(row));
    // The box's top rule: the rule right over the last `❯` row.
    const top = texts.findLastIndex((text, i) => /^─{8,}/u.test(text) && (texts[i + 1] ?? "").startsWith("❯"));
    expect(top).toBeGreaterThan(texts.findIndex((text) => text.includes("Interrupted")));
    const running = plainRows([...texts.slice(0, top), "❯ next prompt", "✻ Pondering… (4s · esc to interrupt)", ...texts.slice(top)]);
    const { state, surface } = run([prompt(1, 0), screen(2, 2000, running)]);
    expect(surface.turn).toBe("running");
    expect(state.running).not.toBeNull();
  });

  it("a dialog screen that still shows the row ends nothing", () => {
    const rows = fixtureRows("claude-lab--plan-approval--w82.txt");
    expect(rows.some((row) => rowText(row).includes("Interrupted · What should Claude do instead?"))).toBe(true);
    const { state } = run([prompt(1, 0), screen(2, 5000, rows)]);
    expect(state.running).not.toBeNull();
  });

  // Second live pass (2026-10-23): Collie's own Stop in a fresh session, and a refused permission in
  // another, kept the turn running 11 to 19 s, until the lost-Stop reads (bridge journal:
  // `surface.lost-stop pane=w76:p3` at 16:36:16 and 16:38:05). Claude Code's fullscreen TUI pins the
  // box to the bottom; a short transcript stands at the top with blank rows down to the box, so the
  // stopped row stood about twenty rows over it, outside the six-row band. Real captures, 120 x 40.
  const FRESH = fixtureRows("claude--v2-1-309-interrupted-fresh-session--w120.txt");
  const FRESH_DENIED = fixtureRows("claude--v2-1-309-permission-denied-fresh-session--w120.txt");
  const rowsOverBox = (rows: ScreenInput["rows"]): number => {
    const texts = rows!.map((row) => rowText(row));
    const frame = findInputFrame(rows!, CLAUDE)!;
    return frame.top - texts.findIndex((text) => text.includes("Interrupted · What should Claude do instead?"));
  };

  it("a fresh fullscreen session: the stopped row stands far over the box, past blank rows only, and still ends the blocks", () => {
    expect(rowsOverBox(FRESH)).toBeGreaterThan(CLAUDE.volatile.above.maxRows);
    expect(rowsOverBox(FRESH_DENIED)).toBeGreaterThan(CLAUDE.volatile.above.maxRows);
    const escaped = run([prompt(1, 0), screen(2, 2000, FRESH)]);
    expect(escaped.surface).toEqual({ revision: 2, turn: "idle", modal: "none", composer: "empty" });
    expect(escaped.state.lostStops).toBe(0);
    const denied = run([prompt(1, 0), dialog(2, 8000), screen(3, 21_000, FRESH_DENIED)]);
    expect(denied.surface).toEqual({ revision: 3, turn: "idle", modal: "none", composer: "empty" });
    expect(denied.state.dialog).toBeNull();
    expect(denied.state.lostStops).toBe(0);
  });

  it("the blank rows are not counted, rows with text are: a stopped row under six rows of newer text ends nothing", () => {
    const texts = INTERRUPTED.map((row) => rowText(row));
    const at = texts.findLastIndex((text) => text.includes("Interrupted · What should Claude do instead?"));
    const newer = Array.from({ length: CLAUDE.volatile.above.maxRows }, (_, i) => `  ${String(i + 1)}. a newer line of the transcript`);
    const buried = plainRows([...texts.slice(0, at + 1), ...newer, ...texts.slice(at + 1)]);
    const { state, surface } = run([prompt(1, 0), screen(2, 2000, buried)]);
    expect(surface.turn).toBe("running");
    expect(state.running).not.toBeNull();
  });

  // Second live pass: Collie's Stop before the first token. Claude Code takes the turn back and puts
  // the prompt into the box: no Interrupted row, a draft, so the lost-Stop reads never count, and the
  // turn read running 20 s and more, until the box was cleared. The Stop receipt said `stopped`; the
  // bridge gives that to the fold as a `stop` edge (the shadow's `stopSeen`). Real capture.
  const RESTORED = fixtureRows("claude--v2-1-309-stopped-prompt-restored--w120.txt");
  const stop = (seq: number, at: number): SurfaceInput => ({ seq, source: "edge", at, kind: "stop" });

  it("Stop before the first token: the restored prompt holds the block on every read; the Stop receipt's stop edge ends it", () => {
    expect(surfaceOfScreen(screen(1, 0, RESTORED), CLAUDE).surface).toEqual({ revision: 1, turn: "idle", modal: "none", composer: "draft" });
    const reads = [2000, 5000, 8000, 11_000, 14_000, 21_000].map((at, i) => screen(i + 2, at, RESTORED));
    const held = run([prompt(1, 0), ...reads]);
    expect(held.surface.turn).toBe("running");
    expect(held.state.lostStops).toBe(0);
    const { state, surface } = run([prompt(1, 0), screen(2, 2000, RESTORED), stop(3, 2400), screen(4, 3000, RESTORED)]);
    expect(surface).toEqual({ revision: 4, turn: "idle", modal: "none", composer: "draft" });
    expect(state.running).toBeNull();
    expect(state.lostStops).toBe(0);
  });
});
