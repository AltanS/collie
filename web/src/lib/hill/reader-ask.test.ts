import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "@/lib/json";
import { hillDecision } from "@/test/hill-fixtures";

import { readHillDecision } from "./reader";
import { HILL_ASK_FILES_MAX } from "./wire";

// The `ask` field of a Decision (`collie walky ask`): read whole or not at all, a file that does not fit left out.

function wire(ask: JsonValue): JsonObject {
  // SAFETY: a HillDecision is plain JSON.
  const base = JSON.parse(JSON.stringify(hillDecision({ id: "ak_aaaaaaaaaaaa" }))) as JsonObject;
  return { ...base, ask };
}

describe("readHillDecision, the ask field", () => {
  it("reads an ask with its files, its root, its mark and the time of its confirmation", () => {
    const read = readHillDecision(wire({ words: false, files: [{ path: "docs/plan.md", heading: "Risks" }, { path: "src/a.ts", line: 40 }], root: "w6:p3", mark: "carried", confirmedAt: 1_762_000_000_000 }));
    expect(read?.ask).toEqual({ words: false, files: [{ path: "docs/plan.md", heading: "Risks" }, { path: "src/a.ts", line: 40 }], root: "w6:p3", mark: "carried", confirmedAt: 1_762_000_000_000 });
  });

  it("reads each mark, an old record with no mark by its confirmedAt, and an unknown mark as unchecked", () => {
    const markOf = (ask: JsonObject) => readHillDecision(wire({ words: false, files: [], root: null, ...ask }))?.ask?.mark;
    expect(markOf({ mark: "fresh" })).toBe("fresh");
    expect(markOf({ mark: "unchecked", confirmedAt: 5 })).toBe("unchecked");
    expect(markOf({})).toBe("fresh");
    expect(markOf({ confirmedAt: 5 })).toBe("carried");
    expect(markOf({ mark: "seen" })).toBe("unchecked");
  });

  it("reads an option's cost, and leaves an empty one out", () => {
    // SAFETY: a HillDecision is plain JSON.
    const base = JSON.parse(JSON.stringify(hillDecision({ id: "ak_aaaaaaaaaaaa" }))) as JsonObject;
    const read = readHillDecision({ ...base, options: [{ intent: "a", label: "A", cost: "One more day" }, { intent: "b", label: "B", cost: "" }], ask: { words: false, files: [], root: null, mark: "fresh" } });
    expect(read?.options).toEqual([{ intent: "a", label: "A", cost: "One more day" }, { intent: "b", label: "B" }]);
  });

  it("reads a null root, and no ask field as a plain Decision", () => {
    expect(readHillDecision(wire({ words: true, files: [], root: null }))?.ask).toEqual({ words: true, files: [], root: null, mark: "fresh" });
    // SAFETY: JSON.
    const plain = JSON.parse(JSON.stringify(hillDecision())) as JsonObject;
    expect(readHillDecision(plain)?.ask).toBeUndefined();
  });

  it("leaves out a file that climbs out of its root, is absolute or has no path, and keeps the ask", () => {
    const read = readHillDecision(wire({ words: false, files: [{ path: "../etc/passwd" }, { path: "/etc/passwd" }, { path: "a\\b" }, { path: "" }, { heading: "x" }, { path: "ok.md", line: -3 }], root: "w1:p1" }));
    expect(read?.ask?.files).toEqual([{ path: "ok.md" }]);
  });

  it("caps the files at the contract's number", () => {
    const files = Array.from({ length: HILL_ASK_FILES_MAX + 4 }, (_, i) => ({ path: `f${i}.md` }));
    expect(readHillDecision(wire({ words: false, files, root: null }))?.ask?.files).toHaveLength(HILL_ASK_FILES_MAX);
  });

  it("reads a damaged ask field as a plain Decision, which still has its question and options", () => {
    const read = readHillDecision(wire({ words: "yes", files: [], root: null }));
    expect(read?.ask).toBeUndefined();
    expect(read?.options).toHaveLength(2);
  });
});
