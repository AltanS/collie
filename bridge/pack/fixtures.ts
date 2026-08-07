import { createTrustStore, selfIdentity, type IdentityMaterial } from "./enrollment.ts";
import { mintIdentity } from "./identity.ts";
import type { ForwardTransport } from "./forward.ts";
import type { PackIdentity, TrustStoreData, TrustedMember } from "./trust-store.ts";

// Shared test fixtures for the pack modules. Not a test file itself (so `bun test` doesn't collect
// it) and not imported by any production path — it exists so five test files agree on what a member,
// a pack and a certificate fingerprint look like, rather than each inventing a plausible one.

export const T0 = 1_754_000_000_000;

/**
 * REAL minted material, one certificate per label, memoised for the process.
 *
 * It used to be a shaped placeholder (`-----BEGIN CERTIFICATE-----\n<label>\n…`) with a fingerprint
 * derived from the label, which was fine while nothing could parse a certificate. It is not fine now:
 * the enrollment and roster parsers re-derive the fingerprint FROM the certificate and refuse a
 * payload where the two disagree, and §8.6 verifies a signature against the pinned certificate's
 * public key. A fixture that could not survive those checks would let a test pass on a store the
 * production path would have rejected.
 *
 * Memoised because a test that builds the same member twice must get the same pin — and because
 * minting is the one thing in this file that costs anything (~1 ms per label).
 */
const minted = new Map<string, IdentityMaterial>();
export function material(label: string): IdentityMaterial {
  const cached = minted.get(label);
  if (cached !== undefined) return cached;
  const fresh = mintIdentity({ commonName: `collie-${label}`, sans: ["localhost", "127.0.0.1"] });
  minted.set(label, fresh);
  return fresh;
}

/** The canonical fingerprint of `label`'s certificate — the value a store would actually hold. */
export function fp(label: string): string {
  return material(label).fingerprint;
}

export const PACK: PackIdentity = {
  packId: "pack-1",
  name: "the herd",
  secret: "s3cret-value-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  secretGeneration: 1,
  rotatedAt: T0,
};

export function member(over: Partial<TrustedMember> & { memberId: string }): TrustedMember {
  return {
    fingerprint: fp(over.memberId),
    certPem: material(over.memberId).certPem,
    address: `${over.memberId}.example:8787`,
    role: "peer",
    status: "enrolled",
    enrolledAt: T0,
    secretGeneration: 1,
    signedAt: 0,
    ...over,
  };
}

/** A lead's store: its own identity, a pack, and whatever roster the test needs. */
export function leadStore(over: Partial<TrustStoreData> = {}): TrustStoreData {
  return {
    ...createTrustStore(selfIdentity("desk", material("desk"), T0)),
    pack: PACK,
    ...over,
  };
}

/** A peer's store: enrolled by `desk`, leading nobody. */
export function peerStore(over: Partial<TrustStoreData> = {}): TrustStoreData {
  return {
    ...createTrustStore(selfIdentity("laptop", material("laptop"), T0)),
    pack: PACK,
    lead: member({ memberId: "desk", role: "lead" }),
    ...over,
  };
}

/**
 * A forward transport that fails the test if it is ever dialled.
 *
 * The default for every `PackLead` a test builds to exercise the SWEEP: forwarding is a per-request
 * path, so a snapshot test that reaches it has found a bug rather than a missing stub.
 */
export const neverProxy: ForwardTransport = (link, route) => {
  throw new Error(`unexpected pack forward: ${route} → ${link.memberId}`);
};

/** Deterministic entropy: `r("a")` yields "a1", "a2", … so a minted value is assertable. */
export function counterRandom(prefix: string): (bytes: number) => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}
