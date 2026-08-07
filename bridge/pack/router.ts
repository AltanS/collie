import type { AuditLog } from "../audit.ts";
import {
  admitPackRequest,
  factsFrom,
  packResponseHeaders,
  parseProtocolHeader,
  protocolMismatchResponse,
  unauthorizedResponse,
  unwiredFingerprints,
  type PeerFingerprintSource,
  type RefusedFactor,
} from "./admission.ts";
import {
  commitPackChange,
  consumeInvite,
  enrollPeer,
  parseEnrollRequest,
  PACK_PROTOCOL_VERSION,
} from "./enrollment.ts";
import { randomToken, type RandomSource } from "./identity.ts";
import type { TrustStore } from "./trust-store.ts";

// The `/pack/v1/*` surface. This module exists **so that `bridge/server.ts` contains no pack route
// literal at all**: a solo instance's route table is asserted, by reading server.ts's source, to be
// exactly today's (`bridge/solo-baseline.test.ts` §4, including `not.toMatch(/"\/pack/)`). Keeping
// the prefix here means solo does not merely *skip* the pack routes — it never registers them, and
// the baseline can prove it by grepping the file that does the registering.
//
// server.ts takes an OPTIONAL handler and calls it before anything else; index.ts supplies one only
// when a trust store exists. With no trust store there is no handler, so `/pack/v1/anything` falls
// through to the ordinary 404 that any unknown path already gets — indistinguishable from a build
// that had never heard of federation.
//
// Everything decision-shaped lives in admission.ts and enrollment.ts as pure functions; what is left
// here is dispatch, body parsing and response assembly, thin enough to review by eye (the
// testability constraint in CLAUDE.md — but note this handler takes a plain `Request` and needs no
// `Bun.serve`, so router.test.ts does exercise it for real).

/** The pack prefix. Must never collide with `/auth`, `/auth/*` or `/cdn-cgi/` (§5) — it does not. */
export const PACK_PREFIX = "/pack/v1/";

export const PACK_ENROLL_PATH = "/pack/v1/enroll";
export const PACK_HELLO_PATH = "/pack/v1/hello";

export interface PackRouterDeps {
  readonly store: TrustStore;
  readonly audit: AuditLog | null;
  /** Reads the caller's TLS certificate fingerprint. Stubbed to "none, so refuse" until TLS lands. */
  readonly fingerprints?: PeerFingerprintSource;
  readonly now?: () => number;
  readonly random?: RandomSource;
}

/** Answers a pack request, or `null` when the path is not ours (so the normal router continues). */
export type PackHandler = (req: Request, url: URL) => Promise<Response | null>;

/**
 * Build the pack handler.
 *
 * **Registered on the existence of a trust store, not on the mode.** The distinction is load-bearing
 * and easy to get wrong: a lead that has minted its first invite still has zero peers, so
 * `deriveMode` correctly calls it `solo` (bridge/pack/mode.ts) — yet it must be able to *answer* that
 * invite or a pack can never form. Tying registration to `mode !== "solo"` would make the first
 * enrollment unanswerable. The zero-tax contract is untouched by this, because it is a promise to an
 * instance that never enrolled, and such an instance has no trust store to register on.
 */
export function createPackRouter(deps: PackRouterDeps): PackHandler {
  const fingerprints = deps.fingerprints ?? unwiredFingerprints;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? randomToken;

  const refuse = (path: string, factor: RefusedFactor): Response => {
    // Audited locally with the real cause; the caller is told only "unauthorized" (§8.1). The two
    // are not in tension: the log is the peer operator's own record on their own disk (§12).
    deps.audit?.record({ action: "pack.refused", detail: { path, factor } });
    return unauthorizedResponse();
  };

  return async (req, url) => {
    const { pathname } = url;
    if (!pathname.startsWith(PACK_PREFIX)) return null;

    if (pathname === PACK_ENROLL_PATH) return enroll(req);

    // Everything else on the prefix passes the two factors first, before routing — ADR 0013's "two
    // independent factors, both, always, before routing". An admitted caller asking for a route this
    // build does not implement gets a 404; an unadmitted one cannot tell which routes exist.
    const data = await deps.store.load();
    const verdict = admitPackRequest(data, factsFrom(req, fingerprints));
    if (!verdict.ok) {
      if (verdict.refusal === "protocol_mismatch") return protocolMismatchResponse(verdict.received);
      return refuse(pathname, verdict.factor);
    }

    if (pathname === PACK_HELLO_PATH && req.method === "GET") {
      // Liveness + version + member id (§5). Nothing else: `hello` is what an admitted lead uses to
      // confirm a link, so it must not become a place to learn anything an unadmitted caller wants.
      return new Response(JSON.stringify({ protocol: PACK_PROTOCOL_VERSION, member: verdict.self }), {
        status: 200,
        headers: packResponseHeaders(verdict.self),
      });
    }

    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: packResponseHeaders(verdict.self),
    });
  };

  /**
   * `POST /pack/v1/enroll` — the lead side of §8.2.
   *
   * Admitted by the **token**, not by the two factors: at this instant the joining peer holds neither
   * the pack secret nor a pin, which is the entire reason an enrollment exchange exists. The token
   * authenticates the exchange and nothing after it.
   */
  async function enroll(req: Request): Promise<Response> {
    if (req.method !== "POST") return refuse(PACK_ENROLL_PATH, "token");

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      // A malformed body is answered exactly like a bad token. Splitting it into a 400 would tell an
      // unauthenticated caller that this endpoint parses enrollment requests.
      return refuse(PACK_ENROLL_PATH, "token");
    }
    const parsed = parseEnrollRequest(body);

    // SPEND FIRST. The token is consumed whether or not the rest of the exchange succeeds, so a
    // stolen token cannot be replayed against a second failure mode until one sticks. This is a
    // persisted write that happens before any validation of what the token was spent on.
    const invite = await commitPackChange(deps.store, deps.audit, (data) =>
      data === null ? null : consumeInvite(data, parsed?.token ?? null, now()),
    );
    if (invite === null || parsed === null) return refuse(PACK_ENROLL_PATH, "token");

    // Version is negotiated only after the token proved good — same ordering, same reason, as the
    // two-factor path above (§7 vs §8.5).
    const version = parseProtocolHeader(req.headers.get("x-pack-protocol")) ?? parsed.protocol;
    if (version !== PACK_PROTOCOL_VERSION) {
      return protocolMismatchResponse(Number.isFinite(version) ? version : null);
    }

    // The certificate the peer will be pinned by. Once TLS client verification is wired, the
    // transport's value is authoritative and a payload that disagrees is a refusal — a joining peer
    // must not be able to have the lead pin a certificate it does not hold. Until then the transport
    // offers nothing and the payload's claim is what the operator's out-of-band token vouches for.
    const presented = fingerprints(req);
    if (presented !== null && presented !== parsed.fingerprint) {
      return refuse(PACK_ENROLL_PATH, "certificate");
    }

    const response = await commitPackChange(deps.store, deps.audit, (data) =>
      data === null
        ? null
        : enrollPeer(
            data,
            { fingerprint: parsed.fingerprint, address: parsed.address, label: parsed.label ?? invite.label },
            now(),
            random,
          ),
    );
    if (response === null) return refuse(PACK_ENROLL_PATH, "not-a-pack-member");

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: packResponseHeaders(response.leadMemberId),
    });
  }
}
