import { describe, expect, test } from "bun:test";
import { sign, verify, X509Certificate } from "node:crypto";

import {
  bearerToken,
  derInteger,
  fingerprintFromDer,
  fingerprintOfCert,
  hashToken,
  mintIdentity,
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

// ── Minting ──────────────────────────────────────────────────────────────────

describe("minting this collie's certificate", () => {
  test("it is a v3 EC certificate a real X.509 parser accepts", () => {
    const minted = mintIdentity({ commonName: "collie-desk", sans: ["desk.example", "127.0.0.1"] });
    const cert = new X509Certificate(minted.certPem);
    expect(cert.subject).toContain("CN=collie-desk");
    // Self-signed: issuer IS subject. Not cosmetic — a certificate whose issuer differs would not
    // verify against itself as a trust anchor, which is the only way it is ever used (§8.1).
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.ca).toBe(true);
    expect(cert.subjectAltName).toContain("desk.example");
    expect(cert.subjectAltName).toContain("127.0.0.1");
    // Ten years (§8.1: expiry is not a trust boundary, the pin is).
    const years = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / (365.25 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThan(9.9);
    expect(years).toBeLessThan(10.1);
  });

  test("the private key really signs for the public key in the certificate", () => {
    const minted = mintIdentity({ commonName: "collie-desk" });
    const message = Buffer.from("a pack request");
    const signature = sign("sha256", message, minted.keyPem);
    expect(verify("sha256", message, new X509Certificate(minted.certPem).publicKey, signature)).toBe(true);
  });

  test("the fingerprint is EXACTLY what `X509Certificate.fingerprint256` says, canonically spelled", () => {
    const minted = mintIdentity({ commonName: "collie-desk" });
    const cert = new X509Certificate(minted.certPem);
    expect(minted.fingerprint).toBe(cert.fingerprint256.replace(/:/g, "").toLowerCase());
    expect(minted.fingerprint).toBe(fingerprintFromDer(cert.raw));
    expect(fingerprintOfCert(minted.certPem)).toBe(minted.fingerprint);
    expect(isFingerprint(minted.fingerprint)).toBe(true);
    // The colon-separated spelling normalises to the same value — one pin, one string (§8.1).
    expect(normalizeFingerprint(cert.fingerprint256) ?? "").toBe(minted.fingerprint);
  });

  test("every mint is a different certificate", () => {
    const a = mintIdentity({ commonName: "collie-desk" });
    const b = mintIdentity({ commonName: "collie-desk" });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  test("the serial is a MINIMAL DER INTEGER — a leading zero only ever guards a sign bit", () => {
    // The 1-in-512 serial that used to mint a certificate no parser would accept: 16 random bytes
    // whose first is `00` and whose second is under `0x80`. The redundant zero must be dropped.
    const hex = (b: Buffer) => b.toString("hex");
    expect(hex(derInteger(Buffer.from([0x00, 0x2a])))).toBe("02012a");
    expect(hex(derInteger(Buffer.from([0x00, 0x00, 0x2a])))).toBe("02012a");
    // …but a high bit still needs its zero, or the INTEGER reads negative.
    expect(hex(derInteger(Buffer.from([0x00, 0x80])))).toBe("02020080");
    expect(hex(derInteger(Buffer.from([0xff])))).toBe("020200ff");
    // Ordinary values are untouched, and zero itself stays one byte rather than becoming empty.
    expect(hex(derInteger(Buffer.from([0x02])))).toBe("020102");
    expect(hex(derInteger(Buffer.from([0x00])))).toBe("020100");
  });

  test("a certificate whose serial drew that leading zero still parses", () => {
    // Belt to the braces above: the whole mint, through a real parser, over enough draws that the
    // 1-in-512 shape is likely present — and harmless now either way, so this cannot itself flake.
    for (let i = 0; i < 64; i += 1) {
      const minted = mintIdentity({ commonName: "collie-serial" });
      expect(fingerprintOfCert(minted.certPem)).toBe(minted.fingerprint);
    }
  });

  test("an unparseable certificate has no fingerprint, rather than a plausible one", () => {
    expect(fingerprintOfCert("not a certificate")).toBeNull();
    expect(fingerprintOfCert("-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n")).toBeNull();
  });

  test("openssl agrees, where openssl exists", () => {
    // A second, INDEPENDENT parser. `X509Certificate` and our encoder could in principle agree on a
    // shared misreading of RFC 5280; BoringSSL-via-openssl could not be in on it. Skipped rather
    // than failed where openssl is absent — this is corroboration, not the contract.
    const openssl = Bun.which("openssl");
    if (openssl === null) return;
    const minted = mintIdentity({ commonName: "collie-openssl", sans: ["probe.example"] });
    const shown = Bun.spawnSync([openssl, "x509", "-noout", "-text"], { stdin: Buffer.from(minted.certPem) });
    const text = shown.stdout.toString();
    expect(shown.exitCode).toBe(0);
    expect(text).toContain("ecdsa-with-SHA256");
    expect(text).toContain("CA:TRUE");
    // The keyUsage BIT STRING is the one byte-level detail that fails late and opaquely when wrong
    // (`KEY_USAGE_BIT_INCORRECT` at `Bun.serve` bind time), so it is read back from a real parser.
    expect(text).toContain("Digital Signature, Certificate Sign");
    expect(text).toContain("TLS Web Server Authentication, TLS Web Client Authentication");
    expect(text).toContain("DNS:probe.example");
  });
});
