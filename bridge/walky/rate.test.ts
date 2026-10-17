import { describe, expect, test } from "bun:test";

import { RATE_LIMIT, RATE_WINDOW_MS, RateLimiter, senderKey } from "./rate.ts";

describe("the sender cap", () => {
  test("takes 30 in 10 minutes, refuses the 31st, and takes again once the window moves", () => {
    const rate = new RateLimiter();
    for (let i = 0; i < RATE_LIMIT; i++) expect(rate.take("a", 1000 + i)).toBe(true);
    expect(rate.take("a", 2000)).toBe(false);
    expect(rate.take("b", 2000)).toBe(true);
    expect(rate.take("a", 1000 + RATE_WINDOW_MS)).toBe(true);
  });

  test("a sender is its pane, or the operator by label", () => {
    expect(senderKey("agent", "local/%1", "x")).toBe("agent:local/%1");
    expect(senderKey("operator", null, "cli")).toBe("operator:cli");
  });
});
