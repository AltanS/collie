/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { hostHealthMap } from "@web/lib/host-health";
import type { ServerSummary } from "@web/lib/types";

import { MAX_HIDDEN_MACHINES, defaultHost, nextHiddenMachines } from "./crew-model";

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
/** The members' health as chips/crew.ts derives it: the lead's clock, one cadence. */
const crewHealth = (servers: ServerSummary[]) => hostHealthMap(servers, { at: 1_000, pollMs: 3_000 });

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
    expect(defaultHost(roster, crewHealth(roster), undefined)).toBe("lead");
  });
  test("the scope's host, when it takes writes", () => {
    expect(defaultHost(roster, crewHealth(roster), "a")).toBe("a");
  });
  test("moves off a member that refuses writes to the first that does not", () => {
    const down = [lead, server("a", { reachable: false }), server("b")];
    expect(defaultHost(down, crewHealth(down), "a")).toBe("lead");
  });
});
