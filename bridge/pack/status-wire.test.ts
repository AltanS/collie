import { describe, expect, test } from "bun:test";

import { leadStore, member, peerStore, PACK, T0 } from "./fixtures.ts";
import { packStatusBody, type PackStatusSources } from "./status-wire.ts";
import type { PeerContribution } from "./merge.ts";
import type { PeerState } from "./registry.ts";
import type { TrustStoreData } from "./trust-store.ts";
import type { Warrant } from "./trust-store.ts";

// `GET /api/pack` is a REPORT: it must say exactly what the lead already believes, and it must be
// unable to go and find out. Both halves are testable here because the composer is pure — the
// signature has no transport in it, so a test that dials nothing is not a test with the network
// stubbed out, it is the whole function.
//
// What each test below is really pinning:
//   • the 404 cases are a MODE decision, not a local re-read of the roster (§3);
//   • an optional field is OMITTED, never null (§11) — asserted on the key, not on the value;
//   • the lead's own row is first and carries no roster fields, because a lead is not in its own
//     roster (§9.2, the same order `servers[]` has);
//   • nothing secret is in the body, asserted over the serialised bytes rather than field by field.

const NOW = T0 + 90_000;

function state(over: Partial<PeerState> & { memberId: string }): PeerState {
  return {
    health: "reachable",
    lastSeenAt: T0 + 60_000,
    reason: null,
    version: "1.0.0",
    conflict: null,
    preflight: null,
    ...over,
  };
}

function contribution(over: Partial<PeerState> & { memberId: string }): PeerContribution {
  return { state: state(over), name: over.memberId, body: null };
}

function sources(over: Partial<PackStatusSources> = {}): PackStatusSources {
  return {
    store: leadStore({ peers: [member({ memberId: "laptop" })] }),
    self: { id: "desk", name: "desk" },
    version: "1.0.0",
    peers: [contribution({ memberId: "laptop" })],
    now: NOW,
    ...over,
  };
}

/** A stored warrant naming `deputy`, with only the fields this surface reads filled honestly. */
function storedWarrant(generation: number, deputyMemberId: string | null): TrustStoreData["warrant"] {
  const warrant: Warrant = {
    packId: PACK.packId,
    generation,
    deputyMemberId,
    deputyFingerprint: null,
    leadMemberId: "desk",
    issuedAt: T0,
    refreshedAt: T0,
    signature: "sig",
  };
  return { warrant, deputyCertPem: null };
}

describe("packStatusBody — who answers at all", () => {
  test("a collie with no trust store has no pack to describe", () => {
    expect(packStatusBody(sources({ store: null, peers: [] }))).toBeNull();
  });

  test("a peer answers nothing — it is not a front door (ADR 0013)", () => {
    expect(packStatusBody(sources({ store: peerStore(), peers: [] }))).toBeNull();
  });

  test("a lead that has enrolled nobody is still solo by mode, and answers nothing", () => {
    // The mode table's own row (mode.ts): a trust store with no lead and no peers is `solo`. This is
    // the case a local `store.pack !== null` check would have got wrong — a pack exists the moment an
    // invite is minted, well before anyone has joined.
    expect(packStatusBody(sources({ store: leadStore({ peers: [] }), peers: [] }))).toBeNull();
  });

  test("a lead with one enrolled peer answers", () => {
    expect(packStatusBody(sources())).not.toBeNull();
  });
});

describe("packStatusBody — the pack and the lead's own row", () => {
  test("the pack block is the trust store's PackIdentity, minus its secret", () => {
    const body = packStatusBody(sources())!;
    expect(body.pack).toEqual({
      id: PACK.packId,
      name: PACK.name,
      secretGeneration: PACK.secretGeneration,
      rotatedAt: PACK.rotatedAt,
    });
    expect(body.ts).toBe(NOW);
    expect(body.self).toEqual({ id: "desk", name: "desk", version: "1.0.0" });
  });

  test("the lead is FIRST, and carries no roster fields — it is not in its own roster", () => {
    const [first, ...rest] = packStatusBody(sources())!.members;
    expect(first).toEqual({
      id: "desk",
      name: "desk",
      isLead: true,
      health: "reachable",
      lastSeenAt: NOW,
      version: "1.0.0",
      secretBehind: false,
      provisional: false,
    });
    // Asserted on the KEYS: §11's rule is that an absent field is absent, not null.
    expect(Object.keys(first!)).not.toContain("address");
    expect(Object.keys(first!)).not.toContain("enrolledAt");
    expect(rest.map((m) => m.isLead)).toEqual([false]);
  });

  test("peers follow the lead in member-id order, whatever order they arrive in", () => {
    const body = packStatusBody(
      sources({
        store: leadStore({
          peers: [member({ memberId: "zeta" }), member({ memberId: "alpha" }), member({ memberId: "mid" })],
        }),
        peers: [contribution({ memberId: "zeta" }), contribution({ memberId: "mid" }), contribution({ memberId: "alpha" })],
      }),
    )!;
    expect(body.members.map((m) => m.id)).toEqual(["desk", "alpha", "mid", "zeta"]);
  });
});

describe("packStatusBody — a peer's row says what the registry believes and nothing more", () => {
  test("a healthy peer carries its roster facts and no reason", () => {
    const body = packStatusBody(sources())!;
    expect(body.members[1]).toEqual({
      id: "laptop",
      name: "laptop",
      isLead: false,
      address: "laptop.example:8787",
      enrolledAt: T0,
      health: "reachable",
      lastSeenAt: T0 + 60_000,
      version: "1.0.0",
      secretBehind: false,
      provisional: false,
    });
  });

  test("a reason is passed through verbatim, and a never-seen peer reads as lastSeenAt 0", () => {
    const body = packStatusBody(
      sources({
        peers: [
          contribution({
            memberId: "laptop",
            health: "unreachable",
            lastSeenAt: null,
            reason: "timed out after 1200ms",
            version: null,
          }),
        ],
      }),
    )!;
    const row = body.members[1]!;
    expect(row.health).toBe("unreachable");
    expect(row.reason).toBe("timed out after 1200ms");
    expect(row.lastSeenAt).toBe(0);
    // Never reported a version ⇒ no key at all, rather than a null the client has to distinguish.
    expect(Object.keys(row)).not.toContain("version");
  });

  test("a failure state the wire does not name projects onto `unreachable`", () => {
    // `refused` is a CLI-only outcome (§14.3) the registry itself already folds; the projection is
    // applied here too so the phone is never handed a fifth badge to explain (§10.2).
    const body = packStatusBody(
      sources({ peers: [contribution({ memberId: "laptop", health: "refused", reason: "403" })] }),
    )!;
    expect(body.members[1]!.health).toBe("unreachable");
  });

  test("a conflicted peer carries who it says it follows (§18.10)", () => {
    const body = packStatusBody(
      sources({
        peers: [
          contribution({
            memberId: "laptop",
            health: "conflicted",
            reason: "follows another lead",
            conflict: { leadMemberId: "other-desk", warrantGeneration: 7 },
          }),
        ],
      }),
    )!;
    expect(body.members[1]!.conflict).toEqual({ leadMemberId: "other-desk", warrantGeneration: 7 });
  });

  test("a reachable peer carries no conflict key at all", () => {
    expect(Object.keys(packStatusBody(sources())!.members[1]!)).not.toContain("conflict");
  });

  test("a member behind on the pack secret is flagged (§8.4); the lead never is", () => {
    const body = packStatusBody(
      sources({
        store: leadStore({
          pack: { ...PACK, secretGeneration: 4 },
          peers: [member({ memberId: "laptop", secretGeneration: 2 })],
        }),
      }),
    )!;
    expect(body.members[0]!.secretBehind).toBe(false);
    expect(body.members[1]!.secretBehind).toBe(true);
  });

  test("provisional is `contactedAt === null` AND not answering — an ABSENT field is not provisional", () => {
    const never = member({ memberId: "laptop", contactedAt: null });
    const old = member({ memberId: "laptop" });
    const down = { memberId: "laptop", health: "unreachable", lastSeenAt: null } as const;

    expect(packStatusBody(sources({ store: leadStore({ peers: [never] }), peers: [contribution(down)] }))!
      .members[1]!.provisional).toBe(true);
    // A record written before `contactedAt` existed says nothing, and silence is not a half-join.
    expect(packStatusBody(sources({ store: leadStore({ peers: [old] }), peers: [contribution(down)] }))!
      .members[1]!.provisional).toBe(false);
    // Answering right now is not half-finished, whatever the stored field says.
    expect(packStatusBody(sources({ store: leadStore({ peers: [never] }), peers: [contribution({ memberId: "laptop" })] }))!
      .members[1]!.provisional).toBe(false);
  });

  test("a member revoked between the two reads is dropped, never half-rendered", () => {
    // `contributions()` comes from the registry and the roster comes from the store; a peer removed
    // between them would otherwise render with no address and no enrollment time — a broken member
    // rather than an absent one.
    const body = packStatusBody(
      sources({ peers: [contribution({ memberId: "laptop" }), contribution({ memberId: "ghost" })] }),
    )!;
    expect(body.members.map((m) => m.id)).toEqual(["desk", "laptop"]);
  });
});

describe("packStatusBody — the deputy is the DESIGNATION, never the warrant", () => {
  test("no designation ⇒ null, even while a warrant sits on disk", () => {
    // The takeover case: the new lead keeps the warrant (it carries the generation counter) and that
    // warrant names THIS machine. Reading the deputy off it reports a lead as its own deputy.
    const store = leadStore({
      peers: [member({ memberId: "laptop" })],
      warrant: storedWarrant(3, "desk"),
      deputySpentAt: T0,
    });
    expect(packStatusBody(sources({ store }))!.deputy).toBeNull();
  });

  test("a designation carries the generation of the warrant this lead holds", () => {
    const store = leadStore({
      peers: [member({ memberId: "laptop" })],
      deputy: "laptop",
      warrant: storedWarrant(3, "laptop"),
    });
    expect(packStatusBody(sources({ store }))!.deputy).toEqual({ id: "laptop", warrantGeneration: 3 });
  });

  test("a designation with no warrant behind it says so with null, rather than losing the key", () => {
    const store = leadStore({ peers: [member({ memberId: "laptop" })], deputy: "laptop" });
    expect(packStatusBody(sources({ store }))!.deputy).toEqual({ id: "laptop", warrantGeneration: null });
  });
});

describe("packStatusBody — nothing secret reaches the wire", () => {
  test("no secret, fingerprint, certificate or key material in the serialised body", () => {
    const store = leadStore({
      peers: [member({ memberId: "laptop", contactedAt: T0 })],
      deputy: "laptop",
      warrant: storedWarrant(2, "laptop"),
    });
    const body = JSON.stringify(packStatusBody(sources({ store }))!);
    expect(body).not.toContain(PACK.secret);
    expect(body).not.toContain("BEGIN CERTIFICATE");
    expect(body).not.toContain("PRIVATE KEY");
    expect(body).not.toMatch(/fingerprint|certPem|keyPem|secret"|token/i);
  });
});
