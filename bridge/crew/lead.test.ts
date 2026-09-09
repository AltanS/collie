import { describe, expect, test } from "bun:test";

import type { SnapshotView } from "../sessions.ts";
import type { MuxConfig, SnapshotResponse } from "../types.ts";
import type { PeerPreflight } from "../update-action.ts";
import { member, muxCaps, neverProxy } from "./fixtures.ts";
import { NARROW_PLAN, snapshotPlan, SWEEP_VIEW, type PeerSnapshotWire } from "./merge.ts";
import {
  clearPeerBackoff,
  CONTACT_RESET_FLOOR_MS,
  dueForProbe,
  foldPeerMemory,
  incompatibleBackoffMs,
  INCOMPATIBLE_BACKOFF_MS,
  MAX_CONTACT_RESETS,
  CrewLead,
  type PeerMemory,
} from "./lead.ts";
import type { CrewLink, PeerOutcome } from "./peer-client.ts";
import { TURN_MISSED_SWEEPS, UpdateTurns } from "./follow.ts";
import { CrewRegistry, type PeerState } from "./registry.ts";
import type { TrustedMember, Warrant } from "./trust-store.ts";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../uploads.ts";

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

/** The `kind: "peer"` half of what {@link CrewLead.resolve} returns: a link and its liveness. */
interface ResolvedPeer {
  link: CrewLink;
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
  script: (link: CrewLink, call: number) => PeerOutcome<unknown>,
  opts: {
    hello?: (
      link: CrewLink,
    ) => Promise<PeerOutcome<{ readonly version: string | null; readonly mux?: MuxConfig | null }>>;
    turns?: UpdateTurns;
  } = {},
) {
  const roster = [...members];
  const calls: string[] = [];
  const journal: string[] = [];
  let clock = NOW;
  const registry = new CrewRegistry({
    sessions: { get: () => undefined },
    self: "desk",
    members: () => roster,
  });
  const l = new CrewLead({
    log: (line) => journal.push(line),
    registry,
    snapshot: async (link) => {
      calls.push(link.memberId);
      return script(link, calls.filter((c) => c === link.memberId).length);
    },
    proxy: neverProxy,
    hello: opts.hello,
    self: { id: "desk", name: "the herd" },
    maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
    now: () => clock,
    follow:
      opts.turns === undefined
        ? undefined
        : {
            leadRelease: () => "1.4.1",
            turns: opts.turns,
            enrolledAt: (id) => roster.find((m) => m.memberId === id)?.enrolledAt ?? 0,
          },
  });
  return {
    lead: l,
    registry,
    calls,
    journal,
    roster,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

// ── No second timer ──────────────────────────────────────────────────────────

describe("CrewLead — the sweep rides the lead's poll, it does not arm a timer", () => {
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

  test("a transport that throws degrades the crew, it does not take the poll loop down", async () => {
    const registry = new CrewRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => [member({ memberId: "laptop" })] });
    const l = new CrewLead({
      log: () => {},
      registry,
      snapshot: () => Promise.reject(new Error("boom")),
      proxy: neverProxy,
      self: { id: "desk", name: "the herd" },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
    });
    await expect(l.sweep()).resolves.toBeUndefined();
    // And it can be swept again — the in-flight guard was released.
    await expect(l.sweep()).resolves.toBeUndefined();
  });
});

// ── Stale never vanishes ─────────────────────────────────────────────────────

describe("CrewLead — a peer's sessions never vanish (§10.2)", () => {
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

    const merged = h.lead.merge(localBody(), NARROW_PLAN);
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
    expect(h.lead.merge(localBody(), NARROW_PLAN).servers).toEqual([
      { id: "desk", name: "the herd", isLead: true, reachable: true, protocol: "ok", lastSeenAt: NOW },
    ]);
  });
});

// ── Incompatible: a slow backoff, not the cadence ────────────────────────────

describe("CrewLead — an incompatible peer is probed on a slow backoff (§10.2)", () => {
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

describe("CrewLead — what it hands the notifier", () => {
  /** A lead whose peer answers a scripted sequence, recording every fresh-body / gone callback. */
  function withNotifier(members: TrustedMember[], script: (link: CrewLink, call: number) => PeerOutcome<unknown>) {
    const roster = [...members];
    const calls: string[] = [];
    const fresh: { memberId: string; blocked: number }[] = [];
    const gone: string[] = [];
    let clock = NOW;
    const registry = new CrewRegistry({
      sessions: { get: () => undefined },
      self: "desk",
      members: () => roster,
    });
    const l = new CrewLead({
      log: () => {},
      registry,
      snapshot: async (link) => {
        calls.push(link.memberId);
        return script(link, calls.filter((c) => c === link.memberId).length);
      },
      proxy: neverProxy,
      self: { id: "desk", name: "the herd" },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
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
    const script = (_l: CrewLink, call: number) =>
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
    const registry = new CrewRegistry({
      sessions: { get: () => undefined },
      self: "desk",
      members: () => [member({ memberId: "laptop" })],
    });
    const dials: string[] = [];
    const crewLead = new CrewLead({
      log: () => {},
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
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
    });

    const url = new URL("https://lead.example/api/pane/w1:p1?host=laptop");
    const resolved = crewLead.resolve({ kind: "member", id: "laptop" });
    expect(resolved?.kind).toBe("peer");
    // SAFETY: `resolved.kind` is asserted to be "peer" on the line above, which is the variant that
    // carries the link + state pair.
    const res = await crewLead.forward(new Request(url), url, resolved as ResolvedPeer);

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
    const registry = new CrewRegistry({
      sessions: { get: () => undefined },
      self: "desk",
      members: () => [member({ memberId: "laptop" })],
    });
    const l = new CrewLead({
      log: () => {},
      registry,
      snapshot: async () => sweepScript(),
      proxy: async () => proxyScript(),
      self: { id: "desk", name: "the herd" },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
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
    // TWO hellos, and they are two different questions on one seam: the good poll earned the
    // once-per-link capability ask (M22/03), then the timeout earned §10.4's verdict probe. The
    // verdict is what this test is about, and it is the second one.
    expect(probed).toEqual(["laptop", "laptop"]);
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

describe("CrewLead — the warrant re-push, on the sweep the lead already runs", () => {
  const WARRANT: Warrant = {
    crewId: "crew-1",
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
    const l = new CrewLead({
      log: () => {},
      registry: new CrewRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => members }),
      snapshot: async (link) =>
        opts.reachable === false ? down : ok({ ...body, ...reports[link.memberId] }),
      proxy: neverProxy,
      self: { id: "desk", name: "the herd" },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
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

/** A peer's snapshot body plus §18.14's two optional reports — the shape this block scripts. */
type PeerReportBody = typeof body & { pairingDigest?: string; pairingCollision?: string[] };

describe("CrewLead — a pairing collision is REPORTED every sweep, never swallowed", () => {
  const sync = { crewId: "crew-1", leadMemberId: "desk", devices: [] };

  /**
   * A lead syncing its registry to `deputy`, with a scripted answer from that deputy — and, since the
   * live drill, a scripted REPORT on the snapshot the sweep already reads.
   */
  function syncing(
    deputy: string | null,
    answer: () => PeerOutcome<unknown>,
    reports: { digest?: string; collision?: string[]; reachable?: boolean } = {},
  ) {
    const said: (readonly string[] | null)[] = [];
    const members = [member({ memberId: "laptop" })];
    // Assigned, never conditionally spread: an absent report must carry NO such key at all, which is
    // exactly the wire's absent-means-closed reading and what these cases are about.
    const answered: PeerReportBody = { ...body };
    if (reports.digest !== undefined) answered.pairingDigest = reports.digest;
    if (reports.collision !== undefined) answered.pairingCollision = reports.collision;
    const l = new CrewLead({
      log: () => {},
      registry: new CrewRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => members }),
      snapshot: async () => (reports.reachable === false ? down : ok(answered)),
      proxy: neverProxy,
      self: { id: "desk", name: "the herd" },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
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

  // ── THE LIVE DRILL, THE REVOCATION ─────────────────────────────────────────
  // The finding used to ride the PUSH, which happens only when the two copies differ — so it flickered
  // for one sweep and then the "level" branch cleared it, and `crew status` could not show a collision
  // that was still true. It is read off the sweep's own answer now, every sweep.
  test("the labels the deputy REPORTS are carried out of the sweep, verbatim, while they are true", async () => {
    const h = syncing("laptop", () => ok(null), { digest: "d1", collision: ["phone", "tablet"] });
    await h.lead.sweep();
    await Bun.sleep(5);
    await h.lead.sweep();
    await Bun.sleep(5);
    // Reported on BOTH sweeps, even though the copies are level and nothing was pushed.
    expect(h.said).toEqual([["phone", "tablet"], ["phone", "tablet"]]);
  });

  test("a deputy that reports NO collision clears the finding — the rename needs no verb", async () => {
    const h = syncing("laptop", () => ok(null), { digest: "d1" });
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.said).toEqual([null]);
  });

  test("a deputy that could not be reached reports NOTHING — silence is not a collision", async () => {
    // The SNAPSHOT is what carries the report, so an unreachable deputy says nothing at all — neither
    // a collision nor the absence of one. A finding invented from silence would outlive the fault.
    const h = syncing("laptop", () => down, { reachable: false });
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.said).toEqual([]);
  });

  test("a PRE-AMENDMENT deputy that refuses the sync outright is still surfaced", async () => {
    // That build freezes its copy — a revoked credential still live at its door — and this lead
    // cannot close it from here. Naming it is all it can do.
    const h = syncing("laptop", () => collision(["phone"]));
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.said).toEqual([null, ["phone"]]);
  });

  test("a crew with no deputy syncs to nobody and reports nothing", async () => {
    const h = syncing(null, () => ok(null));
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.said).toEqual([]);
  });

  // ── THE LIVE DRILL, BUG 4 ──────────────────────────────────────────────────
  // The decision used to be a process-local memory of what this lead had pushed, and `crew deputy`
  // restarts the local bridge as its last step — so the process that knew it still owed a sync was
  // replaced by one that had never offered it, and nothing ever asked the deputy. It is now the
  // deputy's OWN report, on an exchange that already happens, exactly as the warrant's is.
  describe("the deputy's own report decides the push, not something this process remembers", () => {
    /** A lead whose deputy answers its snapshot with `pairingDigest`, or without one. */
    function reporting(reported: string | null) {
      const pushes: string[] = [];
      const members = [member({ memberId: "laptop" })];
      const answer = reported === null ? body : { ...body, pairingDigest: reported };
      const l = new CrewLead({
        log: () => {},
        registry: new CrewRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => members }),
        snapshot: async () => ok(answer),
        proxy: neverProxy,
        self: { id: "desk", name: "the herd" },
        maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
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

    test("a FRESH CrewLead re-offers to a deputy that still reports nothing — a restart forgets nothing", async () => {
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
    const l = new CrewLead({
      log: () => {},
      registry: new CrewRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => members }),
      snapshot: async () => ok(body),
      proxy: neverProxy,
      self: { id: "desk", name: "the herd" },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
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

// ── §19 — the member's own update preflight, banked by the sweep ─────────────

describe("CrewLead — each member's update preflight (§19)", () => {
  const REPORT: PeerPreflight = {
    verdict: "red",
    asOf: 1_757_000_000_000,
    checks: [{ id: "tree", verdict: "red", reason: "working tree has tracked changes: bridge/server.ts" }],
  };

  test("the sweep banks what each member said about its own checkout", async () => {
    const h = lead([member({ memberId: "laptop" })], () => ok({ ...body, updatePreflight: REPORT }));
    await h.lead.sweep();
    expect(h.registry.state("laptop").preflight).toEqual(REPORT);
    expect(h.lead.updateRows()).toEqual([
      {
        name: "laptop",
        version: null,
        verdict: "red",
        reasons: ["working tree has tracked changes: bridge/server.ts"],
        asOf: 1_757_000_000_000,
      },
    ]);
  });

  test("a member that carried none is unknown by name — never green, never omitted", async () => {
    const h = lead([member({ memberId: "laptop" })], () => ok(body));
    await h.lead.sweep();
    expect(h.lead.updateRows()).toEqual([
      { name: "laptop", version: null, verdict: "unknown", reasons: ["we could not check laptop"], asOf: null },
    ]);
  });

  test("a member that did not answer keeps its last report, and the rows still dial nobody", async () => {
    let answer = true;
    const h = lead([member({ memberId: "laptop" })], () => (answer ? ok({ ...body, updatePreflight: REPORT }) : down));
    await h.lead.sweep();
    answer = false;
    await h.lead.sweep();
    // Stale-never-vanish (§10.2): the report survives, and its own `asOf` is what dates it.
    expect(h.lead.updateRows()[0]!.asOf).toBe(1_757_000_000_000);
    const before = h.calls.length;
    h.lead.updateRows();
    h.lead.updateRows();
    expect(h.calls.length).toBe(before);
  });

  test("only the fresh sweep carries the request; the periodic one keeps the strict budget", async () => {
    const asked: boolean[] = [];
    const members = [member({ memberId: "laptop" })];
    const l = new CrewLead({
      log: () => {},
      registry: new CrewRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => members }),
      snapshot: async (_link, _view, freshPreflight) => {
        asked.push(freshPreflight === true);
        return ok(body);
      },
      proxy: neverProxy,
      self: { id: "desk", name: "the herd" },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      now: () => NOW,
    });
    await l.sweep();
    await l.sweep({ freshPreflight: true });
    await l.sweep({});
    expect(asked).toEqual([false, true, false]);
  });
});

// ── §5/§19 — the member's own running version, banked by the same sweep ──────
//
// The defect this closes: a version was banked from `hello` alone, and `hello` is only dialled as a
// verdict probe after a sweep has timed out (§10.4). A member answering every sweep therefore read
// `"version": null` forever on `GET /api/update/check`, so the phone showed no peer version and
// §20's turn queue could never see a member report the new one.

describe("CrewLead — each member's running version (§5, §19)", () => {
  test("ONE sweep, no hello anywhere, and the row carries the version", async () => {
    // `hello` is deliberately not wired: if the row is right, nothing dialled it.
    const h = lead([member({ memberId: "laptop" })], () => ok({ ...body, version: "1.4.1" }));
    await h.lead.sweep();
    expect(h.registry.state("laptop").version).toBe("1.4.1");
    expect(h.lead.updateRows()[0]).toEqual({
      name: "laptop",
      version: "1.4.1",
      verdict: "unknown",
      reasons: ["we could not check laptop"],
      asOf: null,
    });
  });

  test("a sweep that carried none never erases what the lead already knew", async () => {
    let carry = true;
    const h = lead([member({ memberId: "laptop" })], () =>
      carry ? ok({ ...body, version: "1.4.1" }) : ok(body),
    );
    await h.lead.sweep();
    // The member is replaced by a build older than this amendment — it answers, and states nothing.
    carry = false;
    await h.lead.sweep();
    await h.lead.sweep();
    expect(h.registry.state("laptop").version).toBe("1.4.1");
  });

  test("a member that moved reports the new version on the very next sweep", async () => {
    let running = "1.4.1";
    const h = lead([member({ memberId: "laptop" })], () => ok({ ...body, version: running }));
    await h.lead.sweep();
    running = "1.5.0";
    await h.lead.sweep();
    expect(h.lead.updateRows()[0]!.version).toBe("1.5.0");
  });

  test("a failed sweep keeps the last version — stale-never-vanish, exactly as the preflight is", async () => {
    let answer = true;
    const h = lead([member({ memberId: "laptop" })], () => (answer ? ok({ ...body, version: "1.4.1" }) : down));
    await h.lead.sweep();
    answer = false;
    await h.lead.sweep();
    expect(h.lead.updateRows()[0]!.version).toBe("1.4.1");
  });
});

// ── What the journal says ────────────────────────────────────────────────────
//
// 2026-09-07: a crew levelled in seventeen seconds and the lead's run record still read "moving" a
// quarter of an hour later. The journal held one line for the whole run, so the incompatible ladder
// could only be inferred from the arithmetic. These tests pin the lines that would have said it.

describe("CrewLead — the journal names a verdict once per transition", () => {
  test("an incompatible verdict names its reason and the backoff it earned", async () => {
    const h = lead([member({ memberId: "laptop" })], () => skewed);
    await h.lead.sweep();
    expect(h.journal).toEqual(["[crew] laptop: incompatible (peer answered protocol 2), next dial in 30s"]);
  });

  test("a member repeating itself writes nothing — the line is per transition, not per sweep", async () => {
    const h = lead([member({ memberId: "laptop" })], () => down);
    await h.lead.sweep();
    await h.lead.sweep();
    await h.lead.sweep();
    expect(h.journal).toEqual(["[crew] laptop: unreachable (timed out)"]);
  });

  test("each step of the backoff ladder is its own line, because the step is the fact", async () => {
    const h = lead([member({ memberId: "laptop" })], () => skewed);
    await h.lead.sweep();
    h.advance(INCOMPATIBLE_BACKOFF_MS[0]!);
    await h.lead.sweep();
    expect(h.journal).toEqual([
      "[crew] laptop: incompatible (peer answered protocol 2), next dial in 30s",
      "[crew] laptop: incompatible (peer answered protocol 2), next dial in 120s",
    ]);
  });

  test("a member that comes back off the ladder says how many verdicts it took", async () => {
    let answer = false;
    const h = lead([member({ memberId: "laptop" })], () => (answer ? ok(body) : skewed));
    await h.lead.sweep();
    answer = true;
    h.advance(INCOMPATIBLE_BACKOFF_MS[0]!);
    await h.lead.sweep();
    await h.lead.sweep();
    expect(h.journal).toEqual([
      "[crew] laptop: incompatible (peer answered protocol 2), next dial in 30s",
      "[crew] laptop: reachable again after 1 incompatible verdict(s)",
    ]);
  });

  test("a member that goes down and comes back writes one line each way, and the first answer writes none", async () => {
    let answer = true;
    const h = lead([member({ memberId: "laptop" })], () => (answer ? ok(body) : down));
    await h.lead.sweep();
    expect(h.journal).toEqual([]);
    answer = false;
    await h.lead.sweep();
    answer = true;
    await h.lead.sweep();
    await h.lead.sweep();
    expect(h.journal).toEqual(["[crew] laptop: unreachable (timed out)", "[crew] laptop: reachable again"]);
  });
});

// ── A live run keeps its members due (M20/01) ────────────────────────────────

describe("the schedule reads the live run, and the fold runs on every tick", () => {
  test("dueForProbe: urgent overrides the backoff, and never writes it", () => {
    const backed: PeerMemory = { body: null, incompatibleRuns: 3, probeAfter: NOW + 600_000 };
    expect(dueForProbe(backed, NOW)).toBe(false);
    expect(dueForProbe(backed, NOW, true)).toBe(true);
    // The record is untouched, so the ladder the peer earned is waiting the moment the run ends.
    expect(backed.probeAfter).toBe(NOW + 600_000);
  });

  test("a peer on the incompatible ladder is dialled every sweep while a run holds its leg", async () => {
    // The 2026-09-07 incident, as a test. The peer answered three dials as `incompatible`, which put
    // it on the ten-minute step, and the run then waited out a backoff it had no business waiting on.
    // Now the run's open leg overrides the ladder, so the three dials land on three consecutive
    // sweeps rather than across twelve and a half minutes, and the run ends on the third.
    const turns = new UpdateTurns(() => {});
    const h = lead([member({ memberId: "minibuch" })], () => skewed, { turns });
    turns.begin("r-live", "1.4.1");
    for (let i = 0; i < TURN_MISSED_SWEEPS; i += 1) {
      await h.lead.sweep();
      h.advance(1500); // the ordinary sweep cadence, far under the shortest backoff step
    }
    expect(h.calls.length).toBe(TURN_MISSED_SWEEPS);
    // Three misses is unreachable, unreachable is terminal, and a run with no open leg is over.
    expect(turns.peerLegs()[0]?.state).toBe("unreachable");
    expect(turns.settledAt()).not.toBeNull();

    // The control, and the half that must NOT change: with the run over, the same peer on the same
    // ladder is skipped again, and the backoff it earned is the one it kept.
    const before = h.calls.length;
    await h.lead.sweep();
    expect(h.calls.length).toBe(before);
  });

  test("a run that BEGINS during a sweep is not settled on the roster that sweep asked about", async () => {
    // The dials take seconds, and the operator's confirm lands in the middle of them. `due` was
    // computed before the run existed, so a backed-off peer is not in it — and folding that list
    // would settle the new run on a roster it has never looked at, leaving the one peer it was
    // started for undialled and the phone with an empty, silent run.
    const turns = new UpdateTurns(() => {});
    const roster = [member({ memberId: "attic" }), member({ memberId: "basement", enrolledAt: 2 })];
    let begun = false;
    const h = lead(roster, (link) => {
      // `basement` climbs the incompatible ladder first; `attic` always answers, already levelled.
      if (link.memberId === "basement") return skewed;
      // THE RACE: the confirm lands while this dial is in flight.
      if (begun) turns.begin("r-live", "1.4.1");
      // Already on the target, so `attic`'s own leg is terminal the moment it is folded. That is
      // what makes the stale fold able to settle the run with `basement` never dialled.
      return ok({ ...localBody(), version: "1.4.1" });
    }, { turns });
    for (let i = 0; i < INCOMPATIBLE_BACKOFF_MS.length; i += 1) {
      if (i > 0) h.advance(incompatibleBackoffMs(i));
      await h.lead.sweep();
    }
    const dials = h.calls.filter((c) => c === "basement").length;

    begun = true;
    await h.lead.sweep();
    // The run is still open, and `basement` still has its leg to be dialled for.
    expect(turns.current()?.runId).toBe("r-live");
    expect(turns.settledAt()).toBeNull();
    // The immediate re-sweep is the second half: it recomputes `due` under the new run, where
    // `basement`'s open leg overrides the ladder it is sitting on.
    await new Promise((r) => setTimeout(r, 5));
    expect(h.calls.filter((c) => c === "basement").length).toBeGreaterThan(dials);
  });

  test("a lead with no peers due still folds, so its run settles instead of hanging", async () => {
    // `due` is empty on every sweep here, which used to return before the fold. The run then had no
    // way to end at all: `begin` was reachable and `end` was not.
    const turns = new UpdateTurns(() => {});
    const h = lead([], () => skewed, { turns });
    turns.begin("r-live", "1.4.1");
    expect(turns.settledAt()).toBeNull();
    await h.lead.sweep();
    expect(h.calls).toEqual([]);
    expect(turns.settledAt()).toBe(NOW);
    expect(turns.current()).toBeNull();
  });
});

// ── Any admitted contact clears the backoff (M20/02) ─────────────────────────
//
// The backoff is a lead-side GUESS about a peer it cannot reach. A peer that speaks to us is direct
// evidence that the guess is stale, and on 2026-09-07 that evidence was thrown away.

describe("a peer that speaks to us is due", () => {
  /** A lead whose one member has climbed to the top of the incompatible ladder. */
  async function backedOff() {
    const h = lead([member({ memberId: "minibuch" })], () => skewed);
    for (let i = 0; i < INCOMPATIBLE_BACKOFF_MS.length; i += 1) {
      if (i > 0) h.advance(incompatibleBackoffMs(i));
      await h.lead.sweep();
    }
    const dials = h.calls.length;
    // One more sweep straight away is skipped: the ladder is holding it.
    await h.lead.sweep();
    expect(h.calls.length).toBe(dials);
    return { ...h, dials };
  }

  test("the fold helper zeroes both fields, carries the rest, and invents nothing", () => {
    const memory: PeerMemory = { body: null, incompatibleRuns: 3, probeAfter: NOW + 600_000 };
    expect(clearPeerBackoff(memory)).toEqual({ body: null, incompatibleRuns: 0, probeAfter: 0 });
    // Pure: the input is untouched, so the only writer of `this.memory` is still the one that sets it.
    expect(memory.probeAfter).toBe(NOW + 600_000);
    // A member with no entry has no backoff to clear and is already due.
    expect(clearPeerBackoff(undefined)).toBeUndefined();
  });

  test("the last good body survives a reset — a schedule change is never a knowledge change", async () => {
    const h = lead([member({ memberId: "minibuch" })], (_l, call) => (call === 1 ? ok(body) : skewed));
    await h.lead.sweep(); // banks the body
    h.advance(incompatibleBackoffMs(1));
    await h.lead.sweep(); // incompatible, so the ladder starts
    const banked = h.lead.contributions()[0]?.body;
    expect(banked?.sessions).toEqual(body.sessions);
    h.lead.noteAdmittedContact("minibuch");
    // §10.2: a peer's sessions never vanish. The reset moved the SCHEDULE and nothing else.
    expect(h.lead.contributions()[0]?.body).toEqual(banked);
  });

  test("contact marks the member due, and the NEXT sweep does the dial — the seam dials nothing", async () => {
    const h = await backedOff();
    h.lead.noteAdmittedContact("minibuch");
    // Nothing was dialled by the call itself. One dialler, and it is the sweep.
    expect(h.calls.length).toBe(h.dials);
    await h.lead.sweep();
    expect(h.calls.length).toBe(h.dials + 1);
  });

  test("a caller this lead does not lead changes nothing", async () => {
    const h = await backedOff();
    h.lead.noteAdmittedContact("a-stranger");
    await h.lead.sweep();
    expect(h.calls.length).toBe(h.dials);
  });

  test("a second contact inside the floor is ignored", async () => {
    const h = await backedOff();
    h.lead.noteAdmittedContact("minibuch");
    await h.lead.sweep(); // spends the reset: the answer is incompatible again, so the ladder returns
    const dials = h.calls.length;
    h.advance(CONTACT_RESET_FLOOR_MS - 1);
    h.lead.noteAdmittedContact("minibuch");
    await h.lead.sweep();
    expect(h.calls.length).toBe(dials);
    // One millisecond past the floor, the same contact is honoured.
    h.advance(1);
    h.lead.noteAdmittedContact("minibuch");
    await h.lead.sweep();
    expect(h.calls.length).toBe(dials + 1);
  });

  test("a peer that can reach us and cannot serve us runs out of resets, and the ladder stands", async () => {
    const h = await backedOff();
    for (let i = 0; i < MAX_CONTACT_RESETS + 2; i += 1) {
      h.lead.noteAdmittedContact("minibuch");
      await h.lead.sweep();
      h.advance(CONTACT_RESET_FLOOR_MS);
    }
    // Five resets earned five dials. The sixth and seventh contacts earned nothing.
    expect(h.calls.length).toBe(h.dials + MAX_CONTACT_RESETS);
  });

  test("one ok answer clears the counter, so a recovered peer starts from a full allowance", async () => {
    let healthy = false;
    const h = lead([member({ memberId: "minibuch" })], () => (healthy ? ok(body) : skewed));
    await h.lead.sweep();
    for (let i = 0; i < MAX_CONTACT_RESETS; i += 1) {
      h.advance(CONTACT_RESET_FLOOR_MS);
      h.lead.noteAdmittedContact("minibuch");
      await h.lead.sweep();
    }
    const spent = h.calls.length;
    h.advance(CONTACT_RESET_FLOOR_MS);
    h.lead.noteAdmittedContact("minibuch");
    await h.lead.sweep();
    expect(h.calls.length).toBe(spent); // exhausted

    // It answers once, which settles the question the counter was asking.
    healthy = true;
    h.advance(INCOMPATIBLE_BACKOFF_MS.at(-1)!);
    await h.lead.sweep();
    healthy = false;
    h.advance(incompatibleBackoffMs(1));
    await h.lead.sweep(); // back on the ladder, from step one
    const after = h.calls.length;
    h.advance(CONTACT_RESET_FLOOR_MS);
    h.lead.noteAdmittedContact("minibuch");
    await h.lead.sweep();
    expect(h.calls.length).toBe(after + 1);
  });

  test("a genuine version skew returns to the ladder on the very next verdict", async () => {
    const h = await backedOff();
    h.lead.noteAdmittedContact("minibuch");
    await h.lead.sweep();
    const dials = h.calls.length;
    // The peer answered with the same foreign version, so the ladder is right about it again.
    h.advance(CONTACT_RESET_FLOOR_MS);
    await h.lead.sweep();
    expect(h.calls.length).toBe(dials);
  });
});

// ── The dial generation, and the reply it drops (M22/05) ─────────────────────

describe("a reply from an older dial is dropped, never merged (M22/05)", () => {
  /** Our own budget fired, so the member earns the patient probe of §10.4. */
  const budgetMissed: PeerOutcome<unknown> = {
    ok: false,
    state: "unreachable",
    reason: "snapshot: timed out after 1200ms",
    timedOut: true,
    receivedAt: NOW,
  };
  /** The probe's answer, and the harmful one: a FAILURE landing after the member came back. */
  const helloDown: PeerOutcome<{ version: string | null }> = {
    ok: false,
    state: "unreachable",
    reason: "hello: connection refused",
    receivedAt: NOW,
  };

  /**
   * Sweep 1 times out and fires a probe that is left in flight. Sweep 2 answers, so the member is
   * reachable and current. Then the probe's reply lands — from a dial two generations old.
   */
  async function overtaken() {
    let land: (v: PeerOutcome<{ version: string | null }>) => void = () => {};
    const h = lead([member({ memberId: "laptop" })], (_l, call) => (call === 1 ? budgetMissed : ok(body)), {
      hello: () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    });
    await h.lead.sweep();
    await Bun.sleep(5); // the probe is never awaited by the sweep — that is the point of it
    await h.lead.sweep();
    return { ...h, land: (v: PeerOutcome<{ version: string | null }>) => land(v) };
  }

  test("the newer answer stands: a stale hello cannot un-reach a member that came back", async () => {
    const h = await overtaken();
    expect(h.registry.state("laptop").health).toBe("reachable");

    h.land(helloDown);
    await Bun.sleep(5);

    // Without the fence this is the bug: the probe of a dial made BEFORE the member answered would
    // fold its own failure over the top and the lead would report an older world as the current one.
    const state = h.registry.state("laptop");
    expect(state.health).toBe("reachable");
    expect(state.reason).toBeNull();
    expect(state.lastSeenAt).toBe(NOW);
  });

  test("the drop is a value the lead logs and ignores — it names both dials", async () => {
    const h = await overtaken();
    h.land(helloDown);
    await Bun.sleep(5);
    // Sweep 1 claimed dial 1, its probe claimed 2, sweep 2 claimed 3. The reply carries 2.
    expect(h.journal).toContain("[crew] laptop: dropped a stale hello reply, dial 2 of 3");
  });

  test("nothing about the dropped reply reaches the merge", async () => {
    const h = await overtaken();
    h.land(helloDown);
    await Bun.sleep(5);
    const merged = h.lead.merge(localBody(), NARROW_PLAN);
    const peer = merged.servers?.find((s) => s.id === "laptop");
    expect(peer?.reachable).toBe(true);
    // §10.2 holds either way — the rows never vanish — but they are the rows of the dial that won.
    expect(merged.agents.filter((a) => a.host === "laptop").length).toBe(1);
  });

  test("a reply from the CURRENT dial is folded exactly as before", async () => {
    // The fence may only ever drop an overtaken reply. A probe whose dial is still the newest one is
    // the §10.4 path, unchanged: the machine answered, so it is reachable with the slow-link note.
    const h = lead([member({ memberId: "laptop" })], (_l, call) => (call === 1 ? ok(body) : budgetMissed), {
      hello: () =>
        Promise.resolve({
          ok: true as const,
          value: { version: "1.6.0" },
          status: 200,
          member: "laptop",
          receivedAt: NOW,
          date: null,
        }),
    });
    await h.lead.sweep();
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.registry.state("laptop").health).toBe("reachable");
    expect(h.registry.state("laptop").version).toBe("1.6.0");
    expect(h.journal.some((l) => l.includes("dropped a stale"))).toBe(false);
  });
});

// ── M22/03: the lead holds one capability block per member ───────────────────
//
// The map of machines is Collie's, and a mux reports one machine (ADR 0036). So a member's
// capability declaration is a fact about THAT machine, learned over the crew link and answered per
// host. Absent is the one reading that matters most: it means "use the lead's answer", which is
// byte for byte what the phone does today with the lead's single `/api/config` read.

describe("a member's capability block rides `hello` and is answered per host (M22/03)", () => {
  /** A fabricated declaration. The name is deliberately not a real multiplexer's — nothing reads it. */
  function block(over: Partial<MuxConfig> = {}): MuxConfig {
    return {
      name: "reference",
      capabilities: muxCaps({ createSpace: true }),
      unsupportedKeys: [],
      notes: {},
      ...over,
    };
  }

  /** A hello answer carrying (or omitting) a block, shaped like the client's own. */
  function hello(mux: MuxConfig | null): PeerOutcome<{ version: string | null; mux: MuxConfig | null }> {
    return { ok: true, value: { version: "1.7.0", mux }, status: 200, member: "laptop", receivedAt: NOW, date: null };
  }

  test("one good sweep earns one hello, and the block lands under that member", async () => {
    // The sweep dials `snapshot`, never `hello`, so the block has to be asked for. Once per link.
    const answers = [hello(block()), hello(block({ name: "second" }))];
    let asked = 0;
    const h = lead([member({ memberId: "laptop" })], () => ok(body), {
      hello: () => Promise.resolve(answers[Math.min(asked++, answers.length - 1)]!),
    });
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(asked).toBe(1);
    expect(h.lead.muxFor("laptop")?.name).toBe("reference");
    // Three more polls, and no second question: the answer is as fresh as the link is.
    await h.lead.sweep();
    await h.lead.sweep();
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(asked).toBe(1);
  });

  test("a member that has said nothing answers `null`, which the route reads as the lead's", async () => {
    // A peer older than this amendment, and a peer whose bridge holds no adapter, are the same
    // value here — and that value is NOT "every capability present".
    const h = lead([member({ memberId: "laptop" })], () => ok(body), { hello: () => Promise.resolve(hello(null)) });
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.lead.muxFor("laptop")).toBeNull();
    // And a member id nobody holds is the same `null`, so the route never invents a machine.
    expect(h.lead.muxFor("nobody")).toBeNull();
  });

  test("replaces the capability block", async () => {
    // THE RULE, and the reason it is a rule: a restart or an adapter change is a WHOLE new
    // declaration. Folding the new answer into the old one would leave a key alive that the member
    // no longer answers for, and the lead would serve it to a phone as that member's own word.
    const answers = [
      hello(block({ capabilities: muxCaps({ createSpace: true, renamePane: true }) })),
      hello(block({ name: "after-restart", capabilities: muxCaps({ createSpace: false }) })),
      hello(null),
    ];
    let asked = 0;
    // Every sweep fails, so the link drops each time and the next success re-asks.
    const h = lead([member({ memberId: "laptop" })], (_l, call) => (call % 2 === 1 ? ok(body) : down), {
      hello: () => Promise.resolve(answers[Math.min(asked++, answers.length - 1)]!),
    });
    await h.lead.sweep(); // ok → learns the first declaration
    await Bun.sleep(5);
    expect(h.lead.muxFor("laptop")?.capabilities).toEqual(muxCaps({ createSpace: true, renamePane: true }));

    await h.lead.sweep(); // down → the link dropped, so the next return re-asks
    await h.lead.sweep(); // ok → the SECOND declaration, whole
    await Bun.sleep(5);
    const replaced = h.lead.muxFor("laptop");
    expect(replaced?.name).toBe("after-restart");
    // `renamePane` is GONE rather than retained. A merge would have kept it at `true`.
    expect(replaced?.capabilities).toEqual(muxCaps({ createSpace: false }));

    await h.lead.sweep(); // down
    await h.lead.sweep(); // ok, and this time the member publishes nothing at all
    await Bun.sleep(5);
    // Dropped, not retained: the member's current answer is "nothing", and nothing means the lead's.
    expect(h.lead.muxFor("laptop")).toBeNull();
  });

  test("a capability the lead lacks belongs to the member that declared it, and to nobody else", async () => {
    // Two members, one declaration. This is the whole per-host claim: the lead answers `?host=nas`
    // with the NAS's own word and `?host=laptop` with `null`, which is the lead's own block.
    const declared = block({ capabilities: muxCaps({ createWorktree: true }) });
    const h = lead([member({ memberId: "nas" }), member({ memberId: "laptop" })], () => ok(body), {
      hello: (link) => Promise.resolve(link.memberId === "nas" ? hello(declared) : hello(null)),
    });
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.lead.muxFor("nas")?.capabilities).toEqual(muxCaps({ createWorktree: true }));
    expect(h.lead.muxFor("laptop")).toBeNull();
  });

  test("a member that leaves takes its block with it", async () => {
    const h = lead([member({ memberId: "laptop" })], () => ok(body), {
      hello: () => Promise.resolve(hello(block())),
    });
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.lead.muxFor("laptop")).not.toBeNull();

    h.roster.length = 0; // a `leave`, a revocation or a rotation
    await h.lead.sweep();
    expect(h.lead.muxFor("laptop")).toBeNull();
  });

  test("a lead wired without a hello never asks, and answers `null` for every member", async () => {
    // The pre-amendment wiring, and a solo-shaped lead in tests: no probe seam, so no question.
    const h = lead([member({ memberId: "laptop" })], () => ok(body));
    await h.lead.sweep();
    await Bun.sleep(5);
    expect(h.lead.muxFor("laptop")).toBeNull();
  });
});

// ── M22/06: the sweep widens, the merge narrows ──────────────────────────────
// The lead answers the phone from its cache (§10.1's 1200 ms budget under a 1500 ms poll), so a
// member's second session is reachable only if the SWEEP already asked for it. The narrowing is then
// the merge's job, and it happens per request.

describe("CrewLead — every dial asks for every session, and the merge narrows it back (M22/06)", () => {
  /** A member running two sessions, answering the widened ask: every pane carries its session. */
  const widened = {
    sessions: [
      { name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0 },
      { name: "work", isPrimary: false, reachable: true, agents: 1, working: 0, blocked: 0 },
    ],
    agents: [
      { ...body.agents[0]!, paneId: "w1:p1", session: "default" },
      { ...body.agents[0]!, paneId: "w1:p2", session: "work" },
    ],
    shellPanes: [],
  };

  function leadOver(answer: PeerSnapshotWire) {
    const views: SnapshotView[] = [];
    const members = [member({ memberId: "laptop" })];
    const l = new CrewLead({
      log: () => {},
      registry: new CrewRegistry({ sessions: { get: () => undefined }, self: "desk", members: () => members }),
      snapshot: async (_link, view) => {
        views.push(view);
        return ok(answer);
      },
      proxy: neverProxy,
      self: { id: "desk", name: "the herd" },
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      now: () => NOW,
    });
    return { lead: l, views };
  }

  test("the sweep's ask is the widened view, on every dial and with no session named", async () => {
    const h = leadOver(widened);
    await h.lead.sweep();
    expect(h.views).toEqual([SWEEP_VIEW]);
    expect(SWEEP_VIEW).toEqual({ session: undefined, widen: true });
  });

  test("with nothing asked, the merged body is the member's primary session and carries no tag", async () => {
    const h = leadOver(widened);
    await h.lead.sweep();
    const merged = h.lead.merge(localBody(), NARROW_PLAN);
    // One pane, the primary's — and `session` is GONE, which is what makes a one-session member's
    // contribution byte-identical to the pre-widening one (bridge/sessions.ts's widenedPanes rule).
    expect(merged.agents.map((p) => [p.paneId, p.session])).toEqual([["w1:p1", undefined]]);
    expect(JSON.stringify(merged.agents)).not.toContain('"session"');
  });

  test("`?all=1&host=<member>` yields that member's other sessions, tagged", async () => {
    const h = leadOver(widened);
    await h.lead.sweep();
    const merged = h.lead.merge(localBody(), snapshotPlan("laptop", { session: undefined, widen: true }));
    expect(merged.agents.map((p) => [p.paneId, p.session])).toEqual([
      ["w1:p1", "default"],
      ["w1:p2", "work"],
    ]);
    expect(merged.agents.every((p) => p.host === "laptop")).toBe(true);
  });

  test("`?host=<member>&session=<other>` reaches a pane in the member's second session", async () => {
    // The latent gap this spec closes: the sweep used to pin the cache to the member's primary, so
    // this pane was invisible to the phone however it asked.
    const h = leadOver(widened);
    await h.lead.sweep();
    const merged = h.lead.merge(localBody(), snapshotPlan("laptop", { session: "work", widen: false }));
    expect(merged.agents.map((p) => p.paneId)).toEqual(["w1:p2"]);
  });

  test("a widened ask about ONE member leaves the others narrow", async () => {
    const h = leadOver(widened);
    await h.lead.sweep();
    const merged = h.lead.merge(localBody(), snapshotPlan("desktop", { session: undefined, widen: true }));
    expect(merged.agents.map((p) => p.paneId)).toEqual(["w1:p1"]);
  });

  test("a member too old to widen answers as it always did, and narrows to itself", async () => {
    // It ignores the parameter, so its panes arrive untagged. Dropping them would lose a machine.
    const h = leadOver(body);
    await h.lead.sweep();
    expect(h.lead.merge(localBody(), NARROW_PLAN).agents.map((p) => p.paneId)).toEqual(["w1:p1"]);
    const wide = h.lead.merge(localBody(), snapshotPlan("laptop", { session: undefined, widen: true }));
    expect(wide.agents.map((p) => p.paneId)).toEqual(["w1:p1"]);
  });
});
