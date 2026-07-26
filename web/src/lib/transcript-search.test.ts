import {
  matchingEntries,
  searchableText,
  splitHighlight,
  step,
  userTurnIndices,
} from "./transcript-search";
import type { TranscriptEntry } from "@/lib/types";

// Find-in-history exists because a PWA has no browser find, and jump-to-user-message exists because
// the handful of turns you typed are the only landmarks in a thousand-turn thread.

const entry = (over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid: "u1",
  ts: "",
  role: "assistant",
  parts: [{ kind: "text", text: "hello world" }],
  ...over,
});

describe("searchableText", () => {
  it("covers prose and tool summaries — the surface you can actually see", () => {
    const e = entry({
      parts: [
        { kind: "text", text: "shipping now" },
        { kind: "tool", name: "Bash", summary: "git push" },
      ],
    });
    expect(searchableText(e)).toContain("shipping now");
    expect(searchableText(e)).toContain("Bash");
    expect(searchableText(e)).toContain("git push");
  });

  // Matching inside a collapsed body would jump you to a turn where nothing on screen matches.
  it("excludes collapsed tool result bodies", () => {
    const e = entry({
      parts: [
        { kind: "tool", name: "Read", summary: "/a.ts", result: { text: "SECRET_TOKEN=abc" } },
      ],
    });
    expect(searchableText(e)).not.toContain("SECRET_TOKEN");
  });
});

describe("matchingEntries", () => {
  const entries = [
    entry({ uuid: "a", parts: [{ kind: "text", text: "deploy the guard" }] }),
    entry({ uuid: "b", parts: [{ kind: "text", text: "nothing here" }] }),
    entry({ uuid: "c", parts: [{ kind: "text", text: "GUARD rails" }] }),
  ];

  it("finds every matching turn, oldest-first", () => {
    expect(matchingEntries(entries, "guard")).toEqual([0, 2]);
  });

  it("is case-insensitive", () => {
    expect(matchingEntries(entries, "GUARD")).toEqual([0, 2]);
    expect(matchingEntries(entries, "guard")).toEqual(matchingEntries(entries, "GuArD"));
  });

  it.each([["empty", ""], ["whitespace", "   "]])("a %s query matches nothing", (_l, q) => {
    expect(matchingEntries(entries, q)).toEqual([]);
  });

  // A phone find bar must not explode on a half-typed regex.
  it("treats the query as a literal, not a pattern", () => {
    const withParen = [entry({ parts: [{ kind: "text", text: "call foo(bar)" }] })];
    expect(() => matchingEntries(withParen, "foo(")).not.toThrow();
    expect(matchingEntries(withParen, "foo(")).toEqual([0]);
    expect(matchingEntries(withParen, ".*")).toEqual([]); // literal, so no match
  });
});

describe("userTurnIndices", () => {
  it("picks out only the turns the user typed", () => {
    const entries = [
      entry({ role: "assistant" }),
      entry({ role: "user" }),
      entry({ role: "note" }),
      entry({ role: "summary" }),
      entry({ role: "user" }),
    ];
    expect(userTurnIndices(entries)).toEqual([1, 4]);
  });

  it("is empty when the user never spoke", () => {
    expect(userTurnIndices([entry({ role: "assistant" })])).toEqual([]);
  });
});

describe("step", () => {
  const stops = [2, 5, 9];

  it("advances to the next stop after the current position", () => {
    expect(step(stops, 2, 1)).toBe(5);
    expect(step(stops, 3, 1)).toBe(5);
  });

  it("goes back to the previous stop", () => {
    expect(step(stops, 9, -1)).toBe(5);
    expect(step(stops, 6, -1)).toBe(5);
  });

  // A dead button at the last match reads as broken; every find bar cycles.
  it("wraps at both ends", () => {
    expect(step(stops, 9, 1)).toBe(2);
    expect(step(stops, 2, -1)).toBe(9);
  });

  it("starts from nowhere (-1) at the first/last stop", () => {
    expect(step(stops, -1, 1)).toBe(2);
    expect(step(stops, -1, -1)).toBe(9);
  });

  it("returns null when there are no stops", () => {
    expect(step([], 0, 1)).toBeNull();
    expect(step([], 0, -1)).toBeNull();
  });
});

describe("splitHighlight", () => {
  it("splits around a single hit", () => {
    expect(splitHighlight("the guard rails", "guard")).toEqual([
      { text: "the ", hit: false },
      { text: "guard", hit: true },
      { text: " rails", hit: false },
    ]);
  });

  it("marks every occurrence", () => {
    expect(splitHighlight("aXbXc", "x").filter((p) => p.hit)).toHaveLength(2);
  });

  it("preserves the original casing of a hit", () => {
    expect(splitHighlight("GUARD", "guard")).toEqual([{ text: "GUARD", hit: true }]);
  });

  it("handles a hit at the very start and end", () => {
    expect(splitHighlight("abc", "abc")).toEqual([{ text: "abc", hit: true }]);
  });

  it.each([
    ["an empty query", "some text", ""],
    ["no match", "some text", "zzz"],
    ["empty text", "", "q"],
  ])("returns one unmarked piece for %s", (_l, text, query) => {
    expect(splitHighlight(text, query)).toEqual([{ text, hit: false }]);
  });

  it("reassembles to the original string exactly", () => {
    const src = "Deploy the GUARD, then guard again";
    expect(splitHighlight(src, "guard").map((p) => p.text).join("")).toBe(src);
  });
});
