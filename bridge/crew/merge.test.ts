import { describe, expect, test } from "bun:test";

import { computeEtag } from "../http-cache.ts";
import type { PaneWire, SessionSummary, SnapshotResponse, TabView, WorkspaceView } from "../types.ts";
import { NARROW_VIEW } from "../sessions.ts";
import {
  leadLabel,
  MAX_PEER_PANES,
  MAX_PEER_SESSIONS,
  mergeSnapshot,
  narrowPeerBody,
  NARROW_PLAN,
  parsePeerSnapshot,
  snapshotPlan,
  SWEEP_VIEW,
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
  return {
    health: "reachable",
    lastSeenAt: NOW - 1_000,
    reason: null,
    version: null,
    conflict: null,
    preflight: null,
    ...over,
  };
}

function contribution(over: Partial<PeerContribution> & { state: PeerState }): PeerContribution {
  return { name: over.state.memberId, body: null, ...over };
}

function ws(over: Partial<WorkspaceView> & { workspaceId: string }): WorkspaceView {
  return { number: 1, label: "~", focused: false, activeTabId: `${over.workspaceId}:t1`, tabCount: 1, paneCount: 1, ...over };
}

function tabOf(over: Partial<TabView> & { tabId: string; workspaceId: string }): TabView {
  return { number: 1, label: "1", focused: false, paneCount: 1, ...over };
}

/** A peer's contribution, with the two navigator lists defaulted empty so a test names only its subject. */
function body(over: Partial<PeerSnapshotBody> = {}): PeerSnapshotBody {
  return { sessions: [], agents: [], shellPanes: [], workspaces: [], tabs: [], ...over };
}

const peerBody: PeerSnapshotBody = body({
  sessions: [session({ name: "default", agents: 2, blocked: 1 })],
  agents: [pane({ paneId: "w1:p1", status: "blocked" }), pane({ paneId: "w1:p2", status: "working" })],
  shellPanes: [pane({ paneId: "w1:p8", agent: "shell", kind: "shell" })],
});

const SELF = { id: "desk", name: "the herd" };

// ── The lead's own roster label (§9.2: "operator-chosen label", never the crew's name) ──────────

describe("leadLabel — the lead's servers[].name is a machine label, not the crew's name", () => {
  test("a bare short hostname passes through unchanged", () => {
    expect(leadLabel("minibuch", "desk")).toBe("minibuch");
  });

  test("an FQDN is truncated to its first label", () => {
    expect(leadLabel("minibuch.tailnetxyz.ts.net", "desk")).toBe("minibuch");
  });

  test("an empty hostname() falls back to the member id", () => {
    expect(leadLabel("", "desk")).toBe("desk");
  });
});

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

  test("each row carries the multiplexer it drives: the lead's own, and a member's banked one", () => {
    const merged = mergeSnapshot(localBody(), {
      self: { ...SELF, mux: "herdr" },
      peers: [
        contribution({ state: state({ memberId: "laptop", mux: "herdr-core" }) }),
        contribution({ state: state({ memberId: "old-box" }) }),
      ],
      now: NOW,
    });
    expect(merged.servers!.find((s) => s.id === "desk")!.mux).toBe("herdr");
    expect(merged.servers!.find((s) => s.id === "laptop")!.mux).toBe("herdr-core");
    // A member that never said, and a lead that names none, carry no `mux` key at all.
    expect("mux" in merged.servers!.find((s) => s.id === "old-box")!).toBe(false);
    expect("mux" in mergeSnapshot(localBody(), { self: SELF, peers: [], now: NOW }).servers![0]!).toBe(false);
  });

  test("each row carries the host name: the lead's own, and a member's banked one (M77 spec 01)", () => {
    const merged = mergeSnapshot(localBody(), {
      self: { ...SELF, host: "bluefin" },
      peers: [
        contribution({ state: state({ memberId: "laptop", host: "minibuch" }) }),
        contribution({ state: state({ memberId: "old-box" }) }),
      ],
      now: NOW,
    });
    expect(merged.servers!.find((s) => s.id === "desk")!.host).toBe("bluefin");
    expect(merged.servers!.find((s) => s.id === "laptop")!.host).toBe("minibuch");
    // A member that never said, and a lead whose OS gives no name, carry no `host` key at all.
    expect("host" in merged.servers!.find((s) => s.id === "old-box")!).toBe(false);
    expect("host" in mergeSnapshot(localBody(), { self: SELF, peers: [], now: NOW }).servers![0]!).toBe(false);
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
          body: body({ sessions: [session({ name: "default" })], agents: [pane({ paneId: "w1:p1", status: "blocked" })] }),
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
              body: body({
                sessions: [session({ name: "default" })],
                // The peer's pane moved blocked → done. Same id, same host, different body.
                agents: [pane({ paneId: "w1:p1", status: "done" })],
              }),
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

// ── Ordering: one place-ordered list across hosts ────────────────────────────

describe("mergeSnapshot — the space and tab navigators are host-tagged too (F14)", () => {
  // §9.2: "Every session and every pane is host-tagged". Spaces and tabs were not, and Herdr numbers
  // them PER MACHINE — two default installs both call theirs `w1` and `w1:t1`. The lead's own lists
  // were passed straight through, so the member's space had no row at all and every count on the
  // surviving row was the lead's.
  const twoDefaultInstalls = () =>
    mergeSnapshot(
      localBody({
        agents: [pane({ paneId: "w1:p1", status: "blocked" })],
        shellPanes: [],
        workspaces: [ws({ workspaceId: "w1", label: "~" })],
        tabs: [tabOf({ tabId: "w1:t1", workspaceId: "w1" })],
      }),
      {
        self: SELF,
        peers: [
          contribution({
            state: state({ memberId: "member" }),
            body: body({
              agents: [pane({ paneId: "w1:p1", status: "working" })],
              workspaces: [ws({ workspaceId: "w1", label: "~" })],
              tabs: [tabOf({ tabId: "w1:t1", workspaceId: "w1" })],
            }),
          }),
        ],
        now: NOW,
      },
    );

  test("two machines' `w1`s are two rows, not one", () => {
    const merged = twoDefaultInstalls();
    expect(merged.workspaces.map((w) => [w.host, w.workspaceId])).toEqual([
      ["desk", "w1"],
      ["member", "w1"],
    ]);
    expect(merged.tabs.map((t) => [t.host, t.tabId])).toEqual([
      ["desk", "w1:t1"],
      ["member", "w1:t1"],
    ]);
  });

  test("both panes have a space of their own to be counted in", () => {
    const merged = twoDefaultInstalls();
    // Two panes exist. Before the fix the workspace and the tab each claimed one, and the row that
    // claimed it was the lead's.
    expect(merged.agents).toHaveLength(2);
    const byHost = merged.agents.map((p) => p.host).toSorted();
    expect(byHost).toEqual(["desk", "member"]);
    // A pane joins its space by `(host, workspaceId)`; every pane's pair is present exactly once.
    for (const p of merged.agents) {
      const rows = merged.workspaces.filter((w) => w.host === p.host && w.workspaceId === p.workspaceId);
      expect(rows).toHaveLength(1);
    }
  });

  test("no id is rewritten — a pane still finds its space by the id Herdr gave it", () => {
    const merged = twoDefaultInstalls();
    expect(merged.workspaces.every((w) => w.workspaceId === "w1")).toBe(true);
    expect(merged.tabs.every((t) => t.workspaceId === "w1")).toBe(true);
  });

  test("the lead's rows come first, then peers by member id, each machine's order kept", () => {
    const merged = mergeSnapshot(localBody({ workspaces: [ws({ workspaceId: "w1" })] }), {
      self: SELF,
      peers: [
        contribution({
          state: state({ memberId: "zeta" }),
          body: body({ workspaces: [ws({ workspaceId: "w2", number: 2 }), ws({ workspaceId: "w1" })] }),
        }),
        contribution({ state: state({ memberId: "alpha" }), body: body({ workspaces: [ws({ workspaceId: "w1" })] }) }),
      ],
      now: NOW,
    });
    expect(merged.workspaces.map((w) => `${w.host}/${w.workspaceId}`)).toEqual([
      "desk/w1",
      "alpha/w1",
      "zeta/w2",
      "zeta/w1",
    ]);
  });

  test("an unreachable peer keeps its spaces, from the last-good body (§10.2, invariant 2)", () => {
    const merged = mergeSnapshot(localBody({ workspaces: [], tabs: [] }), {
      self: SELF,
      peers: [
        contribution({
          state: state({ memberId: "member", health: "unreachable" }),
          body: body({ workspaces: [ws({ workspaceId: "w1" })], tabs: [tabOf({ tabId: "w1:t1", workspaceId: "w1" })] }),
        }),
      ],
      now: NOW,
    });
    expect(merged.workspaces).toHaveLength(1);
    expect(merged.tabs).toHaveLength(1);
  });

  test("worktree nesting survives the tag — repoRoot and isWorktree ride along per host", () => {
    const merged = mergeSnapshot(localBody({ workspaces: [] }), {
      self: SELF,
      peers: [
        contribution({
          state: state({ memberId: "member" }),
          body: body({
            workspaces: [
              ws({ workspaceId: "w1", repoRoot: "/home/op/collie" }),
              ws({ workspaceId: "w2", repoRoot: "/home/op/collie", isWorktree: true }),
            ],
          }),
        }),
      ],
      now: NOW,
    });
    expect(merged.workspaces.map((w) => [w.host, w.repoRoot, w.isWorktree])).toEqual([
      ["member", "/home/op/collie", undefined],
      ["member", "/home/op/collie", true],
    ]);
  });
});

describe("mergeSnapshot — one list across hosts, ordered by place and never by status (ADR 0063)", () => {
  test("a blocked peer agent stays below an idle lead one — the lead's machine comes first", () => {
    // This test used to assert the opposite: status led the comparator, so a peer's pane that blocked
    // jumped above every lead pane and dropped back when it resumed. Urgency is the phone's mark to
    // paint (the row wash, the "Needs you" line); it never moves a row.
    const merged = mergeSnapshot(localBody({ agents: [pane({ paneId: "w1:p1", status: "idle" })] }), {
      self: SELF,
      peers: [
        contribution({
          state: state({ memberId: "laptop" }),
          body: body({ agents: [pane({ paneId: "w1:p2", status: "blocked" })] }),
        }),
      ],
      now: NOW,
    });
    expect(merged.agents.map((p) => [p.host, p.status])).toEqual([
      ["desk", "idle"],
      ["laptop", "blocked"],
    ]);
  });

  test("the lead sorts first, then peers by member id — a total order", () => {
    const merged = mergeSnapshot(localBody({ agents: [pane({ paneId: "w1:p1", status: "blocked" })] }), {
      self: SELF,
      peers: [
        contribution({
          state: state({ memberId: "zeta" }),
          body: body({ agents: [pane({ paneId: "w1:p1", status: "blocked" })] }),
        }),
        contribution({
          state: state({ memberId: "alpha" }),
          body: body({ agents: [pane({ paneId: "w1:p1", status: "blocked" })] }),
        }),
      ],
      now: NOW,
    });
    // Every key of the comparator is equal except the host — which is precisely the tie the spec's
    // open question worried would jitter between polls. It cannot: `(host, paneId)` is unique.
    expect(merged.agents.map((p) => p.host)).toEqual(["desk", "alpha", "zeta"]);
    expect(merged.servers!.map((s) => s.id)).toEqual(["desk", "alpha", "zeta"]);
  });

  test("inside one machine: space, then the tab's own place in `tabs`, then the pane's place in its tab", () => {
    // The tab list is the multiplexer's order, so `w1:t9` (listed first) outranks `w1:t1`; the pane
    // ids are chosen to disagree with the positions, so a comparator that fell back to the id early
    // would fail here.
    const merged = mergeSnapshot(
      localBody({
        agents: [
          pane({ paneId: "w2:p1", workspaceId: "w2", workspaceNumber: 2, tabId: "w2:t1", tabPosition: 0 }),
          pane({ paneId: "w1:p1", tabId: "w1:t1", tabPosition: 1 }),
          pane({ paneId: "w1:p7", tabId: "w1:t1", tabPosition: 0 }),
          pane({ paneId: "w1:p3", tabId: "w1:t9", tabPosition: 0 }),
        ],
        tabs: [
          tabOf({ tabId: "w1:t9", workspaceId: "w1" }),
          tabOf({ tabId: "w1:t1", workspaceId: "w1", number: 2 }),
          tabOf({ tabId: "w2:t1", workspaceId: "w2" }),
        ],
      }),
      { self: SELF, peers: [contribution({ state: state({ memberId: "laptop" }), body: body() })], now: NOW },
    );
    expect(merged.agents.map((p) => p.paneId)).toEqual(["w1:p3", "w1:p7", "w1:p1", "w2:p1"]);
  });

  test("a status flip on any machine leaves the merged order exactly as it was", () => {
    const run = (lead: PaneWire["status"], peer: PaneWire["status"]) =>
      mergeSnapshot(
        localBody({
          agents: [
            pane({ paneId: "w1:p1", tabPosition: 0, status: "idle" }),
            pane({ paneId: "w1:p2", tabPosition: 1, status: lead }),
          ],
          tabs: [tabOf({ tabId: "w1:t1", workspaceId: "w1" })],
        }),
        {
          self: SELF,
          peers: [
            contribution({
              state: state({ memberId: "laptop" }),
              body: body({
                agents: [
                  pane({ paneId: "w1:p1", tabPosition: 0, status: peer }),
                  pane({ paneId: "w1:p2", tabPosition: 1, status: "working" }),
                ],
                tabs: [tabOf({ tabId: "w1:t1", workspaceId: "w1" })],
              }),
            }),
          ],
          now: NOW,
        },
      ).agents.map((p) => `${p.host}/${p.paneId}`);
    const before = run("working", "done");
    expect(before).toEqual(["desk/w1:p1", "desk/w1:p2", "laptop/w1:p1", "laptop/w1:p2"]);
    expect(run("blocked", "blocked")).toEqual(before);
    expect(run("idle", "unknown")).toEqual(before);
  });

  test("with every peer unreachable and bodyless, the local order is byte-identical to unmerged", () => {
    // The local body is the one state-engine.ts sends: already in place order, with positions. The
    // statuses deliberately run against that order, since status must not re-sort anything.
    const local = localBody({
      agents: [
        pane({ paneId: "w1:p2", tabPosition: 0, status: "done" }),
        pane({ paneId: "w1:p1", tabPosition: 1, status: "blocked" }),
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

  test("a pane's walky instance token is kept only as four characters of [a-z0-9]", () => {
    const parsed = parsePeerSnapshot({
      sessions: [],
      agents: [{ ...pane({ paneId: "w1:p1" }), instance: "k3f9" }, { ...pane({ paneId: "w1:p2" }), instance: "../x" }, { ...pane({ paneId: "w1:p3" }), instance: 1234 }],
      shellPanes: [{ ...pane({ paneId: "w1:p4", kind: "shell" }), instance: "zz00" }],
    })!;
    expect(parsed.agents.map((p) => p.instance)).toEqual(["k3f9", undefined, undefined]);
    expect("instance" in parsed.agents[1]!).toBe(false);
    expect(parsed.shellPanes[0]!.instance).toBe("zz00");
  });

  test("a session's display label is kept only as a string, cleaned and capped by the lead's rule", () => {
    const parsed = parsePeerSnapshot({
      sessions: [
        { ...session({ name: "a" }), label: "Видео" },
        { ...session({ name: "b" }), label: `x‮y${"z".repeat(100)}` },
        { ...session({ name: "c" }), label: { evil: true } },
        { ...session({ name: "d" }), label: "​" },
        session({ name: "e" }),
      ],
      agents: [],
      shellPanes: [],
    })!;
    expect(parsed.sessions.map((s) => s.label)).toEqual(["Видео", `x y${"z".repeat(45)}`, undefined, undefined, undefined]);
    expect("label" in parsed.sessions[2]!).toBe(false);

    // The label survives the merge beside the lead's host tag; the name is still the identity.
    const merged = mergeSnapshot(localBody(), {
      self: SELF,
      peers: [contribution({ state: state({ memberId: "laptop" }), body: parsed })],
      now: NOW,
    });
    expect(merged.sessions.find((s) => s.host === "laptop" && s.name === "a")?.label).toBe("Видео");
  });

  test("a body missing any of the three PANE lists is not a snapshot to salvage", () => {
    expect(parsePeerSnapshot(null)).toBeNull();
    expect(parsePeerSnapshot("nope")).toBeNull();
    expect(parsePeerSnapshot({})).toBeNull();
    expect(parsePeerSnapshot({ sessions: [], agents: [] })).toBeNull();
    expect(parsePeerSnapshot({ sessions: [], agents: [], shellPanes: [] })).toEqual(body());
  });

  // …but the navigator's two lists are absent-means-EMPTY. A peer that omits them still has panes,
  // and every pane carries its own denormalised space and tab labels — refusing the whole body over
  // a missing switcher row would trade one row for a whole MACHINE, which is invariant 1 backwards.
  test("workspaces and tabs are absent-means-empty, never a reason to drop the machine", () => {
    const parsed = parsePeerSnapshot({
      sessions: [],
      agents: [pane({ paneId: "w1:p1" })],
      shellPanes: [],
    });
    expect(parsed?.workspaces).toEqual([]);
    expect(parsed?.tabs).toEqual([]);
    expect(parsed?.agents).toHaveLength(1);
  });

  test("a space or a tab a peer asserts a host for is untagged on the way in", () => {
    // §4: a member id is minted by the lead. A peer that could label its own space with another
    // member's id would move a row onto a machine the operator never asked about.
    const parsed = parsePeerSnapshot({
      sessions: [],
      agents: [],
      shellPanes: [],
      workspaces: [{ ...ws({ workspaceId: "w1" }), host: "somebody-else" }],
      tabs: [{ ...tabOf({ tabId: "w1:t1", workspaceId: "w1" }), host: "somebody-else" }],
    });
    expect(parsed?.workspaces[0]).not.toHaveProperty("host");
    expect(parsed?.tabs[0]).not.toHaveProperty("host");
  });

  test("a space or tab row that cannot be rendered or addressed is dropped", () => {
    const parsed = parsePeerSnapshot({
      sessions: [],
      agents: [],
      shellPanes: [],
      workspaces: [ws({ workspaceId: "w1" }), { label: "no id" }, { workspaceId: "", number: 1 }],
      tabs: [tabOf({ tabId: "w1:t1", workspaceId: "w1" }), { tabId: "orphan" }],
    });
    expect(parsed?.workspaces.map((w) => w.workspaceId)).toEqual(["w1"]);
    expect(parsed?.tabs.map((t) => t.tabId)).toEqual(["w1:t1"]);
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
    expect(Object.keys(summary).toSorted()).toEqual([
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

  test("linkState rides along when the registry has one, and is OMITTED when it has not (§7.1)", () => {
    // Additive and optional: the key is absent for a reachable member and absent for a lead older
    // than the field, and an absent key is what tells a phone to keep printing the single old word.
    const reachable = serverSummaryFor(contribution({ state: state({ memberId: "l" }) }));
    expect("linkState" in reachable).toBe(false);
    const retrying = serverSummaryFor(
      contribution({
        state: state({ memberId: "l", health: "unreachable", reason: "timed out", linkState: "reconnecting" }),
      }),
    );
    expect(retrying.linkState).toBe("reconnecting");
    // The wire word does not change with it. That is the whole compatibility claim.
    expect(retrying.reachable).toBe(false);
    const stuck = serverSummaryFor(
      contribution({
        state: state({ memberId: "l", health: "unreachable", reason: "unauthorized", linkState: "attention" }),
      }),
    );
    expect(stuck.linkState).toBe("attention");
  });
});

// ── M22/06: the sweep widens, the merge narrows ──────────────────────────────
// One function does the narrowing, and it is the only place a cached peer body is cut down. The
// lead's cache holds every session a member runs, because a view the lead does not hold cannot be
// fetched inside a phone poll (§10.1).

describe("narrowPeerBody — a widened cached body, cut to the view a request asked for", () => {
  const widened: PeerSnapshotBody = {
    sessions: [session({ name: "default" }), session({ name: "work", isPrimary: false })],
    agents: [
      pane({ paneId: "l1:p1", session: "default" }),
      pane({ paneId: "l1:p2", session: "work" }),
    ],
    shellPanes: [pane({ paneId: "l1:p9", kind: "shell", agent: "shell", session: "work" })],
    workspaces: [],
    tabs: [],
  };

  test("the sweep's view is the widened one, and it names no session", () => {
    expect(SWEEP_VIEW).toEqual({ session: undefined, widen: true });
  });

  test("no widening asked: the member's primary session, and the tag comes off", () => {
    const narrowed = narrowPeerBody(widened, NARROW_VIEW)!;
    expect(narrowed.agents.map((p) => p.paneId)).toEqual(["l1:p1"]);
    expect(narrowed.shellPanes).toEqual([]);
    // The invariant `widenedPanes` states: an unwidened body carries NO `session` key at all, or an
    // untagged pane would mean two things depending on how the body was built.
    expect(JSON.stringify(narrowed)).not.toContain('"session"');
  });

  test("a named session reaches the panes of that session and nothing else", () => {
    const narrowed = narrowPeerBody(widened, { session: "work", widen: false })!;
    expect(narrowed.agents.map((p) => p.paneId)).toEqual(["l1:p2"]);
    expect(narrowed.shellPanes.map((p) => p.paneId)).toEqual(["l1:p9"]);
    expect(JSON.stringify(narrowed)).not.toContain('"session"');
  });

  test("widening asked: the body is untouched, tags and all", () => {
    expect(narrowPeerBody(widened, { session: undefined, widen: true })).toBe(widened);
  });

  test("the session list is never narrowed — a peer's sessions never vanish (§10.2)", () => {
    expect(narrowPeerBody(widened, NARROW_VIEW)!.sessions.map((s) => s.name)).toEqual(["default", "work"]);
  });

  test("a member with one session produces the body it produced before widening existed", () => {
    // The zero-cost claim. Its panes come back untagged and in the same order, so the merged body is
    // byte-identical to the pre-M22/06 one.
    const one: PeerSnapshotBody = {
      sessions: [session({ name: "default" })],
      agents: [pane({ paneId: "l1:p1", session: "default" })],
      shellPanes: [],
      workspaces: [],
      tabs: [],
    };
    const before: PeerSnapshotBody = { ...one, agents: [pane({ paneId: "l1:p1" })] };
    expect(narrowPeerBody(one, NARROW_VIEW)).toEqual(before);
  });

  test("an untagged pane is kept: that is what a member too old to widen answers with", () => {
    const old: PeerSnapshotBody = {
      sessions: [session({ name: "default" })],
      agents: [pane({ paneId: "l1:p1" })],
      shellPanes: [],
      workspaces: [],
      tabs: [],
    };
    expect(narrowPeerBody(old, NARROW_VIEW)).toEqual(old);
    expect(narrowPeerBody(old, { session: "work", widen: false })).toEqual(old);
  });

  test("a body that never parsed stays null — nothing here invents one", () => {
    expect(narrowPeerBody(null, NARROW_VIEW)).toBeNull();
    expect(narrowPeerBody(null, SWEEP_VIEW)).toBeNull();
  });

  test("nothing flagged primary: the list's own order decides, which is primary-first", () => {
    // A member whose summaries predate `isPrimary`, or whose flag did not survive the parse. The
    // registry publishes the primary first (`SessionRegistry.ordered`), so the first row is the
    // session a narrow request would have been served.
    const unflagged: PeerSnapshotBody = {
      ...widened,
      sessions: widened.sessions.map((s) => session({ ...s, isPrimary: false })),
    };
    expect(narrowPeerBody(unflagged, NARROW_VIEW)!.agents.map((p) => p.paneId)).toEqual(["l1:p1"]);
  });

  test("a member with no session list at all is left alone rather than emptied", () => {
    const sessionless: PeerSnapshotBody = { ...widened, sessions: [] };
    expect(narrowPeerBody(sessionless, NARROW_VIEW)).toBe(sessionless);
  });
});

describe("snapshotPlan — `?h=` says which machine, `?all=1` says how much of it", () => {
  test("no host: the lead takes the view as asked, every member stays narrow", () => {
    const plan = snapshotPlan(null, { session: "work", widen: true });
    expect(plan.local).toEqual({ session: "work", widen: true });
    expect(plan.peer("laptop")).toEqual(NARROW_VIEW);
  });

  test("a member: that member takes the view, the lead falls back to its own primary", () => {
    const plan = snapshotPlan("laptop", { session: "work", widen: true });
    expect(plan.peer("laptop")).toEqual({ session: "work", widen: true });
    expect(plan.local).toEqual(NARROW_VIEW);
    expect(plan.peer("desktop")).toEqual(NARROW_VIEW);
  });

  test("a member id nobody holds widens nothing and dials nothing", () => {
    const plan = snapshotPlan("ghost", { session: undefined, widen: true });
    expect(plan.local).toEqual(NARROW_VIEW);
    expect(plan.peer("laptop")).toEqual(NARROW_VIEW);
  });

  test("NARROW_PLAN is the plan for a request that asks for nothing", () => {
    expect(NARROW_PLAN.local).toEqual(NARROW_VIEW);
    expect(NARROW_PLAN.peer("laptop")).toEqual(NARROW_VIEW);
  });
});

// ── Asks as data cross the merge untouched (ADR 0100) ──────────────────────────
//
// `asks` is additive-optional on a pane (CREW_PROTOCOL.md §7.1). The lead adds no
// rule for them: a pane is kept whole and only its `host` is re-stamped, so a member's open asks reach
// the phone as the member listed them. A pane without the field is a pane from an older member, or
// from any adapter that has a screen, and it parses exactly as before.
describe("asks on a peer's pane", () => {
  const ask = {
    id: "ask-1",
    kind: "permission",
    toolCallId: "call-1",
    revision: 2,
    title: "write_note wants to write /tmp/notes.txt",
    itemId: "item-1",
    options: [
      { id: "allow", label: "Allow once", effect: "allow" as const },
      { id: "deny", label: "Deny", effect: "deny" as const },
    ],
    reason: "The summary is the answer.",
    tool: { name: "write_note", summary: "path=/tmp/notes.txt" },
    expiresAt: "2026-10-15T10:04:00.000Z",
  };

  test("the lead's merge passes asks through, and tags the host", () => {
    const durable = pane({ paneId: "conv-02", agent: "durable", status: "blocked", asks: [ask] });
    const parsed = parsePeerSnapshot({ sessions: [session({ name: "default" })], agents: [durable], shellPanes: [] });
    expect(parsed?.agents[0]?.asks).toEqual([ask]);

    const merged = mergeSnapshot(localBody(), {
      self: { id: "lead", name: "lead" },
      peers: [contribution({ state: state({ memberId: "laptop" }), body: parsed })],
      now: NOW,
    });
    const fromPeer = merged.agents.find((p) => p.paneId === "conv-02");
    expect(fromPeer?.host).toBe("laptop");
    expect(fromPeer?.asks).toEqual([ask]);
    // The ask's expiry rides through the lead unchanged, so the phone counts down a member's question too.
    expect(fromPeer?.asks?.[0]?.expiresAt).toBe("2026-10-15T10:04:00.000Z");
  });

  test("a pane without asks still parses and merges, and gains no asks key (an old peer)", () => {
    const old = pane({ paneId: "w1:p1", status: "blocked" });
    const parsed = parsePeerSnapshot({ sessions: [session({ name: "default" })], agents: [old], shellPanes: [] });
    expect(parsed?.agents).toHaveLength(1);
    expect("asks" in (parsed?.agents[0] ?? {})).toBe(false);
    const merged = mergeSnapshot(localBody(), {
      self: { id: "lead", name: "lead" },
      peers: [contribution({ state: state({ memberId: "laptop" }), body: parsed })],
      now: NOW,
    });
    for (const p of merged.agents) expect("asks" in p).toBe(false);
  });

  test("the lead's merge passes a pane's subtitle and badge through, and an old peer's pane has neither", () => {
    const durable = pane({ paneId: "conv-03", agent: "durable", status: "idle", subtitle: "helping ticket 4", badge: { count: 2 }, progress: { kind: "percent", value: 50 } });
    const old = pane({ paneId: "w1:p1", status: "idle" });
    const parsed = parsePeerSnapshot({ sessions: [session({ name: "default" })], agents: [durable, old], shellPanes: [] });
    expect(parsed?.agents[0]?.subtitle).toBe("helping ticket 4");
    const merged = mergeSnapshot(localBody(), {
      self: { id: "lead", name: "lead" },
      peers: [contribution({ state: state({ memberId: "laptop" }), body: parsed })],
      now: NOW,
    });
    const fromPeer = merged.agents.find((p) => p.paneId === "conv-03");
    expect(fromPeer?.host).toBe("laptop");
    expect(fromPeer?.subtitle).toBe("helping ticket 4");
    expect(fromPeer?.badge).toEqual({ count: 2 });
    expect(fromPeer?.progress).toEqual({ kind: "percent", value: 50 });
    const plain = merged.agents.find((p) => p.paneId === "w1:p1");
    expect("subtitle" in (plain ?? {})).toBe(false);
    expect("badge" in (plain ?? {})).toBe(false);
    expect("progress" in (plain ?? {})).toBe(false);
  });

  test("the lead's merge passes a pane's turnId through beside its asks (ADR 0101), and an old peer's pane has none", () => {
    const durable = pane({ paneId: "conv-02", agent: "durable", status: "blocked", asks: [ask], turnId: "turn-02-a" });
    const old = pane({ paneId: "w1:p1", status: "idle" });
    const parsed = parsePeerSnapshot({ sessions: [session({ name: "default" })], agents: [durable, old], shellPanes: [] });
    expect(parsed?.agents[0]?.turnId).toBe("turn-02-a");
    const merged = mergeSnapshot(localBody(), {
      self: { id: "lead", name: "lead" },
      peers: [contribution({ state: state({ memberId: "laptop" }), body: parsed })],
      now: NOW,
    });
    const fromPeer = merged.agents.find((p) => p.paneId === "conv-02");
    expect(fromPeer?.host).toBe("laptop");
    expect(fromPeer?.turnId).toBe("turn-02-a");
    expect(fromPeer?.asks).toEqual([ask]);
    expect("turnId" in (merged.agents.find((p) => p.paneId === "w1:p1") ?? {})).toBe(false);
  });
});
