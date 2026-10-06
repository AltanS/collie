import { describe, expect, test } from "bun:test";

import type { CrewMemberStatus } from "@web/lib/types";

import { clipName, formationHeight, formationLayout, healthTone, healthWord, spine } from "./crew-formation";

function member(id: string, over: Partial<CrewMemberStatus> = {}): CrewMemberStatus {
  return { id, name: id, isLead: false, health: "reachable", lastSeenAt: 1, secretBehind: false, provisional: false, ...over };
}

const lead = member("lead", { isLead: true });

describe("formationLayout", () => {
  test("a solo crew is the apex alone", () => {
    const nodes = formationLayout([lead], null);
    expect(nodes.map((n) => [n.member.id, n.role, n.row])).toEqual([["lead", "lead", 0]]);
    expect(nodes[0]?.x).toBe(180);
  });

  test("the deputy sits on the centre line under the lead", () => {
    const nodes = formationLayout([lead, member("a"), member("b")], "a");
    const [apex, deputy] = nodes;
    expect(deputy?.role).toBe("deputy");
    expect(deputy?.x).toBe(apex?.x);
    expect(deputy?.y).toBeGreaterThan(apex?.y ?? 0);
  });

  test("no deputy skips the tier: the first peer sits one fan gap under the lead, left of centre", () => {
    const nodes = formationLayout([lead, member("a")], null);
    expect(nodes[1]?.role).toBe("peer");
    expect(nodes[1]?.x).toBeLessThan(180);
    expect(nodes[1]?.row).toBe(1);
  });

  test("peers alternate left then right and widen by rank", () => {
    const peers = ["a", "b", "c", "d"].map((id) => member(id));
    const nodes = formationLayout([lead, ...peers], null).slice(1);
    expect(nodes.map((n) => Math.sign(n.x - 180))).toEqual([-1, 1, -1, 1]);
    expect(Math.abs((nodes[2]?.x ?? 0) - 180)).toBeGreaterThan(Math.abs((nodes[0]?.x ?? 0) - 180));
    expect(nodes[2]?.y).toBeGreaterThan(nodes[0]?.y ?? 0);
  });

  test("past six peers a second V starts below the first", () => {
    const peers = Array.from({ length: 7 }, (_, i) => member(`p${String(i)}`));
    const nodes = formationLayout([lead, ...peers], null).slice(1);
    const lastOfFirstV = nodes[5];
    const firstOfSecondV = nodes[6];
    expect(firstOfSecondV?.y).toBeGreaterThan(lastOfFirstV?.y ?? 0);
  });

  test("a deputy id naming nobody, or the lead, degrades to peers", () => {
    expect(formationLayout([lead, member("a")], "ghost").map((n) => n.role)).toEqual(["lead", "peer"]);
    expect(formationLayout([lead, member("a")], "lead").map((n) => n.role)).toEqual(["lead", "peer"]);
  });

  test("a crew with no lead still draws from the top", () => {
    const nodes = formationLayout([member("a")], null);
    expect(nodes[0]?.y).toBe(58);
  });
});

describe("formationHeight", () => {
  test("empty collapses to zero and a crew reaches under its lowest node", () => {
    expect(formationHeight([])).toBe(0);
    const nodes = formationLayout([lead, member("a"), member("b")], "a");
    expect(formationHeight(nodes)).toBe(Math.max(...nodes.map((n) => n.y)) + 26 + 44);
  });
});

describe("spine", () => {
  test("the deputy's line is the vertical segment below the lead's caption", () => {
    const [apex, deputy] = formationLayout([lead, member("a")], "a");
    expect(spine(apex!, deputy!)).toBe(`M 180 ${String(58 + 26 + 22)} L 180 ${String((deputy?.y ?? 0) - 26)}`);
  });

  test("a peer's line leaves on a bearing and arrives vertically", () => {
    const [apex, peer] = formationLayout([lead, member("a")], null);
    const d = spine(apex!, peer!);
    expect(d.startsWith("M ")).toBe(true);
    expect(d).toContain(` Q ${String(peer?.x)}`);
    expect(d.endsWith(`${String(peer?.x)} ${String((peer?.y ?? 0) - 26)}`)).toBe(true);
  });
});

describe("clipName", () => {
  test("keeps a short name and cuts a long one with an ellipsis inside the budget", () => {
    expect(clipName("lodge")).toBe("lodge");
    expect(clipName("workstation-1")).toBe("workstat…");
    expect(clipName("workstation-1", 9)).toHaveLength(9);
  });
});

describe("health word and tone", () => {
  test("reachable is green, conflicted and incompatible are red, plain unreachable stays plain", () => {
    expect(healthTone({ health: "reachable" })).toBe("text-status-done");
    expect(healthTone({ health: "conflicted" })).toBe("text-status-blocked");
    expect(healthTone({ health: "incompatible" })).toBe("text-status-blocked");
    expect(healthTone({ health: "unreachable" })).toBe("text-muted-foreground");
  });

  test("only an attention link earns the red", () => {
    expect(healthTone({ health: "unreachable", linkState: "attention" })).toBe("text-status-blocked");
    expect(healthTone({ health: "unreachable", linkState: "reconnecting" })).toBe("text-muted-foreground");
  });

  test("the word is never empty", () => {
    for (const health of ["reachable", "unreachable", "incompatible", "conflicted"] as const) {
      expect(healthWord({ health }).length).toBeGreaterThan(0);
    }
  });
});
