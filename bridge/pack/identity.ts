import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";

// The pack's naming and secret primitives: member ids, certificate fingerprints, the pack secret and
// enrollment tokens. Everything here is PURE except the three `random*` mints, which take their
// entropy from an injectable source so a test can pin an exact value without a global stub.
//
// This is the first credential material Collie owns (PACK_PROTOCOL.md §8: "Collie holds no TLS
// material and mints no credentials today"), so the rules are stated here once and imported
// everywhere rather than re-derived per call site.

// ── Member ids ───────────────────────────────────────────────────────────────

/**
 * A member id is `[a-z0-9][a-z0-9-]{0,62}` (PACK_PROTOCOL.md §4). It is minted by the lead, it is
 * **not** a hostname or an address, and it carries no routing information.
 *
 * The grammar is deliberately narrow because the id travels as `?h=` on a URL and is used as a
 * registry key — the identical discipline the session name has carried since multi-session shipped
 * (`bridge/sessions.ts:17-20`). Anchored on both ends: a partial match is a bug, not a near-miss.
 */
export const MEMBER_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isMemberId<T>(value: T): value is T & string {
  return typeof value === "string" && MEMBER_ID_RE.test(value);
}

/**
 * Turn an operator-supplied label into a candidate member id, or `null` when nothing survives.
 *
 * Returning `null` rather than a fallback is the point: "laptop 🐕" slugs cleanly, but a label of
 * pure punctuation has no honest id inside it, and silently inventing one would attach a name the
 * operator never chose to a machine that can type into terminals.
 */
export function slugifyMemberId(label: string): string | null {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return MEMBER_ID_RE.test(slug) ? slug : null;
}

/** Entropy source. Injected so tests pin exact values; production passes {@link randomToken}. */
export type RandomSource = (bytes: number) => string;

/**
 * Mint a member id the lead's roster does not already hold.
 *
 * The label is a *suggestion*: a colliding or unusable label falls back to random, and a colliding
 * random one keeps drawing. Uniqueness is checked against the caller's `taken` set rather than read
 * from disk, so this stays pure and the roster stays the single source of truth.
 */
export function mintMemberId(
  label: string | null,
  taken: ReadonlySet<string>,
  random: RandomSource = randomToken,
): string {
  const wanted = label === null ? null : slugifyMemberId(label);
  if (wanted !== null && !taken.has(wanted)) return wanted;
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = random(4).replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8);
    const candidate = wanted === null ? `collie-${suffix}` : `${wanted}-${suffix}`.slice(0, 63);
    if (MEMBER_ID_RE.test(candidate) && !taken.has(candidate)) return candidate;
  }
  throw new Error("could not mint a unique member id");
}

// ── Certificate fingerprints ─────────────────────────────────────────────────

/**
 * A pinned fingerprint is the **SHA-256 of the certificate's DER**, lowercase hex, no separators.
 *
 * One canonical spelling, chosen so a fingerprint compared as a string is compared correctly. The
 * colon-separated uppercase form `openssl x509 -fingerprint` prints is accepted on *input*
 * ({@link normalizeFingerprint}) and never stored — a store holding two spellings of one certificate
 * is a pin that silently fails to match.
 */
export const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

export function isFingerprint<T>(value: T): value is T & string {
  return typeof value === "string" && FINGERPRINT_RE.test(value);
}

/** Accept any common spelling (colons, spaces, uppercase, a `sha256:` prefix); emit the canonical one. */
export function normalizeFingerprint(value: string): string | null {
  const stripped = value.trim().replace(/^sha-?256[:=]/i, "").replace(/[\s:]/g, "").toLowerCase();
  return FINGERPRINT_RE.test(stripped) ? stripped : null;
}

/** The canonical fingerprint of a certificate, given its DER bytes. */
export function fingerprintFromDer(der: Uint8Array): string {
  return createHash("sha256").update(der).digest("hex");
}

// ── Secrets and tokens ───────────────────────────────────────────────────────

/** Bytes of entropy behind the pack secret and each enrollment token. */
export const SECRET_BYTES = 32;

/** URL-safe random string of `bytes` bytes of entropy — the mint behind secrets, tokens and ids. */
export function randomToken(bytes: number = SECRET_BYTES): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Constant-time equality for credential strings.
 *
 * Both sides are hashed first, so the comparison is over two fixed-width digests and an attacker
 * learns nothing from a *length* mismatch either — `timingSafeEqual` throws on unequal lengths, and
 * catching that throw would itself be the leak. A `null`/empty input is refused before hashing:
 * "no secret presented" is a decision, not a comparison.
 */
export function secretEquals(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (!presented || !expected) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The stored form of an enrollment token: its SHA-256, hex.
 *
 * The lead persists this and never the token itself, so a trust store read by someone who should not
 * have it yields no usable invite. The token is shown to the operator exactly once, at mint time.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Parse `Authorization: Bearer <value>`; `null` for any other scheme, or a missing/blank value. */
export function bearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(authorization.trim());
  return match ? match[1]! : null;
}

// ── Minting this collie's certificate ────────────────────────────────────────
//
// `node:crypto` parses X.509 (`X509Certificate`) and generates keys, but has no entry point that
// *issues* a certificate. There is no dependency in this repo that can either, and adding one to a
// trust boundary is a worse trade than the ~70 lines of DER below — which is all a self-signed EC
// certificate actually is. Everything here is a literal reading of RFC 5280's TBSCertificate.
//
// THE PROFILE IS NOT DECORATIVE. Each extension buys something concrete:
//   • basicConstraints CA:TRUE + keyUsage keyCertSign — a member's own certificate is used as a
//     TRUST ANCHOR in the other side's `ca` list (that is what pinning is, here), and BoringSSL
//     refuses to anchor a leaf that does not say it may sign certificates;
//   • keyUsage digitalSignature — it is also the end-entity key for the handshake and for §8.6's
//     request signatures;
//   • EKU server+client auth — the same certificate is presented in both directions;
//   • 10 years — §8.1: expiry is not a trust boundary here, the pin is.
//
// GOTCHA, PAID FOR ONCE: `keyUsage` must be a well-formed BIT STRING (`03 02 04 86`… i.e. 2 unused
// bits). A malformed one is accepted by every parser we tested and then fails opaquely at
// `Bun.serve` bind time with `BoringSSL error … KEY_USAGE_BIT_INCORRECT`. Do not hand-edit the bytes.

const derLen = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const der = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
const SEQ = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts));
const SET = (...parts: Buffer[]): Buffer => der(0x31, Buffer.concat(parts));
/**
 * A DER INTEGER, **minimally encoded** — the encoding is not free to carry a redundant leading zero.
 *
 * DER requires the shortest form: a leading `00` is legal ONLY to keep a high bit from reading as a
 * sign bit. The serial is 16 random bytes, so roughly 1 draw in 512 starts `00` with the next byte
 * below `0x80` — a non-minimal INTEGER that OpenSSL/BoringSSL refuses outright
 * (`ASN.1 … INVALID_INTEGER`). That certificate mints and fingerprints fine and then fails to parse
 * anywhere it matters, which is a member that cannot be pinned, verified or served.
 *
 * Exported only so `identity.test.ts` can pin the rule deterministically — a test that mints until
 * it draws the bad serial would be the same 1-in-512 flake, aimed at CI instead of at an operator.
 */
export function derInteger(b: Buffer): Buffer {
  let start = 0;
  while (start + 1 < b.length && b[start] === 0 && (b[start + 1]! & 0x80) === 0) start += 1;
  const trimmed = b.subarray(start);
  return der(0x02, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}
const INT = derInteger;
const BOOL = (v: boolean): Buffer => der(0x01, Buffer.from([v ? 0xff : 0x00]));
const OCTET = (b: Buffer): Buffer => der(0x04, b);
const UTF8 = (s: string): Buffer => der(0x0c, Buffer.from(s, "utf8"));
const BITSTR = (b: Buffer): Buffer => der(0x03, Buffer.concat([Buffer.from([0]), b]));
const CTX = (n: number, b: Buffer): Buffer => der(0xa0 | n, b);

function OID(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const value of parts.slice(2)) {
    const bytes: number[] = [value & 0x7f];
    for (let v = value >> 7; v > 0; v >>= 7) bytes.unshift((v & 0x7f) | 0x80);
    out.push(...bytes);
  }
  return der(0x06, Buffer.from(out));
}

/** `YYMMDDHHMMSSZ`. UTCTime is correct until 2049; a 10-year certificate minted today is inside it. */
const utcTime = (d: Date): Buffer =>
  der(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`, "ascii"));

/** `ecdsa-with-SHA256`, the one signature algorithm this build mints and verifies. */
const ECDSA_SHA256 = SEQ(OID("1.2.840.10045.4.3.2"));

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A SAN entry: `iPAddress` for a dotted quad, `dNSName` for anything else. */
function sanEntry(value: string): Buffer {
  if (IPV4_RE.test(value)) return der(0x87, Buffer.from(value.split(".").map(Number)));
  return der(0x82, Buffer.from(value, "ascii"));
}

/** Freshly minted key material: PEMs plus the canonical pin, all derived from the same DER. */
export interface MintedIdentity {
  readonly certPem: string;
  readonly keyPem: string;
  /** {@link fingerprintFromDer} of the certificate just minted. Equals `X509Certificate.fingerprint256`. */
  readonly fingerprint: string;
}

export interface MintOptions {
  /** The certificate's CN. Cosmetic — a pin is a fingerprint, never a name (§4, §8.1). */
  readonly commonName: string;
  /**
   * `subjectAltName` entries. **Also cosmetic to the trust decision**: both sides pin by certificate,
   * and the dialling side overrides `checkServerIdentity`, so a member that roams to an address its
   * SAN never mentioned is still the same member (§4). They are minted anyway so the certificate is
   * legible to `openssl x509 -text` and to any operator who inspects it.
   */
  readonly sans?: readonly string[];
  readonly years?: number;
  readonly now?: Date;
}

/**
 * Mint this collie's self-signed certificate and private key (§8.1).
 *
 * Called on **one** path only — `ensureStore` in `cli/pack.ts`, at the operator's first `pack invite`
 * or `join`. A solo instance never reaches it, which is the "solo mints nothing" row of §11.
 */
export function mintIdentity(opts: MintOptions): MintedIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  // SAFETY: node's `KeyObject.export` returns `Buffer` for `format: "der"` and `string` only for
  // `format: "pem"`; the union in its typings is over both formats, and this call fixes one.
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const name = SEQ(SET(SEQ(OID("2.5.4.3"), UTF8(opts.commonName))));
  const from = opts.now ?? new Date();
  const to = new Date(from);
  to.setUTCFullYear(to.getUTCFullYear() + (opts.years ?? 10));

  const extension = (oid: string, critical: boolean, value: Buffer): Buffer =>
    SEQ(OID(oid), ...(critical ? [BOOL(true)] : []), OCTET(value));
  const sans = (opts.sans ?? []).filter((s) => s !== "");
  const extensions = SEQ(
    extension("2.5.29.19", true, SEQ(BOOL(true))), // basicConstraints: CA:TRUE
    extension("2.5.29.15", true, der(0x03, Buffer.from([0x02, 0x84]))), // keyUsage: digitalSignature|keyCertSign
    extension("2.5.29.37", false, SEQ(OID("1.3.6.1.5.5.7.3.1"), OID("1.3.6.1.5.5.7.3.2"))), // EKU server+client
    ...(sans.length > 0 ? [extension("2.5.29.17", false, SEQ(...sans.map(sanEntry)))] : []),
  );
  const tbs = SEQ(
    CTX(0, INT(Buffer.from([2]))), // version: v3
    INT(randomBytes(16)), // serial
    ECDSA_SHA256,
    name, // issuer == subject: self-signed
    SEQ(utcTime(from), utcTime(to)),
    name,
    spki,
    CTX(3, extensions),
  );
  const certDer = SEQ(tbs, ECDSA_SHA256, BITSTR(cryptoSign("sha256", tbs, privateKey)));
  return {
    certPem: pemOf("CERTIFICATE", certDer),
    // SAFETY: the mirror of the `spki` cast above — `format: "pem"` returns a string, never a Buffer.
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    fingerprint: fingerprintFromDer(certDer),
  };
}

function pemOf(label: string, body: Buffer): string {
  const b64 = body.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/**
 * The canonical fingerprint of a certificate given its PEM, or `null` when it will not parse.
 *
 * Goes through {@link fingerprintFromDer} on the parsed DER rather than reformatting
 * `X509Certificate.fingerprint256`: one derivation, so the stored pin and the minted pin cannot
 * disagree about spelling. (`identity.test.ts` pins that the two agree.)
 */
export function fingerprintOfCert(certPem: string): string | null {
  try {
    return fingerprintFromDer(new X509Certificate(certPem).raw);
  } catch {
    return null;
  }
}
