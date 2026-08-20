import type { AuditLog } from "../audit.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import {
  admitPackRequest,
  factsFrom,
  MEMBER_HEADER,
  packResponseHeaders,
  parseProtocolHeader,
  protocolMismatchResponse,
  PROTOCOL_HEADER,
  unauthorizedResponse,
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
  isDemotionRefused,
  isLeading,
  parseEnrollRequest,
  parseRosterEntry,
  recordSignedRequest,
  removeMember,
  PACK_PROTOCOL_VERSION,
  type DemotionRefused,
} from "./enrollment.ts";
import { randomToken, type RandomSource } from "./identity.ts";
import {
  parseTimestamp,
  timestampVerdict,
  verifyRequestSignature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "./signing.ts";
import type { TrustedMember, TrustStore, TrustStoreData } from "./trust-store.ts";
import { checkWarrantPush, storeWarrant, warrantReportOf, type WarrantRefusal } from "./warrant.ts";
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
 * `POST` — this collie's own lead delivers or refreshes the warrant naming the pack's deputy (§18).
 *
 * **Storage only.** What arrives here lands on disk and is inert at the transport until this collie
 * restarts: `server.reload({tls})` does not swap a pinned `ca` list, so the second anchor a warrant
 * authorises is built at bind time or not at all (§8.1). That is the two-phase arming, and no route
 * can climb it.
 */
export const PACK_WARRANT_PATH = "/pack/v1/warrant";

/**
 * The machine-readable `code` on §14.3's refusal of an unapproved leadership claim.
 *
 * It exists so `collie promote` can tell "the lead said no" from "the lead did not answer" without
 * parsing prose — the difference between an operator running one more verb on the lead and an
 * operator reaching for `--force`, which strands every peer (§14.4).
 */
export const HANDOVER_NOT_APPROVED = "handover_not_approved";

/**
 * The routes a caller may authenticate with a §8.6 signature — deliberately a closed set.
 *
 * These are exactly the routes that travel **peer → lead**, which is the one direction where the
 * transport cannot pin (the lead's front door terminates TLS, `bridge/pack/transport.ts`). The two
 * membership routes are why the mechanism exists; `hello` is on the list because `collie pack status`
 * and `collie reconnect` run on a peer and must be able to probe their lead — a diagnostic that could
 * not authenticate would report every healthy lead as refusing.
 *
 * **The proxy surface is not on this list and must not be**: those calls run lead → peer over a
 * pinned handshake, and admitting a signature there would mean reading a request body to hash it,
 * turning a streamed upload (§13) into a buffered one on the security path. `enroll` is not on it
 * either — at that instant the joiner is pinned by nobody (§8.2).
 */
const SIGNABLE_PATHS: ReadonlySet<string> = new Set([PACK_LEAVE_PATH, PACK_LEAD_PATH, PACK_HELLO_PATH]);

/** The subset of {@link SIGNABLE_PATHS} that CHANGES STATE, and therefore advances the replay floor. */
const MEMBERSHIP_PATHS: ReadonlySet<string> = new Set([PACK_LEAVE_PATH, PACK_LEAD_PATH]);

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
  /**
   * Whether the listener this handler is mounted on was built pin-enforcing
   * (`bridge/pack/transport.ts`). **Defaults to `false`, which admits nothing but a signed request.**
   *
   * Not a configuration key and not readable from a request: it is set by the same code that
   * constructed the TLS options, so "pinned" cannot be claimed by anything that did not do the
   * pinning. A peer whose pin could not be built passes `false` and is down rather than single-factor.
   */
  readonly transportPinned?: boolean;
  /**
   * Called after a membership change this handler wrote — an enrollment, a demotion, an adopted lead.
   *
   * The trust store is read once per process (bridge/index.ts), so a change arriving over the wire is
   * persisted and NOT wired: the lead that just enrolled its first peer is still merging nothing, and
   * the lead that just demoted itself is still listening as a lead. Re-wiring in place is refused —
   * mode, pinned `ca` and sweep are startup-shaped, and `server.reload({tls})` does not swap a pinned
   * `ca` at all — so what this hook buys is the process SAYING so (bridge/pack/staleness.ts). It is a
   * notification, never a control: it takes nothing and it is not awaited.
   */
  readonly onMembershipChange?: () => void;
  /**
   * This build's own version string, for `hello` (§5, §7.1) — bare, as `collie version` names it
   * without its parenthetical (`bridge/version.ts`'s `collieVersionBare`).
   *
   * **Threaded in once, at boot, by whoever constructs the router** (`bridge/index.ts`). It is not
   * read per request: the answer cannot change without a restart, and `hello` is the pack's most
   * frequent route, so a per-request disk read would be a cost with no truth behind it.
   *
   * Absent ⇒ the field is simply omitted from the response, which the other side reads as
   * "older than this amendment" (§7.1's absent-means-closed). Optional so a test constructing a
   * router for some other route need not care; the boot path always supplies it.
   */
  readonly version?: string;
  readonly now?: () => number;
  readonly random?: RandomSource;
}

/** Answers a pack request, or `null` when the path is not ours (so the normal router continues). */
export type PackHandler = (req: Request, url: URL) => Promise<Response | null>;

/** The outcome of checking a §8.6 signature: who signed, when, or which factor to refuse on. */
interface SignedCaller {
  readonly member: string | null;
  readonly timestamp?: number;
  readonly refusal?: RefusedFactor;
}

/**
 * Verify a §8.6 signature against a **pinned** member's certificate.
 *
 * Order is the rule: the signature is checked before the timestamp, so a caller who cannot sign
 * learns nothing about clock skew or about which timestamps this collie has already seen. Every
 * failure returns the same `certificate` factor, which the caller sees as the same uniform 401 as an
 * unpinned certificate — because that is exactly what it is.
 *
 * The candidate set is the pinned roster, narrowed by `X-Pack-Member` when it is present. That header
 * is a **hint that saves verifications, never an identity** (§6): if it names a member whose key does
 * not verify the signature, nothing is admitted, and the fallback tries the rest of the roster rather
 * than trusting the claim.
 */
function verifySigned(
  data: TrustStoreData,
  req: Request,
  url: URL,
  signature: string,
  body: string,
  now: number,
): SignedCaller {
  const timestamp = parseTimestamp(req.headers.get(TIMESTAMP_HEADER));
  if (timestamp === null) return { member: null, refusal: "certificate" };
  const parts = { method: req.method, path: url.pathname, body, timestamp };

  const claimed = req.headers.get(MEMBER_HEADER);
  const roster = [...(data.lead === null ? [] : [data.lead]), ...data.peers].filter((m) => m.status === "enrolled");
  const ordered = claimed === null ? roster : [...roster.filter((m) => m.memberId === claimed), ...roster];
  const signer = ordered.find((m) => verifyRequestSignature(m.certPem, signature, parts));
  if (signer === undefined) return { member: null, refusal: "certificate" };

  const verdict = timestampVerdict(timestamp, now, signer.signedAt);
  if (verdict !== "ok") return { member: null, refusal: "certificate" };
  return { member: signer.memberId, timestamp };
}

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
/**
 * `GET /pack/v1/hello`'s body. `version` is the OPTIONAL field of the 2026-08-12 amendment (§7.1);
 * the two warrant fields are the OPTIONAL fields of §18's, read the same way — **absent means "no
 * warrant, or a build that does not know about warrants", never "up to date"** (RFC §11.2).
 */
type HelloBody = {
  protocol: number;
  member: string;
  version?: string;
  warrantGeneration?: number;
  warrantRefreshedAt?: number;
};

/**
 * A box rather than a bare `let`, so a refusal decided inside `commitPackChange`'s callback survives
 * with its type intact: TypeScript's flow analysis does not follow an assignment made in a closure.
 */
type DemotionGate = { refused: DemotionRefused | null };

/** The record inside a parsed JSON body, or null when the body isn't one (a scalar, an array). */
function asRecord(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

/**
 * A JSON body, or `null` when it will not parse. Every membership route answers `null` with a 400.
 *
 * `cached` is the body text already read to verify a §8.6 signature. Re-reading `req` after that
 * would throw on a consumed stream — and, worse, parsing a *second* read would mean the bytes that
 * were signed and the bytes that are acted on could differ. One read, one meaning.
 */
async function readJson(req: Request, cached: string | null): Promise<JsonValue> {
  try {
    // SAFETY: both branches are JSON.parse output (`Request.json()` is one too), which IS a
    // JsonValue by construction. Every field read off it below is checked before it is used.
    return cached === null ? await req.json() : (JSON.parse(cached) as JsonValue);
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

/** The one body `/pack/v1/warrant` answers with. `applied: false` is a success, not a refusal. */
function warrantAnswer(self: string, generation: number, applied: boolean): Response {
  return new Response(JSON.stringify({ generation, applied }), {
    status: 200,
    headers: packResponseHeaders(self),
  });
}

/**
 * What a refused warrant push is TOLD, which is deliberately less than what is known.
 *
 * The caller here is this collie's own pinned lead, so §8.1's uniform-401 rule does not apply and a
 * useful sentence is owed: every one of these is an operator-fixable fault on the *lead's* side, and
 * a lead that cannot tell "your clock says this expired" from "your certificate did not match" has
 * to guess at a two-machine problem. The signature failure is NOT in this table — it is answered as
 * the uniform 401, because that is the one refusal an attacker could also provoke.
 */
function warrantRefusalText(reason: Exclude<WarrantRefusal, "bad-signature">): string {
  if (reason === "malformed") return "a warrant push needs a well-formed `warrant`";
  if (reason === "foreign") return "this warrant is not from this collie's own lead, or not for this pack";
  if (reason === "expired") return "this warrant is past its validity on this collie's clock — re-run `collie pack deputy`";
  return "the certificate that rode with this warrant is not the one its fingerprint names";
}

export function createPackRouter(deps: PackRouterDeps): PackHandler {
  const transportPinned = deps.transportPinned ?? false;
  const membershipChanged = (): void => deps.onMembershipChange?.();
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

    // §8.6's signature, when one is offered. The BODY is read here — and only here, and only when the
    // header is present — because the digest is part of what was signed. A request without the header
    // (every lead→peer call: those ride the pinned handshake) never has its body touched, which is
    // what keeps a proxied upload a stream rather than a buffer.
    const signature = SIGNABLE_PATHS.has(pathname) ? req.headers.get(SIGNATURE_HEADER) : null;
    let signedBody: string | null = null;
    let signed: SignedCaller = { member: null };
    if (signature !== null && data !== null) {
      signedBody = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      signed = verifySigned(data, req, url, signature, signedBody, now());
      if (signed.refusal !== undefined) return refuse(pathname, signed.refusal);
    }

    const verdict = admitPackRequest(data, factsFrom(req, { transportPinned, signedMember: signed.member }));
    if (!verdict.ok) {
      if (verdict.refusal === "protocol_mismatch") return protocolMismatchResponse(verdict.received);
      return refuse(pathname, verdict.factor);
    }

    // The replay floor moves BEFORE the request is handled, so a captured request replayed against a
    // slow handler cannot land twice (§8.6). Only for a signed MEMBERSHIP call: `hello` changes
    // nothing, so a replay of it is bounded by the skew window alone and does not earn a disk write —
    // and an unsigned call rode a pinned handshake, where replay is the transport's problem.
    // TOCTOU, noted and today harmless: the freshness verdict read `signer.signedAt` back in
    // `verifySigned` (the admission read), while THIS commit advances the replay floor a step later and
    // is serialized behind that read — so two signed requests interleaving could both clear admission
    // before either has committed the new floor. It costs nothing because the only signed state-changing
    // routes are `leave` and `lead` (`MEMBERSHIP_PATHS`), and both are idempotent — a doubled leave or a
    // doubled self-claim lands the same roster. A future NON-idempotent signed membership route must
    // close the window (read-and-advance the floor in one serialized step) rather than inherit this note.
    const signedAt = signed.timestamp;
    if (signed.member !== null && signedAt !== undefined && MEMBERSHIP_PATHS.has(pathname)) {
      await commitPackChange(deps.store, deps.audit, (current) =>
        current === null ? null : recordSignedRequest(current, verdict.member.memberId, signedAt),
      );
    }

    if (pathname === PACK_HELLO_PATH && req.method === "GET") {
      // Liveness + version + member id (§5). Nothing else: `hello` is what an admitted lead uses to
      // confirm a link, so it must not become a place to learn anything an unadmitted caller wants.
      // A version is admissible here for the same reason `member` is — it is already knowable to
      // anyone who has cleared both factors.
      //
      // `version` is the OPTIONAL field of the 2026-08-12 amendment (§7.1) and it is additive: an
      // older parser reads `protocol` and `member` by name and passes the sibling over untouched, so
      // this build answering an older prober costs nothing and needs no coordination.
      const hello: HelloBody = { protocol: PACK_PROTOCOL_VERSION, member: verdict.self };
      if (deps.version !== undefined) hello.version = deps.version;
      // What warrant this member holds (§18). Admissible here for the same reason `member` is: it is
      // already knowable to anyone who cleared both factors, and it names no secret — a generation
      // integer and a timestamp. Omitted entirely when there is no warrant, which is the closed read.
      const report = warrantReportOf(data);
      if (report !== null) {
        hello.warrantGeneration = report.generation;
        hello.warrantRefreshedAt = report.refreshedAt;
      }
      return new Response(JSON.stringify(hello), {
        status: 200,
        headers: packResponseHeaders(verdict.self),
      });
    }

    if (pathname === PACK_SECRET_PATH && req.method === "POST") {
      return secret(req, signedBody, verdict.member, verdict.self);
    }
    if (pathname === PACK_WARRANT_PATH && req.method === "POST") {
      return warrant(req, signedBody, verdict.member, verdict.self);
    }
    if (pathname === PACK_LEAD_PATH && req.method === "POST") {
      return newLead(req, signedBody, verdict.member, verdict.self);
    }
    if (pathname === PACK_LEAVE_PATH && req.method === "POST") {
      // The caller drops ITSELF, and can drop nothing else — the member id is the admitted one, never
      // a body field. Removal is idempotent: a second `leave` from a member already gone answers 200
      // rather than 404, because the operator's question ("am I still listed there?") is answered the
      // same way either time and a 404 would read as a broken link.
      await commitPackChange(deps.store, deps.audit, (current) =>
        current === null ? null : removeMember(current, verdict.member.memberId),
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
      //
      // The warrant report rides ALONG the body rather than inside it (§18, RFC §11.2): `body` is the
      // very object this collie serves its own browser, and a pack-only field has no business in the
      // browser's snapshot type. `mergeSnapshot` whitelists what it reads, so the siblings reach the
      // lead's sweep and never the phone.
      const report = warrantReportOf(data);
      const withReport =
        report === null
          ? body
          : { ...body, warrantGeneration: report.generation, warrantRefreshedAt: report.refreshedAt };
      return new Response(JSON.stringify(withReport), {
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

  /**
   * §14.3's refusal: **403, and free to say why**. The caller passed both factors and §8.6, so
   * §8.1's uniform-401 rule does not apply — that rule exists to tell an *unauthenticated* caller
   * nothing. This is one status up from `badRequest` because the caller is *admitted but not
   * permitted*: §5's "admitted and allowed to do this are different questions", answered on the wire.
   *
   * **Byte-identical for every clause.** No approval at all, an approval naming somebody else, and a
   * fingerprint that does not match the pinned member all produce this exact body: who *is* approved
   * is the operator's business on the lead, not a fact the wire owes an unsuccessful claimant. The
   * only variable is the claimant's own id, which it obviously already knows.
   */
  function handoverNotApproved(self: string, claimant: string): Response {
    return new Response(
      JSON.stringify({
        error:
          `this lead has not approved "${claimant}" to take over — run \`collie pack approve-promote ${claimant}\` ` +
          "here, then re-run `collie promote` on that machine within 10 minutes",
        code: HANDOVER_NOT_APPROVED,
      }),
      { status: 403, headers: packResponseHeaders(self) },
    );
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
  async function secret(req: Request, cached: string | null, from: TrustedMember, self: string): Promise<Response> {
    const body = asRecord(await readJson(req, cached));
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
   * `POST /pack/v1/warrant` — the lead delivers or refreshes the warrant naming the deputy (§18).
   *
   * **Only this collie's own lead may push one**, the same role check `/pack/v1/secret` carries and
   * for the same reason: a warrant is a pack-wide statement about who may take the crown, so an
   * admitted *peer* minting one would be a compromised member reaching past its own machine (§8.5).
   * The check is doubled — the caller must be the pinned lead, and the warrant must claim to come
   * from that same member — because they are two different questions and only both close the gap.
   *
   * **A refusal costs no write.** Every branch below either answers without touching the store or
   * hands one transition to `commitPackChange`; a warrant that does not verify leaves this collie
   * holding exactly what it held before, which is the fail-closed reading of every failure mode.
   */
  async function warrant(req: Request, cached: string | null, from: TrustedMember, self: string): Promise<Response> {
    const data = await deps.store.load();
    if (data === null || data.lead === null || data.lead.memberId !== from.memberId) {
      // Not our lead. Audited as a refused factor for the reason `secret` gives: this is a pinned
      // member exceeding its role rather than a stranger, and that distinction belongs in the log.
      return refuse(PACK_WARRANT_PATH, "not-a-pack-member");
    }
    const verdict = checkWarrantPush(data, await readJson(req, cached), now());
    if (verdict.kind === "refuse") {
      if (verdict.reason === "bad-signature") {
        // A signature that does not verify is answered exactly like an unpinned certificate, because
        // that is what it is: the uniform 401, and the real cause only in this operator's own log.
        return refuse(PACK_WARRANT_PATH, "certificate");
      }
      return badRequest(self, warrantRefusalText(verdict.reason));
    }
    if (verdict.kind === "stale") {
      // A redelivery applies nothing and is still a success — the lead's question is "does this
      // member hold generation N?", and reporting what IS held is what stops the lead re-pushing.
      return warrantAnswer(self, verdict.generation, false);
    }
    const applied = await commitPackChange(deps.store, deps.audit, (current) =>
      current === null ? null : storeWarrant(current, verdict.stored),
    );
    // Stored on disk, INERT at the transport: this process pinned its `ca` list at bind time and
    // `server.reload({tls})` does not swap it (§8.1), so the second anchor the warrant authorises
    // exists only after a restart. Saying so is the whole of what this hook buys (staleness.ts) —
    // and it is exactly the "warrant stored, anchor INACTIVE" state §18 asks the operator to see.
    if (applied !== null) membershipChanged();
    return warrantAnswer(self, applied?.generation ?? verdict.stored.warrant.generation, applied !== null);
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
  async function newLead(req: Request, cached: string | null, from: TrustedMember, self: string): Promise<Response> {
    const body = asRecord(await readJson(req, cached));
    const claim = parseRosterEntry(body?.lead);
    if (claim === null) return badRequest(self, "a leadership claim needs `lead`");
    if (claim.memberId !== from.memberId) {
      return badRequest(self, "a member may only claim leadership for itself");
    }
    const data = await deps.store.load();
    if (data === null) return refuse(PACK_LEAD_PATH, "not-a-pack-member");

    if (isLeading(data)) {
      // The demotion is gated on a live operator approval minted HERE (§14, ADR 0014) — the claim
      // authenticates a member, never an operator's will. The check runs INSIDE the single serialised
      // store write, so reading the approval and spending it cannot be split by an expiry or a race.
      // A box rather than a bare `let`, so the refusal survives the closure with its type intact:
      // TypeScript's flow analysis does not follow an assignment made inside a callback.
      const gate: DemotionGate = { refused: null };
      const handover = await commitPackChange(deps.store, deps.audit, (current) => {
        if (current === null) return null;
        const outcome = demoteSelf(current, claim, from, now());
        if (isDemotionRefused(outcome)) {
          // Carried out, not written: a refusal must add NO store write. The replay floor for this
          // membership route already committed before this handler ran (§8.6) and gate 1 must not
          // compound it — so the transition returns "no change" and `update` writes nothing.
          gate.refused = outcome;
          return null;
        }
        return outcome;
      });
      if (gate.refused !== null) {
        // Audited with the failing clause, on the machine being taken from — the audit log is this
        // operator's own record (§12), so it may say what the wire deliberately does not.
        deps.audit?.record({
          action: "pack.lead.refused",
          detail: { member: claim.memberId, clause: gate.refused.clause },
        });
        return handoverNotApproved(self, claim.memberId);
      }
      if (handover === null) return badRequest(self, "not the lead of this pack");
      // Demoted on disk, still a lead in memory: this process keeps its lead-mode listener — and
      // pins nothing — until it restarts (§14's note). Nothing here restarts it: the supervision
      // tier is the CLI's knowledge, not the bridge's, and an unsupervised bridge that exited to be
      // restarted would simply be gone. So it says so, loudly, in its own journal.
      membershipChanged();
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
    if (changed !== null) membershipChanged();
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

    let body: JsonValue;
    try {
      // SAFETY: `Request.json()` output IS a JsonValue by construction; `parseEnrollRequest` below
      // re-checks every field before any of it is used.
      body = (await req.json()) as JsonValue;
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

    // THE CERTIFICATE ARRIVES IN THE PAYLOAD, AND THAT IS THE WHOLE TRUST STORY HERE (§8.2).
    // There is no transport cross-check to make: enrollment is answered by the LEAD, whose surface
    // sits behind a TLS-terminating front door, so a client certificate cannot reach this process
    // under any design (`bridge/pack/transport.ts`). What vouches for the certificate is the
    // single-use token the operator carried out of band, and the pin is trust-on-first-use at this
    // instant — `parseEnrollRequest` has already refused a payload whose certificate and fingerprint
    // are not the same certificate, so what is pinned is what the joiner will actually present.
    const response = await commitPackChange(deps.store, deps.audit, (data) =>
      data === null
        ? null
        : enrollPeer(
            data,
            {
              fingerprint: parsed.fingerprint,
              certPem: parsed.certPem,
              address: parsed.address,
              label: parsed.label ?? invite.label,
            },
            now(),
            random,
          ),
    );
    if (response === null) return refuse(PACK_ENROLL_PATH, "not-a-pack-member");

    // The peer is in the roster on disk; this process still holds the one it booted with (§8.2's
    // note). The joiner is told to restart the lead too — this is the lead's own record of it.
    membershipChanged();
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: packResponseHeaders(response.leadMemberId),
    });
  }
}
