import { describe, expect, it } from "vitest";

import { agentOf, fixtureRows, idleFor, readScreen, rowsOf, SURFACE_FIXTURES_DIR } from "../../test/surface-corpus";
import { findInputFrame, plainRows } from "./frame";
import { endsInsideFrame, foldSurface, type ScreenInput, SURFACE_SOURCES, type SurfaceInput, surfaceOfScreen } from "./fold";
import { requireProfile } from "./profile";
import { type Ask, isFree, modalWord } from "./surface";
import { ASK, CLAUDE, LABELS, own } from "../../test/surface-fold";

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

  it("omp: up to maxTailRows rows under the box read free, one more reads torn", () => {
    const widget = (n: number) => Array.from({ length: n }, (_, i) => ` widget row ${i + 1}`);
    expect(OMP.frame.maxTailRows).toBe(3);
    expect(surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows: plainRows([...box, ...widget(3)]), ask: null }, OMP).surface).toEqual(IDLE_FREE);
    expect(surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows: plainRows([...box, "", ...widget(2)]), ask: null }, OMP).surface).toEqual(IDLE_FREE);
    expect(surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows: plainRows([...box, ...widget(4)]), ask: null }, OMP).surface.reason).toBe("torn");
  });

  it("omp: a draft under the widget's box still reads as a draft", () => {
    const rows = plainRows([...box.slice(0, 4), "╰─ Reply with only OK.", "   Second line of the message.", " widget row"]);
    const r = surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 1, rows, ask: null }, OMP);
    expect(r.frame?.interior.text).toBe("Reply with only OK. Second line of the message.");
    expect(r.surface.composer).toBe("draft");
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
    // The slash palette stands under the prompt row, so no frame closes and the read ends inside one.
    const read = own("omp--slash-palette.txt");
    expect(findInputFrame(fixtureRows("omp--slash-palette.txt"), idleFor("omp")!)).toBeNull();
    expect(read.surface.reason).toBe("torn");
  });
});

// Claude Code 2.1.302's "Heads up" notice above a live box: its keys act only on a box that holds one
// digit, so the box stays free. The rating survey over the box is another shape and stays unreadable.
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

  it("keeps the rating survey over the box unreadable", () => {
    expect(readScreen(fixtureRows("claude-lab--survey-rating-above-box--w82.txt"), "claude", CLAUDE).surface.modal).toBe("unreadable");
  });
});
