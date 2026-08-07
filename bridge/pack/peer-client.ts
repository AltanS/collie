import { PACK_PROTOCOL_VERSION } from "./enrollment.ts";
import { DEVICE_HEADER, MEMBER_HEADER, PROTOCOL_HEADER, parseProtocolHeader } from "./admission.ts";
import { PACK_PREFIX } from "./router.ts";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./signing.ts";
import type { PackRequestInit, PackTlsOptions } from "./transport.ts";

// The LEAD side of a pack link: the client that dials a peer's `/pack/v1/*` surface.
//
// It is the mirror image of `bridge/pack/router.ts` and the sibling of `bridge/herdr-client.ts` one
// level up. herdr-client is the only module that knows Herdr method names (ARCHITECTURE.md §5); this
// one knows **Collie's HTTP routes and no Herdr method at all** — that is the mux-driver seam
// (ADR 0011, PACK_PROTOCOL.md §2 rule 1), and it is mechanically checked by spec M4/03's grep for a
// dotted method literal in this file.
//
// Two properties shape every line below, and both come from `bridge/event-poker.ts`'s rule that a
// missed event costs one interval and never correctness:
//
//   • FAILURE IS A VALUE. Nothing here throws for a peer that is down, slow, skewed or refusing.
//     Every call answers with a {@link PeerOutcome}, so snapshot assembly upstream can never acquire
//     a `catch` that turns one unreachable laptop into a blank phone (§10.2).
//   • THE TRANSPORT IS INJECTED. `Bun.serve`/`Bun.connect`-dependent code cannot be unit-tested here
//     (CLAUDE.md), so the fetch is a parameter — the `bridge/dial.ts` precedent, applied one layer up.
//     peer-client.test.ts therefore exercises the real decision logic against a fake, not a socket.

/** How long a peer has to answer before the poll gives up on it, by default (§10.1). */
export const DEFAULT_PACK_TIMEOUT_MS = 1200;
/** Operator override for the per-peer budget. A pack key, so it lives here and not on `Config`. */
export const PACK_TIMEOUT_ENV = "COLLIE_PACK_TIMEOUT_MS";
/**
 * The fraction of the lead's poll interval a peer may consume. 1200/1500 — the exact default pair
 * §10.1 names — is this ratio, which is why it is the ratio: a budget must leave the lead time to do
 * its own poll and serialise its own snapshot, or a slow peer stalls the phone by arithmetic.
 */
const BUDGET_FRACTION = 0.8;

/**
 * The per-peer timeout budget, **strictly below the lead's own poll interval** (§10.1).
 *
 * Clamped rather than trusted: an operator who sets `COLLIE_PACK_TIMEOUT_MS=9000` against a 1500 ms
 * poll has asked for a peer that can stall the lead's snapshot for six polls, which is precisely the
 * failure this budget exists to make impossible. A missed budget is an unreachable poll, not a
 * delayed one, so clamping loses nothing — it converts a stall into a `stale` badge.
 */
export function packTimeoutBudget(
  pollMs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[PACK_TIMEOUT_ENV];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw.trim(), 10);
  const wanted = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PACK_TIMEOUT_MS;
  const ceiling = Math.max(1, Math.floor(pollMs * BUDGET_FRACTION));
  return Math.min(wanted, ceiling);
}

/** Where a member is dialled. `address` is the trust store's hint — never a client-supplied value. */
export interface PackLink {
  readonly memberId: string;
  readonly address: string;
}

/**
 * The injected transport. Deliberately the `fetch` shape and not a Collie-specific interface: the
 * production value is the platform's `fetch` (with the pinned-TLS agent, when M4/08 wires one), and
 * a test's value is a function. Anything richer would be a seam only the tests use.
 */
export type PackFetch = (url: string, init: PackRequestInit) => Promise<Response>;

/** Why a peer is not answering usefully. The three states of §10.2, minus `reachable`. */
export type PeerFailure =
  /** Timeout, connection refused, TLS failure, auth failure — retried on the poll cadence. */
  | {
      readonly state: "unreachable";
      readonly reason: string;
      /**
       * Whether the request reached the transport at all.
       *
       * Only ever `false` when this module can PROVE nothing was sent (no pack secret, an address it
       * refuses to dial). Absent or `true` means it may have been written to a socket, which for a
       * write is the difference between "refused" and "outcome unknown" (§10.3) — and the absence of
       * proof has to read as "possibly sent", or an ambiguous send gets reported as a clean failure
       * and the operator sends it twice. Reads ignore this field; nothing changed either way.
       */
      readonly attempted?: boolean;
    }
  /** `X-Pack-Protocol` skew (§7) — NOT retried on the cadence; probed on a slow backoff. */
  | {
      readonly state: "incompatible";
      readonly reason: string;
      readonly expected: number;
      readonly received: number | null;
    };

/**
 * The answer to any pack call. `receivedAt` is stamped from the **lead's** clock on every branch,
 * success or failure — a peer's clock is never trusted for freshness, which is also why no timestamp
 * header rides a pack response (§6, §10.2).
 */
export type PeerOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly status: number; readonly member: string | null; readonly receivedAt: number }
  | (PeerFailure & { readonly ok: false; readonly receivedAt: number });

export interface PeerClientDeps {
  /** The lead's own member id — sent as `X-Pack-Member` (informational only, §6). */
  readonly self: string;
  /**
   * The pack-wide bearer secret, read at call time.
   *
   * A **function**, not a string, for two reasons: `pack rotate` replaces it mid-process and a client
   * holding a copy would keep presenting the old one, and §8.3 keeps secrets out of argv and out of a
   * long-lived process's environment — this one is read from the 0600 trust store into memory and
   * handed over on demand. `null` means "not in a pack": no request is sent at all.
   */
  readonly secret: () => string | null;
  /** Per-peer budget in ms. Build it with {@link packTimeoutBudget}, never by hand. */
  readonly timeoutMs: number;
  readonly fetch: PackFetch;
  readonly now?: () => number;
  /** The operator's device id, forwarded for the peer's audit trail (§6, §12). Off ⇒ `null`. */
  readonly device?: () => string | null;
  /**
   * The pinned TLS material for dialling this member (§8.1, `bridge/pack/transport.ts`). A function
   * of the link rather than a value, for the same reason `secret` is: pins change under a running
   * process. `undefined` means "no material" — the far side's own listener then refuses the
   * handshake, which is exactly the refusal we want and not a quiet downgrade.
   */
  readonly tls?: (link: PackLink) => PackTlsOptions | undefined;
  /**
   * Sign every request with this collie's own identity key (§8.6). Supplied by the CLI, which is the
   * only caller that runs in the **peer → lead** direction; the bridge's lead-side client leaves it
   * unset, because that direction is pinned at the handshake and hashing a body to sign it would
   * pull a streamed upload into memory on the security path.
   */
  readonly sign?: (parts: { method: string; path: string; body: string; timestamp: number }) => string;
}

/**
 * Build the absolute URL for a pack call, from a member's stored address and a route under the pack
 * prefix.
 *
 * **An address is a host, never a URL with anything else in it.** A stored address that carries a
 * path, a query, or credentials is refused rather than dialled: the address is a hint the operator
 * typed at `join` time, and the only thing it is allowed to decide is *which machine*. The final URL
 * is then re-checked to still sit under the pack prefix, so no route segment can escape it.
 *
 * Returns `null` when either check fails — the caller reports it as unreachable, because a member the
 * lead cannot form a URL for is, from the phone's point of view, exactly a member that is not there.
 */
export function packUrl(address: string, route: string, params?: Record<string, string>): string | null {
  const withScheme = /^https?:\/\//i.test(address) ? address : `https://${address}`;
  let base: URL;
  try {
    base = new URL(withScheme);
  } catch {
    return null;
  }
  if (base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") return null;
  if (base.pathname !== "/" || base.host === "") return null;

  let url: URL;
  try {
    url = new URL(`${PACK_PREFIX}${route.replace(/^\/+/, "")}`, base);
  } catch {
    return null;
  }
  // Defence in depth against a route assembled from anything but a literal upstream: `..` segments
  // are normalised by `new URL`, so this catches an escape after normalisation rather than before it.
  if (!url.pathname.startsWith(PACK_PREFIX)) return null;
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * The lead's client for one pack. Stateless: it holds no per-peer state, no timers and no cache, so
 * "what the lead believes about peer X" lives in the registry (bridge/pack/registry.ts) and there is
 * exactly one place to look for it.
 *
 * Zero tax follows from that statelessness — constructing one arms nothing, and a solo lead never
 * constructs one because it has no peers to hand it.
 */
export class PeerClient {
  private readonly now: () => number;

  constructor(private readonly deps: PeerClientDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** `GET /pack/v1/hello` — liveness, version and the peer's member id (§5). */
  async hello(link: PackLink): Promise<PeerOutcome<{ protocol: number; member: string }>> {
    const outcome = await this.json(link, "hello");
    if (!outcome.ok) return outcome;
    const body = outcome.value as Record<string, unknown> | null;
    const member = typeof body?.member === "string" ? body.member : null;
    const protocol = typeof body?.protocol === "number" ? body.protocol : null;
    if (member === null || protocol === null) {
      return this.fail({ state: "unreachable", reason: "hello: malformed response body" });
    }
    return { ...outcome, value: { protocol, member } };
  }

  /** `GET /pack/v1/snapshot` — the one merged route (§5). Shape is spec M4/04's business. */
  snapshot(link: PackLink, session?: string): Promise<PeerOutcome<unknown>> {
    return this.json(link, "snapshot", session === undefined || session === "" ? undefined : { session });
  }

  /** A pack call whose JSON body the lead consumes. */
  async json(
    link: PackLink,
    route: string,
    params?: Record<string, string>,
    init: PackRequestInit = {},
  ): Promise<PeerOutcome<unknown>> {
    const outcome = await this.raw(link, route, params, init);
    if (!outcome.ok) return outcome;
    try {
      return { ...outcome, value: await outcome.value.json() };
    } catch {
      // A body that will not parse, from a peer whose version header matched, is a broken peer — not
      // a version problem. §7's rule runs the other way (a version mismatch is never *reported* as a
      // parse error) and is already applied in `raw()`, before a byte of body is read.
      return this.fail({ state: "unreachable", reason: `${route}: malformed response body` });
    }
  }

  /**
   * A pack call whose `Response` the lead hands on untouched, with **every status the peer chose
   * preserved** — the proxied reads and forwarded writes of §9.1/§5.
   *
   * This is {@link PeerClient.raw} minus its `!res.ok ⇒ unreachable` rule, and the difference is the
   * entire point: `raw` is for bodies the lead consumes, where a 404 is a broken peer; `proxy` is for
   * responses the phone consumes, where the peer's `304`, `404`, `405`, `409`-from-a-handler and
   * `413` are the *answer* and flattening them into "unreachable" would destroy exactly the fidelity
   * §9.1 asks for — most sharply the `304`, which is the whole conditional-GET win.
   *
   * The link's own refusals are still failures, not answers: an unadmitted 401 carries no pack
   * headers by construction (§8.5), so it never reaches the phone as a 401 the operator would read as
   * *their* credentials failing. A peer's own gate refuses with pack headers attached and is passed
   * through, because that refusal is the peer's write-level check doing its job (§12).
   *
   * The body is never read here, so an ETag and a byte-for-byte mirror survive the hop.
   */
  async proxy(
    link: PackLink,
    route: string,
    params?: Record<string, string>,
    init: PackRequestInit = {},
  ): Promise<PeerOutcome<Response>> {
    return this.dial(link, route, params, init, "passthrough");
  }

  /**
   * A pack call whose `Response` the lead hands on untouched, refusing any non-2xx.
   *
   * The body is not read here, so an ETag and a byte-for-byte mirror survive the hop.
   */
  async raw(
    link: PackLink,
    route: string,
    params?: Record<string, string>,
    init: PackRequestInit = {},
  ): Promise<PeerOutcome<Response>> {
    return this.dial(link, route, params, init, "consumed");
  }

  /**
   * The one dial. `mode` decides only what a non-2xx status means — everything before that (the
   * credential, the URL, the budget, the version check, §7's 409) is identical by construction,
   * because two dial paths would be two places for a pack request to forget its `Authorization`.
   */
  private async dial(
    link: PackLink,
    route: string,
    params: Record<string, string> | undefined,
    init: PackRequestInit,
    mode: "consumed" | "passthrough",
  ): Promise<PeerOutcome<Response>> {
    const secret = this.deps.secret();
    if (secret === null || secret === "") {
      // Never send an unauthenticated pack request. A missing secret is a local fault (not in a pack,
      // or a store that failed to load), and probing a peer without a credential would teach an
      // operator's logs nothing while looking exactly like an attack.
      return this.fail({ state: "unreachable", reason: "no pack secret", attempted: false });
    }
    const url = packUrl(link.address, route, params);
    if (url === null) {
      return this.fail({ state: "unreachable", reason: `unusable address: ${link.address}`, attempted: false });
    }

    const device = this.deps.device?.() ?? null;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${secret}`);
    headers.set(PROTOCOL_HEADER, String(PACK_PROTOCOL_VERSION));
    headers.set(MEMBER_HEADER, this.deps.self);
    // A per-call device (a forwarded phone request, §12) wins over the client-wide one: it is the
    // operator the LEAD authenticated for *this* action, where the client-level source is a process
    // default with no request behind it. Authorization/protocol/member are NOT negotiable this way —
    // they are set unconditionally above, so nothing a caller passes can shape the link's own claims.
    if (!headers.has(DEVICE_HEADER) && device !== null && device !== "") headers.set(DEVICE_HEADER, device);

    // §8.6's signature, when this client holds an identity key. Signed over the body **as it will be
    // sent** — hence the requirement that `init.body` be a string here: a stream could not be hashed
    // without consuming it, and a signature over bytes other than the ones on the wire is worse than
    // none. Every signed route's body is a small JSON literal built by a verb, so this costs nothing.
    if (this.deps.sign !== undefined) {
      const timestamp = this.now();
      const body = typeof init.body === "string" ? init.body : "";
      const path = new URL(url).pathname;
      headers.set(TIMESTAMP_HEADER, String(timestamp));
      headers.set(SIGNATURE_HEADER, this.deps.sign({ method: init.method ?? "GET", path, body, timestamp }));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    let res: Response;
    try {
      // `tls` rides the init: Bun's fetch takes the pinned material per request, so there is no agent
      // to construct, cache or invalidate — the pin is read fresh on every dial, from the store.
      const tls = this.deps.tls?.(link);
      res = await this.deps.fetch(url, { ...init, headers, signal: controller.signal, ...(tls ? { tls } : {}) });
    } catch (err) {
      // Timeout, connection refused, DNS, TLS — one state, because the phone's answer is the same in
      // all of them: last-good state, marked stale (§10.2). The peer's address is named; the secret
      // never appears in a reason string, and nothing here interpolates one.
      const reason = controller.signal.aborted
        ? `timed out after ${this.deps.timeoutMs}ms`
        : errorReason(err);
      // `attempted` is left absent, i.e. "possibly sent". The runtime does not tell us whether the
      // request had already been written when the socket died, and §10.3 is explicit that an
      // unresolvable ambiguity is surfaced rather than guessed.
      return this.fail({ state: "unreachable", reason: `${route}: ${reason}` });
    } finally {
      clearTimeout(timer);
    }

    // ── Version first, before status and before the body ─────────────────────
    // §7: "The lead applies the same rule to a peer's RESPONSE header: a reply with a version it
    // cannot read is a mismatch, not a parse error." Reading the body first would turn a v2 peer's
    // perfectly well-formed answer into a parse failure and hide the real cause.
    const received = parseProtocolHeader(res.headers.get(PROTOCOL_HEADER));
    if (received === null && res.status === 401) {
      // An unadmitted caller gets a bare 401 with NO version banner (§8.5, `unauthorizedResponse`).
      // That is the shape of a rotated secret or a dropped pin, and §10.2 files an auth failure under
      // `unreachable` — not `incompatible`, which would put it on the slow backoff and leave the
      // operator waiting ten minutes after fixing the very thing `pack status` told them to fix.
      return this.fail({ state: "unreachable", reason: `${route}: refused by the peer (unauthorized)` });
    }
    if (received !== PACK_PROTOCOL_VERSION) {
      return this.fail({
        state: "incompatible",
        reason: `${route}: peer answered protocol ${received ?? "none"}, this build speaks ${PACK_PROTOCOL_VERSION}`,
        expected: PACK_PROTOCOL_VERSION,
        received,
      });
    }
    if (res.status === 409) {
      // The peer refused *us* for skew (§7). It already named both sides; the body is the reason
      // string the operator sees verbatim in `pack status`, so it is read rather than paraphrased.
      const mismatch = await readMismatch(res);
      return this.fail({
        state: "incompatible",
        reason: `${route}: ${mismatch.reason}`,
        expected: mismatch.expected,
        received: mismatch.received,
      });
    }
    if (mode === "consumed" && !res.ok) {
      // Includes 401 — an auth failure is `unreachable`, per §10.2's table, and not a distinct state:
      // a rotated secret and a pulled cable both mean "the lead cannot see this member right now".
      return this.fail({ state: "unreachable", reason: `${route}: HTTP ${res.status}` });
    }

    return {
      ok: true,
      value: res,
      status: res.status,
      member: res.headers.get(MEMBER_HEADER),
      receivedAt: this.now(),
    };
  }

  private fail(failure: PeerFailure): PeerOutcome<never> {
    return { ok: false, ...failure, receivedAt: this.now() };
  }
}

/**
 * Run one call against every member, **concurrently** (§10.1: "N peers must not add N round trips of
 * latency"). Bounded by each call's own budget, so the whole sweep finishes within one budget rather
 * than N of them.
 *
 * `Promise.all` over already-failure-valued calls is safe by construction: nothing in this module
 * rejects, so the sweep cannot lose a healthy peer's answer to a sick peer's throw. A caller passing
 * a `run` that *does* throw gets the throw — that is its bug, not a state to invent here.
 */
export async function sweepPeers<T>(
  links: readonly PackLink[],
  run: (link: PackLink) => Promise<T>,
): Promise<Map<string, T>> {
  const results = await Promise.all(links.map(async (link) => [link.memberId, await run(link)] as const));
  return new Map(results);
}

/** The reason string for a transport throw, with no secret and no stack in it. */
function errorReason(err: unknown): string {
  if (err instanceof Error) return err.message === "" ? err.name : err.message;
  return "request failed";
}

/** Read a `409` body for §7's `expected`/`received`, tolerating a peer that sends neither. */
async function readMismatch(res: Response): Promise<{ reason: string; expected: number; received: number | null }> {
  try {
    const body = (await res.json()) as Record<string, unknown> | null;
    const error = typeof body?.error === "string" ? body.error : "pack protocol mismatch";
    const expected = typeof body?.expected === "number" ? body.expected : PACK_PROTOCOL_VERSION;
    const received = typeof body?.received === "number" ? body.received : null;
    return { reason: error, expected, received };
  } catch {
    return { reason: "pack protocol mismatch", expected: PACK_PROTOCOL_VERSION, received: null };
  }
}
