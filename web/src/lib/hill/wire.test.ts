import { describe, expect, it } from "vitest";

import {
  HILL_ID_RE,
  HILL_INTENT_RE,
  HILL_RESERVED_INTENTS,
  hillIdOfNode,
  hillNode,
  isHillOptionIntent,
  sortOpenDecisions,
  type HillDecision,
  type HillPriority,
} from "./wire.ts";

function decision(id: string, priority: HillPriority, at: number): HillDecision {
  // SAFETY: the sort reads only id, priority and at, so the other fields stay unset.
  return { id, priority, at } as HillDecision;
}

describe("hillNode and hillIdOfNode", () => {
  it("round-trips an id", () => {
    expect(hillNode("dc_k3m9x2p7q1ab")).toBe("hill/dc_k3m9x2p7q1ab");
    expect(hillIdOfNode(hillNode("dc_k3m9x2p7q1ab"))).toBe("dc_k3m9x2p7q1ab");
  });

  it("returns null for a node that is not a hill node", () => {
    expect(hillIdOfNode("dc_k3m9x2p7q1ab")).toBeNull();
    expect(hillIdOfNode("worktree/dc_k3m9x2p7q1ab")).toBeNull();
    expect(hillIdOfNode("hill/")).toBeNull();
    expect(hillIdOfNode("hill/dc_short")).toBeNull();
    expect(hillIdOfNode("hill/dc_K3m9x2p7q1ab")).toBeNull();
    expect(hillIdOfNode("hill/dc_k3m9x2p7q1abz")).toBeNull();
    expect(hillIdOfNode("hill/dc_k3m9x2p7q1ab/x")).toBeNull();
  });

  it("matches ids of dc_ and twelve lowercase characters only", () => {
    expect(HILL_ID_RE.test("dc_000000000000")).toBe(true);
    expect(HILL_ID_RE.test("dc_00000000000")).toBe(false);
    expect(HILL_ID_RE.test("dc_00000000000_")).toBe(false);
  });
});

describe("isHillOptionIntent", () => {
  it("accepts a plain intent", () => {
    expect(isHillOptionIntent("yes")).toBe(true);
    expect(isHillOptionIntent("ship-edge-first")).toBe(true);
    expect(isHillOptionIntent("a".repeat(32))).toBe(true);
  });

  it("refuses the reserved intents", () => {
    for (const reserved of HILL_RESERVED_INTENTS) {
      expect(HILL_INTENT_RE.test(reserved)).toBe(true);
      expect(isHillOptionIntent(reserved)).toBe(false);
    }
  });

  it("refuses a string that does not match the pattern", () => {
    expect(isHillOptionIntent("")).toBe(false);
    expect(isHillOptionIntent("Yes")).toBe(false);
    expect(isHillOptionIntent("1yes")).toBe(false);
    expect(isHillOptionIntent("yes please")).toBe(false);
    expect(isHillOptionIntent("a".repeat(33))).toBe(false);
  });

  it("keeps a near miss of a reserved word", () => {
    expect(isHillOptionIntent("answers")).toBe(true);
    expect(isHillOptionIntent("dismiss-all")).toBe(true);
  });
});

describe("sortOpenDecisions", () => {
  it("orders now, today, later, and oldest first inside one priority", () => {
    const list = [
      decision("a", "later", 1),
      decision("b", "today", 5),
      decision("c", "now", 9),
      decision("d", "today", 2),
      decision("e", "now", 3),
    ];
    expect(sortOpenDecisions(list).map((d) => d.id)).toEqual(["e", "c", "d", "b", "a"]);
  });

  it("does not mutate the input", () => {
    const list = [decision("a", "later", 1), decision("b", "now", 2)];
    const copy = [...list];
    const sorted = sortOpenDecisions(list);
    expect(list).toEqual(copy);
    expect(sorted).not.toBe(list);
  });

  it("returns an empty list for an empty list", () => {
    expect(sortOpenDecisions([])).toEqual([]);
  });
});
