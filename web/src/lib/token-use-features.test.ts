import { describe, expect, it } from "vitest";

import { TOKEN_USE_FEATURES, tokenUseFeature } from "./token-use-features";

describe("TOKEN_USE_FEATURES", () => {
  it("holds exactly these features, in this order", () => {
    expect(TOKEN_USE_FEATURES.map((feature) => feature.id)).toEqual(["walky-talky", "hill", "agent-view"]);
  });

  it("names each feature once", () => {
    const ids = TOKEN_USE_FEATURES.map((feature) => feature.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every feature a reason and a switch place", () => {
    expect(TOKEN_USE_FEATURES.map((feature) => [feature.id, feature.reason, feature.place])).toEqual([
      ["walky-talky", "agent-messages", "session-sheet"],
      ["hill", "decision-answers", "settings"],
      ["agent-view", "view-taps", "session-sheet"],
    ]);
  });

  it("finds an entry by id, and none for an id it does not hold", () => {
    expect(tokenUseFeature("hill")?.reason).toBe("decision-answers");
    expect(tokenUseFeature("skill")).toBeUndefined();
  });
});
