import { describe, expect, it } from "vitest";

import { ASK_NO_PRIORITY_LINE, parseTrickDocument } from "./schema.ts";

describe("an ask has no priority", () => {
  it("the old key is refused with one sentence, whatever the value, and no other ask is touched", () => {
    expect(ASK_NO_PRIORITY_LINE).toBe('an ask has no priority: remove the key "priority".');
    for (const priority of ["now", "today", "later", "urgent", 3, null]) {
      const read = parseTrickDocument({ v: 1, parts: [], asks: [{ key: "a", title: "T", summary: "S", priority }, { key: "b", title: "T", summary: "S" }] });
      expect(read.refusals.map((r) => [r.code, r.path, r.reason, r.decision]), String(priority)).toEqual([["unknown-key", "/asks/0/priority", ASK_NO_PRIORITY_LINE, "a"]]);
      expect(read.decisions.map((decision) => decision.key)).toEqual(["b"]);
    }
  });
});
