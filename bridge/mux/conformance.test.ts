import { describe, expect, test } from "bun:test";

import {
  MUX_READ_ONLY_CHECKS,
  MUX_WORLD_CHECKS,
  type MuxConformanceFixture,
} from "./conformance.ts";
import { MUX_CONFORMANCE_FIXTURES, fixtureFor } from "./fixtures.ts";
import { MUX_ADAPTERS } from "./registry.ts";

// THE CONFORMANCE SUITE, run against EVERY registered adapter by iteration.
//
// There is no adapter named in this file and there never should be: it walks `MUX_ADAPTERS`
// (registry.ts) and pairs each entry with its fixture (fixtures.ts). tmux (M10/04) and zellij
// (M10/05) get the whole suite by appending one line to each of those two lists — adding an adapter
// must not mean adding a test file, which is the property that makes the seam real rather than
// aspirational.
//
// The checks themselves live in `conformance.ts` and know nothing about a test framework. This file
// is the registration: one `test()` per check per adapter, so a failure names the adapter, the check,
// and every problem the check found rather than one bare assertion.

/** Turn a check's problem list into one legible failure. */
function expectClean(name: string, problems: string[]): void {
  expect(problems, `${name}\n  · ${problems.join("\n  · ")}`).toEqual([]);
}

describe("every registered adapter contributes a conformance fixture", () => {
  for (const factory of MUX_ADAPTERS) {
    test(`${factory.mux} has one`, () => {
      // An adapter with no fixture is an adapter nothing proves. It fails here rather than passing
      // vacuously, which is the difference between a suite and a decoration.
      expect(fixtureFor(factory.mux), `no conformance fixture is registered for "${factory.mux}"`).toBeDefined();
    });
  }

  test("no fixture names an adapter that is not registered", () => {
    const registered = new Set(MUX_ADAPTERS.map((factory) => factory.mux));
    const orphans = MUX_CONFORMANCE_FIXTURES.filter((fixture) => !registered.has(fixture.mux));
    expect(orphans.map((fixture) => fixture.mux)).toEqual([]);
  });
});

/** Register the whole suite for one adapter. Called once per registered fixture, below. */
function describeConformance(fixture: MuxConformanceFixture): void {
  describe(`MuxAdapter conformance — ${fixture.mux}`, () => {
    test("the adapter reports the mux name it is registered under", async () => {
      const world = await fixture.create();
      try {
        expect(world.adapter.mux).toBe(fixture.mux);
      } finally {
        await world.close();
      }
    });

    // The live-safe half. The same list `scripts/mux-probe.ts` runs against a real multiplexer —
    // here it runs against the fixture's world, so a regression is caught with nothing installed.
    describe("read-only (what the live probe also runs)", () => {
      for (const check of MUX_READ_ONLY_CHECKS) {
        test(check.name, async () => {
          const world = await fixture.create();
          try {
            expectClean(check.name, await check.run(world.adapter));
          } finally {
            await world.close();
          }
        });
      }
    });

    // The half that writes: typing, renaming, closing, killing. Fixture worlds only — every check
    // takes the fixture and builds however many fresh worlds it needs, because most of them end by
    // destroying something.
    describe("world (writes — fixture only, never a live pane)", () => {
      for (const check of MUX_WORLD_CHECKS) {
        test(check.name, async () => {
          expectClean(check.name, await check.run(fixture));
        });
      }
    });
  });
}

for (const fixture of MUX_CONFORMANCE_FIXTURES) describeConformance(fixture);
