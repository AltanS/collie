import { describe, expect, it } from "vitest";

import { countByVerdict, filterRows, screensWalked, worst, type Row } from "./data";

function row(over: Partial<Row>): Row {
  return {
    screen: "dashboard",
    group: "Dashboard",
    size: "390x844",
    name: "x",
    selector: "button",
    tag: "button",
    box: [48, 48],
    hit: [48, 48],
    hitShare: 1,
    gap: 10,
    gapTo: null,
    events: ["onClick"],
    shiftPx: null,
    verdict: "ok",
    flags: [],
    severity: 0,
    ...over,
  };
}

describe("the census helpers", () => {
  const rows = [
    row({ name: "a" }),
    row({ name: "b", verdict: "small", severity: 30 }),
    row({ name: "b", verdict: "small", severity: 40, size: "360x780" }),
    row({ name: "c", verdict: "covered", severity: 90 }),
  ];

  it("counts each verdict", () => {
    expect(countByVerdict(rows)).toEqual({ ok: 1, small: 2, covered: 1, shifts: 0, "dead-time": 0 });
  });

  it("lists the worst first and counts a target on two sizes once, at its worse reading", () => {
    const top = worst(rows, 20);
    expect(top.map((r) => r.name)).toEqual(["c", "b"]);
    expect(top[1]?.severity).toBe(40);
  });

  it("filters by size and verdict", () => {
    expect(filterRows(rows, "360x780", "all").map((r) => r.name)).toEqual(["b"]);
    expect(filterRows(rows, "all", "small")).toHaveLength(2);
  });

  it("lists each walked screen once", () => {
    expect(screensWalked([{ screen: "a" }, { screen: "a" }, { screen: "b" }])).toEqual(["a", "b"]);
  });
});
