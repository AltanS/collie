/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import type { ServerSummary, SnapshotResponse } from "@web/lib/types";

import { MAX_HIDDEN_MACHINES, crewHealth, defaultHost, nextHiddenMachines } from "./crew-model";

const server = (id: string, extra: Partial<ServerSummary> = {}): ServerSummary => ({
  id,
  name: id,
  isLead: false,
  reachable: true,
  protocol: "ok",
  lastSeenAt: 1_000,
  ...extra,
});

const lead = server("lead", { isLead: true });
const roster = [lead, server("a"), server("b")];
function snap(ts: number, servers?: ServerSummary[]): SnapshotResponse {
  const body: SnapshotResponse = { bridge: "connected", ts, agents: [], shellPanes: [], workspaces: [], tabs: [] };
  if (servers !== undefined) body.servers = servers;
  return body;
}

describe("nextHiddenMachines", () => {
  test("hiding adds the machine, showing removes it", () => {
    expect(nextHiddenMachines([], "a", true, roster)).toEqual(["a"]);
    expect(nextHiddenMachines(["a", "b"], "a", false, roster)).toEqual(["b"]);
  });
  test("drops stored ids the roster does not list", () => {
    expect(nextHiddenMachines(["gone", "a"], "b", true, roster)).toEqual(["a", "b"]);
  });
  test("hiding a machine twice stores it once", () => {
    expect(nextHiddenMachines(["a"], "a", true, roster)).toEqual(["a"]);
  });
  test("keeps the newest ones past the bound, and always the one just hidden", () => {
    const many = Array.from({ length: MAX_HIDDEN_MACHINES + 4 }, (_, i) => server(`m${String(i)}`));
    const stored = many.slice(0, MAX_HIDDEN_MACHINES).map((s) => s.id);
    const next = nextHiddenMachines(stored, "m17", true, many);
    expect(next).toHaveLength(MAX_HIDDEN_MACHINES);
    expect(next.at(-1)).toBe("m17");
  });
});

describe("defaultHost", () => {
  test("a solo roster has no host", () => {
    expect(defaultHost([lead], new Map(), undefined)).toBeUndefined();
  });
  test("an absent host is the lead", () => {
    expect(defaultHost(roster, crewHealth(snap(1_000, roster), 3_000), undefined)).toBe("lead");
  });
  test("the scope's host, when it takes writes", () => {
    expect(defaultHost(roster, crewHealth(snap(1_000, roster), 3_000), "a")).toBe("a");
  });
  test("moves off a member that refuses writes to the first that does not", () => {
    const down = [lead, server("a", { reachable: false }), server("b")];
    expect(defaultHost(down, crewHealth(snap(1_000, down), 3_000), "a")).toBe("lead");
  });
});

describe("crewHealth", () => {
  test("is empty for a solo snapshot", () => {
    expect(crewHealth(undefined, 3_000).size).toBe(0);
    expect(crewHealth(snap(1), 3_000).size).toBe(0);
  });
  test("keys every member by id, the lead always live", () => {
    const map = crewHealth(snap(1_000, roster), 3_000);
    expect([...map.keys()]).toEqual(["lead", "a", "b"]);
    expect(map.get("lead")?.state).toBe("live");
  });
});
