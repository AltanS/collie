import { bearerToken, secretEquals } from "./identity.ts";
import { PACK_PROTOCOL_VERSION } from "./enrollment.ts";
import type { TrustStoreData, TrustedMember } from "./trust-store.ts";

// Pack admission: the two-factor gate every request on `/pack/v1/*` passes before any handler runs
// (PACK_PROTOCOL.md §8.1, ADR 0013). It is a PURE function of request-shaped facts and the trust
// store's contents — no Request, no socket, no clock — which is what makes the failure matrix in
// admission.test.ts a test of the shipping decision rather than of a harness.
//
// THIS IS NOT A WIDENING OF `checkAccess()`. It shares no code with it, and it must not grow any:
// `checkAccess` (bridge/server.ts:1113-1151) is a browser gate — an `Origin` compared against `Host`,
// an optional tailnet identity, an optional device header — and a pack request satisfies none of its
// preconditions by construction. The two consequences §6 spells out, restated as invariants of this
// module:
//   • browser credentials NEVER admit a pack request — nothing here reads Origin, Host or the device
//     header, so there is no path by which they could;
//   • the pack secret NEVER admits an `/api/*` request — this function is only ever called from the
//     pack prefix, and it returns a member id rather than an access level, so there is nothing for
//     an `/api/*` handler to consume even if someone wired it there by mistake.

/** The header carrying the protocol version, on requests and on responses (§6, §7). */
export const PROTOCOL_HEADER = "x-pack-protocol";
/** Informational "who is speaking". Identity is proven by the pinned certificate, never by this (§6). */
export const MEMBER_HEADER = "x-pack-member";
/** The operator's device identity, forwarded for the peer's audit trail (§6, §12). */
export const DEVICE_HEADER = "x-pack-device";

/**
 * The facts admission decides on. Deliberately a plain record rather than a `Request`: the TLS
 * fingerprint does not live on a `Request` at all, so taking one would force this function to reach
 * for a transport it cannot see, and every test would then be testing the reach rather than the rule.
 */
export interface PackRequestFacts {
  /**
   * The SHA-256 fingerprint of the certificate the caller presented, or `null` when the transport
   * offered none. `null` is a refusal, never a pass — see {@link PeerFingerprintSource}.
   */
  readonly presentedFingerprint: string | null;
  /** The raw `Authorization` header. */
  readonly authorization: string | null;
  /** The raw `X-Pack-Protocol` header. */
  readonly protocol: string | null;
}

/** Why a request was refused. Local detail for the peer's own audit log — never told to the caller. */
export type RefusedFactor = "certificate" | "secret" | "token" | "not-a-pack-member";

export type PackVerdict =
  /** Admitted. `member` is who called; `self` is this collie's own id, for the response headers. */
  | { readonly ok: true; readonly member: TrustedMember; readonly self: string }
  | { readonly ok: false; readonly refusal: "unauthorized"; readonly factor: RefusedFactor }
  | { readonly ok: false; readonly refusal: "protocol_mismatch"; readonly received: number | null };

/**
 * Read the fingerprint of the certificate a caller presented on this connection.
 *
 * ── SEAM, STUBBED ────────────────────────────────────────────────────────────
 * `Bun.serve`'s `fetch(req)` exposes no client-certificate accessor, so there is no way to obtain
 * this value in-process today. The whole gate is built to take it as an input for exactly that
 * reason: when TLS client verification lands, one function is supplied and nothing else moves.
 *
 * The default {@link unwiredFingerprints} returns `null`, which **refuses every request**. That is
 * the correct unwired behaviour and the reason it is not a boolean flag: there is no configuration
 * that turns pinning off, so no deployment can end up single-factor by accident. M4/08's harness is
 * what proves a real handshake pins.
 */
export type PeerFingerprintSource = (req: Request) => string | null;

/** The default source: no TLS session is readable, so nothing is pinned, so nothing is admitted. */
export const unwiredFingerprints: PeerFingerprintSource = () => null;

/** Lift a request plus a fingerprint source into the facts {@link admitPackRequest} decides on. */
export function factsFrom(req: Request, fingerprints: PeerFingerprintSource): PackRequestFacts {
  return {
    presentedFingerprint: fingerprints(req),
    authorization: req.headers.get("authorization"),
    protocol: req.headers.get(PROTOCOL_HEADER),
  };
}

/** Every member this collie pins, in one list: its lead (if a peer) and its peers (if a lead). */
export function pinnedMembers(data: TrustStoreData): readonly TrustedMember[] {
  return data.lead === null ? data.peers : [data.lead, ...data.peers];
}

/**
 * The two-factor decision (§8.1). Both factors are required; neither alone admits anything.
 *
 * **Order: identity, then secret, then version — and the version check is LAST on purpose.**
 * §7 wants a legible `409` naming both versions, and §8.5 wants someone who reaches the port with
 * neither factor to learn nothing but "something is listening". Those pull in opposite directions
 * only if the 409 can be provoked without credentials. Checking the version after admission settles
 * it in both documents' favour: a skewed *enrolled lead* gets its precise 409, and an unauthenticated
 * prober gets the same 401 it would get for any other reason — no version banner, in either the body
 * or the headers.
 *
 * Both factors are evaluated before either is acted on, so the answer's shape does not depend on
 * which one failed first.
 */
export function admitPackRequest(data: TrustStoreData | null, facts: PackRequestFacts): PackVerdict {
  if (data === null || data.pack === null) {
    // Not in a pack: there is no secret to match and nobody is pinned. Same answer as any refusal.
    return { ok: false, refusal: "unauthorized", factor: "not-a-pack-member" };
  }

  // Factor 1 — pinned certificate. An `unenrolled` member is pinned but refused: that is what
  // "dropped by a rotation" means, and it must not read as an unknown machine to the operator's log.
  const presented = facts.presentedFingerprint;
  const pinned = presented === null ? undefined : pinnedMembers(data).find((m) => m.fingerprint === presented);
  const identified = pinned !== undefined && pinned.status === "enrolled";

  // Factor 2 — the pack-wide bearer secret. Evaluated regardless of factor 1's outcome so the two
  // are not chained into a timing oracle for "is this certificate known?".
  const presentedSecret = bearerToken(facts.authorization);
  const secretOk = secretEquals(presentedSecret, data.pack.secret);

  if (!identified) return { ok: false, refusal: "unauthorized", factor: "certificate" };
  if (!secretOk) return { ok: false, refusal: "unauthorized", factor: "secret" };

  const version = parseProtocolHeader(facts.protocol);
  if (version !== PACK_PROTOCOL_VERSION) return { ok: false, refusal: "protocol_mismatch", received: version };

  return { ok: true, member: pinned, self: data.self.memberId };
}

/**
 * Parse `X-Pack-Protocol`. An **explicit integer on the wire, never inferred from the app version**
 * (§7) — so a missing, non-numeric or fractional header is `null`, which is a mismatch, not a
 * default. Defaulting an absent version to 1 would silently admit a v2 client that forgot to send it.
 */
export function parseProtocolHeader(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/**
 * The refusal, as one response shape.
 *
 * `401` with body `{"error":"unauthorized"}` — no `code`, no cause, no hint at which factor failed
 * (§8.1). It also carries **no pack headers**: §6 asks every pack response to state its version, but
 * §8.5 promises a caller with neither factor learns of "no version banner", and an unauthenticated
 * caller is not in a pack exchange yet. So the version header rides admitted responses only, and
 * this one is indistinguishable from any other bare 401 the process could emit.
 */
export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * The version refusal (§7): `409`, naming both sides, never a bare 4xx and never a partial answer.
 * Emitted only to a caller that already passed both factors, which is why it may speak freely.
 */
export function protocolMismatchResponse(received: number | null): Response {
  return new Response(
    JSON.stringify({
      error: "pack protocol mismatch",
      code: "protocol_mismatch",
      expected: PACK_PROTOCOL_VERSION,
      received,
    }),
    {
      status: 409,
      headers: {
        "content-type": "application/json; charset=utf-8",
        [PROTOCOL_HEADER]: String(PACK_PROTOCOL_VERSION),
      },
    },
  );
}

/** Stamp the headers §6 requires on an admitted response: the version, and who is answering. */
export function packResponseHeaders(memberId: string): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    [PROTOCOL_HEADER]: String(PACK_PROTOCOL_VERSION),
    [MEMBER_HEADER]: memberId,
  };
}
