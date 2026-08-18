import type { JsonObject } from "../json.ts";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_OVERHEAD, uploadTooLarge } from "../uploads.ts";
import { DEVICE_HEADER } from "./admission.ts";
import type { PackLink, PeerFailure, PeerOutcome } from "./peer-client.ts";
import { HOST_PARAM, type PeerState } from "./registry.ts";

// The LEAD side of a per-pane request: `?host=laptop` came in, the pane lives on the laptop, so the
// request is forwarded over the pack link and the laptop's answer is handed back (PACK_PROTOCOL.md
// §5, §9.1, §10.3, §12, §13).
//
// ── ONE PATH, NOT SEVEN ──────────────────────────────────────────────────────
// Every forwarded route goes through {@link forwardToPeer}. There is deliberately no per-route
// federation branch: `reply` does not know it can be remote, `upload` has no peer variant, and
// `history` does not gain a host parameter. Route matching stays exactly where it was in server.ts;
// this module is reached from the ONE place that resolves `(host, session)`.
//
// ── WHAT MAKES IT A PROXY AND NOT A RE-IMPLEMENTATION ────────────────────────
// The lead does not parse a forwarded body, does not recompute an ETag, does not touch a disk on a
// peer's behalf, and does not interpret a send/verify sequence (.adr/0010 lives client-side and on
// the OWNING host — §9.1). Everything here is request-shaping in, response-classification out; the
// transport is the injected peer client, so all of it is unit-testable without a socket.
//
// ── AND THE ONE THING IT REFUSES TO GUESS ────────────────────────────────────
// §10.3: an attempted write whose outcome is unknown is SURFACED, never retried and never reported
// as success. A pack link is `.adr/0010`'s problem over a lossier wire — a retry types the bytes into
// a real terminal twice.

/**
 * The pack route for a local `/api/...` pathname, or `null` when this route is not forwardable.
 *
 * The mapping is the identity minus the `/api/` prefix — `/api/pane/w1:p1/reply` →
 * `pane/w1:p1/reply` — because §5's peer table IS the phone's route table re-exposed 1:1. The
 * allowlist below is therefore the whole of the federation-visible surface, and everything §5
 * excludes (`subscribe`, `notifications/*`, `update/check`, `config`, `snapshot`) is excluded here
 * by simply not appearing: push subscriptions live on the lead, notification policy is one pack-wide
 * setting, update checking is per-machine, and `snapshot` is merged rather than proxied.
 *
 * The pane id is carried through **verbatim, still percent-encoded**: it is a Herdr pane id on the
 * peer's registry and never a path on anybody's disk, and re-encoding it here is how `w1:p1` on the
 * lead would quietly become something else on the peer.
 */
export function packRouteFor(pathname: string): string | null {
  if (!pathname.startsWith("/api/")) return null;
  const route = pathname.slice("/api/".length);
  return FORWARDABLE.some((re) => re.test(route)) ? route : null;
}

/**
 * The route grammars, mirroring `PANE_ROUTE` / `TAB_ACTION_ROUTE` in bridge/server.ts one-for-one.
 * `forward.test.ts` pins that correspondence by reading server.ts's source — two grammars that
 * "agree" would be two grammars that drift, and a drift here is a route the phone can call locally
 * but not across a link (or, worse, the reverse).
 */
const FORWARDABLE: readonly RegExp[] = [
  /^pane\/[^/]+(?:\/(?:reply|keys|upload|close|rename|history))?$/,
  /^tab$/,
  /^tab\/[^/]+\/(?:rename|close)$/,
  /^workspace$/,
];

/** The inverse of {@link packRouteFor}, for the peer dispatching a pack route into its own routes. */
export function apiPathFor(route: string): string | null {
  return FORWARDABLE.some((re) => re.test(route)) ? `/api/${route}` : null;
}

/** A forwarded read (proxied byte-for-byte, §9.1) or a forwarded write (§10.3, §12). */
export type ForwardKind = "read" | "write";

/**
 * Read or write, decided the way bridge/server.ts decides it and for the same reason: `history` is a
 * READ despite being an action segment — it only ever reads a log off disk — and everything else with
 * an action segment types into or restructures a terminal.
 */
export function forwardKind(route: string): ForwardKind {
  if (!route.startsWith("pane/")) return "write";
  const action = route.split("/")[2];
  return action === undefined || action === "history" ? "read" : "write";
}

/** The pane id a route addresses, for the lead's own audit line. `undefined` for tab/workspace. */
export function forwardPaneId(route: string): string | undefined {
  if (!route.startsWith("pane/")) return undefined;
  const raw = route.split("/")[1];
  return raw === undefined ? undefined : decodeURIComponent(raw);
}

/**
 * The audit action a forwarded write is recorded under on the LEAD, matching what the PEER's handler
 * will write for the same event — §12 wants "one line, `action` unchanged, plus the target host", so
 * the two independent logs can be read against each other without a translation table.
 *
 * `null` ⇒ a read, which is not audited on either side today and does not become audited by crossing
 * a link.
 */
export function forwardAuditAction(route: string): string | null {
  if (route === "tab") return "tab.create";
  if (route === "workspace") return "workspace.create";
  if (route.startsWith("tab/")) return route.endsWith("/close") ? "tab.close" : "tab.rename";
  const action = route.split("/")[2];
  if (action === undefined || action === "history") return null;
  if (action === "close" || action === "rename") return `pane.${action}`;
  return action; // reply | keys | upload
}

/**
 * The query the peer sees: everything the phone sent **except `host=`**.
 *
 * `session=` rides through untouched and is resolved by the PEER's own session registry (§5) — the
 * lead never maps one machine's session name onto another's. `host=` is dropped rather than rewritten
 * because a peer has no peers (§4): forwarding it would invite a peer to re-resolve a host, which is
 * the first step of a hop chain this protocol does not have.
 */
export function forwardParams(url: URL) {
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    if (k === HOST_PARAM) continue;
    params[k] = v;
  }
  return params;
}

/** One audit row a forward writes. `paneId`/`session` are absent, never `undefined`, when unknown. */
export type ForwardAuditEntry = {
  action: string;
  host: string;
  paneId?: string;
  session?: string;
  outcome: string;
};

/**
 * The headers a forwarded request carries. An allowlist, not a copy: a browser's `cookie`,
 * `origin`, `authorization` or device header must never reach a peer, where they would be a second,
 * unaudited basis for a decision the pack link has already made (§6, ADR 0013).
 *
 * - `if-none-match` — passed through so the peer can answer its own `304` (§9.1).
 * - `x-collie-seen` — the seen semantics travel unchanged, so "seen" is recorded ONCE, by the owning
 *   host's own ledger (.adr/0003). The lead marks nothing for a pane it does not own.
 * - `content-type` — carries the multipart boundary an upload cannot be re-assembled without (§13).
 *
 * **`accept-encoding` is deliberately NOT forwarded.** The lead asks the peer for identity bytes and
 * hands them on verbatim. Negotiating gzip on the peer hop would have the platform `fetch`
 * transparently decompress the body and strip `content-encoding`, leaving the lead re-emitting a
 * header that no longer describes the bytes — the one thing §9.1 forbids. The ETag is unaffected
 * either way (it is hashed over the pre-gzip body, `bridge/http-cache.ts`), so what this costs is one
 * hop's compression on a tailnet link, and what it buys is a byte-for-byte mirror.
 *
 * `X-Pack-Device` is added here rather than on the client because it is a property of the PHONE's
 * request — the operator's device as the lead's own `deviceAuth()` resolved it (§12) — and the sweep
 * that polls a peer's snapshot has no phone behind it. Absent when the lead's device gate is off,
 * matching how the audit field is omitted rather than nulled today.
 */
export function forwardHeaders(req: Request, device?: string | null): Headers {
  const headers = new Headers();
  for (const name of ["if-none-match", "x-collie-seen", "content-type"]) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (device !== null && device !== undefined && device !== "") headers.set(DEVICE_HEADER, device);
  return headers;
}

/** Response headers a proxied answer keeps. Everything else is the peer's business, not the phone's. */
const PROXIED_RESPONSE_HEADERS = ["content-type", "content-encoding", "etag", "cache-control", "vary"];

/**
 * The peer's answer, re-emitted for the phone **unmodified**: status, body bytes, `content-type`,
 * `content-encoding` and — critically — `etag` (§9.1).
 *
 * The body is passed as a stream, never read: a 400-turn history must not be buffered whole on the
 * lead just to be written out again, and reading it would also be the moment an ETag stopped
 * describing what was sent. A `304`/`204` carries no body at all, which the platform enforces.
 *
 * `x-pack-*` headers are stripped. They are link-internal (§6) and a browser must never see them.
 */
export function proxiedResponse(res: Response): Response {
  const headers = new Headers();
  for (const name of PROXIED_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const bodyless = res.status === 304 || res.status === 204;
  return new Response(bodyless ? null : res.body, { status: res.status, headers });
}

/** The machine-readable `code` on every refusal this module invents. The phone renders on these. */
export type ForwardErrorCode =
  | "host_unreachable"
  | "host_incompatible"
  | "write_outcome_unknown"
  | "image_too_large"
  | "route_not_federated";

/** A refusal the LEAD generated (as opposed to a peer's answer). Always JSON, never a bare 500. */
export function forwardError(
  code: ForwardErrorCode,
  error: string,
  status: number,
  extra: JsonObject = {},
): Response {
  return new Response(JSON.stringify({ ok: false, code, error, ...extra }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Whether this member is in a state that refuses a write **before it is attempted** (§10.3).
 *
 * The health here is what the lead's poll last observed (bridge/pack/registry.ts) — so the common
 * case, "the laptop is shut", is answered from knowledge rather than by discovering it mid-write.
 * That is the whole reason the refusal is legible: it names the member and when it was last seen,
 * and nothing was typed anywhere.
 *
 * A read is NOT refused this way. A stale mirror is still worth rendering, and the read has no
 * outcome to be ambiguous about — it either arrives or it does not.
 */
export function refuseWriteBeforeAttempt(state: PeerState): Response | null {
  if (state.health === "reachable") return null;
  if (state.health === "incompatible") {
    return forwardError(
      "host_incompatible",
      `host ${state.memberId} speaks a pack protocol this build cannot: ${state.reason ?? "version mismatch"}`,
      503,
      { host: state.memberId, lastSeenAt: state.lastSeenAt },
    );
  }
  return forwardError(
    "host_unreachable",
    `host ${state.memberId} is unreachable${state.lastSeenAt === null ? "" : ` (last seen ${new Date(state.lastSeenAt).toISOString()})`}` +
      `${state.reason === null ? "" : `: ${state.reason}`}`,
    503,
    { host: state.memberId, lastSeenAt: state.lastSeenAt },
  );
}

/**
 * How a failed call is reported once it HAS been dispatched.
 *
 * ── THE CONSERVATIVE DIRECTION IS THE ONLY SAFE ONE ──────────────────────────
 * For a read, every failure is just "unreachable": nothing happened, and the phone shows a stale
 * mirror.
 *
 * For a write, the question is whether the bytes reached a terminal, and `fetch` cannot answer it.
 * A timeout plainly cannot (the peer may be mid-`send_text` right now), and neither, in truth, can a
 * connection error — the runtime does not tell us whether the request had already been written when
 * the socket died. So anything that went to the transport at all is reported as **outcome unknown**:
 * not a failure, not a success, not retried, and explicitly re-checkable ("re-read the pane"). Only
 * a fault that provably never left this process (`attempted === false` — no pack secret, unusable
 * address) is a hard refusal, and only a *protocol mismatch* is a hard refusal after a round trip,
 * because a peer that answers 409 refused at admission, before its router ever saw the route (§7).
 *
 * Reporting an ambiguous write as failed would be worse than useless: the operator would re-send.
 */
export function classifyWriteFailure(failure: PeerFailure, memberId: string): Response {
  if (failure.state === "incompatible") {
    return forwardError("host_incompatible", `host ${memberId} refused: ${failure.reason}`, 503, { host: memberId });
  }
  // `attempted` lives on `unreachable` alone — the other states both imply a round trip. (A `refused`
  // cannot reach here at all: forwarding dials `proxy`, which passes a status through rather than
  // classifying it, so §14.3's 403 is not a shape this path produces.)
  if (failure.state === "unreachable" && failure.attempted === false) {
    return forwardError("host_unreachable", `host ${memberId} is unreachable: ${failure.reason}`, 503, {
      host: memberId,
    });
  }
  return forwardError(
    "write_outcome_unknown",
    `the action was sent to host ${memberId} but its outcome is unknown (${failure.reason}) — ` +
      `re-read the pane before sending it again; Collie will not retry it`,
    504,
    { host: memberId },
  );
}

/** A failed READ: always plain unreachable — nothing was changed, so nothing is ambiguous. */
export function classifyReadFailure(failure: PeerFailure, memberId: string): Response {
  const code: ForwardErrorCode = failure.state === "incompatible" ? "host_incompatible" : "host_unreachable";
  return forwardError(code, `host ${memberId}: ${failure.reason}`, 503, { host: memberId });
}

/** The transport, narrowed to what forwarding needs — {@link PackLead.forward} in production. */
export type ForwardTransport = (
  link: PackLink,
  route: string,
  params: Record<string, string>,
  init: RequestInit,
) => Promise<PeerOutcome<Response>>;

export interface ForwardDeps {
  readonly link: PackLink;
  /** The lead's current belief about this member — the refuse-before-attempt input (§10.3). */
  readonly state: PeerState;
  readonly transport: ForwardTransport;
  /**
   * The lead's own record of the forward (§12). Called for writes only, after the outcome is known,
   * with the same `action` the peer will write plus `host`. Never called for a read: a read is not
   * audited locally today and does not become audited by crossing a link.
   */
  readonly audit?: (entry: ForwardAuditEntry) => void;
  /** The operator's device, as the LEAD resolved it — forwarded as `X-Pack-Device` (§12). */
  readonly device?: string | null;
}

/**
 * Forward one session-scoped request to the peer that owns it, and answer the phone.
 *
 * Never throws: a peer being down is a rendered state, never a 500 (milestone constraint), and this
 * function is called from inside the request path of the lead's only front door.
 */
export async function forwardToPeer(req: Request, url: URL, deps: ForwardDeps): Promise<Response> {
  const route = packRouteFor(url.pathname);
  if (route === null) {
    // Not a federated route. Reached only if a caller wires a route into the host gate without
    // adding it to §5's table — a bug, answered legibly rather than by forwarding something the
    // peer surface does not expose.
    return forwardError("route_not_federated", `route ${url.pathname} is not available across a pack link`, 501, {
      host: deps.link.memberId,
    });
  }

  const kind = forwardKind(route);
  if (kind === "write") {
    const refusal = refuseWriteBeforeAttempt(deps.state);
    if (refusal !== null) return refusal;
  }

  // §13: the size bound is enforced BEFORE forwarding as well as by the peer. A phone on cellular
  // must not spend its uplink twice — once to the lead, once to a peer that was always going to
  // reject it — and the lead must not become a place where 10 MB of someone else's image is buffered.
  if (route.endsWith("/upload") && uploadTooLarge(req.headers.get("content-length"))) {
    return forwardError(
      "image_too_large",
      `image too large (max ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB)`,
      413,
      { host: deps.link.memberId, limit: MAX_UPLOAD_BYTES + MAX_UPLOAD_OVERHEAD },
    );
  }

  // `duplex` is required by the Fetch spec for a stream body; the DOM lib's `RequestInit` predates
  // it, so the streaming half of this init is typed here rather than asserted at the assignment.
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: forwardHeaders(req, deps.device),
  };
  // The body is STREAMED, not buffered: an upload is up to 10 MB of multipart and the lead never
  // stores a copy of it (§13). Assigned, never conditionally spread: a bodyless method must carry
  // NEITHER key.
  if (req.body !== null && req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    init.duplex = "half";
  }

  const outcome = await deps.transport(deps.link, route, forwardParams(url), init);
  const action = forwardAuditAction(route);
  const paneId = forwardPaneId(route);
  const session = url.searchParams.get("session");
  const record = (result: string): void => {
    if (action === null || deps.audit === undefined) return;
    // Assigned, never conditionally spread: an absent pane/session must leave the key off the entry
    // rather than record it as `undefined`.
    const entry: ForwardAuditEntry = { action, host: deps.link.memberId, outcome: result };
    if (paneId !== undefined) entry.paneId = paneId;
    if (session !== null) entry.session = session;
    deps.audit(entry);
  };

  if (!outcome.ok) {
    const response = kind === "write"
      ? classifyWriteFailure(outcome, deps.link.memberId)
      : classifyReadFailure(outcome, deps.link.memberId);
    // The lead's log records that it forwarded and what it learned — including "unknown", which is
    // the single most important line in this file to be able to find afterwards.
    record(
      outcome.state === "incompatible"
        ? "incompatible"
        : outcome.state === "unreachable" && outcome.attempted === false
          ? "refused"
          : "unknown",
    );
    return response;
  }

  record(`http ${outcome.value.status}`);
  return proxiedResponse(outcome.value);
}

