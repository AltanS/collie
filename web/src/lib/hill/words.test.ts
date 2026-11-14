import { describe, expect, it } from "vitest";

import { closedWord } from "./words";
import { HILL_ANSWERED_IN_SESSION, RIGHTS_CLOSED, type HillDecision } from "./wire";

const COLLIE: HillDecision["from"] = { kind: "collie", address: null, trickId: null, trickKey: null, memberId: null, harness: null, label: "Collie", host: "lodge", trickHost: null, ref: { type: "rights", id: "legs", hash: "7f".repeat(32) } };

describe("rights card close", () => {
  it("rights card close: Collie's card about changed rights says why it closed, never 'Withdrawn by the poster'", () => {
    const closed = (closedReason: string): Pick<HillDecision, "state" | "from" | "closedReason"> => ({ state: "withdrawn", from: COLLIE, closedReason });
    expect(closedWord(closed(RIGHTS_CLOSED.approved))).toBe("It runs again.");
    expect(closedWord(closed(RIGHTS_CLOSED.off))).toBe("The trick is off.");
    expect(closedWord(closed(RIGHTS_CLOSED.removed))).toBe("The trick was removed.");
    expect(closedWord(closed(RIGHTS_CLOSED.moved))).toBe("Its rights changed again. A new card says so.");
    // A reason this phone does not know, and every other card, keep the plain state.
    expect(closedWord(closed("something newer"))).toBe("Withdrawn by the poster");
    expect(closedWord({ state: "withdrawn", from: { ...COLLIE, ref: { type: "version", id: "legs", hash: "7f".repeat(32) } }, closedReason: RIGHTS_CLOSED.off })).toBe("Withdrawn by the poster");
    expect(closedWord({ state: "answered", from: COLLIE, closedReason: null })).toBe("Answered");
  });
});

describe("a card answered in its session (M96 spec 10)", () => {
  it("says so, never 'Withdrawn by the poster'", () => {
    const agent: HillDecision["from"] = { kind: "agent", address: "local/%1#aaaa", trickId: null, trickKey: null, memberId: null, harness: "agent-x", label: "repo", host: "lodge", trickHost: null };
    expect(closedWord({ state: "withdrawn", from: agent, closedReason: HILL_ANSWERED_IN_SESSION })).toBe("You wrote in the session");
    expect(closedWord({ state: "withdrawn", from: agent, closedReason: "by the poster" })).toBe("Withdrawn by the poster");
  });
});
