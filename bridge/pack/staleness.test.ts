import { describe, expect, test } from "bun:test";

import { leadStore, member, peerStore } from "./fixtures.ts";
import {
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
    expect(marker).toEqual({ bootedAt: T0, pid: 4242, mode: "lead", roster: ["peer:nas"] });
    expect(parseMarker(formatMarker(marker))).toEqual(marker);
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
