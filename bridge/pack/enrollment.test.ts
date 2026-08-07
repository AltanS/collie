import { describe, expect, test } from "bun:test";

import { AuditLog, type AuditEntry } from "../audit.ts";
import {
  acceptEnrollment,
  commitPackChange,
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
  unmintableIdentity,
} from "./enrollment.ts";
import { hashToken, isMemberId } from "./identity.ts";
import { TrustStore, type TrustStoreData, type TrustStoreIo } from "./trust-store.ts";
import { counterRandom, fp, leadStore, material, member, PACK, peerStore, T0 } from "./fixtures.ts";

const R = () => counterRandom("r");

describe("this collie's own identity", () => {
  test("the default minter REFUSES rather than enrolling with an unpinnable certificate", async () => {
    // The stub is the honest state of the world: nothing in this dependency tree can issue an X.509
    // certificate. Enrollment fails loudly instead of pinning a placeholder.
    await expect(unmintableIdentity()).rejects.toThrow(/certificate minting is not wired/);
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
    expect(JSON.stringify(next)).not.toContain(result.token);
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
    const first = consumeInvite(data, token, T0 + 1);
    expect(first.result).not.toBeNull();
    expect(first.next.invites).toEqual([]);
    expect(consumeInvite(first.next, token, T0 + 2).result).toBeNull();
  });

  test("a wrong, absent or expired token is refused", () => {
    expect(consumeInvite(data, "wrong", T0 + 1).result).toBeNull();
    expect(consumeInvite(data, null, T0 + 1).result).toBeNull();
    expect(consumeInvite(data, token, T0 + INVITE_TTL_MS + 1).result).toBeNull();
  });

  test("an expired invite is swept even when the spend fails", () => {
    const after = consumeInvite(data, "wrong", T0 + INVITE_TTL_MS + 1);
    expect(after.next.invites).toEqual([]);
  });

  test("the audit line records only whether it was accepted", () => {
    expect(consumeInvite(data, token, T0 + 1).audit).toEqual({
      action: "pack.invite.spend",
      detail: { accepted: true },
    });
  });
});

describe("the exchange — §8.2's transfer table, both directions", () => {
  const lead = leadStore();

  test("the lead pins the peer, mints its id, and hands back every listed item", () => {
    const change = enrollPeer(lead, { fingerprint: fp("laptop"), address: "laptop.ts.net:8787", label: "laptop" }, T0, R())!;
    expect(change.next.peers).toEqual([
      {
        memberId: "laptop",
        fingerprint: fp("laptop"),
        address: "laptop.ts.net:8787",
        role: "peer",
        status: "enrolled",
        enrolledAt: T0,
        secretGeneration: 1,
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
    });
  });

  test("a collie with no pack cannot enroll anybody", () => {
    expect(enrollPeer(leadStore({ pack: null }), { fingerprint: fp("x"), address: "a", label: null }, T0)).toBeNull();
  });

  test("a member id never collides with an existing peer or with the lead itself", () => {
    const crowded = leadStore({ peers: [member({ memberId: "laptop" })] });
    const minted = enrollPeer(crowded, { fingerprint: fp("other"), address: "a", label: "laptop" }, T0, R())!;
    expect(minted.result.memberId).toBe("laptop-r1");
    const asLead = enrollPeer(leadStore(), { fingerprint: fp("other"), address: "a", label: "desk" }, T0, R())!;
    expect(asLead.result.memberId).toBe("desk-r1");
    expect(isMemberId(asLead.result.memberId)).toBe(true);
  });

  test("a RE-JOIN keeps the member id and re-pins — the documented recovery from a missed rotation", () => {
    const dropped = leadStore({ peers: [member({ memberId: "laptop", fingerprint: fp("laptop"), status: "unenrolled" })] });
    const again = enrollPeer(dropped, { fingerprint: fp("laptop"), address: "new.addr:1", label: "whatever" }, T0 + 5, R())!;
    expect(again.result.memberId).toBe("laptop");
    expect(again.next.peers).toHaveLength(1);
    expect(again.next.peers[0]!.status).toBe("enrolled");
    expect(again.next.peers[0]!.address).toBe("new.addr:1");
    expect(again.audit.detail!.rejoin).toBe(true);
  });

  test("the peer adopts the pack, pins the lead, and takes the id the lead minted", () => {
    const joining = createTrustStore(selfIdentity("placeholder", material("laptop"), T0));
    const res = enrollPeer(lead, { fingerprint: fp("laptop"), address: "a", label: "laptop" }, T0, R())!.result;
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
      address: "desk.ts.net:8787",
      role: "lead",
      status: "enrolled",
      enrolledAt: T0 + 1,
      secretGeneration: 1,
    });
  });

  test("a peer's roster gains EXACTLY one entry — a peer has no peers", () => {
    const confused = { ...peerStore(), peers: [member({ memberId: "nas" })] };
    const res = enrollPeer(lead, { fingerprint: fp("laptop"), address: "a", label: "laptop" }, T0, R())!.result;
    expect(acceptEnrollment(confused, res, "a", T0).next.peers).toEqual([]);
  });
});

describe("the exchange — parsing untrusted payloads", () => {
  const req = { protocol: 1, token: "t", fingerprint: fp("laptop"), address: "a:1", label: "laptop" };

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
    expect(await commitPackChange(store, h.audit, (d) => removeMember(d!, "nas"))).toBeNull();
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
