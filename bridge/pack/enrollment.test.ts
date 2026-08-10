import { describe, expect, test } from "bun:test";

import { X509Certificate } from "node:crypto";

import { AuditLog, type AuditEntry } from "../audit.ts";
import {
  acceptEnrollment,
  adoptLead,
  adoptSecret,
  commitPackChange,
  demoteSelf,
  identityMinter,
  isLeading,
  parseRoster,
  promoteSelf,
  rosterEntryOf,
  updateMemberAddress,
  consumeInvite,
  createTrustStore,
  dropMembersBehind,
  enrollPeer,
  INVITE_TTL_MS,
  leavePack,
  markSecretDelivered,
  mintInvite,
  parseEnrollRequest,
  parseEnrollResponse,
  removeMember,
  rotatePackSecret,
  selfIdentity,
} from "./enrollment.ts";
import { fingerprintOfCert, hashToken, isMemberId } from "./identity.ts";
import { TrustStore, type TrustStoreData, type TrustStoreIo } from "./trust-store.ts";
import { counterRandom, fp, leadStore, material, member, PACK, peerStore, T0 } from "./fixtures.ts";

const R = () => counterRandom("r");

describe("this collie's own identity", () => {
  test("identityMinter really mints — the fingerprint matches the certificate, and the PEMs parse", async () => {
    const minted = await identityMinter({ commonName: "collie-test" })();
    expect(fingerprintOfCert(minted.certPem)).toBe(minted.fingerprint);
    expect(() => new X509Certificate(minted.certPem)).not.toThrow();
  });

  test("a fresh store is an identity and nothing else — no pack, no roster, no invites", () => {
    const data = createTrustStore(selfIdentity("desk", material("desk"), T0));
    expect(data).toEqual({
      version: 1,
      self: { memberId: "desk", certPem: expect.any(String), keyPem: expect.any(String), fingerprint: fp("desk"), createdAt: T0 },
      pack: null,
      lead: null,
      peers: [],
      invites: [],
    });
  });
});

describe("invites", () => {
  const fresh = createTrustStore(selfIdentity("desk", material("desk"), T0));

  test("the first invite is what brings the pack (and its secret) into existence", () => {
    expect(fresh.pack).toBeNull();
    const change = mintInvite(fresh, { now: T0, random: R() });
    expect(change.next.pack).not.toBeNull();
    expect(change.next.pack!.secret).toBe("r3");
    expect(change.next.pack!.secretGeneration).toBe(1);
  });

  test("a later invite reuses the existing pack — a second invite is not a second pack", () => {
    const first = mintInvite(fresh, { now: T0, random: R() }).next;
    const second = mintInvite(first, { now: T0 + 1, random: R() }).next;
    expect(second.pack).toEqual(first.pack!);
    expect(second.invites).toHaveLength(2);
  });

  test("the token is returned once and stored only as a hash", () => {
    const { next, result } = mintInvite(fresh, { now: T0, random: R() });
    expect(next.invites[0]!.tokenHash).toBe(hashToken(result.token));
    // Scoped to `invites` (not the whole store): `next.self` now carries a real minted certificate,
    // whose base64 can coincidentally contain a short deterministic token like "r1" as a substring.
    expect(JSON.stringify(next.invites)).not.toContain(result.token);
  });

  test("it expires in ten minutes (§8.2)", () => {
    const { result } = mintInvite(fresh, { now: T0 });
    expect(result.expiresAt).toBe(T0 + INVITE_TTL_MS);
    expect(INVITE_TTL_MS).toBe(10 * 60 * 1000);
  });

  test("the audit line names the invite but never the token", () => {
    const { audit, result } = mintInvite(fresh, { now: T0, label: "laptop" });
    expect(audit.action).toBe("pack.invite");
    expect(JSON.stringify(audit)).not.toContain(result.token);
    expect(audit.detail!.label).toBe("laptop");
  });

  test("minting sweeps invites that have already expired", () => {
    const old = mintInvite(fresh, { now: T0 }).next;
    const later = mintInvite(old, { now: T0 + INVITE_TTL_MS + 1 }).next;
    expect(later.invites).toHaveLength(1);
  });
});

describe("spending an invite", () => {
  const minted = mintInvite(createTrustStore(selfIdentity("desk", material("desk"), T0)), { now: T0, random: R() });
  const data = minted.next;
  const token = minted.result.token;

  test("a good token is accepted exactly ONCE — single-use is enforced by removal", () => {
    const first = consumeInvite(data, token, T0 + 1)!;
    expect(first.result).not.toBeNull();
    expect(first.next.invites).toEqual([]);
    // Nothing left to spend and nothing left to sweep: the retry is a pure no-op, so it does not
    // even ask for a write.
    expect(consumeInvite(first.next, token, T0 + 2)).toBeNull();
  });

  test("a wrong or absent token against only-live invites is a NO-OP — no store to write, nothing spent", () => {
    // F4: this is the unauthenticated path. Returning a `next` here made every junk POST to the
    // enrollment endpoint re-serialize the file holding the private key and the pack secret.
    expect(consumeInvite(data, "wrong", T0 + 1)).toBeNull();
    expect(consumeInvite(data, null, T0 + 1)).toBeNull();
  });

  test("an expired invite is swept even when the spend fails — that sweep IS worth a write", () => {
    const after = consumeInvite(data, "wrong", T0 + INVITE_TTL_MS + 1)!;
    expect(after.next.invites).toEqual([]);
    expect(after.result).toBeNull();
  });

  test("a token that is right but too late sweeps and reports nothing spent", () => {
    const after = consumeInvite(data, token, T0 + INVITE_TTL_MS + 1)!;
    expect(after.result).toBeNull();
    expect(after.next.invites).toEqual([]);
  });

  test("a match among a mix spends exactly it and sweeps the expired one in the same pass", () => {
    const random = R();
    const short = mintInvite(createTrustStore(selfIdentity("desk", material("desk"), T0)), {
      now: T0,
      ttlMs: 1_000,
      random,
    });
    const long = mintInvite(short.next, { now: T0, random });
    expect(long.next.invites).toHaveLength(2);

    const spent = consumeInvite(long.next, long.result.token, T0 + 2_000)!;
    expect(spent.result?.tokenHash).toBe(hashToken(long.result.token));
    expect(spent.next.invites).toEqual([]);
  });

  test("the audit line records only whether it was accepted", () => {
    expect(consumeInvite(data, token, T0 + 1)!.audit).toEqual({
      action: "pack.invite.spend",
      detail: { accepted: true },
    });
  });
});

describe("the exchange — §8.2's transfer table, both directions", () => {
  const lead = leadStore();

  test("the lead pins the peer, mints its id, and hands back every listed item", () => {
    const change = enrollPeer(
      lead,
      { fingerprint: fp("laptop"), certPem: material("laptop").certPem, address: "laptop.ts.net:8787", label: "laptop" },
      T0,
      R(),
    )!;
    expect(change.next.peers).toEqual([
      {
        memberId: "laptop",
        fingerprint: fp("laptop"),
        certPem: material("laptop").certPem,
        address: "laptop.ts.net:8787",
        role: "peer",
        status: "enrolled",
        enrolledAt: T0,
        secretGeneration: 1,
        signedAt: 0,
        // A freshly-enrolled member starts provisional — pinned, never once contacted.
        contactedAt: null,
      },
    ]);
    expect(change.result).toEqual({
      protocol: 1,
      packId: PACK.packId,
      packName: PACK.name,
      packSecret: PACK.secret,
      secretGeneration: 1,
      memberId: "laptop",
      leadMemberId: "desk",
      leadFingerprint: fp("desk"),
      leadCertPem: material("desk").certPem,
    });
  });

  test("a collie with no pack cannot enroll anybody", () => {
    expect(
      enrollPeer(leadStore({ pack: null }), { fingerprint: fp("x"), certPem: material("x").certPem, address: "a", label: null }, T0),
    ).toBeNull();
  });

  test("a member id never collides with an existing peer or with the lead itself", () => {
    const crowded = leadStore({ peers: [member({ memberId: "laptop" })] });
    const minted = enrollPeer(
      crowded,
      { fingerprint: fp("other"), certPem: material("other").certPem, address: "a", label: "laptop" },
      T0,
      R(),
    )!;
    expect(minted.result.memberId).toBe("laptop-r1");
    const asLead = enrollPeer(
      leadStore(),
      { fingerprint: fp("other"), certPem: material("other").certPem, address: "a", label: "desk" },
      T0,
      R(),
    )!;
    expect(asLead.result.memberId).toBe("desk-r1");
    expect(isMemberId(asLead.result.memberId)).toBe(true);
  });

  test("a RE-JOIN keeps the member id and re-pins — the documented recovery from a missed rotation", () => {
    const dropped = leadStore({ peers: [member({ memberId: "laptop", fingerprint: fp("laptop"), status: "unenrolled" })] });
    const again = enrollPeer(
      dropped,
      { fingerprint: fp("laptop"), certPem: material("laptop").certPem, address: "new.addr:1", label: "whatever" },
      T0 + 5,
      R(),
    )!;
    expect(again.result.memberId).toBe("laptop");
    expect(again.next.peers).toHaveLength(1);
    expect(again.next.peers[0]!.status).toBe("enrolled");
    expect(again.next.peers[0]!.address).toBe("new.addr:1");
    expect(again.audit.detail!.rejoin).toBe(true);
  });

  test("the peer adopts the pack, pins the lead, and takes the id the lead minted", () => {
    const joining = createTrustStore(selfIdentity("placeholder", material("laptop"), T0));
    const res = enrollPeer(
      lead,
      { fingerprint: fp("laptop"), certPem: material("laptop").certPem, address: "a", label: "laptop" },
      T0,
      R(),
    )!.result;
    const change = acceptEnrollment(joining, res, "desk.ts.net:8787", T0 + 1);
    expect(change.next.self.memberId).toBe("laptop");
    expect(change.next.self.keyPem).toBe(joining.self.keyPem);
    expect(change.next.pack).toEqual({
      packId: PACK.packId,
      name: PACK.name,
      secret: PACK.secret,
      secretGeneration: 1,
      rotatedAt: T0 + 1,
    });
    expect(change.next.lead).toEqual({
      memberId: "desk",
      fingerprint: fp("desk"),
      certPem: material("desk").certPem,
      address: "desk.ts.net:8787",
      role: "lead",
      status: "enrolled",
      enrolledAt: T0 + 1,
      secretGeneration: 1,
      signedAt: 0,
    });
  });

  test("a peer's roster gains EXACTLY one entry — a peer has no peers", () => {
    const confused = { ...peerStore(), peers: [member({ memberId: "nas" })] };
    const res = enrollPeer(
      lead,
      { fingerprint: fp("laptop"), certPem: material("laptop").certPem, address: "a", label: "laptop" },
      T0,
      R(),
    )!.result;
    expect(acceptEnrollment(confused, res, "a", T0).next.peers).toEqual([]);
  });
});

describe("the exchange — parsing untrusted payloads", () => {
  const req = {
    protocol: 1,
    token: "t",
    fingerprint: fp("laptop"),
    certPem: material("laptop").certPem,
    address: "a:1",
    label: "laptop",
  };

  test("a well-formed request parses, normalising the fingerprint", () => {
    const colons = fp("laptop").match(/../g)!.join(":").toUpperCase();
    expect(parseEnrollRequest({ ...req, fingerprint: colons })!.fingerprint).toBe(fp("laptop"));
  });

  test("anything missing, empty or mistyped is null", () => {
    expect(parseEnrollRequest(null)).toBeNull();
    expect(parseEnrollRequest("nope")).toBeNull();
    expect(parseEnrollRequest({ ...req, token: "" })).toBeNull();
    expect(parseEnrollRequest({ ...req, token: 1 })).toBeNull();
    expect(parseEnrollRequest({ ...req, fingerprint: "nope" })).toBeNull();
    expect(parseEnrollRequest({ ...req, address: "" })).toBeNull();
    expect(parseEnrollRequest({ ...req, label: 7 })).toBeNull();
  });

  test("an absent version parses to NaN, so the caller must still negotiate it explicitly", () => {
    expect(parseEnrollRequest({ ...req, protocol: undefined })!.protocol).toBeNaN();
  });

  test("a response with an out-of-grammar member id or unpinnable fingerprint is refused", () => {
    const res = {
      protocol: 1,
      packId: "p",
      packName: "n",
      packSecret: "s",
      secretGeneration: 1,
      memberId: "laptop",
      leadMemberId: "desk",
      leadFingerprint: fp("desk"),
      leadCertPem: material("desk").certPem,
    };
    expect(parseEnrollResponse(res)).toEqual(res);
    expect(parseEnrollResponse({ ...res, memberId: "Laptop" })).toBeNull();
    expect(parseEnrollResponse({ ...res, leadMemberId: "" })).toBeNull();
    expect(parseEnrollResponse({ ...res, leadFingerprint: "nope" })).toBeNull();
    expect(parseEnrollResponse({ ...res, packSecret: 7 })).toBeNull();
    expect(parseEnrollResponse(null)).toBeNull();
  });
});

describe("rotation (§8.4)", () => {
  const withPeers = leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "laptop" })] });

  test("rotating replaces the secret and bumps the generation — no grace, no rollback value", () => {
    const change = rotatePackSecret(withPeers, T0 + 10, R())!;
    expect(change.next.pack!.secret).toBe("r1");
    expect(change.next.pack!.secret).not.toBe(PACK.secret);
    expect(change.next.pack!.secretGeneration).toBe(2);
    expect(change.next.pack!.rotatedAt).toBe(T0 + 10);
    // The store keeps no copy of the old secret anywhere.
    expect(JSON.stringify(change.next)).not.toContain(PACK.secret);
  });

  test("every member is left behind until it picks the secret up", () => {
    const rotated = rotatePackSecret(withPeers, T0 + 10, R())!.next;
    expect(rotated.peers.map((p) => p.secretGeneration)).toEqual([1, 1]);
    const delivered = markSecretDelivered(rotated, "nas")!.next;
    expect(delivered.peers.map((p) => p.secretGeneration)).toEqual([2, 1]);
    expect(markSecretDelivered(delivered, "nas")).toBeNull();
  });

  test("closing the rotation drops whoever was offline to `unenrolled`, and says who", () => {
    const rotated = rotatePackSecret(withPeers, T0 + 10, R())!.next;
    const delivered = markSecretDelivered(rotated, "nas")!.next;
    const change = dropMembersBehind(delivered)!;
    expect(change.result.dropped).toEqual(["laptop"]);
    expect(change.next.peers.map((p) => [p.memberId, p.status])).toEqual([
      ["nas", "enrolled"],
      ["laptop", "unenrolled"],
    ]);
    expect(change.audit.action).toBe("pack.unenroll");
    // Marked, not deleted: `pack status` must be able to say WHY the machine went quiet.
    expect(change.next.peers).toHaveLength(2);
  });

  test("a fully caught-up pack drops nobody", () => {
    expect(dropMembersBehind(withPeers)).toBeNull();
  });

  test("a collie with no pack cannot rotate", () => {
    expect(rotatePackSecret(leadStore({ pack: null }), T0)).toBeNull();
    expect(markSecretDelivered(leadStore({ pack: null }), "nas")).toBeNull();
    expect(dropMembersBehind(leadStore({ pack: null }))).toBeNull();
  });
});

describe("revocation (§8.4)", () => {
  test("`pack remove` deletes the entry — a disowned machine keeps no pin", () => {
    const data = leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "laptop" })] });
    const change = removeMember(data, "nas")!;
    expect(change.next.peers.map((p) => p.memberId)).toEqual(["laptop"]);
    expect(JSON.stringify(change.next)).not.toContain(fp("nas"));
    expect(change.audit).toEqual({ action: "pack.remove", detail: { member: "nas" } });
    expect(removeMember(change.next, "nas")).toBeNull();
  });

  test("`leave` drops the pack, the roster and the pins — but keeps this collie's own identity", () => {
    const peer = peerStore();
    const change = leavePack(peer)!;
    expect(change.next.pack).toBeNull();
    expect(change.next.lead).toBeNull();
    expect(change.next.peers).toEqual([]);
    expect(change.next.invites).toEqual([]);
    expect(change.next.self).toEqual(peer.self);
    expect(JSON.stringify(change.next)).not.toContain(PACK.secret);
    expect(change.audit.action).toBe("pack.leave");
  });

  test("leaving a pack you are not in changes nothing", () => {
    expect(leavePack(leadStore({ pack: null }))).toBeNull();
  });

  test("after `leave` the mode falls back to solo without deleting the file", () => {
    const left = leavePack(peerStore())!.next;
    expect(left.lead).toBeNull();
    expect(left.peers).toEqual([]);
  });
});

describe("commitPackChange — write first, audit second", () => {
  function harness(initial: TrustStoreData | null) {
    const lines: AuditEntry[] = [];
    let contents = initial === null ? null : JSON.stringify(initial);
    const io: TrustStoreIo = {
      read: async () => contents,
      write: async (_p, d) => {
        contents = d;
      },
    };
    return { lines, io, audit: new AuditLog((l) => void lines.push(JSON.parse(l) as AuditEntry), () => T0) };
  }

  test("a successful change is persisted and audited", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    const store = new TrustStore("/unused", h.io);
    // The result distinguishes "changed" from "no-op": `commitPackChange` answers `null` for the
    // latter, so a transition whose result was also `null` would be indistinguishable to a verb.
    expect(await commitPackChange(store, h.audit, (d) => removeMember(d!, "nas"))).toEqual({ member: "nas" });
    expect(store.current()!.peers).toEqual([]);
    await Bun.sleep(5);
    expect(h.lines.map((l) => l.action)).toEqual(["pack.remove"]);
  });

  test("a no-op change writes nothing and audits nothing", async () => {
    const h = harness(leadStore());
    const store = new TrustStore("/unused", h.io);
    expect(await commitPackChange(store, h.audit, (d) => removeMember(d!, "ghost"))).toBeNull();
    await Bun.sleep(5);
    expect(h.lines).toEqual([]);
  });

  test("a change that fails to PERSIST is never audited — the log must not claim a write that lost", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    const store = new TrustStore("/unused", {
      read: h.io.read,
      write: async () => {
        throw new Error("disk full");
      },
    });
    await expect(commitPackChange(store, h.audit, (d) => removeMember(d!, "nas"))).rejects.toThrow("disk full");
    await Bun.sleep(5);
    expect(h.lines).toEqual([]);
  });

  test("rotation and revocation both reach the audit log through the same path", async () => {
    const h = harness(leadStore({ peers: [member({ memberId: "nas" })] }));
    const store = new TrustStore("/unused", h.io);
    await commitPackChange(store, h.audit, (d) => rotatePackSecret(d!, T0, R()));
    await commitPackChange(store, h.audit, (d) => dropMembersBehind(d!));
    await commitPackChange(store, h.audit, (d) => leavePack(d!));
    await Bun.sleep(5);
    expect(h.lines.map((l) => l.action)).toEqual(["pack.rotate", "pack.unenroll", "pack.leave"]);
    // Audit lines must never carry credential material.
    expect(JSON.stringify(h.lines)).not.toContain(PACK.secret);
  });
});

// ── Distribution, promotion and roaming (M4/07) ──────────────────────────────
// The transitions the operator verbs in `cli/pack.ts` commit. Same rule as everything above: pure in,
// pure out, so what the verb suite exercises is ordering and wording rather than state.

describe("adoptSecret", () => {
  const handover = { secret: "rotated-secret-bbbbbbbbbbbbbbbbbbbb", generation: 2 };

  test("takes the lead's rotated secret and moves this member's generation with it", () => {
    const change = adoptSecret(peerStore(), handover, T0 + 5)!;
    expect(change.next.pack!.secret).toBe(handover.secret);
    expect(change.next.pack!.secretGeneration).toBe(2);
    expect(change.next.lead!.secretGeneration).toBe(2);
    expect(change.audit.action).toBe("pack.secret.adopted");
    // The secret itself never reaches the log.
    expect(JSON.stringify(change.audit)).not.toContain(handover.secret);
  });

  test("keeps NO grace window — the previous secret is replaced, not remembered", () => {
    const change = adoptSecret(peerStore(), handover, T0)!;
    expect(JSON.stringify(change.next)).not.toContain(PACK.secret);
  });

  test("a redelivery of the generation already held is a no-op, not a second write", () => {
    expect(adoptSecret(peerStore(), { secret: "x".repeat(20), generation: 1 }, T0)).toBeNull();
    expect(adoptSecret(peerStore(), { secret: "x".repeat(20), generation: 0 }, T0)).toBeNull();
  });

  test("a lead has no lead to be rotated by, and an empty secret is refused", () => {
    expect(adoptSecret(leadStore({ peers: [member({ memberId: "nas" })] }), handover, T0)).toBeNull();
    expect(adoptSecret(peerStore(), { secret: "", generation: 9 }, T0)).toBeNull();
  });
});

describe("adoptLead / demoteSelf / promoteSelf", () => {
  // `peerStore()` is "laptop", enrolled by "desk"; the pack is promoting "nas".
  const claim = { memberId: "nas", fingerprint: fp("nas"), certPem: material("nas").certPem, address: "nas.example:8787" };

  test("a peer re-pins the new lead and keeps its id, its pack and its secret — a role change", () => {
    const before = peerStore();
    const change = adoptLead(before, claim, T0 + 9)!;
    expect(change.next.lead).toMatchObject({ memberId: "nas", fingerprint: fp("nas"), role: "lead" });
    expect(change.next.self.memberId).toBe(before.self.memberId);
    expect(change.next.pack).toEqual(before.pack);
    expect(change.next.peers).toEqual([]);
  });

  test("adopting the lead already pinned at that address changes nothing", () => {
    expect(
      adoptLead(peerStore(), { memberId: "desk", fingerprint: fp("desk"), certPem: material("desk").certPem, address: "desk.example:8787" }, T0),
    ).toBeNull();
  });

  test("a collie never adopts ITSELF as lead", () => {
    expect(adoptLead(peerStore(), { ...claim, memberId: "laptop" }, T0)).toBeNull();
  });

  test("the old lead steps down and hands over every enrolled peer except the new lead", () => {
    const store = leadStore({
      peers: [member({ memberId: "laptop" }), member({ memberId: "nas" }), member({ memberId: "old", status: "unenrolled" })],
    });
    const change = demoteSelf(store, claim, T0 + 1)!;
    expect(change.result.roster.map((r) => r.memberId)).toEqual(["laptop"]);
    expect(change.next.lead).toMatchObject({ memberId: "nas", role: "lead" });
    expect(change.next.peers).toEqual([]);
    // A roster row carries a public hash and a hint — never key material or the secret.
    expect(JSON.stringify(change.result.roster)).not.toContain(PACK.secret);
  });

  test("a peer asked to demote refuses — it has no roster to hand over", () => {
    expect(demoteSelf(peerStore(), claim, T0)).toBeNull();
    expect(demoteSelf(leadStore(), claim, T0)).toBeNull();
  });

  test("promoteSelf takes the roster it is GIVEN, so --force is the same code with an empty list", () => {
    const store = peerStore();
    const full = promoteSelf(
      store,
      [
        rosterEntryOf(member({ memberId: "desk", role: "lead" })),
        { memberId: "nas", fingerprint: fp("nas"), certPem: material("nas").certPem, address: "nas:1" },
      ],
      T0,
    )!;
    expect(full.next.lead).toBeNull();
    expect(full.next.peers.map((p) => p.memberId)).toEqual(["desk", "nas"]);
    expect(full.next.peers.every((p) => p.role === "peer" && p.secretGeneration === PACK.secretGeneration)).toBe(true);
    expect(full.next.pack).toEqual(store.pack);

    const forced = promoteSelf(store, [], T0)!;
    expect(forced.next.lead).toBeNull();
    expect(forced.next.peers).toEqual([]);
  });

  test("promotion never puts this collie in its own roster", () => {
    const change = promoteSelf(
      peerStore(),
      [{ memberId: "laptop", fingerprint: fp("laptop"), certPem: material("laptop").certPem, address: "x:1" }],
      T0,
    )!;
    expect(change.next.peers).toEqual([]);
  });
});

describe("updateMemberAddress", () => {
  test("moves the lead and leaves the pin alone — DHCP is not a trust decision", () => {
    const change = updateMemberAddress(peerStore(), "desk", "desk.other:8787")!;
    expect(change.next.lead!.address).toBe("desk.other:8787");
    expect(change.next.lead!.fingerprint).toBe(fp("desk"));
    expect(change.result.from).toBe("desk.example:8787");
  });

  test("moves a peer on the lead's roster", () => {
    const store = leadStore({ peers: [member({ memberId: "nas" })] });
    expect(updateMemberAddress(store, "nas", "nas.other:1")!.next.peers[0]!.address).toBe("nas.other:1");
  });

  test("an unknown member, an unchanged address and an empty address all write nothing", () => {
    expect(updateMemberAddress(peerStore(), "ghost", "somewhere:1")).toBeNull();
    expect(updateMemberAddress(peerStore(), "desk", "desk.example:8787")).toBeNull();
    expect(updateMemberAddress(peerStore(), "desk", "")).toBeNull();
  });
});

describe("parseRoster", () => {
  test("accepts a well-formed roster and normalises the fingerprint spelling", () => {
    const upper = fp("nas").toUpperCase().replace(/(..)(?=.)/g, "$1:");
    expect(
      parseRoster([{ memberId: "nas", fingerprint: upper, certPem: material("nas").certPem, address: "nas:1" }]),
    ).toEqual([{ memberId: "nas", fingerprint: fp("nas"), certPem: material("nas").certPem, address: "nas:1" }]);
  });

  test("one bad row rejects the whole roster — a partial roster is an unpinned member", () => {
    expect(
      parseRoster([
        { memberId: "nas", fingerprint: fp("nas"), certPem: material("nas").certPem, address: "nas:1" },
        { memberId: "!" },
      ]),
    ).toBeNull();
    expect(parseRoster("nope")).toBeNull();
    expect(parseRoster([{ memberId: "nas", fingerprint: "short", address: "a" }])).toBeNull();
    expect(
      parseRoster([{ memberId: "nas", fingerprint: fp("nas"), certPem: material("nas").certPem, address: "" }]),
    ).toBeNull();
    // The certificate and fingerprint must be the same certificate (§8.2) — a row that names one and
    // presents another is refused rather than pinned with the two disagreeing.
    expect(
      parseRoster([{ memberId: "nas", fingerprint: fp("nas"), certPem: material("stranger").certPem, address: "nas:1" }]),
    ).toBeNull();
  });
});

describe("isLeading", () => {
  test("is the roster's own answer, in the shape deriveMode reads", () => {
    expect(isLeading(leadStore({ peers: [member({ memberId: "nas" })] }))).toBe(true);
    expect(isLeading(leadStore())).toBe(false);
    expect(isLeading(peerStore())).toBe(false);
  });
});
