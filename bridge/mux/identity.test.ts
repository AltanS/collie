import { describe, expect, test } from "bun:test";

import { checkIdentitySet, idsLostBetween, isValidMuxId, MUX_ID_MAX_LENGTH } from "./identity.ts";

// Identity is the contract's, not an adapter's. These pin the mechanical half (rule 5, transport
// safety) and the two set properties conformance leans on (uniqueness, stability across a reread).

describe("isValidMuxId", () => {
  // The three real shapes: Herdr (HERDR_API.md § object shapes), tmux 3.6b and zellij 0.44.2 (the
  // probes in M10/04 and M10/05). All three must pass unchanged — an id rule that forced an adapter
  // to re-encode its own ids would break rule 1 to satisfy rule 5.
  test.each(["w6:p3", "%0", "%17", "terminal_1", "plugin_2", "0"])("accepts %s", (id) => {
    expect(isValidMuxId(id)).toBe(true);
  });

  test.each([
    ["empty", ""],
    ["a space", "pane 1"],
    ["a tab", "pane\t1"],
    ["a newline", "pane\n1"],
    ["a slash — it is a URL path segment", "w6/p3"],
    ["a query mark", "w6?p3"],
    ["a fragment mark", "w6#p3"],
    ["a control character", "w6\u0001p3"],
  ])("rejects %s", (_why, id) => {
    expect(isValidMuxId(id)).toBe(false);
  });

  // Percent is allowed on purpose — tmux's own pane ids start with it (M10/04 probe).
  test("percent-encoding is the carrier's job, not the id's", () => {
    expect(isValidMuxId("%0")).toBe(true);
    expect(decodeURIComponent(encodeURIComponent("%0"))).toBe("%0");
  });

  test("is bounded — an id is a name, never a payload", () => {
    expect(isValidMuxId("p".repeat(MUX_ID_MAX_LENGTH))).toBe(true);
    expect(isValidMuxId("p".repeat(MUX_ID_MAX_LENGTH + 1))).toBe(false);
  });
});

describe("checkIdentitySet", () => {
  test("a well-formed snapshot has no problems", () => {
    expect(
      checkIdentitySet([
        { paneId: "w6:p3", spaceId: "w6" },
        { paneId: "w6:p4", spaceId: "w6" },
        { paneId: "w7:p1", spaceId: "w7" },
      ]),
    ).toEqual([]);
  });

  // Panes sharing a space is the normal case and must never read as a collision.
  test("a repeated space id is not a duplicate", () => {
    const problems = checkIdentitySet([
      { paneId: "%0", spaceId: "probe" },
      { paneId: "%1", spaceId: "probe" },
    ]);
    expect(problems).toEqual([]);
  });

  test("a repeated pane id is caught — two panes must never share an address", () => {
    const problems = checkIdentitySet([
      { paneId: "%0", spaceId: "a" },
      { paneId: "%0", spaceId: "b" },
    ]);
    expect(problems).toEqual([{ kind: "duplicate", id: "%0" }]);
  });

  test("a malformed id is caught, and says which field", () => {
    const problems = checkIdentitySet([{ paneId: "pane 1", spaceId: "sp ace" }]);
    expect(problems).toEqual([
      { kind: "malformed", id: "pane 1", field: "paneId" },
      { kind: "malformed", id: "sp ace", field: "spaceId" },
    ]);
  });
});

describe("idsLostBetween", () => {
  // Rule 2, as conformance asks it: re-read the same quiescent target and every id survived.
  test("a stable read loses nothing", () => {
    const before = [
      { paneId: "%0", spaceId: "probe" },
      { paneId: "%1", spaceId: "probe" },
    ];
    expect(idsLostBetween(before, [...before].toReversed())).toEqual([]);
  });

  test("an id that moved under a rename is reported", () => {
    const before = [{ paneId: "probe:0", spaceId: "probe" }];
    const after = [{ paneId: "renamed:0", spaceId: "renamed" }];
    expect(idsLostBetween(before, after)).toEqual(["probe:0"]);
  });
});
