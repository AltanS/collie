import { describe, expect, test } from "bun:test";

import type { SnapshotResponse } from "../types.ts";
import { member } from "./fixtures.ts";
import {
  dueForProbe,
  foldPeerMemory,
  incompatibleBackoffMs,
  INCOMPATIBLE_BACKOFF_MS,
  PackLead,
  type PeerMemory,
} from "./lead.ts";
import type { PackLink, PeerOutcome } from "./peer-client.ts";
import { PackRegistry } from "./registry.ts";
import type { TrustedMember } from "./trust-store.ts";

// The sweep and what it remembers. The registry owns a peer's HEALTH (M4/03); this class owns the
// last-good BODY, which is what makes §10.2's "a peer's sessions never vanish" mechanical.

const NOW = 1_754_000_000_000;

const body = {
  sessions: [{ name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0 }],
  agents: [
    {
      paneId: "w1:p1",
      workspaceId: "w1",
      workspaceLabel: "collie",
      workspaceNumber: 1,
      tabId: "w1:t1",
      agent: "claude",
      status: "blocked",
      cwd: "/home/you",
      focused: false,
      kind: "agent",
    },
  ],
  shellPanes: [],
};

function ok(value: unknown, at = NOW): PeerOutcome<unknown> {
  return { ok: true, value, status: 200, member: null, receivedAt: at };
}
const down: PeerOutcome<unknown> = { ok: false, state: "unreachable", reason: "timed out", receivedAt: NOW };
const skewed: PeerOutcome<unknown> = {
  ok: false,
  state: "incompatible",
  reason: "peer answered protocol 2",
  expected: 1,
  received: 2,
  receivedAt: NOW,
};

function localBody(): SnapshotResponse {
  return {
    bridge: "connected",
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [{ name: "default", isPrimary: true, reachable: true, agents: 0, working: 0, blocked: 0 }],
    ts: NOW,
  };
}

/** A lead over `members`, with a scripted per-call outcome and a call log. */
function lead(members: TrustedMember[], script: (link: PackLink, call: number) => PeerOutcome<unknown>) {
  const roster = [...members];
  const calls: string[] = [];
  let clock = NOW;
  const registry = new PackRegistry({
    sessions: { get: () => undefined },
    self: "desk",
    members: () => roster,
  });
  const l = new PackLead({
    registry,
    snapshot: async (link) => {
      calls.push(link.memberId);
      return script(link, calls.filter((c) => c === link.memberId).length);
    },
    self: { id: "desk", name: "the herd" },
    now: () => clock,
  });
  return {
    lead: l,
    registry,
    calls,
    roster,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

// ── No second timer ──────────────────────────────────────────────────────────

describe("PackLead — the sweep rides the lead's poll, it does not arm a timer", () => {
  test("constructing one dials nothing; only sweep() does", async () => {
    const h = lead([member({ memberId: "laptop" })], () => ok(body));
    // §10.1/§11: the sweep is a part of the existing poll. If this class armed anything, this
    // assertion would be the only thing standing between a solo build and a second timer.
    await Bun.sleep(5);
    expect(h.calls).toEqual([]);
    await h.lead.sweep();
    expect(h.calls).toEqual(["laptop"]);
  });

  test("no peers ⇒ no call at all, however often it is swept", async () => {
    const h = lead([], () => ok(body));
    await h.lead.sweep();
    await h.lead.sweep();
    expect(h.calls).toEqual([]);
    // And no `servers` shape is invented for a lead with nobody enrolled.
    expect(h.lead.contributions()).toEqual([]);
  });

  test("a second sweep while one is in flight is refused, not queued", async () => {
    const h = lead([member({ memberId: "laptop" })], () => ok(body));
    const first = h.lead.sweep();
    await h.lead.sweep(); // returns immediately — the freshest answer is the only one that matters
    await first;
    expect(h.calls).toEqual(["laptop"]);
  });

  test("peers are dialled concurrently, not serially (§10.1)", async () => {
    const started: number[] = [];
    const h = lead([member({ memberId: "a" }), member({ memberId: "b" }), member({ memberId: "c" })], () => {
      started.push(Date.now());
      return ok(body);
    });
    await h.lead.sweep();
    expect(h.calls.sort()).toEqual(["a", "b", "c"]);
    expect(Math.max(...started) - Math.min(...started)).toBeLessThan(50);
  });

  test("a transport that throws degrades the pack, it does not take the poll loop down", async () => {
    const registry = new PackRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => [member({ memberId: "laptop" })] });
    const l = new PackLead({
      registry,
      snapshot: () => Promise.reject(new Error("boom")),
      self: { id: "desk", name: "the herd" },
    });
    await expect(l.sweep()).resolves.toBeUndefined();
    // And it can be swept again — the in-flight guard was released.
    await expect(l.sweep()).resolves.toBeUndefined();
  });
});

// ── Stale never vanishes ─────────────────────────────────────────────────────

describe("PackLead — a peer's sessions never vanish (§10.2)", () => {
  test("a failed poll after a good one keeps the last-good body and the last-good clock", async () => {
    const h = lead([member({ memberId: "laptop" })], (_l, call) => (call === 1 ? ok(body) : down));
    await h.lead.sweep();
    expect(h.lead.contributions()[0]!.body?.agents).toHaveLength(1);

    h.advance(30_000);
    await h.lead.sweep();
    const c = h.lead.contributions()[0]!;
    expect(c.state.health).toBe("unreachable");
    // The registry kept the timestamp of the LAST GOOD call — never cleared by a failure.
    expect(c.state.lastSeenAt).toBe(NOW);
    expect(c.body?.agents).toHaveLength(1);

    const merged = h.lead.merge(localBody());
    expect(merged.agents.map((p) => p.host)).toEqual(["laptop"]);
    expect(merged.servers!.find((s) => s.id === "laptop")!.reachable).toBe(false);
  });

  test("a 200 whose body will not parse keeps the old body rather than emptying the list", async () => {
    const h = lead([member({ memberId: "laptop" })], (_l, call) => (call === 1 ? ok(body) : ok({ nonsense: true })));
    await h.lead.sweep();
    await h.lead.sweep();
    expect(h.lead.contributions()[0]!.body?.agents).toHaveLength(1);
  });

  test("a member dropped from the roster stops existing — body and health both", async () => {
    const h = lead([member({ memberId: "laptop" })], () => ok(body));
    await h.lead.sweep();
    expect(h.lead.contributions()).toHaveLength(1);

    h.roster.length = 0; // `collie leave`, a revocation, or a rotation that dropped it
    await h.lead.sweep();
    expect(h.lead.contributions()).toEqual([]);
    expect(h.lead.merge(localBody()).servers).toEqual([
      { id: "desk", name: "the herd", isLead: true, reachable: true, protocol: "ok", lastSeenAt: NOW },
    ]);
  });
});

// ── Incompatible: a slow backoff, not the cadence ────────────────────────────

describe("PackLead — an incompatible peer is probed on a slow backoff (§10.2)", () => {
  test("it is skipped on the next poll tick, and re-probed once the backoff elapses", async () => {
    const h = lead([member({ memberId: "laptop" })], () => skewed);
    await h.lead.sweep();
    expect(h.calls).toHaveLength(1);

    // The lead's poll keeps ticking at 1.5 s. A version skew cannot resolve on its own, so those
    // ticks must not become round trips.
    h.advance(1_500);
    await h.lead.sweep();
    h.advance(1_500);
    await h.lead.sweep();
    expect(h.calls).toHaveLength(1);

    h.advance(INCOMPATIBLE_BACKOFF_MS[0]!);
    await h.lead.sweep();
    expect(h.calls).toHaveLength(2);
  });

  test("an UNREACHABLE peer stays on the cadence — a cable is not a version", async () => {
    const h = lead([member({ memberId: "laptop" })], () => down);
    await h.lead.sweep();
    h.advance(1_500);
    await h.lead.sweep();
    h.advance(1_500);
    await h.lead.sweep();
    expect(h.calls).toHaveLength(3);
  });

  test("the backoff lengthens with each consecutive refusal and clears on any other outcome", () => {
    expect(incompatibleBackoffMs(1)).toBe(INCOMPATIBLE_BACKOFF_MS[0]!);
    expect(incompatibleBackoffMs(2)).toBe(INCOMPATIBLE_BACKOFF_MS[1]!);
    expect(incompatibleBackoffMs(99)).toBe(INCOMPATIBLE_BACKOFF_MS[INCOMPATIBLE_BACKOFF_MS.length - 1]!);
    expect(incompatibleBackoffMs(0)).toBe(INCOMPATIBLE_BACKOFF_MS[0]!);

    let m: PeerMemory = foldPeerMemory(undefined, skewed, NOW);
    expect(m.probeAfter).toBe(NOW + INCOMPATIBLE_BACKOFF_MS[0]!);
    m = foldPeerMemory(m, skewed, NOW);
    expect(m.probeAfter).toBe(NOW + INCOMPATIBLE_BACKOFF_MS[1]!);
    m = foldPeerMemory(m, down, NOW);
    expect(m).toEqual({ body: null, incompatibleRuns: 0, probeAfter: 0 });
  });

  test("dueForProbe: an unknown member is always due; only a backoff defers one", () => {
    expect(dueForProbe(undefined, NOW)).toBe(true);
    expect(dueForProbe({ body: null, incompatibleRuns: 0, probeAfter: 0 }, NOW)).toBe(true);
    expect(dueForProbe({ body: null, incompatibleRuns: 1, probeAfter: NOW + 1 }, NOW)).toBe(false);
    expect(dueForProbe({ body: null, incompatibleRuns: 1, probeAfter: NOW }, NOW)).toBe(true);
  });
});

// ── The fold, as data ────────────────────────────────────────────────────────

describe("foldPeerMemory — the three states as a pure function", () => {
  test("success replaces the body and clears any backoff", () => {
    const prev: PeerMemory = { body: null, incompatibleRuns: 3, probeAfter: NOW + 600_000 };
    const next = foldPeerMemory(prev, ok(body), NOW);
    expect(next.body?.agents).toHaveLength(1);
    expect(next).toMatchObject({ incompatibleRuns: 0, probeAfter: 0 });
  });

  test("no outcome of any kind ever clears a body it did not replace", () => {
    const seeded = foldPeerMemory(undefined, ok(body), NOW);
    for (const outcome of [down, skewed, ok("not a snapshot"), ok(null)]) {
      expect(foldPeerMemory(seeded, outcome, NOW).body).toBe(seeded.body!);
    }
  });
});
