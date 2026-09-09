// REMOVE_IN_1_9_0 — the whole file. Every export below exists for one release of overlap.
//
// ── WHAT THIS IS ─────────────────────────────────────────────────────────────
// Protocol version 2 renamed every name a machine reads on the crew link and moved nothing else
// (CREW_PROTOCOL.md §0, ADR 0039): `/pack/v1/*` became `/crew/v1/*`, `X-Pack-*` became `X-Crew-*`,
// and the two signing contexts took the crew word. A crew is updated LEAD FIRST (§20), so for the
// length of the roll a 1.8.0 lead has to keep a 1.7.0 member enrolling, answering `hello` and
// self-levelling over the link it already has. This module is that overlap, and it is the ONLY place
// version 1 is spelled (§0.1).
//
// ── HOW IT WORKS, AND WHY IT IS A TRANSLATION RATHER THAN A SECOND ROUTER ────
// A second set of handlers would be a second place for a crew decision to live, and the two would
// drift within a release. So there is one router, and `/pack/v1/*` reaches it through two pure
// translations:
//
//   • ON THE WAY IN — {@link translateVersion1Request} renames `x-pack-*` to `x-crew-*` and maps a
//     claimed version 1 to 2, so `admitCrewRequest` decides exactly as it does for a version 2
//     caller. {@link version2PathFor} gives the router the canonical `/crew/v1/*` path to ROUTE on,
//     while the `URL` itself keeps the path that was actually dialled — which is what the §8.6
//     request signature and the dial attestation hash, so neither can be rewritten.
//   • ON THE WAY OUT — {@link toVersion1Response} renames the crew response headers back and maps
//     the protocol header's `2` to `1`. It touches **no body**: a proxied read (§5's 1:1 table) may
//     be megabytes and must stay a stream, so the two bodies that name the version integer take it
//     as an argument instead (`hello`'s `protocol`, the §7 mismatch's `expected`).
//
// ── THE TWO SIGNING CONTEXTS ─────────────────────────────────────────────────
// The request signature names no domain — its four fields are method, path, body digest and
// timestamp (`signing.ts`) — so a version 1 signature verifies untouched, on the version 1 path the
// caller dialled. The dial attestation and the warrant DO name a domain, and both version 1 spellings
// are below: {@link V1_DIAL_DOMAIN} is chosen per dial from the prefix, and
// {@link canonicalWarrantVersion1} is accepted alongside the version 2 form so a warrant a 1.7.0
// lead signed still verifies on a machine that has just updated.
//
// ── WHAT REMOVING THIS LOOKS LIKE ────────────────────────────────────────────
// Delete this file, delete every `REMOVE_IN_1_9_0` site listed in `bridge/removal-schedule.test.ts`,
// and §7's exact-match window does its ordinary job: from 1.9.0 a 1.7.0 member does not talk to a
// 1.9.0 lead, which is what a version window is for. That test fails at package minor 9 while any of
// it is still here, so the removal cannot be forgotten.

import type { JsonValue } from "../json.ts";
import type { Warrant } from "./trust-store.ts";
import { CREW_PREFIX } from "./router.ts";

/** The version 1 path prefix. The one string this whole overlap exists to keep answering. */
export const V1_PREFIX = "/pack/v1/";

/** The protocol integer a version 1 caller claims, and the one the overlap answers with. */
export const V1_PROTOCOL_VERSION = 1;

/** The version 1 header namespace, lowercase — `Headers` keys are lowercased on iteration. */
const V1_HEADER_PREFIX = "x-pack-";

/** The version 2 header namespace, lowercase. Same suffixes, one word apart. */
const V2_HEADER_PREFIX = "x-crew-";

/** The version 1 dial attestation's domain tag (`signing.ts` → `canonicalDial`). */
export const V1_DIAL_DOMAIN = "collie-pack-dial-v1";

/** The version 1 warrant's domain tag (`warrant.ts` → `canonicalWarrant`). */
export const V1_WARRANT_DOMAIN = "collie-pack-warrant-v1";

/** The literal that stands in for a null deputy field. Mirrors `warrant.ts`'s own `NONE`. */
const NONE = "-";

/** Is this request on the version 1 surface? The one test the router makes before translating. */
export function isVersion1Path(pathname: string): boolean {
  return pathname.startsWith(V1_PREFIX);
}

/**
 * The canonical version 2 path a version 1 request ROUTES as. Never the path that is signed, and
 * never written back onto the `URL`: the signature and the dial attestation hash what was dialled.
 */
export function version2PathFor(pathname: string): string {
  return `${CREW_PREFIX}${pathname.slice(V1_PREFIX.length)}`;
}

/** The version 1 path for a version 2 one — the member's fallback dial (`peer-client.ts`). */
export function version1PathFor(pathname: string): string {
  return `${V1_PREFIX}${pathname.slice(CREW_PREFIX.length)}`;
}

/**
 * A version 1 request, restated in version 2's header vocabulary. Body, method, URL and every other
 * header are untouched.
 *
 * The protocol integer is mapped rather than rewritten: `1` becomes `2` so the version check admits,
 * and **anything else is left exactly as it arrived** so a caller claiming a version nobody serves
 * still gets §7's refusal naming what it said.
 */
export function translateVersion1Request(req: Request): Request {
  return new Request(req, { headers: toVersion2Headers(req.headers) });
}

/**
 * `x-pack-*` renamed to `x-crew-*`, and a claimed version `1` mapped to `2`. Every other header,
 * and every other protocol value, is passed through byte for byte.
 *
 * The mapping is one-directional on purpose: a caller claiming a version nobody serves keeps the
 * value it sent, so §7's refusal names what it actually said.
 */
export function toVersion2Headers(from: Headers): Headers {
  const headers = renamed(from, V1_HEADER_PREFIX, V2_HEADER_PREFIX);
  const key = `${V2_HEADER_PREFIX}protocol`;
  const claimed = headers.get(key);
  if (claimed !== null && claimed.trim() === String(V1_PROTOCOL_VERSION)) {
    headers.set(key, String(V1_PROTOCOL_VERSION + 1));
  }
  return headers;
}

/**
 * `x-crew-*` renamed to `x-pack-*`, and this build's version `2` mapped to `1`.
 *
 * Used on both sides of the overlap — a lead's answer to a 1.7.0 member, and a 1.8.0 member's own
 * fallback dial — so the two can never state the header set differently.
 */
export function toVersion1Headers(from: Headers): Headers {
  const headers = renamed(from, V2_HEADER_PREFIX, V1_HEADER_PREFIX);
  const key = `${V1_HEADER_PREFIX}protocol`;
  const stated = headers.get(key);
  if (stated !== null && stated.trim() === String(V1_PROTOCOL_VERSION + 1)) {
    headers.set(key, String(V1_PROTOCOL_VERSION));
  }
  return headers;
}

/** Every header, with one namespace prefix swapped for another. Nothing else is touched. */
function renamed(from: Headers, was: string, becomes: string): Headers {
  const headers = new Headers();
  for (const [name, value] of from) {
    headers.set(name.startsWith(was) ? `${becomes}${name.slice(was.length)}` : name, value);
  }
  return headers;
}

/**
 * `POST /pack/v1/enroll`'s body, with its `protocol` field mapped 1 → 2.
 *
 * The one body this overlap rewrites, and the only one it may: `enroll` is the single route whose
 * version can arrive in the payload rather than the header (`router.ts` reads the header first and
 * falls back to the field), and it is deliberately absent from `SIGNABLE_PATHS` — at that instant the
 * joiner is pinned by nobody, so no signature covers these bytes and rewriting them breaks nothing.
 *
 * A body that is not an object, or whose `protocol` is not `1`, is returned unchanged.
 */
export function translateVersion1EnrollBody(body: JsonValue): JsonValue {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  if (body.protocol !== V1_PROTOCOL_VERSION) return body;
  return { ...body, protocol: V1_PROTOCOL_VERSION + 1 };
}

/**
 * A version 2 answer, restated in version 1's header vocabulary. **The body is never read.**
 *
 * `x-crew-protocol: 2` becomes `x-pack-protocol: 1`; any other value is passed through, because a
 * value this build did not write is not this function's to reinterpret.
 */
export function toVersion1Response(res: Response): Response {
  const bodyless = res.status === 304 || res.status === 204;
  return new Response(bodyless ? null : res.body, { status: res.status, headers: toVersion1Headers(res.headers) });
}

/**
 * A version 1 answer, restated in version 2's header vocabulary. **The body is never read.**
 *
 * The member's half of the fallback: with the headers moved once, here, every line that reads a crew
 * header off a response — the version check, the member banner, `forward.ts`'s stripping — is
 * version-agnostic and does not have to be taught the overlap.
 */
export function toVersion2Response(res: Response): Response {
  const bodyless = res.status === 304 || res.status === 204;
  return new Response(bodyless ? null : res.body, { status: res.status, headers: toVersion2Headers(res.headers) });
}

/** The version 1 URL for a version 2 one — the member's fallback dial (`peer-client.ts`). */
export function version1Url(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = version1PathFor(parsed.pathname);
  return parsed.toString();
}

/**
 * The version 1 canonical warrant string — the eight fields with the old domain tag.
 *
 * Accepted alongside the version 2 form (`warrant.ts` → `verifyWarrantSignature`) for one reason a
 * transient roll does not cover: a peer that updates from 1.7.0 finds a warrant its old lead signed
 * already on its disk, and a machine that refused its own stored warrant would disarm the standby
 * door on the update rather than on the operator's decision. Nothing SIGNS this form any more.
 */
export function canonicalWarrantVersion1(w: Warrant): string {
  return [
    V1_WARRANT_DOMAIN,
    w.crewId,
    String(w.generation),
    w.leadMemberId,
    w.deputyMemberId ?? NONE,
    w.deputyFingerprint ?? NONE,
    String(w.issuedAt),
    String(w.refreshedAt),
  ].join("\n");
}

/**
 * Does this answer look like a collie that has never heard of `/crew/v1`? (§0.1)
 *
 * Read only when the answer carried NO crew protocol header, which the caller has already checked —
 * a crew answer is always stamped, so this can never claim one.
 *
 * Three shapes, and the third is the one that decides it on a real machine. Measured in the VM lab
 * on 2026-09-09: a 1.7.0 bridge answers `/crew/v1/hello` with `200 OK`, `content-type: text/html`
 * and the PWA's app shell, because `bridge/server.ts` hands every unrouted path the built
 * `index.html` so a deep link works offline. A path it has never heard of is a deep link to that
 * fallthrough. The other two are real but narrower: a peer serving no web bundle answers `404`, and
 * a loopback-strict one answers `403 non-loopback peer rejected` — which never fires on a crew
 * machine, because those all set `COLLIE_ALLOW_NON_LOOPBACK_BIND=1`.
 *
 * **A 5xx is excluded and must stay excluded.** That is a proxy or a peer mid-restart, not a version,
 * and a second dial there would double what every poll spends on a machine that is not answering.
 *
 * **This is a heuristic, on purpose.** It reads what a 1.7.0 bridge ANSWERS an unrouted path with —
 * its SPA catch-all, a `200 text/html` carrying no crew protocol header — because a build already in
 * the field cannot be patched after the fact to name its version on a path it does not route. Hence
 * `REMOVE_IN_1_9_0` for the whole of it: the guess is cheaper than the alternative for one release,
 * and after that release nothing needs it.
 */
export function routesNoCrewV1(res: Response): boolean {
  if (res.status >= 500) return false;
  if (res.status === 404 || res.status === 403) return true;
  if (res.status !== 200) return false;
  // A crew answer is `application/json`. Anything else on a 200 — `text/html` above all — is a
  // build answering a path it does not route.
  const type = res.headers.get("content-type") ?? "";
  return !type.toLowerCase().includes("json");
}

/**
 * The one line a member writes when it falls back, once per lead (`peer-client.ts`).
 *
 * `[crew]` because that is the journal prefix from 1.8.0 on, and an operator grepping a journal that
 * spans the update is told to grep both (`docs/crew.md` → "Updating from 1.7.0").
 */
export function version1FallbackLine(memberId: string): string {
  return `[crew] ${memberId}: speaks version 1, dialling /pack/v1 until it updates`;
}
