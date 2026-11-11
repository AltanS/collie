import { describe, expect, it } from "vitest";

import { hillDecision } from "@/test/hill-fixtures";

import { readHillDecision } from "./reader";
import { sortOpenDecisions, type HillDecision } from "./wire";

// The quiet mark (1.29.0): an open card whose session the person wrote to after it asked carries
// `spokeAfter`, and sorts below the fresh cards of its priority, otherwise in the order it had.

describe("the quiet mark", () => {
  it("sinks a marked card below the fresh ones of its priority, and keeps the order inside each", () => {
    const oldMarked = hillDecision({ title: "old marked", at: 1, spokeAfter: 50 });
    const oldFresh = hillDecision({ title: "old fresh", at: 2 });
    const newMarked = hillDecision({ title: "new marked", at: 3, spokeAfter: 60 });
    const newFresh = hillDecision({ title: "new fresh", at: 4 });
    const later = hillDecision({ title: "later fresh", at: 0, priority: "later" });
    const now = hillDecision({ title: "now marked", at: 9, priority: "now", spokeAfter: 70 });
    expect(sortOpenDecisions([later, newMarked, oldFresh, newFresh, oldMarked, now]).map((d) => d.title)).toEqual(["now marked", "old fresh", "new fresh", "old marked", "new marked", "later fresh"]);
  });

  it("reads the mark on an open card only, and drops a value that is no time", () => {
    // SAFETY: a JSON round trip of a fixture is a JsonValue.
    const wire = (over: Partial<HillDecision>) => JSON.parse(JSON.stringify(hillDecision(over)));
    expect(readHillDecision(wire({ spokeAfter: 1234 }))?.spokeAfter).toBe(1234);
    expect(readHillDecision({ ...wire({}), spokeAfter: "soon" })?.spokeAfter).toBeUndefined();
    const closed = readHillDecision(wire({ spokeAfter: 1234, state: "withdrawn", closedAt: 2000, closedReason: "by the poster" }));
    expect(closed?.state).toBe("withdrawn");
    expect(closed?.spokeAfter).toBeUndefined();
    expect(readHillDecision(wire({}))).not.toHaveProperty("spokeAfter");
  });

  it("reads the mark on an agent's card only: a trick's card never carries one (C-A7)", () => {
    // SAFETY: a JSON round trip of a fixture is a JsonValue.
    const wire = JSON.parse(JSON.stringify(hillDecision({ spokeAfter: 1234 })));
    const trick = readHillDecision({ ...wire, from: { ...wire.from, kind: "trick", address: null, trickId: "look", trickKey: "ship-zoom", harness: null, host: null } });
    expect(trick?.from.kind).toBe("trick");
    expect(trick).not.toHaveProperty("spokeAfter");
  });
});
