import { describe, expect, test } from "bun:test";

import type { CrewMemberStatus } from "@web/lib/types";

import { asServerSummary, clipName, formationHeight, formationLayout, spine } from "./formation";

function member(id: string, over: Partial<CrewMemberStatus> = {}): CrewMemberStatus {
  return { id, name: id, isLead: false, health: "reachable", lastSeenAt: 1, secretBehind: false, provisional: false, ...over };
}

const lead = member("lead", { isLead: true });

describe("formationLayout", () => {
  test("a solo crew is the apex alone", () => {
    const nodes = formationLayout([lead], null);
    expect(nodes.map((n) => n.role)).toEqual(["lead"]);
    expect(nodes[0]?.x).toBe(180);
  });

  test("the deputy sits on the centre line below the lead", () => {
    const nodes = formationLayout([lead, member("b"), member("c")], "b");
    const deputy = nodes.find((n) => n.role === "deputy");
    expect(deputy?.x).toBe(180);
    expect(deputy?.y).toBeGreaterThan(nodes[0]?.y ?? 0);
    expect(nodes.find((n) => n.member.id === "c")?.role).toBe("peer");
  });

  test("no deputy means a shallower crew, not an empty slot", () => {
    const nodes = formationLayout([lead, member("b")], null);
    expect(nodes.map((n) => n.role)).toEqual(["lead", "peer"]);
    expect(nodes[1]?.x).toBeLessThan(180);
  });

  test("peers fan left first, then right, and a seventh wraps into a second V", () => {
    const peers = Array.from({ length: 7 }, (_, i) => member(`p${String(i)}`));
    const nodes = formationLayout([lead, ...peers], null);
    const fan = nodes.filter((n) => n.role === "peer");
    expect(fan[0]?.x).toBeLessThan(180);
    expect(fan[1]?.x).toBeGreaterThan(180);
    expect(fan[6]?.y).toBeGreaterThan(fan[5]?.y ?? 0);
    expect(fan[6]?.x).toBeLessThan(180);
  });

  test("a deputy id naming nobody degrades to peers", () => {
    const nodes = formationLayout([lead, member("b")], "ghost");
    expect(nodes.every((n) => n.role !== "deputy")).toBe(true);
  });

  test("the height is zero for an empty crew", () => {
    expect(formationHeight([])).toBe(0);
    expect(formationHeight(formationLayout([lead], null))).toBeGreaterThan(0);
  });
});

describe("words and paths", () => {
  test("clipName counts characters and ends on an ellipsis", () => {
    expect(clipName("short")).toBe("short");
    expect(clipName("a-very-long-name")).toBe("a-very-l…");
  });

  test("only reachable is a green light", () => {
    expect(asServerSummary(member("x", { health: "conflicted" })).reachable).toBe(false);
    expect(asServerSummary(member("x")).reachable).toBe(true);
  });

  test("the deputy's connector is vertical, a peer's is curved", () => {
    const nodes = formationLayout([lead, member("b"), member("c")], "b");
    const apex = nodes[0];
    const deputy = nodes[1];
    const peer = nodes[2];
    if (!apex || !deputy || !peer) throw new Error("layout");
    expect(spine(apex, deputy)).toContain(" L ");
    expect(spine(apex, peer)).toContain(" Q ");
  });
});
