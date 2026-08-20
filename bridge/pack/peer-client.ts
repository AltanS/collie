import type { JsonObject, JsonValue } from "../json.ts";
import { PACK_PROTOCOL_VERSION } from "./enrollment.ts";
import { DEVICE_HEADER, MEMBER_HEADER, PROTOCOL_HEADER, parseProtocolHeader } from "./admission.ts";
import { LEAD_CONFLICT, PACK_PREFIX, PAIRING_LABEL_COLLISION } from "./router.ts";
import { DIAL_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, type DialParts } from "./signing.ts";
import type { PackRequestInit, PackTlsOptions } from "./transport.ts";
import type { Warrant } from "./trust-store.ts";
import { parsePairingReport, type PairingSync } from "./standby-devices.ts";
import type { TakeoverBody } from "./takeover.ts";
import { parseWarrant, parseWarrantActiveReport, type WarrantPush } from "./warrant.ts";

// The LEAD side of a pack link: the client that dials a peer's `/pack/v1/*` surface.
//
// It is the mirror image of `bridge/pack/router.ts` and the sibling of `bridge/mux/herdr/client.ts`.
// That module is the only one that knows Herdr method names (ARCHITECTURE.md §5); this
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
  const { wanted, ceiling } = budgetParts(pollMs, env);
  return Math.min(wanted, ceiling);
}

/** The two halves {@link packTimeoutBudget} compares, so the warning below reads the same arithmetic. */
function budgetParts(pollMs: number, env: Record<string, string | undefined>) {
  const raw = env[PACK_TIMEOUT_ENV];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw.trim(), 10);
  const asked = Number.isFinite(parsed) && parsed > 0;
  return {
    wanted: asked ? parsed : DEFAULT_PACK_TIMEOUT_MS,
    ceiling: Math.max(1, Math.floor(pollMs * BUDGET_FRACTION)),
    asked,
  };
}

/**
 * The sentence to print when the clamp above **bit** — i.e. the operator asked for a budget and got a
 * smaller one. `null` when they asked for nothing, or asked for something the poll can afford.
 *
 * The clamp itself stays (it is the arithmetic that keeps a slow peer from stalling the lead), but it
 * stops being SILENT: `COLLIE_PACK_TIMEOUT_MS=3000` at the default 1500 ms poll changes nothing at
 * all, and an operator who set it to chase a slow link deserves to be told which knob actually moves —
 * `COLLIE_POLL_MS`. Same posture as `startupWarnings` in `bridge/server.ts`: a pure function that
 * returns the line, and a caller that decides where it is printed.
 */
export function packTimeoutClampWarning(
  pollMs: number,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const { wanted, ceiling, asked } = budgetParts(pollMs, env);
  if (!asked || wanted <= ceiling) return null;
  const neededPoll = Math.ceil(wanted / BUDGET_FRACTION);
  return (
    `[pack] ${PACK_TIMEOUT_ENV}=${wanted} has no effect beyond ${ceiling}ms: a peer may use at most ` +
    `${BUDGET_FRACTION} of the ${pollMs}ms poll, or a slow peer stalls this lead's own snapshot. ` +
    `For the full ${wanted}ms, raise the poll too: COLLIE_POLL_MS=${neededPoll}.`
  );
}

/** How long a `hello` PROBE may take before the lead calls a member gone (§10.4), by default. */
export const DEFAULT_PACK_HELLO_TIMEOUT_MS = 5000;
/** Operator override for the probe budget. A pack key, so it lives here and not on `Config`. */
export const PACK_HELLO_TIMEOUT_ENV = "COLLIE_PACK_HELLO_TIMEOUT_MS";
/**
 * A hard stop on the probe budget. It exists only so a typo (`50000000`) cannot wedge a one-shot verb
 * like `pack status` for the rest of the afternoon; nothing on the poll path waits on this budget, so
 * it is a usability bound and not a safety one.
 */
const HELLO_BUDGET_CEILING_MS = 60_000;

/**
 * The budget for a `hello` PROBE — the call that decides §10.2's **verdict**, and the one budget in
 * this file that the poll fraction does NOT clamp.
 *
 * ── WHY THIS EXISTS (measured, 2026-08-18) ───────────────────────────────────
 * A healthy peer behind a Tailscale DERP relay (≈350 ms RTT, TLS handshake measured at 1.9 s) read
 * `unreachable · hello: timed out after 1200ms` forever. The arithmetic, not the peer, was the fault:
 *
 *   • Bun's `fetch` DOES pool a pinned-TLS connection, even though `tls` rides each init and this
 *     module hands it a fresh object per dial — 5 sequential dials cost 1 TCP accept, measured
 *     through a counting proxy (`harness.test.ts`, "a cold handshake priced above the budget").
 *   • But an ABORTED attempt leaves no pooled connection behind. So when the cold handshake alone
 *     costs more than the whole per-request budget, every attempt aborts mid-handshake, the next one
 *     starts cold again, and the link never bootstraps. Four attempts, four accepts, four timeouts.
 *   • One patient call breaks the deadlock: it completes the handshake, and every strict-budget
 *     request after it rides the warm connection at one RTT.
 *
 * So the verdict gets its own budget and the poll keeps the strict one. A data request that misses
 * {@link packTimeoutBudget} still means "stale this poll" — never "peer gone" — and the probe that
 * decides "gone" is allowed to pay for a handshake. Clamping it to the poll fraction would restore
 * the deadlock, which is precisely why it is not clamped.
 *
 * It is floored at the data budget so an operator cannot make the verdict MORE impatient than the
 * poll it is meant to outlast.
 */
export function packHelloBudget(
  pollMs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[PACK_HELLO_TIMEOUT_ENV];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw.trim(), 10);
  const wanted = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PACK_HELLO_TIMEOUT_MS;
  return Math.max(packTimeoutBudget(pollMs, env), Math.min(wanted, HELLO_BUDGET_CEILING_MS));
}

// ── The bootstrap credit ─────────────────────────────────────────────────────
//
// The patient budget above fixed the VERDICT and left the DATA path in the same deadlock it was
// measured out of (2026-08-19, against a real DERP-relayed peer): hello cold 1.86 s → 200, snapshot
// cold **with the handshake** 1.22 s → 200, snapshot warm 0.12 s. Every data request carried the
// strict ~1200 ms budget, so a cold one aborted mid-handshake; an aborted attempt pools nothing, so
// the next one started cold as well, and the peer read `unreachable` with every pane read answering
// 503 after exactly one budget, forever.
//
// So a data request gets ONE patient attempt per cold link — the same medicine as `hello`, bounded so
// it can never become the steady-state budget:
//
//   • WARM (a dial reached the far side and nothing has failed since) ⇒ the strict budget, always.
//     Warm requests measured 0.11–0.12 s, so the strict budget is not what is broken.
//   • COLD with its credit unspent ⇒ the patient budget, and the credit is spent AT ISSUE. Concurrent
//     requests and later polls therefore do not stack patient dials: at most one is ever in flight.
//   • COLD with its credit spent ⇒ the strict budget. A host that is genuinely gone fails in one
//     strict budget per poll, which is the pre-existing behaviour and the point of the bound.
//   • A warm link that fails is granted a fresh credit, because that is exactly the shape of a pool
//     the far side (or an idle timer) tore down: one strict miss, then one patient re-bootstrap.
//
// It is deliberately small, pure and exported so `peer-client.test.ts` can pin the matrix without a
// socket. Only a DATA dial spends a credit — `hello` already carries the patient budget of its own.

/** What a {@link PeerClient} remembers about one link, for budget selection and nothing else. */
export interface LinkWarmth {
  /** A dial reached the far side and nothing has failed since. */
  readonly warm: boolean;
  /** The one patient attempt a cold link is allowed has already been issued. */
  readonly bootstrapSpent: boolean;
}

/** A link nothing is known about yet: cold, and owed its one patient attempt. */
export const COLD_LINK: LinkWarmth = { warm: false, bootstrapSpent: false };

/** The budget for one data dial, and the warmth to remember while it is in flight. */
export interface TakenBudget {
  readonly budgetMs: number;
  readonly next: LinkWarmth;
}

/**
 * Pick a data request's budget and consume a bootstrap credit if it takes one.
 *
 * `patientMs` is floored at `strictMs` here as well as in {@link packHelloBudget}, so a hand-wired
 * client can never make its bootstrap attempt MORE impatient than its steady state.
 */
export function takeDataBudget(state: LinkWarmth, strictMs: number, patientMs: number): TakenBudget {
  if (state.warm || state.bootstrapSpent) return { budgetMs: strictMs, next: state };
  return { budgetMs: Math.max(strictMs, patientMs), next: { warm: false, bootstrapSpent: true } };
}

/**
 * Fold one dial's TRANSPORT result back in. `reached` is "the far side answered at all" — a 401, a 409
 * and a 404 all reached it, and all leave a usable pooled connection behind, so all of them are warm.
 * Only a throw (timeout, refusal, DNS, TLS) is a failure here.
 */
export function foldWarmth(state: LinkWarmth, reached: boolean): LinkWarmth {
  if (reached) return { warm: true, bootstrapSpent: false };
  return { warm: false, bootstrapSpent: state.warm ? false : state.bootstrapSpent };
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
      /**
       * `true` when this call died on its own budget rather than on the network — the difference
       * between "the link is slow" and "the host is not there".
       *
       * It is the one distinction §10.4 can make CHEAPLY: the abort is this process's own doing, so
       * no extra probe, no extra socket and no guess is involved. A refused connection, a DNS
       * failure and a TLS refusal all leave it absent, because those are answers from the world.
       * `PackLead` reads it to decide which failures deserve a patient re-probe.
       */
      readonly timedOut?: boolean;
    }
  /** `X-Pack-Protocol` skew (§7) — NOT retried on the cadence; probed on a slow backoff. */
  | {
      readonly state: "incompatible";
      readonly reason: string;
      readonly expected: number;
      readonly received: number | null;
    }
  /**
   * The far side is there, admitted us, and **said no** — §14.3's `403` with a machine-readable
   * `code` (today: an unapproved promotion).
   *
   * Its own state because collapsing it into `unreachable` is how `collie promote` came to aim the
   * operator at `--force`, the destructive remedy, for what is actually a missing consent on the
   * lead. A refusal is an *answer*: the verb prints it verbatim and stops, and nothing retries it.
   */
  | {
      readonly state: "refused";
      /** The far side's own `error` string, surfaced verbatim — never paraphrased. */
      readonly reason: string;
      readonly code: string;
      readonly status: number;
      /**
       * The labels the refusal named, when it named any — today only `pairing_label_collision`
       * (§18.14), where the far side's own device labels are the fact its operator's counterpart has
       * to act on. Absent everywhere else, and **absent means none**: a refusal that names no label
       * is not a refusal about labels.
       */
      readonly labels?: readonly string[];
    }
  /**
   * **The far side follows a different lead** — §18.10's named `409`, with `code: "lead_conflict"`.
   *
   * Its own state, and §10.2's fourth, because the three it is NOT are each wrong in a different
   * way: it is not `unreachable` (the member answered, and answered precisely), it is not
   * `incompatible` (§7 reserves that for a protocol mismatch, and this build reads that member's
   * protocol perfectly well), and it is not `refused` (that is a member declining an action, not one
   * declining the caller's whole premise about who leads).
   *
   * `warrant` is the proof that deposed the caller, when the answering member sent one. It is
   * verified by the reader against its OWN certificate before anything acts on it
   * (`deposed.ts` — `isDepositionProof`), so nothing here trusts it; this is transport, and it hands
   * the bytes over unchanged.
   */
  | {
      readonly state: "conflicted";
      readonly reason: string;
      readonly leadMemberId: string;
      /** The generation the answering member holds, or `null` when it reported none. */
      readonly warrantGeneration: number | null;
      readonly warrant: Warrant | null;
    };

/**
 * The answer to any pack call. `receivedAt` is stamped from the **lead's** clock on every branch,
 * success or failure — a peer's clock is never trusted for freshness, which is also why no timestamp
 * header rides a pack response (§6, §10.2).
 */
export type PeerOutcome<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly status: number;
      readonly member: string | null;
      readonly receivedAt: number;
      /**
       * The far side's HTTP `Date`, in epoch ms, or `null` when it sent none or an unparseable one.
       *
       * **Not a protocol field and not a freshness signal** — §6's "no timestamp header rides a pack
       * response" is untouched, because nothing here adds one: `Date` is what every HTTP server
       * already writes, and reading it costs no route, no field and no exchange. Its one consumer is
       * `collie doctor`'s clock check, which compares it against `receivedAt` (this collie's own
       * clock) to catch the skew that breaks §8.6 signatures as a uniform 401. Nothing on the poll
       * path reads it, and it is never persisted.
       */
      readonly date: number | null;
    }
  | (PeerFailure & { readonly ok: false; readonly receivedAt: number });

/** What a `hello` reports about the member that answered it (§5). */
export interface HelloResult {
  readonly protocol: number;
  readonly member: string;
  /** The answering build's own version, or `null` when it did not report one — §7.1's pre-amendment. */
  readonly version: string | null;
  /**
   * The warrant generation that member holds, or `null` (§18.7).
   *
   * **Absent means "holds no warrant, or is a build that does not know about warrants" — never "up
   * to date".** The boot gate (`boot-gate.ts`) reads it as evidence in exactly one direction: a
   * member reporting a generation HIGHER than this machine's own has been told something by somebody
   * else. Nothing reads a lower or absent one as agreement.
   */
  readonly warrantGeneration: number | null;
  /**
   * The warrant generation that member's LISTENER activated at bind, or `null` (§18.17).
   *
   * The other half of RFC §5's two phases, and the half a lead cannot observe: storage is a file the
   * peer reports, activation is what its process came up holding. **Absent means "nothing active
   * there, or a build that cannot say" — never "armed"**, so the lead falls back to the lower bound
   * in its own `pack-ops.json` and keeps naming the remedy, which is today's reading unchanged.
   */
  readonly warrantActiveGeneration: number | null;
  /**
   * The digest of the synced pairing registry that member holds, or `null` (§18.14).
   *
   * **Absent means "nothing synced there", never "up to date"** — the same reading the warrant
   * generation beside it carries, and both make the lead push. `collie pack deputy` renders it so the
   * operator can see a deputy whose door has no credential to check against.
   */
  readonly pairingDigest: string | null;
}

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
  /**
   * The patient budget: {@link PeerClient.hello}'s, and a cold link's one bootstrap data attempt
   * ({@link takeDataBudget}). Build it with {@link packHelloBudget}, never by hand.
   *
   * It is still built from `COLLIE_PACK_HELLO_TIMEOUT_MS` because it is the same budget the verdict
   * probe named on 2026-08-18 and an operator-facing key does not churn for a second caller. Absent ⇒
   * every call shares the strict data budget, which is the pre-2026-08-18 behaviour and the deadlock
   * the two docs above describe — so every production wiring supplies it.
   */
  readonly patientTimeoutMs?: number;
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
  /**
   * Attest **every** dial with this collie's own identity key (§8.6's dial attestation) — the
   * lead → peer direction's answer to "which of my two anchors is calling?".
   *
   * Unlike {@link PeerClientDeps.sign} it never touches the body, so a streamed upload (§13) stays a
   * stream: what it binds is the method, the path, the timestamp and **the member being dialled**.
   * That last field is what stops a lead-signed dial the deputy legitimately received being presented
   * at a sibling peer (`signing.ts` → `canonicalDial`).
   *
   * **Every production wiring supplies it**, on both sides of the CLI/bridge split, because a peer
   * that has anchored a deputy refuses a dial without one. Absent ⇒ the header is simply not sent,
   * which a single-anchor peer reads exactly as it always has.
   */
  readonly dialSign?: (parts: DialParts) => string;
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
 * The lead's client for one pack. It holds no timers, no cache and no belief about a peer: "what the
 * lead believes about peer X" lives in the registry (bridge/pack/registry.ts) and there is exactly one
 * place to look for it.
 *
 * The one thing it does remember is {@link LinkWarmth} — whether a dial to an address has ever
 * succeeded — because the budget for the NEXT request depends on whether a handshake has already been
 * paid for, and nothing outside this class knows that. It is transport bookkeeping, not state about a
 * member: it decides a timeout and never a verdict, it is never persisted, and losing it costs one
 * patient dial. Keyed by address, which is what the connection pool is keyed by; a member that moved
 * (`collie reconnect`) is a different connection and correctly starts cold again. Bounded by the
 * roster, since an address only ever comes from the trust store.
 *
 * Zero tax otherwise — constructing one arms nothing, and a solo lead never constructs one because it
 * has no peers to hand it.
 */
export class PeerClient {
  private readonly now: () => number;
  private readonly warmth = new Map<string, LinkWarmth>();

  constructor(private readonly deps: PeerClientDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * `GET /pack/v1/hello` — liveness, version and the peer's member id (§5).
   *
   * **The call that ALWAYS runs on the patient budget** ({@link packHelloBudget}), where a data
   * request gets one such attempt per cold link ({@link takeDataBudget}) and the strict budget
   * thereafter. It is the verdict probe: `pack status` renders it, `reconnect` confirms with it, and
   * the lead re-probes a timed-out peer with it. It is never on the poll's hot path, so paying for a
   * cold handshake here costs the phone nothing — and the connection it warms is the one the next
   * strict-budget snapshot rides.
   */
  async hello(link: PackLink): Promise<PeerOutcome<HelloResult>> {
    const outcome = await this.json(link, "hello", undefined, {}, this.deps.patientTimeoutMs);
    if (!outcome.ok) return outcome;
    const body = asRecord(outcome.value);
    const member = typeof body?.member === "string" ? body.member : null;
    const protocol = typeof body?.protocol === "number" ? body.protocol : null;
    if (member === null || protocol === null) {
      return this.fail({ state: "unreachable", reason: "hello: malformed response body" });
    }
    // `version` is OPTIONAL (§5, amended 2026-08-12) and read with absent-means-closed semantics
    // (§7.1): absent means "a build older than this amendment", NEVER an error and never a reason to
    // refuse — the protocol integer is the only thing that refuses. Anything that is not a string is
    // absent too: a malformed sibling on an otherwise well-formed body is one member reporting
    // nothing, not a broken link, and it must not turn a reachable peer unreachable.
    const version = typeof body?.version === "string" && body.version !== "" ? body.version : null;
    // The warrant generation (§18.7), read the same absent-means-closed way `version` is: anything
    // that is not a safe integer is "reported nothing", which never refuses a link and never reads as
    // agreement. The refresh timestamp is deliberately not read here — the lead's re-push decision
    // rides the `snapshot` answer (`warrant.ts` → `parseWarrantReport`), and a second reader of the
    // same pair would be a second place for "is this member behind?" to be answered.
    const generation = body?.warrantGeneration;
    const warrantGeneration = typeof generation === "number" && Number.isSafeInteger(generation) ? generation : null;
    // §18.14's report, read the same absent-means-closed way: anything that is not a digest is
    // "nothing synced", which never refuses a link and never reads as agreement.
    // §18.17's activation report, read the same absent-means-closed way: anything that is not a safe
    // integer is "nothing active there", which never refuses a link and never reads as armed.
    const warrantActiveGeneration = parseWarrantActiveReport(outcome.value);
    const pairingDigest = parsePairingReport(outcome.value);
    return {
      ...outcome,
      value: { protocol, member, version, warrantGeneration, warrantActiveGeneration, pairingDigest },
    };
  }

  /**
   * `POST /pack/v1/warrant` — deliver or refresh the warrant naming the pack's deputy (§18).
   *
   * An ordinary **data** dial, on the same budget every other one gets: the strict per-poll budget,
   * plus the single bootstrap credit a cold link is owed ({@link takeDataBudget}). It is deliberately
   * NOT given `hello`'s standing patient budget — that one belongs to the verdict, and a member that
   * is behind on its warrant is simply behind until the next sweep asks again.
   *
   * A **404 is the answer, not a fault**: it is a pre-amendment member, which is not warrant-capable
   * and therefore not takeover-capable (§7.1's absent-means-closed). It surfaces here as the ordinary
   * `unreachable` outcome the caller already handles, and re-asking costs one small body per sweep.
   */
  warrant(link: PackLink, payload: WarrantPush): Promise<PeerOutcome<JsonValue>> {
    return this.json(link, "warrant", undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /**
   * `POST /pack/v1/pairing` — sync the lead's paired-device registry to the DEPUTY (RFC §6.5, §18.14).
   *
   * An ordinary data dial on the ordinary budget. A `404` or a `401` is the answer, not a fault: a
   * pre-amendment member has no route, and a member that is not the deputy refuses the role — both
   * surface as the `unreachable` outcome the caller already handles, and neither is retried faster.
   */
  pairing(link: PackLink, payload: PairingSync): Promise<PeerOutcome<JsonValue>> {
    return this.json(link, "pairing", undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /**
   * `POST /pack/v1/takeover` — the witness question, then the re-pin (RFC §7).
   *
   * **Never §8.6-signed, and that is not an omission.** The caller here is the DEPUTY, which is not in
   * the receiving peer's roster at all — so a signature could only ever fail to verify against it, and
   * a failed signature is the uniform 401 before the deputy path is reached. What authenticates this
   * dial is the pinned handshake against the anchored certificate plus the dial attestation that says
   * which of the two anchors is calling (§8.1's 2026-08-20 amendment), which is strictly the same key.
   */
  takeover(link: PackLink, payload: TakeoverBody): Promise<PeerOutcome<JsonValue>> {
    return this.json(
      link,
      "takeover",
      undefined,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
      undefined,
      false,
    );
  }

  /** `GET /pack/v1/snapshot` — the one merged route (§5). Shape is spec M4/04's business. */
  snapshot(link: PackLink, session?: string): Promise<PeerOutcome<JsonValue>> {
    return this.json(link, "snapshot", session === undefined || session === "" ? undefined : { session });
  }

  /** A pack call whose JSON body the lead consumes. */
  async json(
    link: PackLink,
    route: string,
    params?: Record<string, string>,
    init: PackRequestInit = {},
    budgetMs?: number,
    sign = true,
  ): Promise<PeerOutcome<JsonValue>> {
    const outcome = await this.raw(link, route, params, init, budgetMs, sign);
    if (!outcome.ok) return outcome;
    try {
      const value: JsonValue = await outcome.value.json();
      return { ...outcome, value };
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
    return this.dial(link, route, params, init, "passthrough", undefined, false);
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
    budgetMs?: number,
    sign = true,
  ): Promise<PeerOutcome<Response>> {
    return this.dial(link, route, params, init, "consumed", budgetMs, sign);
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
    // The one knob a caller may widen, and only `hello` does: the verdict probe's patient budget
    // (§10.4). Everything else runs on the strict per-poll one — except for the single bootstrap
    // attempt a cold link is owed, which is chosen below and can never repeat while the link stays
    // down. A caller must never widen a data request by hand; that rule is what keeps a slow peer
    // from stalling the lead's snapshot every poll.
    budgetMs?: number,
    // Whether a §8.6 REQUEST signature may ride this call, when this client holds a key. Two callers
    // say no, and for two different reasons: `proxy` streams its body (a signature over a stream
    // cannot be computed without buffering it, §8.6's own trade), and `takeover` is dialled by a
    // machine that is not in the receiver's roster, where a signature could only ever be a refusal.
    sign = true,
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
    // Chosen AFTER the two pre-flight refusals above, so a missing secret or an unusable address —
    // neither of which touches a socket — can never spend a link's one bootstrap credit.
    const timeoutMs = budgetMs ?? this.takeBudget(link);

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
    // Both signatures share ONE timestamp, because they share the header that carries it and a
    // second stamp would be a second freshness claim about one request.
    const stampedAt = this.now();
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    if (this.deps.sign !== undefined && sign) {
      const body = typeof init.body === "string" ? init.body : "";
      headers.set(TIMESTAMP_HEADER, String(stampedAt));
      headers.set(SIGNATURE_HEADER, this.deps.sign({ method, path, body, timestamp: stampedAt }));
    }
    // The dial attestation rides EVERY call, not a closed set: it hashes no body, so there is no
    // streamed upload to pull into memory and therefore no reason to confine it (§8.6).
    if (this.deps.dialSign !== undefined) {
      headers.set(TIMESTAMP_HEADER, String(stampedAt));
      headers.set(DIAL_HEADER, this.deps.dialSign({ method, path, timestamp: stampedAt, to: link.memberId }));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      // `tls` rides the init: Bun's fetch takes the pinned material per request, so there is no agent
      // to construct, cache or invalidate — the pin is read fresh on every dial, from the store.
      const tls = this.deps.tls?.(link);
      const dialInit: PackRequestInit = { ...init, headers, signal: controller.signal };
      // Assigned, never conditionally spread: an unpinned link must carry NO `tls` key at all.
      if (tls) dialInit.tls = tls;
      res = await this.deps.fetch(url, dialInit);
      // A response — ANY response — means the handshake completed and the pool holds a connection the
      // next strict-budget request can ride. Status is irrelevant here; it is read further down.
      this.settle(link, true);
    } catch (err) {
      this.settle(link, false);
      // Timeout, connection refused, DNS, TLS — one state, because the phone's answer is the same in
      // all of them: last-good state, marked stale (§10.2). The peer's address is named; the secret
      // never appears in a reason string, and nothing here interpolates one.
      const aborted = controller.signal.aborted;
      const reason = aborted ? `timed out after ${timeoutMs}ms` : errorReason(err);
      // `attempted` is left absent, i.e. "possibly sent". The runtime does not tell us whether the
      // request had already been written when the socket died, and §10.3 is explicit that an
      // unresolvable ambiguity is surfaced rather than guessed.
      //
      // `timedOut` is NOT the same ambiguity: the abort is this process's own clock firing, so it is
      // known rather than guessed, and it is what lets §10.4 tell a slow link from a dead host.
      return this.fail({ state: "unreachable", reason: `${route}: ${reason}`, timedOut: aborted });
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
      // TWO answers share this status, and the body's `code` is what tells them apart (§18.10). The
      // body is read ONCE and both readings come off that one record: a second `res.json()` would
      // throw on a consumed stream, and re-reading is how two answers to one question drift apart.
      const body = await read409(res);
      const conflict = leadConflictOf(body);
      if (conflict !== null) {
        // Not a version skew and not a refusal: this member answered precisely, and what it said is
        // that the caller's whole premise about who leads is out of date (§10.2's fourth state).
        return this.fail({
          state: "conflicted",
          reason: `${route}: ${conflict.error}`,
          leadMemberId: conflict.leadMemberId,
          warrantGeneration: conflict.warrantGeneration,
          warrant: conflict.warrant,
        });
      }
      // §18.14's label collision, and it is a REFUSAL rather than a skew. The receiver read this body
      // perfectly and declined it for a reason on its own disk, so classifying it as `incompatible`
      // would blame the protocol for a duplicate device label — and would leave the lead unable to
      // name the labels, which is the one thing its operator can act on.
      const collision = pairingCollisionOf(body);
      if (collision !== null) {
        return this.fail({
          state: "refused",
          reason: `${route}: ${collision.error}`,
          code: PAIRING_LABEL_COLLISION,
          status: res.status,
          labels: collision.labels,
        });
      }
      // The peer refused *us* for skew (§7). It already named both sides; the body is the reason
      // string the operator sees verbatim in `pack status`, so it is read rather than paraphrased.
      const mismatch = readMismatch(body);
      return this.fail({
        state: "incompatible",
        reason: `${route}: ${mismatch.reason}`,
        expected: mismatch.expected,
        received: mismatch.received,
      });
    }
    if (mode === "consumed" && res.status === 403) {
      // An honest post-admission refusal (§14.3), if it carries a `code`. A bare 403 without one is
      // left to the rule below: this branch classifies only what the protocol defined, so a fronting
      // proxy's own 403 never masquerades as a considered answer from a member.
      const refusal = await readRefusal(res);
      if (refusal !== null) {
        return this.fail({ state: "refused", reason: refusal.error, code: refusal.code, status: res.status });
      }
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
      date: httpDate(res.headers.get("date")),
    };
  }

  /**
   * The budget for one data dial, spending this link's bootstrap credit if it is owed one.
   *
   * With no patient budget wired there is nothing to spend and nothing to remember, so the strict
   * budget is returned untouched — the pre-2026-08-19 behaviour, exactly.
   */
  private takeBudget(link: PackLink): number {
    const patient = this.deps.patientTimeoutMs;
    if (patient === undefined) return this.deps.timeoutMs;
    const taken = takeDataBudget(this.warmth.get(link.address) ?? COLD_LINK, this.deps.timeoutMs, patient);
    this.warmth.set(link.address, taken.next);
    return taken.budgetMs;
  }

  /** Remember whether this link's transport reached the far side. See {@link foldWarmth}. */
  private settle(link: PackLink, reached: boolean): void {
    this.warmth.set(link.address, foldWarmth(this.warmth.get(link.address) ?? COLD_LINK, reached));
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

/**
 * An HTTP `Date` header as epoch ms. Tolerant by construction: absent, empty or unparseable all read
 * as `null`, because a diagnostic that guesses a timestamp is worse than one that says it cannot tell.
 */
function httpDate(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** The record inside a parsed JSON body, or null when the body isn't one (a scalar, an array). */
function asRecord(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

/** The reason string for a transport throw, with no secret and no stack in it. */
function errorReason<T>(err: T): string {
  if (err instanceof Error) return err.message === "" ? err.name : err.message;
  return "request failed";
}

/**
 * Read a `403` body as §14.3's refusal — `{ error, code }` — or `null` when it is not one.
 *
 * Both fields are required: the `code` is what makes this a refusal the protocol defined rather than
 * an opaque 403 from something in front of the member, and the `error` is the sentence the operator
 * will read verbatim. Anything else falls through to the ordinary "HTTP 403 ⇒ unreachable" rule.
 */
async function readRefusal(res: Response): Promise<{ error: string; code: string } | null> {
  try {
    const raw: JsonValue = await res.json();
    const body = asRecord(raw);
    const error = typeof body?.error === "string" ? body.error : null;
    const code = typeof body?.code === "string" ? body.code : null;
    return error === null || code === null || code === "" ? null : { error, code };
  } catch {
    return null;
  }
}

/**
 * The one read of a `409` body. `null` for a body that will not parse, which both readers below
 * treat as "said nothing" — the tolerant reading, because a member that answered 409 has told us the
 * important half already and a parse failure must not upgrade a refusal into something else.
 */
async function read409(res: Response): Promise<JsonObject | null> {
  try {
    const raw: JsonValue = await res.json();
    return asRecord(raw);
  } catch {
    return null;
  }
}

/** The lead-conflict reading (§18.10), or `null` when this 409 is not one. */
function leadConflictOf(body: JsonObject | null) {
  if (body === null || body.code !== LEAD_CONFLICT) return null;
  // The member id is REQUIRED: without it the answer names nothing, and a conflict with no named
  // lead is indistinguishable from a 409 that happened to carry the code. That falls through to the
  // skew reading, which is the closed one.
  const leadMemberId = typeof body.leadMemberId === "string" && body.leadMemberId !== "" ? body.leadMemberId : null;
  if (leadMemberId === null) return null;
  const generation = body.warrantGeneration;
  const error = typeof body.error === "string" ? body.error : `this member follows lead "${leadMemberId}"`;
  return {
    error,
    leadMemberId,
    warrantGeneration: typeof generation === "number" && Number.isSafeInteger(generation) ? generation : null,
    // Optional, and absent means "no proof came with this answer" — which still deposes a stale lead
    // (§18.11) but can no longer self-heal it (§18.12). Parsed, never trusted: the reader verifies it
    // against its own certificate before a byte of it is acted on.
    warrant: parseWarrant(body.warrant),
  };
}

/**
 * The pairing-collision reading (§18.14), or `null` when this 409 is not one.
 *
 * The labels are read but never re-derived: they are that member's own device names, which only that
 * member can know, and the lead's `pack status` prints them as it received them.
 */
function pairingCollisionOf(body: JsonObject | null) {
  if (body === null || body.code !== PAIRING_LABEL_COLLISION) return null;
  const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === "string") : [];
  const error = typeof body.error === "string" ? body.error : "a device with that label already exists there";
  return { error, labels };
}

/** §7's `expected`/`received` reading, tolerating a peer that sends neither. */
function readMismatch(body: JsonObject | null) {
  const error = typeof body?.error === "string" ? body.error : "pack protocol mismatch";
  const expected = typeof body?.expected === "number" ? body.expected : PACK_PROTOCOL_VERSION;
  const received = typeof body?.received === "number" ? body.received : null;
  return { reason: error, expected, received };
}
