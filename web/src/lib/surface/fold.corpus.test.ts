import { describe, expect, it } from "vitest";

import { agentOf, CUES_BLIND, fixtureRows, idleFor, incidentScreens, readScreen } from "../../test/surface-corpus";
import { askOf, isFree } from "./surface";
import { CLAUDE, CORPUS_WALK, FIXTURES, labelOf, LABELS, NEGATIVE, own, WRONG_PROFILE_FREE } from "../../test/surface-fold";

// M56 spec 04, the corpus half: the labels, the idle matcher against the modal detector, the negative set and
// the generic cues alone, over the whole fixture corpus. The fold was one file of 1329 tests and 142 s on a
// loaded machine; the parts are fold.<part>.test.ts, the shared reads are in src/test/surface-fold.ts.

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

  it("never both match one fixture, with its own profile", CORPUS_WALK, () => {
    const both = FIXTURES.filter((name) => {
      const read = own(name);
      return idleSignature(read) && modalDetector(read);
    });
    expect(both).toEqual([]);
  });

  it("never both match one fixture, with the one profile applied to every fixture", CORPUS_WALK, () => {
    const both = FIXTURES.filter((name) => {
      const read = readScreen(fixtureRows(name), agentOf(labelOf(name).harness), CLAUDE);
      return idleSignature(read) && modalDetector(read);
    });
    expect(both).toEqual([]);
  });

  it("never both match: the matchers are not vacuous", CORPUS_WALK, () => {
    const idle = FIXTURES.filter((name) => idleSignature(own(name))).length;
    const modal = FIXTURES.filter((name) => modalDetector(own(name))).length;
    expect(idle).toBeGreaterThan(30);
    expect(modal).toBeGreaterThan(300);
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
