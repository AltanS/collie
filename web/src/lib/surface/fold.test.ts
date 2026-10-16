import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  agentOf,
  CUES_BLIND,
  fixtureRows,
  idleFor,
  incidentScreens,
  loadLabels,
  PANES_DIR,
  perturbations,
  readScreen,
  rowsOf,
} from "../../test/surface-corpus";
import { findInputFrame, plainRows } from "./frame";
import { endsInsideFrame, foldSurface, SURFACE_SOURCES, surfaceOfScreen, type ScreenInput, type SurfaceInput } from "./fold";
import { requireProfile } from "./profile";
import { askOf, isFree, modalWord, type Ask, type Surface } from "./surface";

// M56 spec 04: the fold from a numbered input log to a Surface, and the profile tests of the design
// record (experiments/reader-stability/ARCHITECTURE.md section 4) over the whole fixture corpus:
//  (a) the idle matcher and the modal detector never both match one fixture;
//  (b) a perturbed fixture stays the same or becomes unknown, never free from a dialog;
//  (d) the negative set never reads free.
// (c), quoted dialogs in a transcript, is in cues.test.ts.

const CLAUDE = requireProfile("claude").idle;
const LABELS = loadLabels();
const FIXTURES = readdirSync(PANES_DIR)
  .filter((name) => name.endsWith(".txt"))
  .toSorted();
const NEGATIVE = new Set(["dialog", "screen"]);

// Incident screens that read free when the one profile there is is applied to a harness it does not
// describe. The Surface takes its profile from the binary, never from the screen, so this is a
// record of what a later profile must cover, not a gap in the fold.
const WRONG_PROFILE_FREE = new Map([
  [
    "5de40a86",
    "Muse draws its tasks popup in the rows under its own box where this profile walks a statusline; a statusline is never read for a cue. Muse has no profile, so its panes never read free.",
  ],
]);

function labelOf(name: string) {
  const label = LABELS.fixtures[name];
  if (label === undefined) throw new Error(`${name} has no row in surface-labels.json`);
  return label;
}

/** A fixture read the way the shadow reads it: its harness's own profile, the readers lifting. */
function own(name: string) {
  const label = labelOf(name);
  return readScreen(fixtureRows(name), agentOf(label.harness), idleFor(label.harness));
}

describe("the label file", () => {
  it("has one row per pane fixture, and none for a fixture that is gone", () => {
    expect(Object.keys(LABELS.fixtures).toSorted()).toEqual(FIXTURES);
  });

  it("names a known state on every row", () => {
    const states = new Set(["idle", "draft", "running", "popup", "dialog", "screen", "other"]);
    for (const [name, label] of Object.entries(LABELS.fixtures)) expect(states.has(label.state), name).toBe(true);
  });

  it("holds all eight incident commits of the research note", () => {
    expect(Object.keys(LABELS.incidents).toSorted()).toEqual(
      ["526d7a92", "5de40a86", "78234d4f", "7d964012", "9acc1502", "a3e74596", "c7e5c8e8", "ec3e5efc"].toSorted(),
    );
    for (const incident of incidentScreens()) expect(incident.rows.length, incident.name).toBeGreaterThan(0);
  });
});

describe("running labels", () => {
  const readsFree = (name: string): boolean => {
    const label = LABELS.fixtures[name]!;
    return isFree(readScreen(fixtureRows(name), agentOf(label.harness), idleFor(label.harness)).surface);
  };

  it("no fixture labelled running reads free, except the known mismatches, each with its reason", () => {
    const free = Object.entries(LABELS.fixtures)
      .filter(([name, label]) => label.state === "running" && readsFree(name))
      .map(([name]) => name)
      .toSorted();
    expect(free).toEqual(Object.keys(LABELS.knownMismatches).toSorted());
  });

  it("every known mismatch is a running label that still reads free", () => {
    for (const [name, why] of Object.entries(LABELS.knownMismatches)) {
      expect(LABELS.fixtures[name]?.state, name).toBe("running");
      expect(why.length, name).toBeGreaterThan(20);
      expect(readsFree(name), name).toBe(true);
    }
  });
});

describe("the idle matcher and the modal detector", () => {
  // The idle matcher is the profile's idle signature: the frame is found, the composer is empty and
  // the turn idle, and no cue at all sits at the frame. The modal detector is a block reader's typed
  // lift, or a strong generic cue. The cue halves read the same anchored cluster, so they exclude
  // each other by construction; what this pins is that construction, and that no reader ever lifts a
  // dialog off a screen whose idle signature holds. Run with each fixture's own profile, and again
  // with the one profile there is applied to every fixture (a wrong profile must not make both
  // match either).
  function idleSignature(read: ReturnType<typeof own>): boolean {
    return read.frame !== null && read.surface.composer === "empty" && read.surface.turn === "idle" && read.cues?.strength === "none";
  }
  function modalDetector(read: ReturnType<typeof own>): boolean {
    return askOf(read.surface.modal) !== null || read.cues?.strength === "strong";
  }

  it("never both match one fixture, with its own profile", () => {
    const both = FIXTURES.filter((name) => {
      const read = own(name);
      return idleSignature(read) && modalDetector(read);
    });
    expect(both).toEqual([]);
  });

  it("never both match one fixture, with the one profile applied to every fixture", () => {
    const both = FIXTURES.filter((name) => {
      const read = readScreen(fixtureRows(name), agentOf(labelOf(name).harness), CLAUDE);
      return idleSignature(read) && modalDetector(read);
    });
    expect(both).toEqual([]);
  });

  it("never both match: the matchers are not vacuous", () => {
    const idle = FIXTURES.filter((name) => idleSignature(own(name))).length;
    const modal = FIXTURES.filter((name) => modalDetector(own(name))).length;
    expect(idle).toBeGreaterThan(30);
    expect(modal).toBeGreaterThan(300);
  });
});

/**
 * The claims of `after` that moved toward free from `before`: a modal that became `none`, a turn that
 * became `idle`, a composer that became `empty` or `draft`. A claim that stays, turns `unknown`, or
 * stays a modal of another kind (an ask the reader lost and the cues kept as `unreadable`) moved
 * away from free or nowhere.
 */
function towardFree(before: Surface, after: Surface): string[] {
  const moved: string[] = [];
  if (after.modal === "none" && before.modal !== "none") moved.push(`modal ${modalWord(before.modal)} -> none`);
  if (after.turn === "idle" && before.turn !== "idle") moved.push(`turn ${before.turn} -> idle`);
  if ((after.composer === "empty" || after.composer === "draft") && after.composer !== before.composer) {
    moved.push(`composer ${before.composer} -> ${after.composer}`);
  }
  return moved;
}

describe("perturbed fixtures", () => {
  // Each fixture is perturbed (moved row, blank row, extra status row, dropped border, width change)
  // and read again through the whole pipeline. A perturbed screen may stay the same or lose its
  // claims; it may never become free unless the fixture itself is free, and a negative fixture may
  // never become free at all. On a negative fixture no single claim may move toward free either: the
  // design record's "stays the same or becomes unknown", where a modal that changes kind still counts
  // as a modal.
  for (const name of FIXTURES) {
    it(`perturb: ${name}`, () => {
      const label = labelOf(name);
      const agent = agentOf(label.harness);
      const idle = idleFor(label.harness);
      const before = readScreen(fixtureRows(name), agent, idle).surface;
      const original = isFree(before);
      const wrong: string[] = [];
      for (const perturbed of perturbations(fixtureRows(name))) {
        const after = readScreen(perturbed.rows, agent, idle).surface;
        if (isFree(after) && (!original || NEGATIVE.has(label.state))) wrong.push(`${perturbed.name}: free`);
        if (NEGATIVE.has(label.state)) for (const move of towardFree(before, after)) wrong.push(`${perturbed.name}: ${move}`);
      }
      expect(wrong).toEqual([]);
    });
  }

  it("perturb: a claim that moves toward free is caught", () => {
    const dialog: Surface = { revision: 1, turn: "unknown", modal: "unreadable", composer: "unknown" };
    expect(towardFree(dialog, { ...dialog, modal: "none", composer: "draft" })).toEqual(["modal unreadable -> none", "composer unknown -> draft"]);
    expect(towardFree(dialog, { ...dialog, modal: "unknown" })).toEqual([]);
    expect(towardFree({ ...dialog, modal: { ask: ASK } }, dialog)).toEqual([]);
  });

  it("perturb: the incident screens never become free", () => {
    const wrong: string[] = [];
    for (const incident of incidentScreens()) {
      const profiles = WRONG_PROFILE_FREE.has(incident.sha) ? [idleFor(incident.agent)] : [idleFor(incident.agent), CLAUDE];
      for (const idle of profiles) {
        for (const perturbed of perturbations(incident.rows)) {
          if (isFree(readScreen(perturbed.rows, incident.agent, idle).surface)) wrong.push(`${incident.name}: ${perturbed.name}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("perturb: most idle frames survive a blank row and an extra status row", () => {
    const idle = FIXTURES.filter((name) => labelOf(name).state === "idle" && labelOf(name).harness === "claude");
    let kept = 0;
    let total = 0;
    for (const name of idle) {
      for (const perturbed of perturbations(fixtureRows(name)).filter((p) => p.name.startsWith("one more status row at"))) {
        total++;
        if (isFree(readScreen(perturbed.rows, "claude", CLAUDE).surface)) kept++;
      }
    }
    expect(total).toBeGreaterThan(30);
    expect(kept / total).toBeGreaterThan(0.9);
  });
});

describe("the negative set", () => {
  // Every dialog, picker, rating prompt, search box and shell prompt fixture, and the eight incident
  // screens, must never read free: with the harness's own profile, and with the one profile there is
  // applied to every screen.
  const negative = FIXTURES.filter((name) => NEGATIVE.has(labelOf(name).state));

  it("negative set: is not vacuous", () => {
    expect(negative.length).toBeGreaterThan(400);
    expect(incidentScreens().length).toBeGreaterThanOrEqual(19);
  });

  for (const name of negative) {
    it(`negative set: ${name} never reads free`, () => {
      const label = labelOf(name);
      expect(isFree(own(name).surface)).toBe(false);
      expect(isFree(readScreen(fixtureRows(name), agentOf(label.harness), CLAUDE).surface)).toBe(false);
      expect(isFree(readScreen(fixtureRows(name), agentOf(label.harness), CLAUDE, { lift: false }).surface)).toBe(false);
    });
  }

  it("negative set: the eight incident screens never read free", () => {
    const wrong = incidentScreens().filter(
      (incident) =>
        isFree(readScreen(incident.rows, incident.agent, idleFor(incident.agent)).surface) ||
        (!WRONG_PROFILE_FREE.has(incident.sha) && isFree(readScreen(incident.rows, incident.agent, CLAUDE).surface)),
    );
    expect(wrong.map((incident) => `${incident.sha} ${incident.name}`)).toEqual([]);
  });

  it("negative set: at least 95% of idle Claude fixtures do read free", () => {
    const idle = FIXTURES.filter((name) => labelOf(name).state === "idle" && labelOf(name).harness === "claude");
    const free = idle.filter((name) => isFree(own(name).surface));
    expect(idle.length).toBeGreaterThan(30);
    expect(free.length / idle.length).toBeGreaterThanOrEqual(0.95);
  });
});

describe("the generic cues alone", () => {
  // The other harnesses have no profile and few readers, so the cues are what keeps their dialogs from
  // a guess: with no reader lifting, every dialog fixture of a harness other than the profiled one
  // reads as a modal (`unreadable`), not merely `unknown`. scripts/surface-corpus.ts fails on the same
  // rule and prints the column.
  const others = FIXTURES.filter((name) => {
    const label = labelOf(name);
    // A "-cut" fixture is a screen truncated on purpose: it hides the footer that proves the dialog, and its uncut sibling is in the set.
    // CUES_BLIND names the dialogs whose bottom cluster the cues cannot reach, each with its reason.
    return (
      label.state === "dialog" &&
      label.harness !== "claude" &&
      label.harness !== "shell" &&
      !name.endsWith("-cut.txt") &&
      !CUES_BLIND.has(name)
    );
  });

  it("cues alone: the set covers codex, pi, opencode, grok and omp", () => {
    const harnesses = new Set(others.map((name) => labelOf(name).harness));
    for (const harness of ["codex", "pi", "opencode", "grok", "omp"]) expect(harnesses.has(harness), harness).toBe(true);
    expect(others.length).toBeGreaterThan(200);
  });

  it("cues alone: flag every dialog fixture of the other harnesses as modal", () => {
    const missed = others.filter((name) => {
      const label = labelOf(name);
      const surface = readScreen(fixtureRows(name), agentOf(label.harness), idleFor(label.harness), { lift: false }).surface;
      return surface.modal !== "unreadable" && askOf(surface.modal) === null;
    });
    expect(missed).toEqual([]);
  });
});

// ── The fold's own rules ─────────────────────────────────────────────────────────────────────────

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
const ASK: Ask = { id: "ask-1-0", kind: "permission", options: [{ id: "1", label: "Yes" }], channel: "keys", hash: "00" };

function screen(seq: number, at: number, rows: ScreenInput["rows"], revision = seq, ask: Ask | null = null): ScreenInput {
  return { seq, source: "screen", at, revision, rows, ask };
}

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

  it("names its sources in one list, screen reads and ticks in version 1", () => {
    expect([...SURFACE_SOURCES]).toEqual(["screen", "tick"]);
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
