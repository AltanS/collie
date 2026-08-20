import { describe, expect, test } from "bun:test";

import type { SnapshotResponse } from "../types.ts";
import { member, neverProxy } from "./fixtures.ts";
import {
  dueForProbe,
  foldPeerMemory,
  incompatibleBackoffMs,
  INCOMPATIBLE_BACKOFF_MS,
  PackLead,
  type PeerMemory,
} from "./lead.ts";
import type { PackLink, PeerOutcome } from "./peer-client.ts";
import { PackRegistry, type PeerState } from "./registry.ts";
import type { TrustedMember, Warrant } from "./trust-store.ts";

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

/** The `kind: "peer"` half of what {@link PackLead.resolve} returns: a link and its liveness. */
interface ResolvedPeer {
  link: PackLink;
  state: PeerState;
}

function ok<T>(value: T, at = NOW): PeerOutcome<T> {
  return { ok: true, value, status: 200, member: null, receivedAt: at, date: null };
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
function lead(
  members: TrustedMember[],
  script: (link: PackLink, call: number) => PeerOutcome<unknown>,
  opts: { hello?: (link: PackLink) => Promise<PeerOutcome<{ readonly version: string | null }>> } = {},
) {
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
    proxy: neverProxy,
    hello: opts.hello,
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
    expect(h.calls.toSorted()).toEqual(["a", "b", "c"]);
    expect(Math.max(...started) - Math.min(...started)).toBeLessThan(50);
  });

  test("a transport that throws degrades the pack, it does not take the poll loop down", async () => {
    const registry = new PackRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => [member({ memberId: "laptop" })] });
    const l = new PackLead({
      registry,
      snapshot: () => Promise.reject(new Error("boom")),
      proxy: neverProxy,
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

// ── Fresh bodies only (M4/06) ────────────────────────────────────────────────

describe("PackLead — what it hands the notifier", () => {
  /** A lead whose peer answers a scripted sequence, recording every fresh-body / gone callback. */
  function withNotifier(members: TrustedMember[], script: (link: PackLink, call: number) => PeerOutcome<unknown>) {
    const roster = [...members];
    const calls: string[] = [];
    const fresh: { memberId: string; blocked: number }[] = [];
    const gone: string[] = [];
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
      proxy: neverProxy,
      self: { id: "desk", name: "the herd" },
      onPeerSnapshot: (memberId, b) =>
        fresh.push({ memberId, blocked: b.agents.filter((a) => a.status === "blocked").length }),
      onPeerGone: (memberId) => gone.push(memberId),
      now: () => clock,
    });
    // Sweeping past an incompatible verdict needs the clock to clear its backoff — the sweep is the
    // lead's poll, and a poll happens on a wall clock this test owns.
    return {
      lead: l,
      fresh,
      gone,
      roster,
      sweep: async () => {
        clock += 15 * 60_000;
        await l.sweep();
      },
    };
  }

  test("a poll that parsed a body offers it; one that did not offers nothing", async () => {
    const idle = { ...body, agents: [{ ...body.agents[0]!, status: "working" }] };
    const script = (_l: PackLink, call: number) =>
      call === 1 ? ok(body) : call === 2 ? down : call === 3 ? skewed : call === 4 ? ok("garbage") : ok(idle);
    const { fresh, sweep } = withNotifier([member({ memberId: "laptop" })], script);

    for (let i = 0; i < 5; i++) await sweep();

    // Calls 2–4 (unreachable / incompatible / unparseable) all RETAIN the last-good body — offering
    // it again would replay hour-old blocks onto the phone the moment a peer came back.
    expect(fresh).toEqual([
      { memberId: "laptop", blocked: 1 },
      { memberId: "laptop", blocked: 0 },
    ]);
  });

  test("an unchanged peer still offers a body each poll — the diff, not this class, dedupes", async () => {
    const { fresh, sweep } = withNotifier([member({ memberId: "laptop" })], () => ok(body));
    await sweep();
    await sweep();
    expect(fresh).toHaveLength(2);
  });

  test("a member the registry drops is reported gone, once", async () => {
    const { gone, roster, sweep } = withNotifier([member({ memberId: "laptop" })], () => ok(body));
    await sweep();
    expect(gone).toEqual([]);

    roster.length = 0; // `collie leave` / revocation / rotation
    await sweep();
    await sweep();
    expect(gone).toEqual(["laptop"]);
  });
});

describe("forward — the lead's per-pane hop (M4/05)", () => {
  test("it delegates to the injected transport and answers with the peer's own response", async () => {
    const registry = new PackRegistry({
      sessions: { get: () => undefined },
      self: "desk",
      members: () => [member({ memberId: "laptop" })],
    });
    const dials: string[] = [];
    const packLead = new PackLead({
      registry,
      snapshot: async () => ({ ok: false, state: "unreachable", reason: "unused", receivedAt: 0 }),
      proxy: async (_link, route) => {
        dials.push(route);
        return {
          ok: true,
          value: new Response(`{"lines":["hi"]}`, { status: 200, headers: { etag: '"peer"' } }),
          status: 200,
          date: null,
          member: "laptop",
          receivedAt: 1,
        };
      },
      self: { id: "desk", name: "the herd" },
    });

    const url = new URL("https://lead.example/api/pane/w1:p1?host=laptop");
    const resolved = packLead.resolve({ kind: "member", id: "laptop" });
    expect(resolved?.kind).toBe("peer");
    // SAFETY: `resolved.kind` is asserted to be "peer" on the line above, which is the variant that
    // carries the link + state pair.
    const res = await packLead.forward(new Request(url), url, resolved as ResolvedPeer);

    expect(dials).toEqual(["pane/w1:p1"]);
    expect(res.status).toBe(200);
    // The peer's ETag, not one this build computed — the lead adds nothing (§9.1).
    expect(res.headers.get("etag")).toBe('"peer"');
    expect(await res.json()).toEqual({ lines: ["hi"] });
  });
});

// ── §10.2: the sweep is the floor, not the only receipt ──────────────────────

describe("a landed forward refreshes the receipt (§10.2)", () => {
  /** A lead whose sweep and whose forwards are each scripted, sharing one registry. */
  function fed(sweepScript: () => PeerOutcome<unknown>, proxyScript: () => PeerOutcome<Response>) {
    const registry = new PackRegistry({
      sessions: { get: () => undefined },
      self: "desk",
      members: () => [member({ memberId: "laptop" })],
    });
    const l = new PackLead({
      registry,
      snapshot: async () => sweepScript(),
      proxy: async () => proxyScript(),
      self: { id: "desk", name: "the herd" },
      now: () => NOW,
    });
    return {
      lead: l,
      seen: () => registry.state("laptop").lastSeenAt,
      health: () => registry.state("laptop").health,
      read: async () => {
        const url = new URL("https://lead.example/api/pane/w1:p1?host=laptop");
        const resolved = l.resolve({ kind: "member", id: "laptop" });
        // SAFETY: "laptop" is the sole enrolled member and is not `self`, so `resolve` returns the
        // `peer` variant — the one carrying the link + state pair.
        await l.forward(new Request(url), url, resolved as ResolvedPeer);
      },
    };
  }

  /** A peer answering a proxied read at `at` on the LEAD's clock. */
  function answered(at: number): PeerOutcome<Response> {
    return { ok: true, value: new Response("{}"), status: 200, member: "laptop", receivedAt: at, date: null };
  }

  test("a phone's own read of a peer pane stamps lastSeenAt, without waiting for a sweep", async () => {
    // The bug this pins: the sweep relaxes to the idle cadence (12 s) while a phone watching this
    // pane polls at 1.5 s, so a receipt only the sweep refreshed aged past 3 × pollMs and the phone
    // called a peer that was answering every request "unreachable".
    const h = fed(() => ok(body), () => answered(NOW + 3_000));
    await h.lead.sweep();
    expect(h.seen()).toBe(NOW);

    await h.read();
    expect(h.seen()).toBe(NOW + 3_000);
    expect(h.health()).toBe("reachable");
  });

  test("lastSeenAt only moves forward — a forward that lands out of order never rewinds it", async () => {
    let at = NOW + 5_000;
    const h = fed(() => ok(body), () => answered(at));
    await h.lead.sweep();
    await h.read();
    expect(h.seen()).toBe(NOW + 5_000);

    // Reads are concurrent by nature and may land out of order. An older receipt is not news.
    at = NOW + 1_000;
    await h.read();
    expect(h.seen()).toBe(NOW + 5_000);
  });

  test("a FAILED forward changes nothing — classification stays the sweep's and the probe's", async () => {
    const h = fed(
      () => ok(body),
      () => ({ ok: false, state: "unreachable", reason: "timed out", attempted: true, receivedAt: NOW + 9_000 }),
    );
    await h.lead.sweep();
    await h.read();
    // Not "unreachable" from this path: the forward runs on a different budget, and two code paths
    // deciding what that word means is exactly what §10.2's single classifier exists to prevent.
    expect(h.health()).toBe("reachable");
    expect(h.seen()).toBe(NOW);
  });

  test("a landed forward does not revive a member the sweep believes down", async () => {
    let sweepOk = true;
    const h = fed(
      () => (sweepOk ? ok(body) : down),
      () => answered(NOW + 7_000),
    );
    await h.lead.sweep();
    sweepOk = false;
    await h.lead.sweep();
    expect(h.health()).toBe("unreachable");

    // A read still forwards (only writes are refused before attempt, §10.3) and may even succeed —
    // but the verdict is the sweep's, and it clears on the next tick anyway.
    await h.read();
    expect(h.health()).toBe("unreachable");
    expect(h.seen()).toBe(NOW);
  });
});

// ── §10.4: the verdict probe ─────────────────────────────────────────────────

describe("a sweep that died on its own clock earns a patient re-ask (§10.4)", () => {
  /** The sweep outcome the DERP finding produces: our own budget fired, the peer said nothing. */
  const budgetMissed: PeerOutcome<unknown> = {
    ok: false,
    state: "unreachable",
    reason: "snapshot: timed out after 1200ms",
    timedOut: true,
    receivedAt: NOW,
  };
  const helloOk: PeerOutcome<{ version: string | null }> = {
    ok: true,
    value: { version: "1.0.0" },
    status: 200,
    member: "laptop",
    receivedAt: NOW,
    date: null,
  };

  test("the probe's answer turns a slow member back into a reachable one", async () => {
    const probed: string[] = [];
    const h = lead([member({ memberId: "laptop" })], (_l, call) => (call === 1 ? ok(body) : budgetMissed), {
      hello: (link) => {
        probed.push(link.memberId);
        return Promise.resolve(helloOk);
      },
    });
    await h.lead.sweep(); // a good poll first, so there is a real `lastSeenAt` to protect
    await h.lead.sweep(); // …then the timeout that produced the live "unreachable forever"

    await Bun.sleep(5); // the probe is never awaited by the sweep — that is the point of it
    expect(probed).toEqual(["laptop"]);
    const state = h.registry.state("laptop");
    expect(state.health).toBe("reachable");
    expect(state.version).toBe("1.0.0");
    // Reachable, but NOT refreshed: the phone still renders this peer's panes as stale.
    expect(state.lastSeenAt).toBe(NOW);
  });

  test("a failure that is NOT our own clock is never re-asked slowly", async () => {
    // A refusal, a reset or a DNS failure is an answer from the world. Asking it again patiently
    // would only be slower, and would spend the patient budget on a peer that already answered.
    const probed: string[] = [];
    const h = lead([member({ memberId: "laptop" })], () => down, {
      hello: (link) => {
        probed.push(link.memberId);
        return Promise.resolve(helloOk);
      },
    });
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(probed).toEqual([]);
  });

  test("at most one probe per member is in flight, however many ticks time out", async () => {
    // The patient budget outlasts several polls. One probe per tick would turn a slow peer into a
    // fan-out of dials at exactly the moment the link is least able to carry them.
    let resolveHello: (v: PeerOutcome<{ version: string | null }>) => void = () => {};
    const probed: string[] = [];
    const h = lead([member({ memberId: "laptop" })], () => budgetMissed, {
      hello: (link) => {
        probed.push(link.memberId);
        return new Promise((resolve) => {
          resolveHello = resolve;
        });
      },
    });
    await h.lead.sweep();
    await h.lead.sweep();
    await h.lead.sweep();
    expect(probed).toEqual(["laptop"]);

    resolveHello(helloOk);
    await Bun.sleep(5);
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(probed).toEqual(["laptop", "laptop"]);
  });

  test("a probe that lands after the member is gone does not resurrect its row", async () => {
    let resolveHello: (v: PeerOutcome<{ version: string | null }>) => void = () => {};
    const h = lead([member({ memberId: "laptop" })], () => budgetMissed, {
      hello: () =>
        new Promise((resolve) => {
          resolveHello = resolve;
        }),
    });
    await h.lead.sweep();
    h.roster.length = 0; // a `leave` mid-flight
    await h.lead.sweep();
    resolveHello(helloOk);
    await Bun.sleep(5);
    expect(h.registry.list()).toEqual([]);
  });

  test("a lead wired without a probe keeps the pre-amendment behaviour", async () => {
    const h = lead([member({ memberId: "laptop" })], () => budgetMissed);
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.registry.state("laptop").health).toBe("unreachable");
  });
});

// ── Warrant distribution rides the same sweep (§18, RFC §5) ──────────────────

describe("PackLead — the warrant re-push, on the sweep the lead already runs", () => {
  const WARRANT: Warrant = {
    packId: "pack-1",
    generation: 2,
    deputyMemberId: "nas",
    deputyFingerprint: "a".repeat(64),
    leadMemberId: "desk",
    issuedAt: NOW,
    refreshedAt: NOW,
    signature: "sig",
  };

  /** A lead whose members answer `report` on `snapshot`, with a scripted warrant distribution. */
  function distributing(
    reports: Record<string, { warrantGeneration?: number; warrantRefreshedAt?: number }>,
    opts: { warrant?: Warrant | null; push?: () => Promise<PeerOutcome<unknown>>; reachable?: boolean } = {},
  ) {
    const pushed: string[] = [];
    let currents = 0;
    const members = Object.keys(reports).map((memberId) => member({ memberId }));
    const l = new PackLead({
      registry: new PackRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => members }),
      snapshot: async (link) =>
        opts.reachable === false ? down : ok({ ...body, ...reports[link.memberId] }),
      proxy: neverProxy,
      self: { id: "desk", name: "the herd" },
      now: () => NOW,
      warrant: {
        current: async () => {
          currents += 1;
          const held = opts.warrant === undefined ? WARRANT : opts.warrant;
          return held === null ? null : { warrant: held, deputyCertPem: "PEM" };
        },
        push: async (link) => {
          pushed.push(link.memberId);
          return opts.push === undefined ? ok(null) : opts.push();
        },
      },
    });
    return { lead: l, pushed, currents: () => currents };
  }

  test("a member reporting NOTHING is pushed — absent is never read as up to date", async () => {
    const h = distributing({ laptop: {} });
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.pushed).toEqual(["laptop"]);
  });

  test("a member at this exact generation and refresh is NOT dialled again", async () => {
    const h = distributing({ laptop: { warrantGeneration: 2, warrantRefreshedAt: NOW } });
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.pushed).toEqual([]);
  });

  test("a member behind on the generation, or on the refresh, is pushed", async () => {
    const behind = distributing({
      old: { warrantGeneration: 1, warrantRefreshedAt: NOW },
      stale: { warrantGeneration: 2, warrantRefreshedAt: NOW - 1 },
      current: { warrantGeneration: 2, warrantRefreshedAt: NOW },
    });
    await behind.lead.sweep();
    await Bun.sleep(5);
    expect(behind.pushed.toSorted()).toEqual(["old", "stale"]);
  });

  test("a member that did NOT answer is skipped — it has told us nothing about what it holds", async () => {
    const h = distributing({ laptop: {} }, { reachable: false });
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.pushed).toEqual([]);
  });

  test("a lead that has named nobody moves not one byte", async () => {
    const h = distributing({ laptop: {} }, { warrant: null });
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.pushed).toEqual([]);
  });

  test("the warrant is read ONCE per sweep, not once per member", async () => {
    const h = distributing({ a: {}, b: {}, c: {} });
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.currents()).toBe(1);
    expect(h.pushed.toSorted()).toEqual(["a", "b", "c"]);
  });

  test("at most one push per member is in flight, however many sweeps run", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = distributing(
      { laptop: {} },
      {
        push: async () => {
          await held;
          return ok(null);
        },
      },
    );
    await h.lead.sweep();
    await h.lead.sweep();
    await h.lead.sweep();
    expect(h.pushed).toEqual(["laptop"]);
    release();
    await Bun.sleep(5);
  });

  test("a push that THROWS is contained — the sweep is not the place a transport bug lands", async () => {
    const h = distributing({ laptop: {} }, { push: () => Promise.reject(new Error("boom")) });
    await h.lead.sweep();
    await Bun.sleep(5);
    // The sweep still recorded the member's health: distribution is a rider, never the point.
    expect(h.pushed).toEqual(["laptop"]);
  });

  test("a lead wired WITHOUT distribution pushes nothing at all", async () => {
    const h = lead([member({ memberId: "laptop" })], () => ok(body));
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.calls).toEqual(["laptop"]);
  });
});

// ── The pairing sync's two decided outcomes (RFC §6.5, §18.14) ────────────────

describe("PackLead — a refused pairing sync is REPORTED, never swallowed", () => {
  const sync = { packId: "pack-1", leadMemberId: "desk", devices: [] };

  /** A lead syncing its registry to `deputy`, with a scripted answer from that deputy. */
  function syncing(deputy: string | null, answer: () => PeerOutcome<unknown>) {
    const said: (readonly string[] | null)[] = [];
    const members = [member({ memberId: "laptop" })];
    const l = new PackLead({
      registry: new PackRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => members }),
      snapshot: async () => ok(body),
      proxy: neverProxy,
      self: { id: "desk", name: "the herd" },
      now: () => NOW,
      pairing: {
        deputy: () => deputy,
        current: () => ({ sync, digest: "d1" }),
        push: async () => answer(),
        collision: (labels) => void said.push(labels),
      },
    });
    return { lead: l, said };
  }

  const collision = (labels: readonly string[]): PeerOutcome<unknown> => ({
    ok: false,
    state: "refused",
    reason: "pairing: this machine already has paired devices called \"phone\"",
    code: "pairing_label_collision",
    status: 409,
    labels,
    receivedAt: NOW,
  });

  test("the labels the deputy named are carried out of the sweep, verbatim", async () => {
    const h = syncing("laptop", () => collision(["phone", "tablet"]));
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.said).toEqual([["phone", "tablet"]]);
  });

  test("a sync that LANDS clears the finding — the operator's rename needs no verb", async () => {
    const h = syncing("laptop", () => ok(null));
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.said).toEqual([null]);
  });

  test("a deputy that could not be reached reports NOTHING — silence is not a collision", async () => {
    const h = syncing("laptop", () => down);
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.said).toEqual([]);
  });

  test("a refusal is re-offered: only a landed sync is remembered as delivered", async () => {
    const h = syncing("laptop", () => collision(["phone"]));
    await h.lead.sweep();
    await Bun.sleep(5);
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.said).toEqual([["phone"], ["phone"]]);
  });

  test("a pack with no deputy syncs to nobody and reports nothing", async () => {
    const h = syncing(null, () => ok(null));
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.said).toEqual([]);
  });

  // ── THE LIVE DRILL, BUG 4 ──────────────────────────────────────────────────
  // The decision used to be a process-local memory of what this lead had pushed, and `pack deputy`
  // restarts the local bridge as its last step — so the process that knew it still owed a sync was
  // replaced by one that had never offered it, and nothing ever asked the deputy. It is now the
  // deputy's OWN report, on an exchange that already happens, exactly as the warrant's is.
  describe("the deputy's own report decides the push, not something this process remembers", () => {
    /** A lead whose deputy answers its snapshot with `pairingDigest`, or without one. */
    function reporting(reported: string | null) {
      const pushes: string[] = [];
      const members = [member({ memberId: "laptop" })];
      const answer = reported === null ? body : { ...body, pairingDigest: reported };
      const l = new PackLead({
        registry: new PackRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => members }),
        snapshot: async () => ok(answer),
        proxy: neverProxy,
        self: { id: "desk", name: "the herd" },
        now: () => NOW,
        pairing: {
          deputy: () => "laptop",
          current: () => ({ sync, digest: "d1" }),
          push: async () => {
            pushes.push("laptop");
            return ok(null);
          },
        },
      });
      return { lead: l, pushes };
    }

    test("a deputy REPORTING NOTHING is pushed to — absent means nothing synced, never up to date", async () => {
      const h = reporting(null);
      await h.lead.sweep();
      await Bun.sleep(5);
      expect(h.pushes).toEqual(["laptop"]);
    });

    test("a deputy reporting a DIFFERENT digest is pushed to", async () => {
      const h = reporting("d0");
      await h.lead.sweep();
      await Bun.sleep(5);
      expect(h.pushes).toEqual(["laptop"]);
    });

    test("a deputy reporting the SAME digest costs no dial, on this sweep or any other", async () => {
      const h = reporting("d1");
      await h.lead.sweep();
      await Bun.sleep(5);
      await h.lead.sweep();
      await Bun.sleep(5);
      expect(h.pushes).toEqual([]);
    });

    test("a FRESH PackLead re-offers to a deputy that still reports nothing — a restart forgets nothing", async () => {
      // The regression, stated as the property that closes it: this lead has never pushed anything,
      // and it does not need to have, because the answer is on the wire.
      const first = reporting(null);
      await first.lead.sweep();
      await Bun.sleep(5);
      const second = reporting(null);
      await second.lead.sweep();
      await Bun.sleep(5);
      expect(second.pushes).toEqual(["laptop"]);
    });
  });

  test("a failing WARRANT half never takes the pairing half down with it", async () => {
    // They used to share one try/catch, so a store write failing in the warrant refresh silently
    // skipped the sync on every sweep thereafter. Neither is the other's precondition.
    const pushes: string[] = [];
    const members = [member({ memberId: "laptop" })];
    const l = new PackLead({
      registry: new PackRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => members }),
      snapshot: async () => ok(body),
      proxy: neverProxy,
      self: { id: "desk", name: "the herd" },
      now: () => NOW,
      warrant: {
        current: () => Promise.reject(new Error("boom")),
        push: async () => ok(null),
      },
      pairing: {
        deputy: () => "laptop",
        current: () => ({ sync, digest: "d1" }),
        push: async () => {
          pushes.push("laptop");
          return ok(null);
        },
      },
    });
    await l.sweep();
    await Bun.sleep(5);
    expect(pushes).toEqual(["laptop"]);
  });
});
