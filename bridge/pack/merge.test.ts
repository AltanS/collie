import { describe, expect, test } from "bun:test";

import { computeEtag } from "../http-cache.ts";
import type { PaneWire, SessionSummary, SnapshotResponse } from "../types.ts";
import {
  MAX_PEER_PANES,
  MAX_PEER_SESSIONS,
  mergeSnapshot,
  parsePeerSnapshot,
  serverSummaryFor,
  type PeerContribution,
  type PeerSnapshotBody,
} from "./merge.ts";
import type { PeerState } from "./registry.ts";

// The merge is the one place the lead re-serialises (PACK_PROTOCOL.md §9.2), so it is where the
// three states of §10.2 either hold or quietly die. Everything here is data in, data out — no
// fetch, no timer, no server — which is exactly why the states are testable at all.

const NOW = 1_754_000_000_000;

function pane(over: Partial<PaneWire> & { paneId: string }): PaneWire {
  return {
    workspaceId: "w1",
    workspaceLabel: "collie",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/you",
    focused: false,
    kind: "agent",
    ...over,
  };
}

function session(over: Partial<SessionSummary> & { name: string }): SessionSummary {
  return { isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0, ...over };
}

function localBody(over: Partial<SnapshotResponse> = {}): SnapshotResponse {
  return {
    bridge: "connected",
    agents: [pane({ paneId: "w1:p1", status: "blocked" })],
    shellPanes: [pane({ paneId: "w1:p9", agent: "shell", kind: "shell", status: "idle" })],
    workspaces: [],
    tabs: [],
    sessions: [session({ name: "default" })],
    notifications: { snoozedUntil: null },
    ts: NOW,
    ...over,
  };
}

function state(over: Partial<PeerState> & { memberId: string }): PeerState {
  return { health: "reachable", lastSeenAt: NOW - 1_000, reason: null, version: null, ...over };
}

function contribution(over: Partial<PeerContribution> & { state: PeerState }): PeerContribution {
  return { name: over.state.memberId, body: null, ...over };
}

const peerBody: PeerSnapshotBody = {
  sessions: [session({ name: "default", agents: 2, blocked: 1 })],
  agents: [pane({ paneId: "w1:p1", status: "blocked" }), pane({ paneId: "w1:p2", status: "working" })],
  shellPanes: [pane({ paneId: "w1:p8", agent: "shell", kind: "shell" })],
};

const SELF = { id: "desk", name: "the herd" };

// ── The three states of §10.2 ────────────────────────────────────────────────

describe("mergeSnapshot — reachable / unreachable / incompatible, never conflated", () => {
  test("a reachable peer contributes its sessions and panes, host-tagged by the lead", () => {
    const merged = mergeSnapshot(localBody(), {
      self: SELF,
      peers: [contribution({ state: state({ memberId: "laptop" }), body: peerBody })],
      now: NOW,
    });

    expect(merged.servers).toEqual([
      { id: "desk", name: "the herd", isLead: true, reachable: true, protocol: "ok", lastSeenAt: NOW },
      { id: "laptop", name: "laptop", isLead: false, reachable: true, protocol: "ok", lastSeenAt: NOW - 1_000 },
    ]);
    expect(merged.sessions.map((s) => [s.host, s.name])).toEqual([
      ["desk", "default"],
      ["laptop", "default"],
    ]);
    expect(merged.agents.map((p) => [p.host, p.paneId])).toEqual([
      ["desk", "w1:p1"],
      ["laptop", "w1:p1"],
      ["laptop", "w1:p2"],
    ]);
  });

  test("an unreachable peer degrades its ENTRY, never the response", () => {
    const merged = mergeSnapshot(localBody(), {
      self: SELF,
      peers: [
        contribution({
          state: state({
            memberId: "laptop",
            health: "unreachable",
            lastSeenAt: NOW - 30_000,
            reason: "snapshot: timed out after 1200ms",
          }),
          // §10.2: A PEER'S SESSIONS NEVER VANISH. The body survives the failed poll.
          body: peerBody,
        }),
      ],
      now: NOW,
    });

    const laptop = merged.servers!.find((s) => s.id === "laptop")!;
    expect(laptop.reachable).toBe(false);
    // It answered before, so its protocol is known-good; only its reachability moved.
    expect(laptop.protocol).toBe("ok");
    expect(laptop.lastSeenAt).toBe(NOW - 30_000);
    expect(laptop.protocolDetail).toBeUndefined();
    // Stale, listed, addressable — not gone. A triage list that flickers is worse than a stale one.
    expect(merged.agents.filter((p) => p.host === "laptop")).toHaveLength(2);
    expect(merged.sessions.filter((s) => s.host === "laptop")).toHaveLength(1);
  });

  test("an incompatible peer carries the refusal reason verbatim, and still lists its panes", () => {
    const reason = "snapshot: peer answered protocol 2, this build speaks 1";
    const merged = mergeSnapshot(localBody(), {
      self: SELF,
      peers: [
        contribution({
          state: state({ memberId: "laptop", health: "incompatible", lastSeenAt: NOW - 60_000, reason }),
          body: peerBody,
        }),
      ],
      now: NOW,
    });

    const laptop = merged.servers!.find((s) => s.id === "laptop")!;
    expect(laptop.protocol).toBe("incompatible");
    expect(laptop.protocolDetail).toBe(reason);
    expect(laptop.reachable).toBe(false);
    expect(merged.agents.filter((p) => p.host === "laptop")).toHaveLength(2);
  });

  test("a peer that has never answered is `unknown`, listed, and contributes nothing", () => {
    const merged = mergeSnapshot(localBody(), {
      self: SELF,
      peers: [
        contribution({
          state: state({ memberId: "laptop", health: "unreachable", lastSeenAt: null, reason: "never polled" }),
        }),
      ],
      now: NOW,
    });

    expect(merged.servers!.find((s) => s.id === "laptop")).toEqual({
      id: "laptop",
      name: "laptop",
      isLead: false,
      reachable: false,
      protocol: "unknown",
      // `0`, not null: the field is a number on the wire and "never" is what 0 says (§9.2).
      lastSeenAt: 0,
    });
    expect(merged.agents.every((p) => p.host === "desk")).toBe(true);
  });

  test("the lead's own entry is present, first, and always current", () => {
    const merged = mergeSnapshot(localBody(), { self: SELF, peers: [], now: NOW });
    expect(merged.servers![0]).toEqual({
      id: "desk",
      name: "the herd",
      isLead: true,
      reachable: true,
      protocol: "ok",
      lastSeenAt: NOW,
    });
  });
});

// ── Freshness is the lead's clock ────────────────────────────────────────────

describe("mergeSnapshot — freshness comes from the lead's receipt time, never the peer's", () => {
  test("lastSeenAt is the PeerState's stamp; a `ts` inside the peer's body is ignored", () => {
    const withPeerClock = parsePeerSnapshot({
      ...peerBody,
      // A peer whose clock is a year fast. Nothing may read this.
      ts: NOW + 31_536_000_000,
    })!;
    const merged = mergeSnapshot(localBody(), {
      self: SELF,
      peers: [contribution({ state: state({ memberId: "laptop", lastSeenAt: NOW - 500 }), body: withPeerClock })],
      now: NOW,
    });
    expect(merged.servers!.find((s) => s.id === "laptop")!.lastSeenAt).toBe(NOW - 500);
    expect(JSON.stringify(merged)).not.toContain(String(NOW + 31_536_000_000));
    // The lead's own `ts` is the lead's, untouched by the merge.
    expect(merged.ts).toBe(NOW);
  });
});

// ── Cross-host collisions: the whole reason the host dimension exists ─────────

describe("mergeSnapshot — the same pane id on two hosts never collapses", () => {
  const twoHosts = () =>
    mergeSnapshot(localBody(), {
      self: SELF,
      peers: [
        contribution({
          state: state({ memberId: "laptop" }),
          body: { sessions: [session({ name: "default" })], agents: [pane({ paneId: "w1:p1", status: "blocked" })], shellPanes: [] },
        }),
      ],
      now: NOW,
    });

  test("two `w1:p1`s survive as two addressable rows", () => {
    const merged = twoHosts();
    const ids = merged.agents.map((p) => `${p.host} ${p.paneId}`);
    expect(ids).toEqual(["desk w1:p1", "laptop w1:p1"]);
    expect(new Set(ids).size).toBe(2);
  });

  test("a same-named session on two hosts is two rows, distinguished only by host", () => {
    const merged = twoHosts();
    expect(merged.sessions).toHaveLength(2);
    expect(merged.sessions.map((s) => s.name)).toEqual(["default", "default"]);
    expect(merged.sessions.map((s) => s.host)).toEqual(["desk", "laptop"]);
  });

  test("the merged ETag is the LEAD's own assertion: it moves when any peer's contribution moves", () => {
    const before = computeEtag(JSON.stringify(twoHosts()));
    const after = computeEtag(
      JSON.stringify(
        mergeSnapshot(localBody(), {
          self: SELF,
          peers: [
            contribution({
              state: state({ memberId: "laptop" }),
              body: {
                sessions: [session({ name: "default" })],
                // The peer's pane moved blocked → done. Same id, same host, different body.
                agents: [pane({ paneId: "w1:p1", status: "done" })],
                shellPanes: [],
              },
            }),
          ],
          now: NOW,
        }),
      ),
    );
    expect(after).not.toBe(before);
  });

  test("dropping the host would collapse the two rows into one ETag — the negative control", () => {
    const merged = twoHosts();
    const stripped = { ...merged, agents: merged.agents.map(({ host: _h, ...rest }) => rest) };
    expect(computeEtag(JSON.stringify(stripped))).not.toBe(computeEtag(JSON.stringify(merged)));
    // And they would be indistinguishable rows, which is the failure the host dimension prevents.
    expect(stripped.agents[0]).toEqual(stripped.agents[1]!);
  });
});

// ── Ordering: one triage list across hosts ───────────────────────────────────

describe("mergeSnapshot — one triage-sorted list across hosts", () => {
  test("a blocked peer agent outranks an idle local one (no host tab can hide NEEDS YOU)", () => {
    const merged = mergeSnapshot(localBody({ agents: [pane({ paneId: "w1:p1", status: "idle" })] }), {
      self: SELF,
      peers: [
        contribution({
          state: state({ memberId: "laptop" }),
          body: { sessions: [], agents: [pane({ paneId: "w1:p2", status: "blocked" })], shellPanes: [] },
        }),
      ],
      now: NOW,
    });
    expect(merged.agents.map((p) => [p.host, p.status])).toEqual([
      ["laptop", "blocked"],
      ["desk", "idle"],
    ]);
  });

  test("within one status the lead sorts first, then peers by member id — a total order", () => {
    const merged = mergeSnapshot(localBody({ agents: [pane({ paneId: "w1:p1", status: "blocked" })] }), {
      self: SELF,
      peers: [
        contribution({
          state: state({ memberId: "zeta" }),
          body: { sessions: [], agents: [pane({ paneId: "w1:p1", status: "blocked" })], shellPanes: [] },
        }),
        contribution({
          state: state({ memberId: "alpha" }),
          body: { sessions: [], agents: [pane({ paneId: "w1:p1", status: "blocked" })], shellPanes: [] },
        }),
      ],
      now: NOW,
    });
    // Every key of the comparator is equal except the host — which is precisely the tie the spec's
    // open question worried would jitter between polls. It cannot: `(host, paneId)` is unique.
    expect(merged.agents.map((p) => p.host)).toEqual(["desk", "alpha", "zeta"]);
    expect(merged.servers!.map((s) => s.id)).toEqual(["desk", "alpha", "zeta"]);
  });

  test("with every peer unreachable and bodyless, the local order is byte-identical to unmerged", () => {
    const local = localBody({
      agents: [
        pane({ paneId: "w1:p2", status: "blocked" }),
        pane({ paneId: "w1:p1", status: "done" }),
      ],
    });
    const merged = mergeSnapshot(local, {
      self: SELF,
      peers: [contribution({ state: state({ memberId: "laptop", health: "unreachable", lastSeenAt: null }) })],
      now: NOW,
    });
    expect(merged.agents.map((p) => p.paneId)).toEqual(local.agents.map((p) => p.paneId));
    // Same body modulo the two additive fields — nothing about the lead's own view is rewritten.
    const { servers: _s, ...rest } = merged;
    expect({
      ...rest,
      agents: rest.agents.map(({ host: _h, ...p }) => p),
      shellPanes: rest.shellPanes.map(({ host: _h, ...p }) => p),
      sessions: rest.sessions.map(({ host: _h, ...s }) => s),
    }).toEqual(local);
  });

  test("the lead's own workspaces/tabs are not unioned with a peer's", () => {
    const merged = mergeSnapshot(localBody({ workspaces: [], tabs: [] }), {
      self: SELF,
      peers: [contribution({ state: state({ memberId: "laptop" }), body: peerBody })],
      now: NOW,
    });
    // Space ids are only unique per machine; a pane carries the denormalised label it renders with.
    expect(merged.workspaces).toEqual([]);
    expect(merged.tabs).toEqual([]);
  });
});

// ── Parsing a peer's body ────────────────────────────────────────────────────

describe("parsePeerSnapshot — a peer contributes rows, never claims", () => {
  test("a peer's own `host` on a session or pane is stripped, not trusted", () => {
    const parsed = parsePeerSnapshot({
      sessions: [{ ...session({ name: "default" }), host: "desk" }],
      agents: [{ ...pane({ paneId: "w1:p1" }), host: "desk" }],
      shellPanes: [],
    })!;
    expect(parsed.sessions[0]!.host).toBeUndefined();
    expect(parsed.agents[0]!.host).toBeUndefined();

    // And after the merge it is the LEAD's registry key, not the peer's claim.
    const merged = mergeSnapshot(localBody(), {
      self: SELF,
      peers: [contribution({ state: state({ memberId: "laptop" }), body: parsed })],
      now: NOW,
    });
    expect(merged.agents.filter((p) => p.host === "desk").map((p) => p.paneId)).toEqual(["w1:p1"]);
    expect(merged.agents.filter((p) => p.host === "laptop")).toHaveLength(1);
  });

  test("a body missing any of the three lists is not a snapshot to salvage", () => {
    expect(parsePeerSnapshot(null)).toBeNull();
    expect(parsePeerSnapshot("nope")).toBeNull();
    expect(parsePeerSnapshot({})).toBeNull();
    expect(parsePeerSnapshot({ sessions: [], agents: [] })).toBeNull();
    expect(parsePeerSnapshot({ sessions: [], agents: [], shellPanes: [] })).toEqual({
      sessions: [],
      agents: [],
      shellPanes: [],
    });
  });

  test("rows that cannot be rendered or addressed are dropped, not defaulted", () => {
    const parsed = parsePeerSnapshot({
      sessions: [session({ name: "ok" }), { name: 42 }, null],
      agents: [pane({ paneId: "w1:p1" }), { paneId: "" }, { paneId: "w1:p2", status: "nonsense", workspaceNumber: 1 }],
      shellPanes: [],
    })!;
    expect(parsed.sessions.map((s) => s.name)).toEqual(["ok"]);
    expect(parsed.agents.map((p) => p.paneId)).toEqual(["w1:p1"]);
  });

  test("one peer cannot make the lead's snapshot unbounded", () => {
    const many = Array.from({ length: MAX_PEER_PANES + 25 }, (_, i) => pane({ paneId: `w1:p${i}` }));
    const manySessions = Array.from({ length: MAX_PEER_SESSIONS + 5 }, (_, i) => session({ name: `s${i}` }));
    const parsed = parsePeerSnapshot({ sessions: manySessions, agents: many, shellPanes: many })!;
    expect(parsed.agents).toHaveLength(MAX_PEER_PANES);
    expect(parsed.shellPanes).toHaveLength(MAX_PEER_PANES);
    expect(parsed.sessions).toHaveLength(MAX_PEER_SESSIONS);
  });
});

describe("serverSummaryFor — §9.2's shape, exactly", () => {
  test("carries no field the protocol does not specify", () => {
    const summary = serverSummaryFor(contribution({ state: state({ memberId: "laptop" }), body: peerBody }));
    expect(Object.keys(summary).sort()).toEqual([
      "id",
      "isLead",
      "lastSeenAt",
      "name",
      "protocol",
      "reachable",
    ]);
  });

  test("protocolDetail appears only for an incompatible member", () => {
    const unreachable = serverSummaryFor(
      contribution({ state: state({ memberId: "l", health: "unreachable", reason: "connection refused" }) }),
    );
    expect(unreachable.protocolDetail).toBeUndefined();
    const skewed = serverSummaryFor(
      contribution({ state: state({ memberId: "l", health: "incompatible", reason: "speaks 2" }) }),
    );
    expect(skewed.protocolDetail).toBe("speaks 2");
  });
});
