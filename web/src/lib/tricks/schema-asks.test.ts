import { describe, expect, it } from "vitest";

import { DOCUMENT_KEYS, OLD_ASKS_LISTED_LINE, parseManifest, parseTrickDocument, RESERVED_TRICK_IDS } from "./schema.ts";

// ADR 0179: the old trick names fail with one sentence; the new ones work. Beside schema.test.ts, which is at its size ceiling.

describe("the document key asks (ADR 0179; decisions before)", () => {
  const ask = { key: "k", title: "T", summary: "S" };

  it("reads asks, and DOCUMENT_KEYS names asks, not decisions", () => {
    expect(DOCUMENT_KEYS).toContain("asks");
    expect(DOCUMENT_KEYS).not.toContain("decisions");
    const read = parseTrickDocument({ v: 1, parts: [], asks: [ask] });
    expect(read.refusals).toEqual([]);
    expect(read.decisions.map((d) => d.key)).toEqual(["k"]);
  });

  it("an old key decisions that lists asks is one dropped note with its one sentence, and no ask is read from it", () => {
    const read = parseTrickDocument({ v: 1, parts: [], decisions: [ask] });
    expect(read.decisions).toEqual([]);
    expect(read.refusedDecisions).toEqual([]);
    // A tolerant read: a note, not a refusal of the document. `dropped` is the code the trick's row shows.
    expect(read.refusals).toEqual([]);
    expect(read.documentRefused).toBe(false);
    expect(read.notes.map((r) => [r.code, r.path, r.reason])).toEqual([["dropped", "/decisions", OLD_ASKS_LISTED_LINE]]);
    expect(OLD_ASKS_LISTED_LINE).toBe('"decisions" is "asks" now, so the asks listed under it are not shown. Update the helper with: collie trick helper <id>.');
  });

  it("an old key decisions that is empty, or no list, stays a note that says it is ignored", () => {
    for (const old of [[], "x", {}, null]) {
      const read = parseTrickDocument({ v: 1, parts: [], decisions: old });
      expect(read.decisions, JSON.stringify(old)).toEqual([]);
      expect(read.refusals).toEqual([]);
      expect(read.notes.map((r) => [r.code, r.path, r.reason])).toEqual([
        ["ignored", "/decisions", '"decisions" is "asks" now. Update the helper with: collie trick helper <id>. This Collie ignores it.'],
      ]);
    }
  });

  it("with asks and an old decisions that lists asks, only asks is read, and the parts draw", () => {
    const read = parseTrickDocument({ v: 1, parts: [{ at: "belt", id: "belt", mark: { label: "1" } }], asks: [ask], decisions: [{ ...ask, key: "old" }] });
    expect(read.decisions.map((d) => d.key)).toEqual(["k"]);
    expect(read.parts).toHaveLength(1);
    expect(read.notes.map((r) => [r.code, r.path])).toEqual([["dropped", "/decisions"]]);
  });

  it("keeps asks and hill as ids no trick takes, and the manifest of a trick named asks is refused", () => {
    expect(RESERVED_TRICK_IDS).toEqual(["walky-talky", "asks", "hill", "collie", "view"]);
    for (const id of ["asks", "hill"]) {
      const read = parseManifest({ id, name: "N", run: "./n.ts", places: ["belt"] });
      expect(read.manifest, id).toBeUndefined();
      expect(read.refusals.map((r) => [r.code, r.path, r.reason]), id).toEqual([["id", "/id", `"${id}" is a name Collie keeps for itself. Give the trick another id.`]]);
    }
  });
});
