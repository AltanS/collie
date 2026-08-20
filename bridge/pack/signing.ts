import { createHash, sign as cryptoSign, verify as cryptoVerify, X509Certificate } from "node:crypto";

// Signed membership requests (PACK_PROTOCOL.md §8.6).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// §8.1's first factor is a pinned certificate, and on the PEER's listener that pin is enforced by
// BoringSSL at the handshake (`bridge/pack/transport.ts`). The LEAD cannot do the same: its pack
// surface rides the front door, and `tailscale serve` — or any conforming reverse proxy — terminates
// TLS before the process sees it, so no client certificate can survive to the lead under any design.
//
// A peer→lead request would therefore have exactly one factor (the pack secret), and the two requests
// that travel that direction are the two most consequential in the protocol: `leave` removes a member
// from a roster, and `lead` moves the crown (§14). A pack-wide bearer token is held by every member,
// so with the secret alone any member could speak for any other.
//
// So the second factor is re-established at the application layer, over the material both sides
// already pinned: the member signs a canonical statement of its own request with the private key
// behind its pinned certificate, and the receiver verifies it with the public key of the certificate
// it pinned. Nothing new is trusted, no new key material exists, and the guarantee is the same one
// the handshake gives on the other direction.
//
// PURE BY CONSTRUCTION. Everything below is a function of strings and bytes — no Request, no clock,
// no store — so `signing.test.ts` tests the shipping rule rather than a harness.

/** Base64 ECDSA-P256-SHA256 over {@link canonicalRequest}. */
export const SIGNATURE_HEADER = "x-pack-signature";
/** Epoch milliseconds, as a decimal integer. Part of the signed string, so it cannot be re-stamped. */
export const TIMESTAMP_HEADER = "x-pack-timestamp";

/**
 * How far apart two members' clocks may be before a signature is refused.
 *
 * Five minutes is generous on purpose: the alternative to a wide window is not tighter security but
 * an operator whose `collie leave` fails for a reason no error message can usefully name. Replay
 * inside the window is closed by monotonicity ({@link timestampVerdict}), not by the window.
 */
export const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * The string both sides sign, exactly (§8.6):
 *
 * ```
 * <METHOD>\n<path>\n<sha256(body) hex>\n<timestamp>
 * ```
 *
 * Four fields and no more, each of which closes a specific substitution:
 *   • **method** — a signed `POST /pack/v1/leave` must not be replayable as anything else;
 *   • **path** — the same body must not be movable from `leave` to `lead`;
 *   • **body digest** — the claim inside the body (which member, which fingerprint) is what §14
 *     authenticates, so it has to be under the signature rather than beside it;
 *   • **timestamp** — carried in a header, but signed here, so an attacker cannot re-stamp a captured
 *     request to walk it forward through the skew window.
 *
 * The **query string is deliberately absent**: no membership route takes one, and signing a value no
 * route reads would be a rule that silently stops holding the day one does. A membership route that
 * ever grows a parameter must extend this string and the version that goes with it.
 *
 * **Neither the RECEIVER nor the pack id is named here**, so a signed request verifies at *any* collie
 * that pins the signer's certificate — not only at the one it was aimed at. This is inert today because
 * roster topology bounds who-pins-whom: a peer pins only its lead and a lead pins only its members
 * (§8.2), so a given signer's key is pinned in exactly one place and a captured signature has exactly
 * one collie it could replay at. A v2 that broadens that — a peer pinning more than one lead, a shared
 * or nested roster (ADR 0012's "what would justify revisiting") — MUST bind a receiver identity and/or
 * the pack id into this string, or a signature minted for one collie would verify at another that
 * happens to pin the same key.
 *
 * `path` is the URL's pathname only — never the host. A pack member is dialled at an address the
 * operator owns and may re-point (§4, `collie reconnect`); binding the signature to it would make
 * roaming a signature failure.
 */
export function canonicalRequest(method: string, path: string, bodySha256: string, timestamp: number): string {
  return `${method.toUpperCase()}\n${path}\n${bodySha256}\n${timestamp}`;
}

/** SHA-256 of a request body, lowercase hex. An empty body hashes the empty string, not a constant. */
export function bodyDigest(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export interface SignedRequestParts {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly timestamp: number;
}

/**
 * Sign ANY canonical string with the PKCS#8 private key behind this collie's own pinned certificate.
 * Base64, DER ECDSA-P256-SHA256.
 *
 * The one place this codebase signs anything, so a second signed object is a second *canonical
 * string* and never a second algorithm, a second key or a second trust anchor. The warrant (RFC §4.1)
 * is the second caller; it is kept apart from {@link canonicalRequest}'s four-field string by a fixed
 * domain tag in its own first field (RFC §4.3), not by field-count arithmetic.
 */
export function signCanonical(keyPem: string, message: string): string {
  return cryptoSign("sha256", Buffer.from(message, "utf8"), keyPem).toString("base64");
}

/**
 * Verify a canonical string against the public key of a **pinned** certificate. The counterpart of
 * {@link signCanonical}, and the one place a signature is checked.
 *
 * A malformed certificate or signature is `false`, never a throw: a refusal is a decision, and an
 * exception on this path would be a 500 that tells a caller more than a uniform refusal does.
 */
export function verifyCanonical(certPem: string, signatureB64: string, message: string): boolean {
  if (signatureB64 === "") return false;
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    return false;
  }
  try {
    return cryptoVerify("sha256", Buffer.from(message, "utf8"), cert.publicKey, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** Sign with the PKCS#8 private key behind this collie's own pinned certificate. Base64, DER ECDSA. */
export function signRequest(keyPem: string, parts: SignedRequestParts): string {
  return signCanonical(keyPem, canonicalRequest(parts.method, parts.path, bodyDigest(parts.body), parts.timestamp));
}

/**
 * Verify against the public key of a **pinned** certificate.
 *
 * The certificate is the one already in the trust store, so this asks "did the member we pinned sign
 * this?" and nothing else — it is not a chain check, there is no CA, and a certificate that arrives
 * with the request is never an input here. A malformed certificate or signature is `false`, never a
 * throw: a refusal is a decision, and an exception on this path would be a 500 that tells a caller
 * more than the uniform 401 does.
 */
export function verifyRequestSignature(certPem: string, signatureB64: string, parts: SignedRequestParts): boolean {
  const message = canonicalRequest(parts.method, parts.path, bodyDigest(parts.body), parts.timestamp);
  return verifyCanonical(certPem, signatureB64, message);
}

// ── The dial attestation (§8.6, added 2026-08-20) ────────────────────────────
//
// **What it is for, stated first, because it is NOT the request signature above.** A peer whose
// listener carries a second TLS anchor (§8.1's 2026-08-20 amendment) can no longer read "the
// handshake was pin-enforcing" as "the caller is my lead" — the list names one of two, and Bun
// exposes no accessor for which certificate was presented. So the caller SAYS which, with its key:
// every lead→peer dial carries a signature, and a two-anchored peer resolves identity from **which
// pinned certificate verifies it**, never from the transport boolean.
//
// ── WHY IT IS A SECOND OBJECT AND NOT `canonicalRequest` ─────────────────────
// Two facts about this surface make the four-field request string unusable here, and both are
// load-bearing rather than inconvenient:
//
//   1. **The body cannot be hashed.** A proxied write streams `req.body` straight through (§13, up to
//      10 MB of multipart, never buffered on the lead — `bridge/pack/forward.ts`). Signing a digest
//      would mean buffering every upload in the lead's memory *on the security path*, which is the
//      exact trade §8.6's SIGNABLE_PATHS was drawn to avoid.
//   2. **`canonicalRequest` names no RECEIVER**, and its own doc says a v2 that broadens who-pins-whom
//      "MUST bind a receiver identity … or a signature minted for one collie would verify at another
//      that happens to pin the same key". This IS that broadening: a two-anchored peer pins two
//      members, and the lead dials the deputy exactly as it dials every other member — so the deputy
//      legitimately holds lead-signed dials and could otherwise present them at a sibling peer.
//
// So this string **binds the receiver and omits the body**, and is kept structurally disjoint from
// both the request string and the warrant by a fixed domain tag (the warrant's rule, RFC §4.3).
//
// ── WHAT IT DOES NOT CLAIM ───────────────────────────────────────────────────
// **Identity, not integrity.** Body integrity on this hop is TLS's, and TLS is not weakened by any of
// this: the connection is pinned mutual TLS to one of two certificates the operator chose. The
// attacker this closes is a compromised DEPUTY being read as the lead, and a compromised deputy
// cannot produce the lead's signature over any string at all.
//
// **Freshness is the skew window, not the replay floor.** `TrustedMember.signedAt` is advanced only by
// signed MEMBERSHIP calls (§8.6), and it must stay that way: the lead makes several dials
// concurrently within one millisecond, so a monotonic floor here would refuse all but one of every
// sweep. What bounds a captured dial instead is the receiver binding — the only party positioned to
// capture one is the receiver itself, and it is the only collie it verifies at.

/** Base64 ECDSA-P256-SHA256 over {@link canonicalDial}. Rides beside `X-Pack-Timestamp`. */
export const DIAL_HEADER = "x-pack-dial";

/** The fixed domain tag, and the first field of every canonical dial string. */
export const DIAL_DOMAIN = "collie-pack-dial-v1";

export interface DialParts {
  readonly method: string;
  readonly path: string;
  readonly timestamp: number;
  /** The member id this dial is aimed at. The field that makes a captured dial unusable elsewhere. */
  readonly to: string;
}

/**
 * The string a dial attestation signs, exactly:
 *
 * ```
 * collie-pack-dial-v1\n<METHOD>\n<path>\n<timestamp>\n<to>
 * ```
 */
export function canonicalDial(parts: DialParts): string {
  return [DIAL_DOMAIN, parts.method.toUpperCase(), parts.path, String(parts.timestamp), parts.to].join("\n");
}

/** Sign one dial with this collie's own identity key. */
export function signDial(keyPem: string, parts: DialParts): string {
  return signCanonical(keyPem, canonicalDial(parts));
}

/** Did the member whose certificate this is attest this dial, at this receiver? */
export function verifyDial(certPem: string, signatureB64: string, parts: DialParts): boolean {
  return verifyCanonical(certPem, signatureB64, canonicalDial(parts));
}

/** Parse `X-Pack-Timestamp`. A non-integer, negative or absent value is `null`, which is a refusal. */
export function parseTimestamp(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d{1,15}$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) ? value : null;
}

export type TimestampVerdict = "ok" | "skew" | "replay";

/**
 * The freshness rule (§8.6): a signature is good once, and only near now.
 *
 * - **skew** — more than {@link MAX_SKEW_MS} either side of the receiver's clock. Both directions,
 *   because a future timestamp is how a captured request is parked for later use.
 * - **replay** — not strictly newer than the last timestamp this member was admitted on. Strictly:
 *   two requests genuinely sent in the same millisecond are rare, and refusing the second costs a
 *   retry, where admitting an equal one costs the whole rule.
 *
 * `lastAccepted` is per member and persisted (`TrustedMember.signedAt`), so it survives the restart
 * every membership verb performs — a monotonic counter that resets on restart is not one.
 */
export function timestampVerdict(timestamp: number, now: number, lastAccepted: number): TimestampVerdict {
  if (Math.abs(now - timestamp) > MAX_SKEW_MS) return "skew";
  if (timestamp <= lastAccepted) return "replay";
  return "ok";
}
