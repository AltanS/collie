import { describe, expect, test } from "bun:test";

import type { TranscriptEntry } from "@web/lib/types";

import { withoutTools } from "./transcript";

const entry = (parts: TranscriptEntry["parts"]): TranscriptEntry => ({ uuid: "u", ts: "", role: "assistant", parts });

describe("withoutTools", () => {
  test("a turn with no steps is returned as it is", () => {
    const e = entry([{ kind: "text", text: "hi" }]);
    expect(withoutTools(e)).toEqual({ entry: e, hidden: 0 });
  });
  test("steps are dropped and counted", () => {
    const e = entry([
      { kind: "text", text: "hi" },
      { kind: "tool", name: "Bash", summary: "ls" },
      { kind: "tool", name: "Read", summary: "a" },
    ]);
    const out = withoutTools(e);
    expect(out.hidden).toBe(2);
    expect(out.entry.parts).toHaveLength(1);
  });
});
