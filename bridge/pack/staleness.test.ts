import { describe, expect, test } from "bun:test";

import { leadStore, member, peerStore } from "./fixtures.ts";
import {
  checkpointMarker,
  checkpointStale,
  formatMarker,
  markerFor,
  packRuntimePath,
  parseMarker,
  rosterDrift,
  rosterSignature,
} from "./staleness.ts";

// The boot-time roster snapshot, and the drift the CLI reads off it. Everything here is pure: the
// bridge writes the marker, `collie pack status` compares it, and neither of those two processes is
// needed to pin what "the running bridge is behind" means.

const T0 = 1_760_000_000_000;

describe("rosterSignature", () => {
  test("no store is an empty roster — a solo instance has nothing to be behind on", () => {
    expect(rosterSignature(null)).toEqual([]);
  });

  test("names enrolled members by role and id, sorted, and ignores tombstones", () => {
    const data = leadStore({
      peers: [member({ memberId: "nas" }), member({ memberId: "attic", status: "unenrolled" })],
    });
    expect(rosterSignature(data)).toEqual(["peer:nas"]);
  });

  test("a peer's roster is its lead", () => {
    expect(rosterSignature(peerStore())).toEqual([`lead:${peerStore().lead!.memberId}`]);
  });
});

describe("the marker", () => {
  test("round-trips through its own format", () => {
    const data = leadStore({ peers: [member({ memberId: "nas" })] });
    const marker = markerFor(data, T0, 4242);
    expect(marker).toEqual({
      bootedAt: T0,
      pid: 4242,
      mode: "lead",
      roster: ["peer:nas"],
      // The boot write IS its own first checkpoint, and a process that has just started holds none
      // of the runtime facts (§18.9).
      checkpointedAt: T0,
      anchoredGeneration: null,
      leadLastDialledAt: null,
      leadRefusedSecretAt: null,
      deposed: null,
      pairingCollision: null,
    });
    expect(parseMarker(formatMarker(marker))).toEqual(marker);
  });

  test("a checkpoint carries the facts only the running process holds (§18.9)", () => {
    const data = peerStore();
    const boot = markerFor(data, T0, 7);
    const live = checkpointMarker(
      boot,
      {
        anchoredGeneration: 3,
        leadLastDialledAt: T0 + 4_000,
        leadRefusedSecretAt: null,
        deposed: null,
        pairingCollision: null,
      },
      T0 + 15_000,
    );
    // The boot half is what this process WIRED and never moves; only the facts and the stamp do.
    expect(live.bootedAt).toBe(T0);
    expect(live.pid).toBe(7);
    expect(live.checkpointedAt).toBe(T0 + 15_000);
    expect(parseMarker(formatMarker(live))).toEqual(live);
  });

  test("a marker from a build that predates §18.9 reads as reporting nothing, never as a receipt", () => {
    const before = '{"bootedAt":100,"pid":2,"mode":"peer","roster":[]}';
    expect(parseMarker(before)).toEqual({
      bootedAt: 100,
      pid: 2,
      mode: "peer",
      roster: [],
      // One write, at boot — which is exactly what such a marker is.
      checkpointedAt: 100,
      anchoredGeneration: null,
      leadLastDialledAt: null,
      leadRefusedSecretAt: null,
      deposed: null,
      pairingCollision: null,
    });
  });

  test("a pairing collision round-trips, and a mark naming no label is no mark", () => {
    const boot = markerFor(leadStore(), T0, 7);
    const live = checkpointMarker(boot, { ...boot, pairingCollision: { at: T0, labels: ["phone"] } }, T0);
    expect(parseMarker(formatMarker(live))?.pairingCollision).toEqual({ at: T0, labels: ["phone"] });
    // The labels ARE the finding: a collision surface with nothing to rename is a warning nobody can
    // act on, so it reads as no finding at all rather than as an empty one.
    const empty = JSON.stringify({ ...live, pairingCollision: { at: T0, labels: [] } });
    expect(parseMarker(empty)?.pairingCollision).toBeNull();
    const junk = JSON.stringify({ ...live, pairingCollision: { labels: ["phone"] } });
    expect(parseMarker(junk)?.pairingCollision).toBeNull();
  });

  test("a deposed mark this build cannot read is simply no mark — nothing acts on it", () => {
    const boot = markerFor(peerStore(), T0, 7);
    const raw = JSON.stringify({ ...boot, deposed: { outcome: "abdicated", generation: 1, at: T0 } });
    expect(parseMarker(raw)?.deposed).toBeNull();
  });

  test("a checkpoint nothing has refreshed is stale after three intervals, and not before", () => {
    const boot = markerFor(peerStore(), T0, 7);
    expect(checkpointStale(boot, T0 + 44_000, 15_000)).toBe(false);
    expect(checkpointStale(boot, T0 + 46_000, 15_000)).toBe(true);
  });

  test("anything unreadable is simply no marker — never a thrown verb", () => {
    for (const bad of [null, "", "{", "[]", '{"bootedAt":1}', '{"bootedAt":1,"pid":2,"roster":[],"mode":"boss"}']) {
      expect(parseMarker(bad)).toBeNull();
    }
  });

  test("lives in the state dir beside the store it describes", () => {
    expect(packRuntimePath("/state")).toBe("/state/pack-runtime.json");
  });
});

describe("rosterDrift", () => {
  const solo = markerFor(null, T0, 1);

  test("no marker means no running process to be stale — the silent case", () => {
    expect(rosterDrift(null, leadStore({ peers: [member({ memberId: "nas" })] }))).toBeNull();
  });

  test("a marker that still describes the store reports nothing", () => {
    const data = leadStore({ peers: [member({ memberId: "nas" })] });
    expect(rosterDrift(markerFor(data, T0, 1), data)).toBeNull();
  });

  test("THE FIRST ENROLLMENT: a lead that booted empty and enrolled a peer since", () => {
    // The gap the two-instance harness found. `pack invite` restarted the lead so it could ANSWER
    // the invite; the enrollment landed afterwards, in that same running process.
    const booted = markerFor(leadStore({ peers: [] }), T0, 1);
    const drift = rosterDrift(booted, leadStore({ peers: [member({ memberId: "nas" })] }));
    expect(drift).toEqual({ gained: ["peer:nas"], lost: [], modeChanged: "lead" });
  });

  test("THE DEMOTION: a process running as a lead whose store says it is a peer", () => {
    const booted = markerFor(leadStore({ peers: [member({ memberId: "nas" })] }), T0, 1);
    const drift = rosterDrift(booted, peerStore());
    expect(drift?.modeChanged).toBe("peer");
    expect(drift?.lost).toEqual(["peer:nas"]);
  });

  test("a tombstone left by a rotation is drift — the process still pins a member the store dropped", () => {
    const booted = markerFor(leadStore({ peers: [member({ memberId: "nas" })] }), T0, 1);
    const after = leadStore({ peers: [member({ memberId: "nas", status: "unenrolled" })] });
    expect(rosterDrift(booted, after)).toEqual({ gained: [], lost: ["peer:nas"], modeChanged: "solo" });
  });

  test("a solo process with a solo store is not drifting", () => {
    expect(rosterDrift(solo, null)).toBeNull();
    expect(rosterDrift(solo, leadStore({ peers: [] }))).toBeNull();
  });
});
