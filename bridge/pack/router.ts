import type { AuditLog } from "../audit.ts";
import {
  admitPackRequest,
  factsFrom,
  MEMBER_HEADER,
  packResponseHeaders,
  parseProtocolHeader,
  protocolMismatchResponse,
  PROTOCOL_HEADER,
  unauthorizedResponse,
  unwiredFingerprints,
  type PeerFingerprintSource,
  type RefusedFactor,
} from "./admission.ts";
import { apiPathFor } from "./forward.ts";
import { HOST_PARAM } from "./registry.ts";
import {
  adoptLead,
  adoptSecret,
  commitPackChange,
  consumeInvite,
  demoteSelf,
  enrollPeer,
  isLeading,
  parseEnrollRequest,
  parseRosterEntry,
  removeMember,
  PACK_PROTOCOL_VERSION,
} from "./enrollment.ts";
import { randomToken, type RandomSource } from "./identity.ts";
import type { TrustedMember, TrustStore } from "./trust-store.ts";
import type { SnapshotResponse } from "../types.ts";

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
export const PACK_SNAPSHOT_PATH = "/pack/v1/snapshot";

// ── The membership routes (M4/07) ────────────────────────────────────────────
// Three routes that exist because three operator verbs are otherwise undeliverable: §8.4's rotation
// "distributes to every reachable peer", §14's promotion "reachable peers are updated by the
// promotion itself", and §8.4's `collie leave` "revokes on both sides where reachable". Each is the
// receiving half of a verb in `cli/pack.ts`; none is reachable by a browser, and all three sit behind
// the same two factors as everything else on the prefix.
//
// They are NOT in §5's proxy table and never will be: that table is "the routes the phone already
// calls, re-exposed". These carry no pane data, take no `?session=`, and are addressed to the collie
// rather than to anything it fronts.

/** `POST` — the lead hands a peer the rotated pack secret (§8.4). */
export const PACK_SECRET_PATH = "/pack/v1/secret";
/** `POST` — "this member is the pack's lead now" (§14). Answered by the old lead and by every peer. */
export const PACK_LEAD_PATH = "/pack/v1/lead";
/** `POST` — the caller removes ITSELF from this collie's roster (§8.4, `collie leave`). */
export const PACK_LEAVE_PATH = "/pack/v1/leave";

/**
 * This collie's own snapshot body, for the one merged route (§9.2). `undefined` ⇒ the `?session=`
 * named does not exist here, which is the peer's own 404 and not the lead's.
 *
 * Injected from `bridge/server.ts`, which hands over the very closure it serves browsers from —
 * a peer therefore cannot answer its lead with a body that differs from its own `/api/snapshot`.
 */
export type SnapshotSource = (session?: string) => SnapshotResponse | undefined;

/**
 * Run one session-scoped route — the pane family, tabs, workspaces — as this collie would for its
 * own operator (§5). `from` is the admitted member that forwarded it, for the peer's audit line.
 *
 * Injected from `bridge/server.ts` for the same reason {@link SnapshotSource} is: it hands over the
 * very block the browser routes dispatch through, so "the peer runs the same handler" is a fact about
 * the wiring rather than a claim about two implementations.
 */
export type ApiDispatch = (req: Request, url: URL, from: string) => Promise<Response>;

/** What this collie exposes to an admitted lead. Absent ⇒ that half of §5's table simply 404s. */
export interface PackSurface {
  readonly snapshot?: SnapshotSource;
  readonly dispatch?: ApiDispatch;
}

export interface PackRouterDeps {
  readonly store: TrustStore;
  readonly audit: AuditLog | null;
  /** Absent ⇒ `/pack/v1/snapshot` 404s like any unimplemented route. */
  readonly snapshot?: SnapshotSource;
  /** Absent ⇒ the per-pane/tab/workspace half of §5's table 404s. */
  readonly dispatch?: ApiDispatch;
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

    if (pathname === PACK_SECRET_PATH && req.method === "POST") {
      return secret(req, verdict.member, verdict.self);
    }
    if (pathname === PACK_LEAD_PATH && req.method === "POST") {
      return newLead(req, verdict.member, verdict.self);
    }
    if (pathname === PACK_LEAVE_PATH && req.method === "POST") {
      // The caller drops ITSELF, and can drop nothing else — the member id is the admitted one, never
      // a body field. Removal is idempotent: a second `leave` from a member already gone answers 200
      // rather than 404, because the operator's question ("am I still listed there?") is answered the
      // same way either time and a 404 would read as a broken link.
      await commitPackChange(deps.store, deps.audit, (data) =>
        data === null ? null : removeMember(data, verdict.member.memberId),
      );
      return new Response(JSON.stringify({ removed: verdict.member.memberId }), {
        status: 200,
        headers: packResponseHeaders(verdict.self),
      });
    }

    if (pathname === PACK_SNAPSHOT_PATH && req.method === "GET" && deps.snapshot !== undefined) {
      // The only merged route (§9.2), and the peer's half of it: it answers with its OWN view,
      // never a merged one — a pack link never forwards a `host=`, because a peer has no peers (§4).
      // `?session=` is honoured with the identical semantics the browser API has: absent ⇒ primary,
      // unknown ⇒ 404, and the name is only ever a registry key.
      const body = deps.snapshot(url.searchParams.get("session") ?? undefined);
      if (body === undefined) {
        return new Response(JSON.stringify({ error: "unknown session" }), {
          status: 404,
          headers: packResponseHeaders(verdict.self),
        });
      }
      // No `etag` and no conditional handling: the lead re-serialises this body into its merged
      // snapshot, so a 304 here would save a transfer the lead cannot pass on and would leave it
      // with nothing to merge. Proxied reads (§9.1, M4/05) are the opposite case and keep theirs.
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: packResponseHeaders(verdict.self),
      });
    }

    // ── The 1:1 half of §5's table ───────────────────────────────────────────
    // Pane read/history/reply/keys/upload/close/rename, tab create/rename/close, workspace create —
    // dispatched into the SAME handlers the browser routes use, with the same `?session=` semantics.
    //
    // Three rules hold this together, and each is one line below:
    //   1. The route must be on the allowlist (`apiPathFor`), so a route §5 excludes — subscribe,
    //      notifications, update/check — is not reachable across a link merely because it exists.
    //   2. `host=` is REFUSED, never forwarded. A peer has no peers (§4); accepting one would be the
    //      first hop of a chain this protocol does not have.
    //   3. The dispatched response is stamped with the pack headers §6 requires. That is not
    //      cosmetic: the lead checks the version before it reads a byte (§7), and an unstamped
    //      response would read as a version skew.
    const route = pathname.slice(PACK_PREFIX.length);
    const apiPath = apiPathFor(route);
    if (apiPath !== null && deps.dispatch !== undefined) {
      if (url.searchParams.has(HOST_PARAM)) {
        return new Response(JSON.stringify({ error: "a pack request may not name a host" }), {
          status: 400,
          headers: packResponseHeaders(verdict.self),
        });
      }
      const local = new URL(url.toString());
      local.pathname = apiPath;
      const answer = await deps.dispatch(req, local, verdict.member.memberId);
      const headers = new Headers(answer.headers);
      headers.set(PROTOCOL_HEADER, String(PACK_PROTOCOL_VERSION));
      headers.set(MEMBER_HEADER, verdict.self);
      const bodyless = answer.status === 304 || answer.status === 204;
      return new Response(bodyless ? null : answer.body, { status: answer.status, headers });
    }

    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: packResponseHeaders(verdict.self),
    });
  };

  /** A JSON body, or `null` when it will not parse. Every membership route answers `null` with a 400. */
  async function readJson(req: Request): Promise<unknown> {
    try {
      return await req.json();
    } catch {
      return null;
    }
  }

  /** A 400 on an admitted link. Free to say why — the caller already passed both factors (§8.5). */
  function badRequest(self: string, reason: string): Response {
    return new Response(JSON.stringify({ error: reason }), {
      status: 400,
      headers: packResponseHeaders(self),
    });
  }

  /**
   * `POST /pack/v1/secret` — the peer side of rotation (§8.4).
   *
   * **Only this collie's own lead may rotate it.** A pack secret is pack-wide, so without that check
   * any admitted member could hand every other member a value of its own choosing and lock the lead
   * out of its own pack — a compromised peer escalating to pack-wide denial (§8.5 is explicit that a
   * compromised peer must not reach past its own machine).
   *
   * The request is authenticated by the OUTGOING secret and carries the incoming one; there is no
   * window in which both are accepted (§8.4), so the lead dials with the superseded value it still
   * holds in memory and the peer's very next request already needs the new one.
   */
  async function secret(req: Request, from: TrustedMember, self: string): Promise<Response> {
    const body = (await readJson(req)) as Record<string, unknown> | null;
    const value = typeof body?.secret === "string" ? body.secret : null;
    const generation = typeof body?.generation === "number" ? body.generation : null;
    if (value === null || value === "" || generation === null || !Number.isSafeInteger(generation)) {
      return badRequest(self, "a secret handover needs `secret` and `generation`");
    }
    const data = await deps.store.load();
    if (data === null || data.lead === null || data.lead.memberId !== from.memberId) {
      // Not our lead. Audited as a refused factor: the member is pinned and holds the secret, so this
      // is a member exceeding its role rather than a stranger, and that distinction belongs in the log.
      return refuse(PACK_SECRET_PATH, "not-a-pack-member");
    }
    const applied = await commitPackChange(deps.store, deps.audit, (current) =>
      current === null ? null : adoptSecret(current, { secret: value, generation }, now()),
    );
    // A redelivery applies nothing and is still a success: the lead's question is "does this member
    // hold generation N?", and it does.
    return new Response(
      JSON.stringify({ generation: applied?.secretGeneration ?? generation, applied: applied !== null }),
      { status: 200, headers: packResponseHeaders(self) },
    );
  }

  /**
   * `POST /pack/v1/lead` — "the member calling you is the pack's lead now" (§14).
   *
   * One route, two roles, because it is one fact arriving at two kinds of recipient:
   *   • **the old lead** demotes itself and answers with its roster, which is the only way the new
   *     lead can pin members it has never spoken to;
   *   • **a peer** re-pins and starts dialling the new address, keeping its member id and the pack
   *     secret — §14's role change rather than a re-enrollment.
   *
   * **A member may only claim leadership for itself.** The claimed id must be the admitted one, so
   * nobody can nominate a third party, and the fingerprint travels in the body only so a peer that has
   * never pinned this member can pin it now.
   */
  async function newLead(req: Request, from: TrustedMember, self: string): Promise<Response> {
    const body = (await readJson(req)) as Record<string, unknown> | null;
    const claim = parseRosterEntry(body?.lead);
    if (claim === null) return badRequest(self, "a leadership claim needs `lead`");
    if (claim.memberId !== from.memberId) {
      return badRequest(self, "a member may only claim leadership for itself");
    }
    const data = await deps.store.load();
    if (data === null) return refuse(PACK_LEAD_PATH, "not-a-pack-member");

    if (isLeading(data)) {
      const handover = await commitPackChange(deps.store, deps.audit, (current) =>
        current === null ? null : demoteSelf(current, claim, now()),
      );
      if (handover === null) return badRequest(self, "not the lead of this pack");
      // The front door is NOT torn down here: publishing and unpublishing `tailscale serve` is
      // `collie serve`/`unserve`'s business (ADR 0001's ownership record lives beside the CLI, not in
      // the bridge), and no process may shell out to a tailnet on another operator's say-so. The new
      // lead prints the exact command the demoted machine's operator must run.
      return new Response(JSON.stringify({ demoted: self, roster: handover.roster }), {
        status: 200,
        headers: packResponseHeaders(self),
      });
    }

    const changed = await commitPackChange(deps.store, deps.audit, (current) =>
      current === null ? null : adoptLead(current, claim, now()),
    );
    return new Response(JSON.stringify({ lead: claim.memberId, applied: changed !== null, roster: [] }), {
      status: 200,
      headers: packResponseHeaders(self),
    });
  }

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
