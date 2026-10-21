import { describe, expect, test } from "bun:test";

import { PAIR_LIMIT, pairKey, RATE_LIMIT, RATE_WINDOW_MS, RateLimiter, senderKey } from "./rate.ts";

describe("the caps", () => {
  test("takes 30 in 10 minutes, refuses the 31st, and takes again once the window moves", () => {
    const rate = new RateLimiter();
    for (let i = 0; i < RATE_LIMIT; i++) expect(rate.take("a", 1000 + i)).toBe(true);
    expect(rate.take("a", 2000)).toBe(false);
    expect(rate.take("b", 2000)).toBe(true);
    expect(rate.take("a", 1000 + RATE_WINDOW_MS)).toBe(true);
  });

  test("a broadcast takes one token per target, all or none", () => {
    const rate = new RateLimiter(5);
    expect(rate.take("op", 1, 4)).toBe(true);
    expect(rate.room("op", 1, 2)).toBe(false);
    expect(rate.take("op", 1, 2)).toBe(false);
    expect(rate.take("op", 1, 1)).toBe(true);
  });

  test("a sender is its kind, machine and pane, never its label", () => {
    expect(senderKey("agent", "desk", "desk/%1")).toBe("agent:desk:desk/%1");
    expect(senderKey("operator", null, null)).toBe("operator:-:-");
  });

  test("a pair is the same pair in either direction", () => {
    expect(pairKey("local/%1", "local/%2")).toBe(pairKey("local/%2", "local/%1"));
    const rate = new RateLimiter(PAIR_LIMIT);
    for (let i = 0; i < PAIR_LIMIT; i++) expect(rate.take(pairKey(i % 2 === 0 ? "a" : "b", i % 2 === 0 ? "b" : "a"), 1)).toBe(true);
    expect(rate.take(pairKey("a", "b"), 1)).toBe(false);
  });
});
