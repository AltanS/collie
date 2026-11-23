import { describe, expect, it } from "vitest";

import { DOCUMENT_KEYS, parseManifest, parseTrickDocument, RESERVED_TRICK_IDS } from "./schema.ts";

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

  it("refuses the old key decisions with its one sentence, and reads no ask from it", () => {
    const read = parseTrickDocument({ v: 1, parts: [], decisions: [ask] });
    expect(read.decisions).toEqual([]);
    // A tolerant read: the top level's unknown key is a note that says it is ignored, not a refusal of the document.
    expect(read.refusals).toEqual([]);
    expect(read.documentRefused).toBe(false);
    expect(read.notes.map((r) => [r.code, r.path, r.reason])).toEqual([
      ["ignored", "/decisions", '"decisions" is "asks" now (ADR 0179). Update the helper with: collie trick helper <id>. This Collie ignores it.'],
    ]);
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
