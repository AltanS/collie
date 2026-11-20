// The slow cases of invariants.gates.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterAll, describe, expect, test } from "bun:test";
import { allSurfaces } from "../../web/src/test/invariants/surfaces.ts";
import { SCREENS, SEEDS, CASES, covered, allOutcomes, breaks } from "./invariants.gates.rig.ts";

afterAll(() => {
  // The coverage line the report quotes.
  console.info(`[invariants.gates] seeds ${SEEDS.join(",")}: ${String(CASES.length)} cases, ${String(covered)} distinct of ${String(allSurfaces().length * SCREENS.length)} (Surface x screen)`);
});

describe("M102-15 part 1a, the bridge's gates over every Surface", () => {
  test("I6: one request id gives at most one text write and one Enter, and the same id again writes nothing", async () => {
    expect(breaks(await allOutcomes(), (o) => o.i6)).toEqual([]);
    // About 9 s on Linux and 55 s alone on the Windows VM, which passed 120 s inside the full bridge run
    // there (the stage/next run, 2026-11-20).
  }, 300_000);
});
