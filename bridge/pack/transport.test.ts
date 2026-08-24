import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { selfIdentity } from "./enrollment.ts";
import { mintIdentity } from "./identity.ts";
import { fp, leadStore, material, member, peerStore, T0 } from "./fixtures.ts";
import type { StoredWarrant, TrustStoreData } from "./trust-store.ts";
import { dialTls, peerListenerTls } from "./transport.ts";
import { mintWarrant, WARRANT_TTL_MS } from "./warrant.ts";

/**
 * A warrant `desk` really signed, naming `nas`, with `nas`'s real certificate beside it — the shape a
 * peer holds after §18.5's push. Minted rather than hand-written: the anchor decision verifies the
 * signature and re-derives the fingerprint from the certificate, so a shaped placeholder would let a
 * test pass on a store the production path refuses.
 */
function stored(over: Partial<StoredWarrant["warrant"]> = {}, now = T0): StoredWarrant {
  const change = mintWarrant(
    leadStore({ peers: [member({ memberId: "nas" }), member({ memberId: "attic" })] }),
    "nas",
    now,
  );
  if (change === null) throw new Error("fixture: expected a mint");
  return { warrant: { ...change.result, ...over }, deputyCertPem: material("nas").certPem };
}

/** A peer of `desk` holding `warrant`. */
function anchored(warrant: StoredWarrant | null): TrustStoreData {
  return peerStore({ warrant });
}

describe("the peer's pinned listener", () => {
  test("a peer anchors on its lead's certificate, and demands one back", () => {
    const store = peerStore();
    const tls = peerListenerTls("peer", store);
    expect(tls).not.toBeNull();
    expect(tls!.cert).toBe(store.self.certPem);
    expect(tls!.key).toBe(store.self.keyPem);
    // EXACTLY ONE anchor — a peer has no peers (§4), so anything else in this list would be a
    // machine that could reach this pane family without being anyone's lead.
    expect(tls!.ca).toEqual([store.lead!.certPem]);
    expect(tls!.requestCert).toBe(true);
    expect(tls!.rejectUnauthorized).toBe(true);
  });

  // ── The second anchor (§18.5, RFC §5 phase 2) ──────────────────────────────
  // The rule under every case below: the deputy's certificate joins the list **iff** the stored
  // warrant verifies against the certificate this peer already pinned as its lead's. Every refusal
  // leaves EXACTLY today's single anchor — never zero, so no clause here can take a working pack
  // down, and never three.

  test("a verified warrant adds the deputy's certificate — and only ever as a SECOND anchor", () => {
    const tls = peerListenerTls("peer", anchored(stored()), T0);
    expect(tls!.ca).toEqual([material("desk").certPem, material("nas").certPem]);
    // The lead's own certificate is still first and still there: an existing lead's handshake is
    // unaffected by any of this, which is why the widening is not a wire change (RFC §11.5).
    expect(tls!.ca[0]).toBe(anchored(null).lead!.certPem);
  });

  test("no warrant at all is exactly today: one anchor", () => {
    expect(peerListenerTls("peer", anchored(null), T0)!.ca).toEqual([material("desk").certPem]);
    // Absent and explicitly-null are the same answer here, and both are the closed one.
    expect(peerListenerTls("peer", peerStore(), T0)!.ca).toHaveLength(1);
  });

  test("a TAMPERED warrant anchors nobody — the signature is the whole question", () => {
    // Bend one signed field. `nas` is still named, its certificate still matches its fingerprint, and
    // the store still parses — the ONLY thing wrong is that `desk` did not sign this.
    const bent = stored({ generation: 99 });
    expect(peerListenerTls("peer", anchored(bent), T0)!.ca).toEqual([material("desk").certPem]);
  });

  test("an EXPIRED warrant anchors nobody — a dark pack disarms at the transport too", () => {
    const at = T0 + WARRANT_TTL_MS;
    expect(peerListenerTls("peer", anchored(stored()), at)!.ca).toEqual([material("desk").certPem]);
    // One millisecond earlier it is still alive, so the clause is the clock and not the shape.
    expect(peerListenerTls("peer", anchored(stored()), at - 1)!.ca).toHaveLength(2);
  });

  test("a REVOCATION names nobody, so it anchors nobody", () => {
    const revoked: StoredWarrant = {
      warrant: { ...stored().warrant, deputyMemberId: null, deputyFingerprint: null },
      deputyCertPem: null,
    };
    expect(peerListenerTls("peer", anchored(revoked), T0)!.ca).toEqual([material("desk").certPem]);
  });

  test("a certificate that is not the fingerprint's is refused — BoringSSL anchors on CERTIFICATES", () => {
    // §8.2's enrollment rule, one layer down: a hash cannot be enforced, so what is anchored must be
    // provably the certificate the signed fingerprint names. Here it is `attic`'s, under `nas`'s name.
    const swapped: StoredWarrant = { ...stored(), deputyCertPem: material("attic").certPem };
    expect(peerListenerTls("peer", anchored(swapped), T0)!.ca).toEqual([material("desk").certPem]);
    // …and with no certificate at all there is nothing to anchor, however good the signature is.
    expect(peerListenerTls("peer", anchored({ ...stored(), deputyCertPem: null }), T0)!.ca).toHaveLength(1);
  });

  test("a warrant from a member this peer does not follow anchors nobody", () => {
    // Signed by `desk`, verifiable by anyone holding `desk`'s certificate — but this peer follows
    // `nas`, so `desk` is not the member whose consent it accepts. A warrant is not a bearer token.
    const elsewhere = peerStore({ lead: member({ memberId: "nas", role: "lead" }), warrant: stored() });
    expect(peerListenerTls("peer", elsewhere, T0)!.ca).toEqual([material("nas").certPem]);
  });

  test("a warrant naming THIS collie, or its own lead, adds no anchor — both are already there", () => {
    // The deputy is this peer itself: anchoring its own certificate would name no member it cannot
    // already reach, and it must not inflate the list.
    const asDeputy: TrustStoreData = {
      ...peerStore({ warrant: stored() }),
      self: selfIdentity("nas", material("nas"), T0),
    };
    expect(peerListenerTls("peer", asDeputy, T0)!.ca).toEqual([material("desk").certPem]);

    // And the degenerate case the other way: a warrant naming the very member this peer follows.
    const namesLead: StoredWarrant = {
      warrant: { ...stored().warrant, deputyMemberId: "desk", deputyFingerprint: fp("desk") },
      deputyCertPem: material("desk").certPem,
    };
    expect(peerListenerTls("peer", anchored(namesLead), T0)!.ca).toEqual([material("desk").certPem]);
  });

  test("a lead pins nothing: its surface rides a front door that terminates TLS", () => {
    expect(peerListenerTls("lead", leadStore({ peers: [member({ memberId: "laptop" })] }))).toBeNull();
  });

  test("a solo instance has no listener TLS and no store to build it from", () => {
    expect(peerListenerTls("solo", null)).toBeNull();
    expect(peerListenerTls("peer", null)).toBeNull();
  });

  test("a peer whose lead is unenrolled or certificate-less pins NOTHING, and so admits nothing", () => {
    // Fail-closed, and the reason it is expressed as `null` rather than as a relaxed listener: the
    // caller turns `null` into `transportPinned: false`, and admission then refuses every request.
    // A listener built without `ca` would have been a pack running on the secret alone.
    expect(peerListenerTls("peer", peerStore({ lead: member({ memberId: "desk", role: "lead", status: "unenrolled" }) }))).toBeNull();
    expect(peerListenerTls("peer", peerStore({ lead: member({ memberId: "desk", role: "lead", certPem: "" }) }))).toBeNull();
    expect(peerListenerTls("peer", peerStore({ lead: null }))).toBeNull();
  });

  test("a membership change re-pins ONLY through a restart — there is no live reload path", () => {
    // `server.reload({ tls })` does NOT swap a pinned `ca` on Bun 1.3.14 (measured; a member added
    // after bind is still refused at the handshake). So the listener's anchors are a pure function of
    // the trust store AS IT WAS AT BOOT, and the only thing that changes them is a new process —
    // which is exactly why every membership verb restarts the bridge (`applyLocally`, cli/pack.ts).
    const before = peerListenerTls("peer", peerStore());
    const rotated = peerStore({ lead: member({ memberId: "nas", role: "lead" }) });
    const after = peerListenerTls("peer", rotated);
    expect(after!.ca).toEqual([material("nas").certPem]);
    expect(after!.ca).not.toEqual(before!.ca);

    // The structural half of the same claim: nothing in the bridge calls `reload`, so no code path
    // could believe it re-pinned. A grep, because the alternative is a live server.
    for (const file of ["server.ts", "index.ts"]) {
      const src = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect(src).not.toMatch(/\.reload\(/);
    }
  });
});

describe("the dialling side", () => {
  test("it pins the member's certificate and neutralises the NAME check", () => {
    const store = leadStore({ peers: [member({ memberId: "laptop" })] });
    const tls = dialTls(store, store.peers[0]!);
    expect(tls).not.toBeNull();
    expect(tls!.ca).toEqual([material("laptop").certPem]);
    expect(tls!.rejectUnauthorized).toBe(true);
    // §4: an address is a hint the operator may re-point, so a member that roams must not become
    // untrusted because its SAN no longer covers where it is dialled. Identity is the certificate.
    // The name check is therefore made TAUTOLOGICAL — SNI is a name the pinned certificate itself
    // carries, so it can only ever match — rather than switched off with a callback, which Bun 1.4
    // refuses to pool a connection for (§10.4 depends on that pooling).
    expect(tls!.serverName).toBe("localhost");
    expect(tls!.checkServerIdentity).toBeUndefined();
  });

  test("a certificate that names nothing falls back to the callback", () => {
    const store = leadStore({ peers: [member({ memberId: "laptop" })] });
    const nameless = mintIdentity({ commonName: "collie-nameless" });
    const tls = dialTls(store, { certPem: nameless.certPem });
    expect(tls!.serverName).toBeUndefined();
    expect(tls!.checkServerIdentity).toBeInstanceOf(Function);
    expect(tls!.checkServerIdentity!()).toBeUndefined();
  });

  test("it presents THIS collie's own certificate, so the far side can pin back", () => {
    const store = leadStore({ peers: [member({ memberId: "laptop" })] });
    const tls = dialTls(store, store.peers[0]!);
    expect(tls!.cert).toBe(store.self.certPem);
    expect(tls!.key).toBe(store.self.keyPem);
  });

  test("a member with no certificate is not dialled unpinned — it is not dialled", () => {
    expect(dialTls(leadStore(), { certPem: "" })).toBeNull();
    expect(dialTls(null, { certPem: material("laptop").certPem })).toBeNull();
  });
});
