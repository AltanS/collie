// Pure-logic tests of web/e2e/rig/scenarios.ts: which case runs on which harness in which leg of the
// browser leg. NO rig, no browser, no Playwright. It sits in scripts/ for the reason
// browser-leg-nightly.test.ts does: `bun test ./scripts` runs it there.
//
// The nightly runner reads the solo leg's table and calls any "not reached" row a failed run, so a
// crew case that leaked into the solo table would fail every night. These tests hold the split.
import { describe, expect, test } from "bun:test";

import { HARNESS_IDS, SCENARIOS, legOf, scenarioApplies, type Leg } from "../web/e2e/rig/scenarios";

/** The (harness, case) cells one leg's table prints, in table order. */
function cells(leg: Leg): string[] {
  return HARNESS_IDS.flatMap((harness) => SCENARIOS.filter((scenario) => scenarioApplies(scenario, harness, leg)).map((scenario) => `${harness} ${scenario.id}`));
}

describe("the browser leg's cases per leg", () => {
  test("the solo leg prints thirty-four cells: the twenty-two it printed before the crew leg, cases 16 to 18, case 22, the two take-backs, case 25, case 26, case 28, and case 29", () => {
    expect(cells("solo")).toHaveLength(34);
    expect(cells("solo").filter((cell) => cell.endsWith(" queued-omp"))).toEqual(["omp queued-omp"]);
    expect(cells("solo").filter((cell) => cell.endsWith(" stop-pi"))).toEqual(["pi stop-pi"]);
    expect(cells("solo").filter((cell) => cell.endsWith(" belt-model-draft"))).toEqual(["claude belt-model-draft"]);
    expect(cells("solo").filter((cell) => cell.endsWith(" walky-busy"))).toEqual(["claude walky-busy", "pi walky-busy", "omp walky-busy"]);
    expect(cells("solo").filter((cell) => cell.endsWith(" steer"))).toEqual(["pi steer"]);
    expect(cells("solo").filter((cell) => cell.endsWith(" clear-pi"))).toEqual(["pi clear-pi"]);
    expect(cells("solo").every((cell) => !cell.includes("walky-crew"))).toBe(true);
  });

  test("the crew leg prints cases 12 to 15 and 19 to 21, once each, under Claude", () => {
    expect(cells("crew")).toEqual([
      "claude walky-crew-broadcast",
      "claude walky-crew-agents",
      "claude walky-crew-unreachable",
      "claude crew-release-line",
      "claude walky-crew-member-to-lead",
      "claude walky-crew-off",
      "claude walky-crew-pair-limit",
    ]);
  });

  test("no cell is in both legs, and every case is in one", () => {
    const solo = new Set(cells("solo"));
    expect(cells("crew").some((cell) => solo.has(cell))).toBe(false);
    for (const scenario of SCENARIOS) expect(HARNESS_IDS.some((harness) => scenarioApplies(scenario, harness, legOf(scenario)))).toBe(true);
  });

  test("the leg defaults to solo, as the solo teardown calls it", () => {
    const crewCase = SCENARIOS.find((scenario) => scenario.id === "walky-crew-broadcast")!;
    const soloCase = SCENARIOS.find((scenario) => scenario.id === "walky")!;
    expect(scenarioApplies(crewCase, "claude")).toBe(false);
    expect(scenarioApplies(soloCase, "claude")).toBe(true);
  });
});
