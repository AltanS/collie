import { describe, expect, test } from "bun:test";

import type { JsonObject } from "../json.ts";

import { fp, leadStore, material, member, PACK, peerStore, T0 } from "./fixtures.ts";
import type { StoredWarrant, TrustStoreData, Warrant } from "./trust-store.ts";
import { parseTrustStore, serializeTrustStore } from "./trust-store.ts";
import {
  canonicalWarrant,
  checkWarrantPush,
  currentWarrant,
  discardForeignWarrant,
  mintWarrant,
  parseWarrant,
  parseWarrantReport,
  refreshWarrant,
  storeWarrant,
  verifyWarrantSignature,
  warrantExpired,
  warrantPushNeeded,
  warrantReportOf,
  warrantSupersedes,
  WARRANT_DOMAIN,
  WARRANT_REFRESH_INTERVAL_MS,
  WARRANT_TTL_MS,
} from "./warrant.ts";

// The warrant, as data. Everything here is a pure function of a store and a clock — no socket, no
// disk — so what is pinned below is the shipping rule and not a harness (CLAUDE.md).

/** A lead (`desk`) with two enrolled peers, one of which is a plausible deputy. */
function lead(over: Partial<TrustStoreData> = {}): TrustStoreData {
  return leadStore({
    peers: [member({ memberId: "nas" }), member({ memberId: "attic" })],
    ...over,
  });
}

/** Mint a warrant on `desk` naming `nas`, and hand back both halves. */
function named(now = T0) {
  const change = mintWarrant(lead(), "nas", now);
  if (change === null) throw new Error("fixture: expected a mint");
  return { data: change.next, warrant: change.result };
}

/**
 * A warrant as the JSON document it travels as. Written out field by field rather than spread,
 * because that is what lets a test bend ONE field without an assertion anywhere near it.
 */
function wireOf(w: Warrant): JsonObject {
  return {
    packId: w.packId,
    generation: w.generation,
    deputyMemberId: w.deputyMemberId,
    deputyFingerprint: w.deputyFingerprint,
    leadMemberId: w.leadMemberId,
    issuedAt: w.issuedAt,
    refreshedAt: w.refreshedAt,
    signature: w.signature,
  };
}

/** The push body a lead would send for `warrant`, with the deputy's real certificate. */
function push(warrant: Warrant, certLabel: string | null = warrant.deputyMemberId): JsonObject {
  return certLabel === null
    ? { warrant: wireOf(warrant) }
    : { warrant: wireOf(warrant), deputyCertPem: material(certLabel).certPem };
}

/** A peer (`laptop`) led by `desk`, optionally already holding a warrant. */
function peer(held?: StoredWarrant): TrustStoreData {
  return held === undefined ? peerStore() : peerStore({ warrant: held });
}

describe("the canonical string", () => {
  test("is eight LF-separated fields behind a fixed domain tag", () => {
    const { warrant } = named();
    const fields = canonicalWarrant(warrant).split("\n");
    expect(fields).toHaveLength(8);
    expect(fields[0]).toBe(WARRANT_DOMAIN);
    expect(fields).toEqual([
      WARRANT_DOMAIN,
      PACK.packId,
      "1",
      "desk",
      "nas",
      fp("nas"),
      String(T0),
      String(T0),
    ]);
  });

  test("a revocation writes `-` in both deputy fields, never an empty one", () => {
    const { data } = named();
    const change = mintWarrant(data, null, T0 + 1);
    const fields = canonicalWarrant(change!.result).split("\n");
    expect(fields[4]).toBe("-");
    expect(fields[5]).toBe("-");
    expect(fields).toHaveLength(8);
  });

  test("the domain tag keeps a warrant disjoint from §8.6's request string", () => {
    // Four fields there, eight here, and the first of these is a tag no request string can produce —
    // so the two can never verify as one another under the one key that signs both.
    const { warrant } = named();
    expect(canonicalWarrant(warrant).startsWith(`${WARRANT_DOMAIN}\n`)).toBe(true);
  });
});

describe("sign and verify", () => {
  test("round-trips against the pinned lead's certificate", () => {
    const { warrant } = named();
    expect(verifyWarrantSignature(warrant, material("desk").certPem)).toBe(true);
  });

  test("does not verify against any other member's certificate", () => {
    const { warrant } = named();
    expect(verifyWarrantSignature(warrant, material("nas").certPem)).toBe(false);
  });

  test("a tampered deputy is caught — the fingerprint is inside the signature", () => {
    const { warrant } = named();
    const forged: Warrant = { ...warrant, deputyMemberId: "attic", deputyFingerprint: fp("attic") };
    expect(verifyWarrantSignature(forged, material("desk").certPem)).toBe(false);
  });

  test("a tampered refreshedAt is caught — a refresh is a new signature, never a re-stamp", () => {
    const { warrant } = named();
    expect(verifyWarrantSignature({ ...warrant, refreshedAt: T0 + WARRANT_TTL_MS }, material("desk").certPem))
      .toBe(false);
  });

  test("a tampered generation is caught", () => {
    const { warrant } = named();
    expect(verifyWarrantSignature({ ...warrant, generation: 99 }, material("desk").certPem)).toBe(false);
  });

  test("a garbage signature and a garbage certificate are `false`, never a throw", () => {
    const { warrant } = named();
    expect(verifyWarrantSignature({ ...warrant, signature: "not-base64!!" }, material("desk").certPem)).toBe(false);
    expect(verifyWarrantSignature(warrant, "-----BEGIN CERTIFICATE-----\nnope\n")).toBe(false);
  });
});

describe("minting", () => {
  test("names an enrolled peer at generation 1 and writes the designation with it", () => {
    const { data, warrant } = named();
    expect(warrant.generation).toBe(1);
    expect(warrant.deputyMemberId).toBe("nas");
    expect(warrant.deputyFingerprint).toBe(fp("nas"));
    expect(warrant.leadMemberId).toBe("desk");
    expect(warrant.issuedAt).toBe(warrant.refreshedAt);
    expect(data.deputy).toBe("nas");
    expect(currentWarrant(data)?.warrant).toEqual(warrant);
  });

  test("the lead keeps no copy of the deputy's certificate — it pins it in its own roster", () => {
    const { data } = named();
    expect(currentWarrant(data)?.deputyCertPem).toBeNull();
  });

  test("refuses a member this lead does not pin, an unenrolled one, and itself", () => {
    expect(mintWarrant(lead(), "stranger", T0)).toBeNull();
    expect(mintWarrant(lead({ peers: [member({ memberId: "nas", status: "unenrolled" })] }), "nas", T0)).toBeNull();
    expect(mintWarrant(lead(), "desk", T0)).toBeNull();
  });

  test("refuses a member behind on the pack secret", () => {
    const stale = lead({ peers: [member({ memberId: "nas", secretGeneration: PACK.secretGeneration - 1 })] });
    expect(mintWarrant(stale, "nas", T0)).toBeNull();
  });

  test("refuses on a collie that does not lead", () => {
    expect(mintWarrant(peerStore({ peers: [member({ memberId: "nas" })] }), "nas", T0)).toBeNull();
  });

  test("naming a second deputy supersedes the first — it never adds one", () => {
    const first = named();
    const second = mintWarrant(first.data, "attic", T0 + 5)!;
    expect(second.result.generation).toBe(2);
    expect(second.result.deputyMemberId).toBe("attic");
    expect(currentWarrant(second.next)?.warrant.deputyMemberId).toBe("attic");
    expect(second.next.deputy).toBe("attic");
    expect(warrantSupersedes(first.warrant, second.result)).toBe(true);
  });

  test("a revocation is generation N+1 naming nobody, and the counter does not reset", () => {
    const { data } = named();
    const revoked = mintWarrant(data, null, T0 + 5)!;
    expect(revoked.result.generation).toBe(2);
    expect(revoked.result.deputyMemberId).toBeNull();
    expect(revoked.result.deputyFingerprint).toBeNull();
    expect(revoked.next.deputy).toBeNull();
    // …and the next real mint is 3, not 1 — a reset would make generation 1 verify again.
    expect(mintWarrant(revoked.next, "nas", T0 + 6)!.result.generation).toBe(3);
  });

  test("revoking when nothing is named writes nothing", () => {
    expect(mintWarrant(lead(), null, T0)).toBeNull();
  });
});

describe("refresh (RFC §4.5)", () => {
  test("re-signs the same generation with a new refreshedAt, once the interval has elapsed", () => {
    const { data, warrant } = named();
    const at = T0 + WARRANT_REFRESH_INTERVAL_MS;
    const change = refreshWarrant(data, at)!;
    expect(change.result.generation).toBe(warrant.generation);
    expect(change.result.deputyMemberId).toBe("nas");
    expect(change.result.issuedAt).toBe(T0);
    expect(change.result.refreshedAt).toBe(at);
    expect(change.result.signature).not.toBe(warrant.signature);
    expect(verifyWarrantSignature(change.result, material("desk").certPem)).toBe(true);
    expect(warrantSupersedes(warrant, change.result)).toBe(true);
  });

  test("writes nothing inside the interval — the wire budget is one body per member per hour", () => {
    const { data } = named();
    expect(refreshWarrant(data, T0 + WARRANT_REFRESH_INTERVAL_MS - 1)).toBeNull();
  });

  test("writes nothing when no warrant is held", () => {
    expect(refreshWarrant(lead(), T0 + WARRANT_REFRESH_INTERVAL_MS)).toBeNull();
  });

  test("REFUSES to refresh an expired warrant — a dark pack disarms rather than re-arming", () => {
    const { data } = named();
    expect(refreshWarrant(data, T0 + WARRANT_TTL_MS)).toBeNull();
    expect(refreshWarrant(data, T0 + WARRANT_TTL_MS + 1)).toBeNull();
  });

  test("a clock that jumped backwards cannot walk the warrant backwards", () => {
    const { data } = named();
    expect(refreshWarrant(data, T0 - WARRANT_REFRESH_INTERVAL_MS)).toBeNull();
  });

  test("a peer never refreshes the warrant it was pushed", () => {
    const { warrant } = named();
    const held = peer({ warrant, deputyCertPem: material("nas").certPem });
    expect(refreshWarrant(held, T0 + WARRANT_REFRESH_INTERVAL_MS)).toBeNull();
  });
});

describe("supersession and TTL", () => {
  const { warrant } = named();

  test("a higher generation always wins; a lower one is discarded", () => {
    expect(warrantSupersedes(warrant, { ...warrant, generation: 2 })).toBe(true);
    expect(warrantSupersedes({ ...warrant, generation: 2 }, warrant)).toBe(false);
  });

  test("a lower generation wins on NEITHER axis, however fresh its refreshedAt", () => {
    const old = { ...warrant, generation: 1, refreshedAt: T0 + WARRANT_TTL_MS };
    expect(warrantSupersedes({ ...warrant, generation: 2 }, old)).toBe(false);
  });

  test("inside one generation, only a strictly newer refreshedAt wins", () => {
    expect(warrantSupersedes(warrant, { ...warrant, refreshedAt: T0 + 1 })).toBe(true);
    expect(warrantSupersedes(warrant, warrant)).toBe(false);
    expect(warrantSupersedes(warrant, { ...warrant, refreshedAt: T0 - 1 })).toBe(false);
  });

  test("anything supersedes nothing", () => {
    expect(warrantSupersedes(null, warrant)).toBe(true);
    expect(warrantSupersedes(undefined, warrant)).toBe(true);
  });

  test("expiry is 30 days from the last refresh, on the reader's own clock", () => {
    expect(warrantExpired(warrant, T0)).toBe(false);
    expect(warrantExpired(warrant, T0 + WARRANT_TTL_MS - 1)).toBe(false);
    expect(warrantExpired(warrant, T0 + WARRANT_TTL_MS)).toBe(true);
    // A refresh moves the whole window, which is the point: a warrant is only ever as old as the
    // last time the pack was healthy.
    expect(warrantExpired({ ...warrant, refreshedAt: T0 + WARRANT_TTL_MS }, T0 + WARRANT_TTL_MS)).toBe(false);
  });
});

describe("parsing a warrant off the wire", () => {
  const { warrant } = named();
  const wire = wireOf(warrant);

  test("round-trips a well-formed one", () => {
    expect(parseWarrant(wire)).toEqual(warrant);
  });

  test("refuses a scalar, an array and a half-named deputy", () => {
    expect(parseWarrant("warrant")).toBeNull();
    expect(parseWarrant([])).toBeNull();
    expect(parseWarrant({ ...wire, deputyFingerprint: null })).toBeNull();
    expect(parseWarrant({ ...wire, deputyMemberId: null })).toBeNull();
  });

  test("refuses a bad generation, a bad member id and an empty signature", () => {
    expect(parseWarrant({ ...wire, generation: 0 })).toBeNull();
    expect(parseWarrant({ ...wire, generation: 1.5 })).toBeNull();
    expect(parseWarrant({ ...wire, leadMemberId: "Not An Id" })).toBeNull();
    expect(parseWarrant({ ...wire, signature: "" })).toBeNull();
  });

  test("accepts a revocation with both deputy fields null", () => {
    const revoked = mintWarrant(named().data, null, T0 + 5)!.result;
    expect(parseWarrant(wireOf(revoked))).toEqual(revoked);
  });
});

describe("checkWarrantPush — the receiving decision", () => {
  const { warrant } = named();

  test("accepts a verifying warrant with the deputy's real certificate", () => {
    const verdict = checkWarrantPush(peer(), push(warrant), T0);
    expect(verdict.kind).toBe("accept");
    if (verdict.kind !== "accept") return;
    expect(verdict.stored.warrant).toEqual(warrant);
    expect(verdict.stored.deputyCertPem).toBe(material("nas").certPem);
  });

  test("refuses a certificate that is not the one the fingerprint names", () => {
    const verdict = checkWarrantPush(peer(), push(warrant, "attic"), T0);
    expect(verdict).toEqual({ kind: "refuse", reason: "certificate-mismatch" });
  });

  test("refuses a warrant that names a deputy and carries no certificate at all", () => {
    expect(checkWarrantPush(peer(), { warrant: wireOf(warrant) }, T0)).toEqual({ kind: "refuse", reason: "certificate-mismatch" });
  });

  test("refuses a REVOCATION that carries a certificate — it names nobody, so it carries nothing", () => {
    const revoked = mintWarrant(named().data, null, T0 + 5)!.result;
    expect(checkWarrantPush(peer(), push(revoked, "nas"), T0 + 5)).toEqual({
      kind: "refuse",
      reason: "certificate-mismatch",
    });
    expect(checkWarrantPush(peer(), { warrant: wireOf(revoked) }, T0 + 5).kind).toBe("accept");
  });

  test("refuses a tampered warrant on the signature, not on the fingerprint", () => {
    const forged: Warrant = { ...warrant, deputyMemberId: "attic", deputyFingerprint: fp("attic") };
    expect(checkWarrantPush(peer(), push(forged), T0)).toEqual({ kind: "refuse", reason: "bad-signature" });
  });

  test("refuses a warrant signed by a member that is not this collie's lead", () => {
    // Same warrant, a peer whose lead is somebody else entirely.
    const elsewhere = peerStore({ lead: member({ memberId: "attic", role: "lead" }) });
    expect(checkWarrantPush(elsewhere, push(warrant), T0)).toEqual({ kind: "refuse", reason: "foreign" });
  });

  test("refuses a warrant for another pack", () => {
    const other = { ...warrant, packId: "pack-2" };
    expect(checkWarrantPush(peer(), push(other), T0)).toEqual({ kind: "refuse", reason: "foreign" });
  });

  test("refuses on a collie with no store, no pack, or no lead", () => {
    expect(checkWarrantPush(null, push(warrant), T0)).toEqual({ kind: "refuse", reason: "foreign" });
    expect(checkWarrantPush(lead(), push(warrant), T0)).toEqual({ kind: "refuse", reason: "foreign" });
    expect(checkWarrantPush(peerStore({ pack: null }), push(warrant), T0)).toEqual({
      kind: "refuse",
      reason: "foreign",
    });
  });

  test("refuses a malformed body before it asks anything about trust", () => {
    expect(checkWarrantPush(peer(), {}, T0)).toEqual({ kind: "refuse", reason: "malformed" });
    expect(checkWarrantPush(peer(), "warrant", T0)).toEqual({ kind: "refuse", reason: "malformed" });
  });

  test("refuses one past its 30 days on this collie's own clock", () => {
    expect(checkWarrantPush(peer(), push(warrant), T0 + WARRANT_TTL_MS - 1).kind).toBe("accept");
    expect(checkWarrantPush(peer(), push(warrant), T0 + WARRANT_TTL_MS)).toEqual({
      kind: "refuse",
      reason: "expired",
    });
  });

  test("an OLD generation is refused as stale, and the peer keeps what it holds", () => {
    const second = mintWarrant(named().data, "attic", T0 + 5)!.result;
    const holding = peer({ warrant: second, deputyCertPem: material("attic").certPem });
    expect(checkWarrantPush(holding, push(warrant), T0 + 6)).toEqual({ kind: "stale", generation: 2 });
  });

  test("a redelivery of the same generation and refresh is stale, not an error", () => {
    const holding = peer({ warrant, deputyCertPem: material("nas").certPem });
    expect(checkWarrantPush(holding, push(warrant), T0)).toEqual({ kind: "stale", generation: 1 });
  });

  test("a refreshed signature of the SAME generation is accepted", () => {
    const holding = peer({ warrant, deputyCertPem: material("nas").certPem });
    const refreshed = refreshWarrant(named().data, T0 + WARRANT_REFRESH_INTERVAL_MS)!.result;
    const verdict = checkWarrantPush(holding, push(refreshed), T0 + WARRANT_REFRESH_INTERVAL_MS);
    expect(verdict.kind).toBe("accept");
  });

  test("a refusal is decided before supersession, so it can never displace what is held", () => {
    const holding = peer({ warrant, deputyCertPem: material("nas").certPem });
    const forged: Warrant = { ...warrant, generation: 9, signature: warrant.signature };
    expect(checkWarrantPush(holding, push(forged), T0)).toEqual({ kind: "refuse", reason: "bad-signature" });
  });
});

describe("storing", () => {
  test("writes the warrant and NOT the designation — that field is the lead's", () => {
    const { warrant } = named();
    const stored: StoredWarrant = { warrant, deputyCertPem: material("nas").certPem };
    const change = storeWarrant(peer(), stored);
    expect(change.next.warrant).toEqual(stored);
    expect(change.next.deputy).toBeUndefined();
    expect(change.audit.action).toBe("pack.warrant.stored");
  });
});

describe("a warrant from a pack this collie is not in (the incident)", () => {
  test("a FOREIGN warrant is discarded, with the deputy fields that rode with it", () => {
    const { warrant } = named();
    const held = peerStore({
      warrant: { warrant: { ...warrant, packId: "pack-elsewhere" }, deputyCertPem: null },
      deputy: "nas",
      standbyRoster: [{ memberId: "nas", fingerprint: fp("nas"), certPem: material("nas").certPem, address: "nas.example:8787" }],
    });
    const change = discardForeignWarrant(held)!;
    expect(change.next.warrant).toBeNull();
    expect(change.next.standbyRoster).toBeNull();
    expect(change.next.deputy).toBeNull();
    expect(change.result).toEqual({ packId: "pack-elsewhere", generation: warrant.generation });
    expect(change.audit.action).toBe("pack.warrant.foreign");
  });

  test("this pack's OWN warrant is left alone, and so is a store holding none", () => {
    const { warrant } = named();
    expect(discardForeignWarrant(peer({ warrant, deputyCertPem: null }))).toBeNull();
    expect(discardForeignWarrant(peerStore())).toBeNull();
    expect(discardForeignWarrant(leadStore({ pack: null }))).toBeNull();
  });
});

describe("the report a member makes, and what the lead does with it", () => {
  const { data, warrant } = named();

  test("reports the generation and the refresh it holds, or nothing at all", () => {
    expect(warrantReportOf(data)).toEqual({ generation: 1, refreshedAt: T0 });
    expect(warrantReportOf(lead())).toBeNull();
    expect(warrantReportOf(null)).toBeNull();
  });

  test("an ABSENT pair reads as unknown, never as up to date", () => {
    expect(parseWarrantReport({ member: "nas", protocol: 1 })).toBeNull();
    expect(warrantPushNeeded(warrant, null)).toBe(true);
  });

  test("a HALF-reported pair is exactly as unknown as an absent one", () => {
    expect(parseWarrantReport({ warrantGeneration: 1 })).toBeNull();
    expect(parseWarrantReport({ warrantRefreshedAt: T0 })).toBeNull();
    expect(parseWarrantReport({ warrantGeneration: "1", warrantRefreshedAt: T0 })).toBeNull();
    expect(parseWarrantReport("hello")).toBeNull();
  });

  test("a member at this exact generation and refresh is NOT re-pushed", () => {
    expect(warrantPushNeeded(warrant, { generation: 1, refreshedAt: T0 })).toBe(false);
  });

  test("a member behind on generation, or on the refresh, IS re-pushed", () => {
    expect(warrantPushNeeded({ ...warrant, generation: 2 }, { generation: 1, refreshedAt: T0 })).toBe(true);
    expect(warrantPushNeeded({ ...warrant, refreshedAt: T0 + 1 }, { generation: 1, refreshedAt: T0 })).toBe(true);
  });

  test("a member AHEAD of this lead is not pushed to — a push only ever moves a member forward", () => {
    expect(warrantPushNeeded(warrant, { generation: 2, refreshedAt: T0 })).toBe(false);
    expect(warrantPushNeeded(warrant, { generation: 1, refreshedAt: T0 + 1 })).toBe(false);
  });

  test("a lead with no warrant pushes nothing, whatever a member reports", () => {
    expect(warrantPushNeeded(null, null)).toBe(false);
    expect(warrantPushNeeded(null, { generation: 1, refreshedAt: T0 })).toBe(false);
  });
});

describe("the trust store carries it (RFC §11.4)", () => {
  test("a warrant and a designation survive a save→load round trip", () => {
    const { data } = named();
    const back = parseTrustStore(serializeTrustStore(data));
    expect(back?.deputy).toBe("nas");
    expect(back?.warrant).toEqual(data.warrant!);
  });

  test("a peer's stored certificate survives it too — the second anchor depends on those bytes", () => {
    const stored: StoredWarrant = { warrant: named().warrant, deputyCertPem: material("nas").certPem };
    const back = parseTrustStore(serializeTrustStore(peer(stored)));
    expect(back?.warrant?.deputyCertPem).toBe(material("nas").certPem);
  });

  test("a store written before the fields existed reads as no deputy, and round-trips unchanged", () => {
    const before = serializeTrustStore(lead());
    const back = parseTrustStore(before);
    expect(back).not.toBeNull();
    expect(back?.deputy).toBeUndefined();
    expect(back?.warrant).toBeUndefined();
    expect(currentWarrant(back)).toBeNull();
    expect(serializeTrustStore(back!)).toBe(before);
  });

  test("a MALFORMED warrant invalidates the whole store, and is never read around", () => {
    const { data, warrant } = named();
    const bent = { ...data, warrant: { warrant: { ...warrant, deputyFingerprint: "nope" }, deputyCertPem: null } };
    expect(parseTrustStore(serializeTrustStore(bent))).toBeNull();
  });

  test("a half-named deputy inside a stored warrant invalidates it too", () => {
    const { data, warrant } = named();
    const bent = { ...data, warrant: { warrant: { ...warrant, deputyMemberId: null }, deputyCertPem: null } };
    expect(parseTrustStore(serializeTrustStore(bent))).toBeNull();
  });

  test("a malformed designation invalidates the whole store too", () => {
    expect(parseTrustStore(serializeTrustStore(lead({ deputy: "Not An Id" })))).toBeNull();
  });

  test("an explicit null designation is kept as null, not collapsed into absent", () => {
    const revoked = mintWarrant(named().data, null, T0 + 5)!.next;
    const raw = serializeTrustStore(revoked);
    expect(raw).toContain('"deputy": null');
    expect(parseTrustStore(raw)?.deputy).toBeNull();
  });
});

// ── THE LIVE DRILL, BUG 2's other half ───────────────────────────────────────
test("naming a deputy clears the takeover's spent stamp — the question it answers no longer applies", () => {
  const took = { ...lead(), deputy: null, deputySpentAt: T0 - 5000 };
  const change = mintWarrant(took, "nas", T0);
  expect(change).not.toBeNull();
  expect(change!.next.deputy).toBe("nas");
  expect(change!.next.deputySpentAt).toBeNull();
});

// ── THE WARRANT SURVIVES AN UPDATE RESTART (M16/04) ──────────────────────────
// A peer following its lead restarts itself. That restart is not special: the warrant is persisted
// in the trust store, so it survives an update exactly as it survives a `systemctl restart` — which
// is what the manual drill on 2026-09-03 demonstrated. Nothing in the follow path may touch it.

test("the deputy warrant survives an update restart — it is store state, not process state", () => {
  const { data } = named();
  // What a restarted process does: re-read the file it left behind. An update rewrites the binary
  // and the bundle; it does not rewrite `pack-trust.json`.
  const reread = parseTrustStore(serializeTrustStore(data));
  expect(reread).not.toBeNull();
  expect(reread!.warrant).toEqual(data.warrant!);
  expect(reread!.deputy).toBe(data.deputy);
  // And the ARMED reading is the same one, so a deputy that was armed before the update is armed
  // after it. `warrantActiveGeneration` (§18.17) stays threaded into the router once at boot, which
  // is exactly what a restart re-does.
  expect(currentWarrant(reread)).toEqual(currentWarrant(data));
});

test("a follow-driven restart writes no warrant field — the update path never touches the store", async () => {
  // Mechanical, and deliberately so: the guarantee above is only worth anything while nothing in the
  // follow path can write the field. `bridge/pack/follow.ts` reads a run record and spawns a
  // command; it has no trust store at all.
  const follow = await Bun.file(new URL("./follow.ts", import.meta.url)).text();
  expect(follow).not.toContain('from "./trust-store.ts"');
  expect(follow).not.toContain("StoredWarrant");
  expect(follow).not.toContain("mintWarrant");
  expect(follow).not.toContain("storeWarrant");
});
