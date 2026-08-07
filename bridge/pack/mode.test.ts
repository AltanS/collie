import { describe, expect, test } from "bun:test";

import { deriveMode, modeForWire, type Enrollment } from "./mode.ts";

// Mode is the seam the whole zero-tax promise hangs off (PACK_PROTOCOL.md §3, §11): if `solo` is
// what an unenrolled instance computes, and every federation path is behind a mode check made once,
// then "does a solo user pay for this?" is a question about this file. So it is pinned exhaustively,
// including the inputs a hand-edited or half-written trust store can produce.

const member = (memberId: string) => ({ memberId });

const enrollment = (over: Partial<Enrollment> = {}): Enrollment => ({
  peers: [],
  lead: null,
  ...over,
});

describe("deriveMode — the three modes", () => {
  test("no trust store at all is solo", () => {
    expect(deriveMode(null)).toEqual({ mode: "solo", conflict: null });
  });

  test("a trust store with neither a lead nor peers is solo too", () => {
    // Distinct input, same answer: `collie leave` empties the roster without deleting the store,
    // and that instance is a solo lead again — not a peer stranded without its lead.
    expect(deriveMode(enrollment())).toEqual({ mode: "solo", conflict: null });
  });

  test("one enrolled peer makes this collie the lead", () => {
    expect(deriveMode(enrollment({ peers: [member("laptop")] }))).toEqual({
      mode: "lead",
      conflict: null,
    });
  });

  test("many enrolled peers is still exactly one lead", () => {
    const many = enrollment({ peers: [member("laptop"), member("nas"), member("workstation")] });
    expect(deriveMode(many).mode).toBe("lead");
  });

  test("having been enrolled BY a lead makes this collie a peer", () => {
    expect(deriveMode(enrollment({ lead: member("desk") }))).toEqual({
      mode: "peer",
      conflict: null,
    });
  });
});

describe("deriveMode — the ambiguous input", () => {
  const both = enrollment({ lead: member("desk"), peers: [member("nas")] });

  test("lead AND peer is refused as a role, and resolves toward peer", () => {
    // v1's answer to 'can one collie lead one pack and be a peer of another?' is no (§1: a pack is a
    // star with one lead). The tie breaks toward the mode that PUBLISHES LESS, so a corrupted roster
    // can never open a front door — the worst it can do is withhold one.
    expect(deriveMode(both).mode).toBe("peer");
  });

  test("the conflict is reported, not swallowed — `pack status` has something to print", () => {
    const { conflict } = deriveMode(both);
    expect(conflict).toBeString();
    expect(conflict).toContain("desk");
    expect(conflict).toContain("collie leave");
  });

  test("a coherent roster never reports a conflict", () => {
    for (const e of [null, enrollment(), enrollment({ peers: [member("nas")] }), enrollment({ lead: member("desk") })]) {
      expect(deriveMode(e).conflict).toBeNull();
    }
  });
});

describe("deriveMode — a peer never self-demotes", () => {
  test("derivation takes no clock and no reachability signal", () => {
    // The function's arity IS the guarantee: there is nothing to pass that could express 'the lead
    // has been gone a while', so no timeout can ever re-publish a front door on an idle machine.
    expect(deriveMode.length).toBe(1);
  });

  test("the same enrollment yields the same mode however often it is asked", () => {
    const e = enrollment({ lead: member("desk") });
    expect(deriveMode(e)).toEqual(deriveMode(e));
    expect(deriveMode(e).mode).toBe("peer");
  });
});

describe("modeForWire — solo emits nothing", () => {
  test("solo is undefined, so /api/config keeps today's exact body", () => {
    expect(modeForWire("solo")).toBeUndefined();
  });

  test("lead and peer report themselves", () => {
    expect(modeForWire("lead")).toBe("lead");
    expect(modeForWire("peer")).toBe("peer");
  });
});
