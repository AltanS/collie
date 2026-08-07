import { describe, expect, test } from "bun:test";

import {
  bearerToken,
  fingerprintFromDer,
  hashToken,
  isFingerprint,
  isMemberId,
  mintMemberId,
  normalizeFingerprint,
  randomToken,
  secretEquals,
  slugifyMemberId,
} from "./identity.ts";
import { counterRandom } from "./fixtures.ts";

describe("member ids", () => {
  test("the grammar is exactly PACK_PROTOCOL.md §4's, anchored on both ends", () => {
    expect(isMemberId("a")).toBe(true);
    expect(isMemberId("laptop-2")).toBe(true);
    expect(isMemberId("a".repeat(63))).toBe(true);
    expect(isMemberId("a".repeat(64))).toBe(false);
    expect(isMemberId("-leading")).toBe(false);
    expect(isMemberId("Upper")).toBe(false);
    expect(isMemberId("has space")).toBe(false);
    expect(isMemberId("has/slash")).toBe(false);
    expect(isMemberId("")).toBe(false);
    expect(isMemberId("ok\nnot")).toBe(false);
    expect(isMemberId(42)).toBe(false);
  });

  test("a label slugs, and a label with nothing usable in it slugs to null rather than to a guess", () => {
    expect(slugifyMemberId("Altan's Laptop")).toBe("altan-s-laptop");
    expect(slugifyMemberId("  NAS  ")).toBe("nas");
    expect(slugifyMemberId("!!!")).toBeNull();
    expect(slugifyMemberId("")).toBeNull();
    expect(slugifyMemberId("-".repeat(5))).toBeNull();
  });

  test("minting prefers the label, falls back to random, and never collides", () => {
    expect(mintMemberId("laptop", new Set(), counterRandom("x"))).toBe("laptop");
    expect(mintMemberId("laptop", new Set(["laptop"]), counterRandom("x"))).toBe("laptop-x1");
    expect(mintMemberId(null, new Set(), counterRandom("x"))).toBe("collie-x1");
    expect(mintMemberId("!!!", new Set(), counterRandom("x"))).toBe("collie-x1");
  });

  test("every minted id satisfies the grammar it will travel on a URL as", () => {
    for (const label of [null, "laptop", "Altan's Laptop", "!!!", "A".repeat(80)]) {
      expect(isMemberId(mintMemberId(label, new Set(["laptop"])))).toBe(true);
    }
  });
});

describe("fingerprints", () => {
  test("the canonical form is 64 lowercase hex, and only that", () => {
    expect(isFingerprint("a".repeat(64))).toBe(true);
    expect(isFingerprint("A".repeat(64))).toBe(false);
    expect(isFingerprint("a".repeat(63))).toBe(false);
    expect(isFingerprint("zz" + "a".repeat(62))).toBe(false);
  });

  test("every spelling openssl or a config file might carry normalizes to one value", () => {
    const canonical = "a".repeat(64);
    const colons = canonical.match(/../g)!.join(":").toUpperCase();
    expect(normalizeFingerprint(colons)).toBe(canonical);
    expect(normalizeFingerprint(`SHA256:${colons}`)).toBe(canonical);
    expect(normalizeFingerprint(`sha-256=${canonical}`)).toBe(canonical);
    expect(normalizeFingerprint(`  ${canonical}  `)).toBe(canonical);
    expect(normalizeFingerprint("not a fingerprint")).toBeNull();
    expect(normalizeFingerprint(canonical.slice(1))).toBeNull();
  });

  test("a fingerprint is the SHA-256 of the DER — stable, and different for different bytes", () => {
    const der = new Uint8Array([1, 2, 3]);
    expect(fingerprintFromDer(der)).toBe(fingerprintFromDer(new Uint8Array([1, 2, 3])));
    expect(fingerprintFromDer(der)).not.toBe(fingerprintFromDer(new Uint8Array([1, 2, 4])));
    expect(isFingerprint(fingerprintFromDer(der))).toBe(true);
  });
});

describe("secrets and tokens", () => {
  test("randomToken is URL-safe and does not repeat", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(randomToken());
    expect(Buffer.from(a, "base64url").length).toBe(32);
  });

  test("secretEquals matches equal values and refuses everything else, including empties", () => {
    expect(secretEquals("abc", "abc")).toBe(true);
    expect(secretEquals("abc", "abd")).toBe(false);
    // Unequal LENGTHS must not throw (timingSafeEqual does) and must not leak — both sides are
    // hashed to a fixed width before the comparison.
    expect(secretEquals("a", "aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(secretEquals("", "abc")).toBe(false);
    expect(secretEquals("abc", "")).toBe(false);
    expect(secretEquals(null, null)).toBe(false);
    expect(secretEquals(undefined, "abc")).toBe(false);
  });

  test("a token is stored as its hash, so a leaked store yields nothing spendable", () => {
    const token = randomToken();
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);
    expect(hashToken(`${token}x`)).not.toBe(hash);
  });
});

describe("bearerToken", () => {
  test("parses the Bearer scheme and nothing else", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("  Bearer   abc  ")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("abc")).toBeNull();
    expect(bearerToken("Bearer ")).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken("")).toBeNull();
  });
});
