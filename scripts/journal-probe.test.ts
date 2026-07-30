import { describe, expect, test } from "bun:test";

import { refFor } from "./journal-probe.ts";

const path = "/sessions/project/2026-07-30T11-03-04-544Z_019fb2b1-3060-7000-a086-4e7b785fd895.jsonl";

describe("journal probe session refs", () => {
  test.each(["omp", "pi"])("uses Herdr's path ref for %s", (agent) => {
    expect(refFor(agent, path)).toEqual({ kind: "path", value: path });
  });

  test("derives id refs for UUID-based harnesses", () => {
    expect(refFor("claude", path)).toEqual({
      kind: "id",
      value: "019fb2b1-3060-7000-a086-4e7b785fd895",
    });
    expect(refFor("claude", "/sessions/subagent.jsonl")).toBeNull();
  });
});
