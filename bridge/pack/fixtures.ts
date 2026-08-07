import { createTrustStore, selfIdentity, type IdentityMaterial } from "./enrollment.ts";
import type { ForwardTransport } from "./forward.ts";
import type { PackIdentity, TrustStoreData, TrustedMember } from "./trust-store.ts";

// Shared test fixtures for the pack modules. Not a test file itself (so `bun test` doesn't collect
// it) and not imported by any production path — it exists so five test files agree on what a member,
// a pack and a certificate fingerprint look like, rather than each inventing a plausible one.

/** A fingerprint-shaped value: 64 lowercase hex chars, derived from a label so it reads in failures. */
export function fp(label: string): string {
  const seed = label.padEnd(8, "-");
  let out = "";
  for (let i = 0; i < 32; i++) out += (seed.charCodeAt(i % seed.length) % 256).toString(16).padStart(2, "0");
  return out;
}

export const T0 = 1_754_000_000_000;

export function material(label: string): IdentityMaterial {
  return {
    certPem: `-----BEGIN CERTIFICATE-----\n${label}\n-----END CERTIFICATE-----\n`,
    keyPem: `-----BEGIN PRIVATE KEY-----\n${label}\n-----END PRIVATE KEY-----\n`,
    fingerprint: fp(label),
  };
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
    address: `${over.memberId}.example:8787`,
    role: "peer",
    status: "enrolled",
    enrolledAt: T0,
    secretGeneration: 1,
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
