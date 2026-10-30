import { describe, expect, it } from "vitest";

import { hostHealth, type HostHealth } from "./host-health";
import { groupByHost, hasSharedHost, instanceLabel, machineOf } from "./machines";
import type { ServerSummary } from "./types";

// The crew grouped by physical host (M77): machines keyed by `host`, instances inside, health summed.

const row = (id: string, over: Partial<ServerSummary> = {}): ServerSummary => ({
  id,
  name: id,
  isLead: false,
  reachable: true,
  protocol: "ok",
  lastSeenAt: 1_000,
  ...over,
});

const devCrew: ServerSummary[] = [
  row("minibuch-hc", { host: "minibuch", mux: "herdr-core" }),
  row("bluefin-hc", { host: "bluefin", mux: "herdr-core" }),
  row("minibuch", { host: "minibuch", mux: "herdr" }),
  row("bluefin", { host: "bluefin", mux: "herdr", isLead: true }),
];

const unreachable = (s: ServerSummary): ServerSummary => ({ ...s, reachable: false });

const ids = (m: { instances: ServerSummary[] }) => m.instances.map((s) => s.id);

describe("groupByHost: grouping and order", () => {
  it("puts every instance of one host on one machine, named by the host", () => {
    const machines = groupByHost(devCrew, { deputyId: "minibuch" });
    expect(machines.map((m) => m.key)).toEqual(["bluefin", "minibuch"]);
    expect(machines.map((m) => m.name)).toEqual(["bluefin", "minibuch"]);
    expect(machines.map(ids)).toEqual([
      ["bluefin", "bluefin-hc"],
      ["minibuch", "minibuch-hc"],
    ]);
  });

  it("orders the lead's machine first, the deputy's second, then the rest by name", () => {
    const servers = [
      row("zeta", { host: "zeta" }),
      row("alpha", { host: "alpha" }),
      row("deputy", { host: "yard" }),
      row("lead", { host: "home", isLead: true }),
    ];
    expect(groupByHost(servers, { deputyId: "deputy" }).map((m) => m.key)).toEqual(["home", "yard", "alpha", "zeta"]);
    // Without a named deputy, everyone after the lead goes by name.
    expect(groupByHost(servers).map((m) => m.key)).toEqual(["home", "alpha", "yard", "zeta"]);
  });

  it("orders the instances inside a machine lead first, deputy next, then by name", () => {
    const servers = [
      row("b-two", { host: "box" }),
      row("b-one", { host: "box" }),
      row("b-dep", { host: "box" }),
      row("b-lead", { host: "box", isLead: true }),
    ];
    expect(ids(groupByHost(servers, { deputyId: "b-dep" })[0]!)).toEqual(["b-lead", "b-dep", "b-one", "b-two"]);
  });

  it("makes a row without host a machine of its own, keyed and named by the member", () => {
    const servers = [row("bluefin", { isLead: true }), row("attic", { name: "Attic box" }), row("cellar")];
    const machines = groupByHost(servers);
    expect(machines.map((m) => m.key)).toEqual(["bluefin", "attic", "cellar"]);
    expect(machines.map((m) => m.name)).toEqual(["bluefin", "Attic box", "cellar"]);
    expect(hasSharedHost(machines)).toBe(false);
  });

  it("names a one-instance machine by its member, as the rows did before hosts existed", () => {
    const machines = groupByHost([row("bluefin", { host: "bluefin.local", isLead: true }), row("w", { host: "ws" })]);
    expect(machines.map((m) => m.name)).toEqual(["bluefin", "w"]);
  });

  it("finds the machine that holds a member id", () => {
    const machines = groupByHost(devCrew);
    expect(machineOf(machines, "minibuch-hc")?.key).toBe("minibuch");
    expect(machineOf(machines, "nobody")).toBeUndefined();
    expect(hasSharedHost(machines)).toBe(true);
  });
});

describe("groupByHost: health as a sum", () => {
  it("is ok when every instance is reachable", () => {
    const machines = groupByHost(devCrew);
    expect(machines.map((m) => m.health)).toEqual(["ok", "ok"]);
    expect(machines.map((m) => m.downInstances)).toEqual([[], []]);
  });

  it("is degraded when some instance is not reachable, and names it by its multiplexer", () => {
    const servers = devCrew.map((s) => (s.id === "minibuch-hc" ? unreachable(s) : s));
    const minibuch = groupByHost(servers).find((m) => m.key === "minibuch")!;
    expect(minibuch.health).toBe("degraded");
    expect(minibuch.downInstances).toEqual(["herdr-core"]);
  });

  it("is down when no instance is reachable", () => {
    const servers = devCrew.map((s) => (s.host === "minibuch" ? unreachable(s) : s));
    const minibuch = groupByHost(servers).find((m) => m.key === "minibuch")!;
    expect(minibuch.health).toBe("down");
    expect(minibuch.downInstances).toEqual(["herdr", "herdr-core"]);
  });

  it("reads the data root's health map first, the one the sheet and the crew page share", () => {
    // The row says reachable; the map, derived against the lead's clock, says it cannot be written.
    const notWritable: HostHealth = { ...hostHealth(devCrew[0]!, { at: 0, pollMs: 0 }), writable: false };
    const health = new Map([["minibuch-hc", notWritable]]);
    expect(groupByHost(devCrew, { health }).find((m) => m.key === "minibuch")!.health).toBe("degraded");
  });

  it("never counts the lead as down: its own row is always writable", () => {
    const servers = devCrew.map((s) => (s.isLead ? unreachable(s) : s));
    expect(groupByHost(servers)[0]!.health).toBe("ok");
  });
});

describe("instanceLabel", () => {
  it("is the multiplexer, or the member name when there is none or two share it", () => {
    const a = row("box-a", { mux: "tmux" });
    const b = row("box-b", { mux: "tmux" });
    expect(instanceLabel(a)).toBe("tmux");
    expect(instanceLabel(a, [a, b])).toBe("box-a");
    expect(instanceLabel(row("plain"))).toBe("plain");
  });
});
