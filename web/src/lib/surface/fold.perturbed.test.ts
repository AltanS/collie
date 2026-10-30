import { describe, expect, it } from "vitest";

import { agentOf, fixtureRows, idleFor, incidentScreens, perturbations, readScreen } from "../../test/surface-corpus";
import { isFree, type Surface } from "./surface";
import { ASK, CLAUDE, CORPUS_WALK, FIXTURES, labelOf, NEGATIVE, towardFree, WRONG_PROFILE_FREE } from "../../test/surface-fold";

// M56 spec 04 (b): every fixture perturbed and read again. The longest part of the fold tests, so it has a file.

// Known moves toward free, each pinned exactly, with its reason (M78 spec 04). herdr-core keeps a
// redrawn screen in its history, so a core capture of a dialog holds an older input box above it
// (here the slash list's `❯ /` box). Read whole, the dialog wins; with the dialog's lowest border
// dropped, the older box is the lowest frame and reads as a draft. The live read never drops a
// border, so this is a robustness gap, not a misread; a reader that skips frames above a dialog's
// region closes it, and then this list empties.
const KNOWN_PERTURBED = {
  "claude--v21314-core-menu-model--w120.txt": ["the lowest border dropped: turn unknown -> idle", "the lowest border dropped: composer unknown -> draft"],
  "claude--v21314-core-permission--w120.txt": ["the lowest border dropped: turn unknown -> idle", "the lowest border dropped: composer unknown -> draft"],
} satisfies Readonly<Record<string, readonly string[]>>;
const knownMoves = (name: string): readonly string[] => Object.entries(KNOWN_PERTURBED).find(([fixture]) => fixture === name)?.[1] ?? [];

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
      expect(wrong).toEqual(knownMoves(name));
    });
  }

  it("perturb: a claim that moves toward free is caught", () => {
    const dialog: Surface = { revision: 1, turn: "unknown", modal: "unreadable", composer: "unknown" };
    expect(towardFree(dialog, { ...dialog, modal: "none", composer: "draft" })).toEqual(["modal unreadable -> none", "composer unknown -> draft"]);
    expect(towardFree(dialog, { ...dialog, modal: "unknown" })).toEqual([]);
    expect(towardFree({ ...dialog, modal: { ask: ASK } }, dialog)).toEqual([]);
  });

  it("perturb: the incident screens never become free", CORPUS_WALK, () => {
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
