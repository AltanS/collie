import { describe, expect, test } from "bun:test";

import type { TranscriptEntry } from "@web/lib/types";

import { INITIAL_RENDER, RENDER_STEP, countToReach, grownCount, heldEntries, olderQuery, visibleEntries } from "./window";

const turn = (uuid: string, over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({ uuid, ts: "", role: "user", parts: [], ...over });
const many = (n: number): TranscriptEntry[] => Array.from({ length: n }, (_, i) => turn(`u${String(i)}`));

describe("heldEntries", () => {
  test("keeps the first array's identity when nothing is older and nothing was rewound", () => {
    const first = many(3);
    expect(heldEntries([], first)).toBe(first);
  });
  test("puts older turns first", () => {
    expect(heldEntries([turn("old")], [turn("new")]).map((e) => e.uuid)).toEqual(["old", "new"]);
  });
  test("drops a turn the agent rewound past", () => {
    const held = heldEntries([], [turn("a"), turn("b", { abandoned: true })]);
    expect(held.map((e) => e.uuid)).toEqual(["a"]);
  });
});

describe("the window", () => {
  test("draws the newest turns", () => {
    const all = many(100);
    const shown = visibleEntries(all, INITIAL_RENDER);
    expect(shown).toHaveLength(INITIAL_RENDER);
    expect(shown.at(-1)?.uuid).toBe("u99");
  });
  test("draws everything when the window covers it", () => {
    const all = many(10);
    expect(visibleEntries(all, INITIAL_RENDER)).toBe(all);
  });
  test("grows by one step and stops at the total", () => {
    expect(grownCount(60, 1000)).toBe(60 + RENDER_STEP);
    expect(grownCount(60, 100)).toBe(100);
  });
  test("reaching a turn far above draws back to it with context", () => {
    expect(countToReach(0, 500, 60)).toBe(500);
    expect(countToReach(450, 500, 60)).toBe(60);
  });
});

describe("olderQuery", () => {
  test("pages from the oldest turn held", () => {
    expect(olderQuery("a b")).toBe("limit=5000&before=a%20b");
  });
  test("has nothing to anchor on without one", () => {
    expect(olderQuery(undefined)).toBeNull();
  });
});
