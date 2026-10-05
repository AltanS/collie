import { describe, expect, test } from "bun:test";

import type { JsonValue } from "../json.ts";
import { parsePeerMachineStats } from "../machine-parse.ts";
import type { MachineSample } from "../types.ts";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../uploads.ts";
import { member, neverProxy } from "./fixtures.ts";
import { CrewLead } from "./lead.ts";
import type { PeerOutcome } from "./peer-client.ts";
import { CrewRegistry } from "./registry.ts";

// ADR 0084's half of the crew wire: a member's own load rides its `/crew/v1/snapshot` answer as the
// additive-optional sibling `machineStats` (CREW_PROTOCOL.md §5, §7.1). Absent or malformed is "not
// reported", the lead stamps it on receipt, and nothing about it can refuse a member.

const NOW = 1_754_000_000_000;

const SAMPLE: MachineSample = { cpu: 0.42, cores: 8, memUsed: 6e9, memTotal: 16e9, load1: 2.5, rxBps: 1e5, txBps: 2e4 };

const body = {
  sessions: [{ name: "default", isPrimary: true, reachable: true, agents: 0, working: 0, blocked: 0 }],
  agents: [],
  shellPanes: [],
};

describe("parsePeerMachineStats — absent and malformed are 'not reported'", () => {
  test("a whole sample parses, and the optional keys may be absent", () => {
    expect(parsePeerMachineStats({ ...body, machineStats: { ...SAMPLE } })).toEqual(SAMPLE);
    const windowsLike = { cpu: 0.1, cores: 4, memUsed: 1e9, memTotal: 8e9 };
    expect(parsePeerMachineStats({ ...body, machineStats: windowsLike })).toEqual(windowsLike);
  });

  test("an answer without the field is an older member, and reads as null", () => {
    expect(parsePeerMachineStats(body)).toBeNull();
    expect(parsePeerMachineStats(null)).toBeNull();
    expect(parsePeerMachineStats([])).toBeNull();
  });

  test("an unknown key is ignored, so a later build may add one", () => {
    expect(parsePeerMachineStats({ machineStats: { ...SAMPLE, gpu: 0.9 } })).toEqual(SAMPLE);
  });

  test("any number that is not finite and in range drops the whole sample", () => {
    const bad: JsonValue[] = [
      { ...SAMPLE, cpu: 1.2 },
      { ...SAMPLE, cpu: -0.1 },
      { ...SAMPLE, cpu: "0.4" },
      { ...SAMPLE, cores: 0 },
      { ...SAMPLE, cores: 2.5 },
      { ...SAMPLE, memUsed: 17e9 },
      { ...SAMPLE, memTotal: 0 },
      { ...SAMPLE, load1: -1 },
      { ...SAMPLE, load1: null },
      { ...SAMPLE, rxBps: -5 },
      { ...SAMPLE, txBps: "fast" },
      "a string",
      42,
    ];
    for (const machineStats of bad) expect(parsePeerMachineStats({ ...body, machineStats })).toBeNull();
    // JSON cannot carry NaN or Infinity, but a broken sender can carry the number 1e400, which parses
    // to Infinity — and that must not become a chart's y axis.
    expect(parsePeerMachineStats(JSON.parse(`{"machineStats":{"cpu":0.1,"cores":2,"memUsed":1,"memTotal":1e400}}`))).toBeNull();
  });
});

describe("the sweep hands a member's load to the watch, stamped on the lead's clock", () => {
  function sweepWith(answer: PeerOutcome<unknown>) {
    const seen: { memberId: string; sample: MachineSample; at: number }[] = [];
    const l = new CrewLead({
      log: () => {},
      registry: new CrewRegistry({
        sessions: { get: () => undefined },
        self: "desk",
        members: () => [member({ memberId: "laptop" })],
      }),
      snapshot: async () => answer,
      proxy: neverProxy,
      self: { id: "desk", name: "desk" },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      now: () => NOW,
      onMachineStats: (memberId, sample, at) => seen.push({ memberId, sample, at }),
    });
    return { l, seen };
  }

  const ok = (value: JsonValue): PeerOutcome<unknown> => ({
    ok: true,
    value,
    status: 200,
    member: null,
    // The PEER's idea of the time. The lead must not use it (§10.2).
    receivedAt: NOW - 3_600_000,
    date: null,
  });

  test("a carried sample reaches the watch with the lead's receipt time", async () => {
    const { l, seen } = sweepWith(ok({ ...body, machineStats: { ...SAMPLE } }));
    await l.sweep();
    expect(seen).toEqual([{ memberId: "laptop", sample: SAMPLE, at: NOW }]);
  });

  test("an older member, a malformed field and a failed dial all call nothing", async () => {
    for (const answer of [
      ok(body),
      ok({ ...body, machineStats: { ...SAMPLE, cpu: 7 } }),
      { ok: false, state: "unreachable", reason: "timed out", receivedAt: NOW } satisfies PeerOutcome<unknown>,
    ]) {
      const { l, seen } = sweepWith(answer);
      await l.sweep();
      expect(seen).toEqual([]);
    }
  });

  test("the member's snapshot still merges exactly as before, field or no field", async () => {
    const { l } = sweepWith(ok({ ...body, machineStats: { ...SAMPLE } }));
    await l.sweep();
    const contributed = l.contributions().find((c) => c.state.memberId === "laptop");
    expect(contributed?.state.health).toBe("reachable");
    // The merge whitelists what it reads: the sibling never becomes part of the body the phone sees.
    expect(JSON.stringify(contributed?.body)).not.toContain("machineStats");
  });
});
