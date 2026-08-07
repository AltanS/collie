import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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

export function isMemberId(value: unknown): value is string {
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

export function isFingerprint(value: unknown): value is string {
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
