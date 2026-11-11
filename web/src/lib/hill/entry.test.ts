import { describe, expect, it } from "vitest";

import { groupDecision, hillDecision, trickDecision } from "@/test/hill-fixtures";

import { hillWaiting } from "./entry";

// What the phone can know before the Hill is switched off: how many Decisions wait, and how many are Collie's own.

describe("hillWaiting", () => {
  it("is nothing for an empty list", () => {
    expect(hillWaiting([])).toEqual({ count: 0, own: 0 });
  });

  it("counts every open Decision, and only Collie's own kind as own", () => {
    const open = [hillDecision(), trickDecision(), groupDecision(2), groupDecision(3, { from: { ...groupDecision().from, ref: { type: "version", id: "legs", hash: "b".repeat(64) } } })];
    expect(hillWaiting(open)).toEqual({ count: 4, own: 2 });
  });

  it("an agent's and a trick's questions are not Collie's own", () => {
    expect(hillWaiting([hillDecision(), trickDecision()])).toEqual({ count: 2, own: 0 });
  });
});
