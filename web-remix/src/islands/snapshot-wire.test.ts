import { describe, expect, test } from "bun:test";

import { decodeHeld, decodeRanks, encodeHeld, encodeRanks, frameHash, parseSnapshotAnswer, snapshotAnswer } from "./snapshot-wire";

describe("snapshot wire (S3)", () => {
  test("held hashes round-trip, unknown frame names are dropped", () => {
    const held = new Map([["home-list", "abc"] as const]);
    expect(decodeHeld(encodeHeld(held))).toEqual(held);
    expect(decodeHeld("home-list=x,elsewhere=y,pane-head=")).toEqual(new Map([["home-list", "x"], ["pane-head", ""]]));
    expect(decodeHeld(null).size).toBe(0);
  });

  test("ranks round-trip with keys that need encoding, and refuse a header without an order", () => {
    const keys = ["\u0000\u0000w1:p1", "peer\u0000s\u0000w2:p1"];
    expect(decodeRanks(encodeRanks("activity", keys))).toEqual({ order: "activity", keys });
    expect(encodeRanks("activity", [])).toBeNull();
    expect(decodeRanks(":a,b")).toBeNull();
    expect(decodeRanks("cache:%E0%A4%A")).toBeNull();
  });

  test("the frame hash is stable and moves with the HTML", () => {
    expect(frameHash("<a>1</a>")).toBe(frameHash("<a>1</a>"));
    expect(frameHash("<a>1</a>")).not.toBe(frameHash("<a>2</a>"));
  });

  test("an answer carries the snapshot and the moved frames, and parses back", () => {
    const body = snapshotAnswer(JSON.stringify({ ts: 1, note: "</script><b>" }), [{ name: "home-list", hash: "h1", html: "<div>rows</div>" }]);
    expect(body).not.toContain("</script><b>");
    const parsed = parseSnapshotAnswer(body);
    expect(parsed?.snapshot).toEqual({ ts: 1, note: "</script><b>" });
    expect(parsed?.frames).toEqual([{ name: "home-list", hash: "h1", html: "<div>rows</div>" }]);
    expect(parseSnapshotAnswer(snapshotAnswer("{}", []))?.frames).toEqual([]);
    expect(parseSnapshotAnswer("<html>a proxy page</html>")).toBeNull();
  });
});
