import type { JsonObject, JsonValue } from "../json.ts";
import { CREW_PROTOCOL_VERSION } from "./enrollment.ts";
import { DEVICE_HEADER, MEMBER_HEADER, PROTOCOL_HEADER, parseProtocolHeader } from "./admission.ts";
import {
  LEAD_CONFLICT,
  CREW_MUX_FIELD,
  CREW_PREFIX,
  PAIRING_LABEL_COLLISION,
  PREFLIGHT_FRESH,
  PREFLIGHT_HEADER,
} from "./router.ts";
import { LEAD_RELEASE_HEADER, UPDATE_TURN_HEADER } from "./follow.ts";
import { DIAL_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, type DialParts } from "./signing.ts";
// REMOVE_IN_1_9_0 — the member's one fallback to `/pack/v1/*` (§0.1).
import {
  routesNoCrewV1,
  toVersion1Headers,
  toVersion2Response,
  V1_DIAL_DOMAIN,
  V1_PROTOCOL_VERSION,
  version1FallbackLine,
  version1Url,
} from "./v1-overlap.ts";
import type { CrewRequestInit, CrewTlsOptions } from "./transport.ts";
import type { Warrant } from "./trust-store.ts";
import { NARROW_VIEW, SESSIONS_ALL, SESSIONS_PARAM, SESSION_PARAM, type SnapshotView } from "../sessions.ts";
import type { MuxConfig } from "../types.ts";
import { parseCollisionReport, parsePairingReport, type PairingSync } from "./standby-devices.ts";
import type { TakeoverBody } from "./takeover.ts";
import { parseWarrant, parseWarrantActiveReport, type WarrantPush } from "./warrant.ts";
import { CREW_VERSION_FIELD } from "../update-action.ts";

// The LEAD side of a crew link: the client that dials a peer's `/crew/v1/*` surface.
//
// It is the mirror image of `bridge/crew/router.ts` and the sibling of `bridge/mux/herdr/client.ts`.
// That module is the only one that knows Herdr method names (ARCHITECTURE.md §5); this
// one knows **Collie's HTTP routes and no Herdr method at all** — that is the mux-driver seam
// (ADR 0011, CREW_PROTOCOL.md §2 rule 1), and it is mechanically checked by spec M4/03's grep for a
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

/**
 * §20's two request headers, as one value the sweep passes down. `null`/absent for either ⇒ that
 * header is simply not sent, which is the closed reading on the far end.
 */
export interface FollowHeaders {
  /** The lead's own settled release (`X-Crew-Lead-Release`), or null while it may state nothing. */
  readonly leadRelease?: string | null;
  /** `<member-name>;<run-id>` (`X-Crew-Update-Turn`), for the ONE member holding the turn. */
  readonly turn?: string | null;
}

/** How long a peer has to answer before the poll gives up on it, by default (§10.1). */
export const DEFAULT_CREW_TIMEOUT_MS = 1200;
/** Operator override for the per-peer budget. A crew key, so it lives here and not on `Config`. */
export const CREW_TIMEOUT_ENV = "COLLIE_CREW_TIMEOUT_MS";
/**
 * REMOVE_IN_1_9_0: the 1.7.0 spelling of {@link CREW_TIMEOUT_ENV}. Read only when the crew spelling
 * is absent, so an install that carries the old key in a unit file keeps the budget it asked for.
 */
export const LEGACY_CREW_TIMEOUT_ENV = "COLLIE_PACK_TIMEOUT_MS";
/**
 * The fraction of the lead's poll interval a peer may consume. 1200/1500 — the exact default pair
 * §10.1 names — is this ratio, which is why it is the ratio: a budget must leave the lead time to do
 * its own poll and serialise its own snapshot, or a slow peer stalls the phone by arithmetic.
 */
const BUDGET_FRACTION = 0.8;

/**
 * The per-peer timeout budget, **strictly below the lead's own poll interval** (§10.1).
 *
 * Clamped rather than trusted: an operator who sets `COLLIE_CREW_TIMEOUT_MS=9000` against a 1500 ms
 * poll has asked for a peer that can stall the lead's snapshot for six polls, which is precisely the
 * failure this budget exists to make impossible. A missed budget is an unreachable poll, not a
 * delayed one, so clamping loses nothing — it converts a stall into a `stale` badge.
 */
export function crewTimeoutBudget(
  pollMs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const { wanted, ceiling } = budgetParts(pollMs, env);
  return Math.min(wanted, ceiling);
}

/** The two halves {@link crewTimeoutBudget} compares, so the warning below reads the same arithmetic. */
function budgetParts(pollMs: number, env: Record<string, string | undefined>) {
  const raw = readBudgetEnv(env, CREW_TIMEOUT_ENV, LEGACY_CREW_TIMEOUT_ENV);
  const parsed = raw === undefined ? NaN : Number.parseInt(raw.trim(), 10);
  const asked = Number.isFinite(parsed) && parsed > 0;
  return {
    wanted: asked ? parsed : DEFAULT_CREW_TIMEOUT_MS,
    ceiling: Math.max(1, Math.floor(pollMs * BUDGET_FRACTION)),
    asked,
  };
}

/**
 * The sentence to print when the clamp above **bit** — i.e. the operator asked for a budget and got a
 * smaller one. `null` when they asked for nothing, or asked for something the poll can afford.
 *
 * The clamp itself stays (it is the arithmetic that keeps a slow peer from stalling the lead), but it
 * stops being SILENT: `COLLIE_CREW_TIMEOUT_MS=3000` at the default 1500 ms poll changes nothing at
 * all, and an operator who set it to chase a slow link deserves to be told which knob actually moves —
 * `COLLIE_POLL_MS`. Same posture as `startupWarnings` in `bridge/server.ts`: a pure function that
 * returns the line, and a caller that decides where it is printed.
 */
export function crewTimeoutClampWarning(
  pollMs: number,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const { wanted, ceiling, asked } = budgetParts(pollMs, env);
  if (!asked || wanted <= ceiling) return null;
  const neededPoll = Math.ceil(wanted / BUDGET_FRACTION);
  return (
    `[crew] ${CREW_TIMEOUT_ENV}=${wanted} has no effect beyond ${ceiling}ms: a peer may use at most ` +
    `${BUDGET_FRACTION} of the ${pollMs}ms poll, or a slow peer stalls this lead's own snapshot. ` +
    `For the full ${wanted}ms, raise the poll too: COLLIE_POLL_MS=${neededPoll}.`
  );
}

/**
 * Read one crew budget key: the crew spelling first, the 1.7.0 `COLLIE_PACK_*` spelling second.
 *
 * REMOVE_IN_1_9_0 — the second read, not the function. An operator who set the old key in a systemd
 * unit or a shell profile keeps the budget they asked for across the 1.8.0 update, and is told once
 * by {@link crewEnvFallbackWarning} which key to rewrite.
 */
function readBudgetEnv(
  env: Record<string, string | undefined>,
  key: string,
  legacy: string,
): string | undefined {
  return env[key] ?? env[legacy];
}

/**
 * The ONE line to print at start when a 1.7.0 environment key is doing the work of its crew
 * successor. `null` when no old key is set, or when the crew key beside it already wins.
 *
 * One line for both keys, not one per read: {@link readBudgetEnv} runs on every poll, and a warning
 * on that path would be a log flood rather than a notice. Same posture as
 * {@link crewTimeoutClampWarning} — a pure function; the caller decides where it lands.
 *
 * REMOVE_IN_1_9_0, together with the fallback it announces.
 */
export function crewEnvFallbackWarning(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const used = [
    { legacy: LEGACY_CREW_TIMEOUT_ENV, key: CREW_TIMEOUT_ENV },
    { legacy: LEGACY_CREW_HELLO_TIMEOUT_ENV, key: CREW_HELLO_TIMEOUT_ENV },
  ].filter((pair) => env[pair.legacy] !== undefined && env[pair.key] === undefined);
  if (used.length === 0) return null;
  const named = used.map((pair) => `${pair.legacy} (use ${pair.key})`).join(", ");
  return `[crew] ${named}: the COLLIE_PACK_* spelling still works in 1.8.0 and is removed in 1.9.0.`;
}

/**
 * How long a **forwarded write** may take before the lead gives up on it (§10.1, §10.3).
 *
 * ── WHY A WRITE IS NOT A POLL (measured, 2026-09-08, VM lab) ─────────────────
 * A write forwarded to a member (`bridge/crew/forward.ts`) used to ride the poll budget of
 * {@link crewTimeoutBudget} — 1200 ms under a 1500 ms poll. That number is sized for a peer that
 * serialises a snapshot it already holds. A write does work: a launch onto a **zellij** member spawns
 * a process and asks the multiplexer to build a tab, which straddled 1200 ms in about two tries out
 * of three. The phone then read `write_outcome_unknown` over a tab that had in fact been created —
 * the one outcome §10.3 exists to keep rare, produced by arithmetic rather than by a fault.
 *
 * So a forwarded write gets its own budget and the sweep keeps the strict one. This is sound for the
 * same reason {@link crewHelloBudget} is: **the poll fraction bounds the SWEEP**, because a slow peer
 * there stalls the lead's own snapshot for every phone. A forwarded write is one operator's one
 * request, awaited on that request's own path, and it spends no bootstrap credit and no sweep
 * accounting — it is passed to `dial` as an explicit budget, which is the branch that bypasses
 * {@link takeDataBudget} entirely.
 *
 * 5000 ms: what a process-spawning multiplexer answers in comfortably, and well inside the phone's
 * own 20 s mutation budget (`web/src/lib/api.ts` `MUTATION_TIMEOUT_MS`), so the deadline that fires
 * first is still the lead's and the phone still gets §10.3's legible refusal rather than a dead
 * socket. A read is untouched: it keeps the poll budget exactly, bootstrap credit and all.
 *
 * Lead-local, never on the wire, so moving it needs no protocol bump.
 */
export const WRITE_BUDGET_MS = 5000;

/** How long a `hello` PROBE may take before the lead calls a member gone (§10.4), by default. */
export const DEFAULT_CREW_HELLO_TIMEOUT_MS = 5000;
/** Operator override for the probe budget. A crew key, so it lives here and not on `Config`. */
export const CREW_HELLO_TIMEOUT_ENV = "COLLIE_CREW_HELLO_TIMEOUT_MS";
/** REMOVE_IN_1_9_0: the 1.7.0 spelling of {@link CREW_HELLO_TIMEOUT_ENV}, read as a fallback. */
export const LEGACY_CREW_HELLO_TIMEOUT_ENV = "COLLIE_PACK_HELLO_TIMEOUT_MS";
/**
 * A hard stop on the probe budget. It exists only so a typo (`50000000`) cannot wedge a one-shot verb
 * like `crew status` for the rest of the afternoon; nothing on the poll path waits on this budget, so
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
 *     Bun ≥1.4 pools that dial only while its `tls` carries NO `checkServerIdentity` callback, which
 *     is why `dialTls` pins the name via the certificate's own SAN instead — mechanism in
 *     `transport.ts`. Everything below assumes pooling holds; break it and the deadlock returns.
 *   • But an ABORTED attempt leaves no pooled connection behind. So when the cold handshake alone
 *     costs more than the whole per-request budget, every attempt aborts mid-handshake, the next one
 *     starts cold again, and the link never bootstraps. Four attempts, four accepts, four timeouts.
 *   • One patient call breaks the deadlock: it completes the handshake, and every strict-budget
 *     request after it rides the warm connection at one RTT.
 *
 * So the verdict gets its own budget and the poll keeps the strict one. A data request that misses
 * {@link crewTimeoutBudget} still means "stale this poll" — never "peer gone" — and the probe that
 * decides "gone" is allowed to pay for a handshake. Clamping it to the poll fraction would restore
 * the deadlock, which is precisely why it is not clamped.
 *
 * It is floored at the data budget so an operator cannot make the verdict MORE impatient than the
 * poll it is meant to outlast.
 */
export function crewHelloBudget(
  pollMs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = readBudgetEnv(env, CREW_HELLO_TIMEOUT_ENV, LEGACY_CREW_HELLO_TIMEOUT_ENV);
  const parsed = raw === undefined ? NaN : Number.parseInt(raw.trim(), 10);
  const wanted = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CREW_HELLO_TIMEOUT_MS;
  return Math.max(crewTimeoutBudget(pollMs, env), Math.min(wanted, HELLO_BUDGET_CEILING_MS));
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

/**
 * How long a member may answer with NO `X-Crew-Protocol` header before the lead stops calling it
 * merely unreachable and puts it on the incompatible ladder (§7, §10.2).
 *
 * A DURATION, and not a count of answers, on counsel of 2026-09-08. A count was written first and it
 * measures the wrong thing. The lead's cadence moves between 1500 ms and 12 000 ms, and this same
 * client also carries `hello`, the phone's proxied reads, warrant push and pairing push, so an
 * operator with the phone open spends five answers in seven seconds while an idle lead takes a
 * minute. The bound would then be tightest exactly when the operator is watching, which is the
 * shape of the incident this milestone exists for. A restart takes the seconds it takes whatever
 * anybody is polling at, so the bound is in seconds too.
 *
 * Sixty of them: enough for a service restart and a proxy reload, which is the case the patience is
 * for. A peer being levelled is covered for longer than this by spec 01 anyway, since a member in a
 * live run is dialled every sweep whatever ladder it is on. A stranger that never sends the header
 * costs 240 tiny dials at the fastest legal cadence before it lands on the ladder.
 *
 * Lead-local. It is never on the wire, so moving it needs no protocol bump.
 */
export const HEADERLESS_PATIENCE_MS = 60_000;

/** The budget for one data dial, and the warmth to remember while it is in flight. */
export interface TakenBudget {
  readonly budgetMs: number;
  readonly next: LinkWarmth;
}

/**
 * Pick a data request's budget and consume a bootstrap credit if it takes one.
 *
 * `patientMs` is floored at `strictMs` here as well as in {@link crewHelloBudget}, so a hand-wired
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
export interface CrewLink {
  readonly memberId: string;
  readonly address: string;
}

/**
 * The injected transport. Deliberately the `fetch` shape and not a Collie-specific interface: the
 * production value is the platform's `fetch` (with the pinned-TLS agent, when M4/08 wires one), and
 * a test's value is a function. Anything richer would be a seam only the tests use.
 */
export type CrewFetch = (url: string, init: CrewRequestInit) => Promise<Response>;

/** Why a peer is not answering usefully. The three states of §10.2, minus `reachable`. */
export type PeerFailure =
  /** Timeout, connection refused, TLS failure, auth failure — retried on the poll cadence. */
  | {
      readonly state: "unreachable";
      readonly reason: string;
      /**
       * Whether the request reached the transport at all.
       *
       * Only ever `false` when this module can PROVE nothing was sent (no crew secret, an address it
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
       * `CrewLead` reads it to decide which failures deserve a patient re-probe.
       */
      readonly timedOut?: boolean;
      /**
       * `true` when the peer ANSWERED and the answer was a bare `401` (§8.5) — a rotated secret or a
       * dropped pin, not a machine that is away.
       *
       * It rides here rather than becoming a fifth state because §10.2's word does not change: this
       * is still `unreachable` on the wire, and every released phone reads it as one. What it buys is
       * the presentation split (§10.2's Reconnecting / Attention note): retrying cannot fix a wrong
       * secret, so the lead may say so instead of implying the operator should wait.
       *
       * Absent means "not that", exactly as `timedOut`'s absence does.
       */
      readonly authRefused?: boolean;
    }
  /** `X-Crew-Protocol` skew (§7) — NOT retried on the cadence; probed on a slow backoff. */
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
 * The answer to any crew call. `receivedAt` is stamped from the **lead's** clock on every branch,
 * success or failure — a peer's clock is never trusted for freshness, which is also why no timestamp
 * header rides a crew response (§6, §10.2).
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
       * **Not a protocol field and not a freshness signal** — §6's "no timestamp header rides a crew
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
   * in its own `crew-ops.json` and keeps naming the remedy, which is today's reading unchanged.
   */
  readonly warrantActiveGeneration: number | null;
  /**
   * The digest of the synced pairing registry that member holds, or `null` (§18.14).
   *
   * **Absent means "nothing synced there", never "up to date"** — the same reading the warrant
   * generation beside it carries, and both make the lead push. `collie crew deputy` renders it so the
   * operator can see a deputy whose door has no credential to check against.
   */
  readonly pairingDigest: string | null;
  /**
   * Labels that member's OWN paired devices share with the registry it was synced (§18.14), or `null`.
   *
   * A finding for the operator on THIS machine — the one who can rename or revoke one of the two —
   * and never a refusal: the sync itself always lands, or a device revoked here would stay valid at
   * that machine's standby door.
   */
  readonly pairingCollision: readonly string[] | null;
  /**
   * That member's own multiplexer block, or `null` (M22/03).
   *
   * **Absent means "use the lead's answer" — never "every capability present".** That is the reading
   * the phone already gives every pane on every host: it reads the lead's `/api/config` once and
   * applies it everywhere. So a peer that publishes nothing keeps producing exactly today's answer,
   * and no old peer regresses.
   *
   * Parsed, never trusted: {@link parseMuxReport} re-checks every field, and anything half-formed
   * reads as `null`, which is the same "said nothing" the absent field carries.
   */
  readonly mux: MuxConfig | null;
}

export interface PeerClientDeps {
  /** The lead's own member id — sent as `X-Crew-Member` (informational only, §6). */
  readonly self: string;
  /**
   * The crew-wide bearer secret, read at call time.
   *
   * A **function**, not a string, for two reasons: `crew rotate` replaces it mid-process and a client
   * holding a copy would keep presenting the old one, and §8.3 keeps secrets out of argv and out of a
   * long-lived process's environment — this one is read from the 0600 trust store into memory and
   * handed over on demand. `null` means "not in a crew": no request is sent at all.
   */
  readonly secret: () => string | null;
  /** Per-peer budget in ms. Build it with {@link crewTimeoutBudget}, never by hand. */
  readonly timeoutMs: number;
  /**
   * The patient budget: {@link PeerClient.hello}'s, and a cold link's one bootstrap data attempt
   * ({@link takeDataBudget}). Build it with {@link crewHelloBudget}, never by hand.
   *
   * It is still built from `COLLIE_CREW_HELLO_TIMEOUT_MS` because it is the same budget the verdict
   * probe named on 2026-08-18 and an operator-facing key does not churn for a second caller. Absent ⇒
   * every call shares the strict data budget, which is the pre-2026-08-18 behaviour and the deadlock
   * the two docs above describe — so every production wiring supplies it.
   */
  readonly patientTimeoutMs?: number;
  readonly fetch: CrewFetch;
  readonly now?: () => number;
  /** The operator's device id, forwarded for the peer's audit trail (§6, §12). Off ⇒ `null`. */
  readonly device?: () => string | null;
  /**
   * The pinned TLS material for dialling this member (§8.1, `bridge/crew/transport.ts`). A function
   * of the link rather than a value, for the same reason `secret` is: pins change under a running
   * process. `undefined` means "no material" — the far side's own listener then refuses the
   * handshake, which is exactly the refusal we want and not a quiet downgrade.
   */
  readonly tls?: (link: CrewLink) => CrewTlsOptions | undefined;
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
  /**
   * REMOVE_IN_1_9_0 — where the version 1 fallback's one line goes (§0.1). Absent ⇒ `console.log`,
   * which is the journal on every production wiring.
   */
  readonly log?: (line: string) => void;
  /**
   * REMOVE_IN_1_9_0 — the members this PROCESS has already said speak version 1, shared by every
   * client in it (§0.1).
   *
   * Injected because a lead holds more than one client per peer — the sweep's and the takeover's are
   * built by two separate factories in `bridge/index.ts` — and a set per client made the line print
   * once per client instead of once per member. The set is the process's, so the journal gets one
   * sentence per member. Absent ⇒ a fresh set, which is what a test wants and what a one-shot verb
   * can live with.
   */
  readonly toldVersion1?: Set<string>;
}

/**
 * REMOVE_IN_1_9_0 — one dial's answer, plus the marker that says the far side spoke version 1.
 *
 * The marker never escapes this class: it is set only where the answer is about to be discarded in
 * favour of the fallback dial, and the fallback's own answer never carries one.
 */
type DialAnswer = PeerOutcome<Response> & { readonly speaksVersion1?: true };

/**
 * Build the absolute URL for a crew call, from a member's stored address and a route under the crew
 * prefix.
 *
 * **An address is a host, never a URL with anything else in it.** A stored address that carries a
 * path, a query, or credentials is refused rather than dialled: the address is a hint the operator
 * typed at `join` time, and the only thing it is allowed to decide is *which machine*. The final URL
 * is then re-checked to still sit under the crew prefix, so no route segment can escape it.
 *
 * Returns `null` when either check fails — the caller reports it as unreachable, because a member the
 * lead cannot form a URL for is, from the phone's point of view, exactly a member that is not there.
 */
export function crewUrl(address: string, route: string, params?: Record<string, string>): string | null {
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
    url = new URL(`${CREW_PREFIX}${route.replace(/^\/+/, "")}`, base);
  } catch {
    return null;
  }
  // Defence in depth against a route assembled from anything but a literal upstream: `..` segments
  // are normalised by `new URL`, so this catches an escape after normalisation rather than before it.
  if (!url.pathname.startsWith(CREW_PREFIX)) return null;
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * The lead's client for one crew. It holds no timers, no cache and no belief about a peer: "what the
 * lead believes about peer X" lives in the registry (bridge/crew/registry.ts) and there is exactly one
 * place to look for it.
 *
 * It remembers two things, both small and both about the wire rather than the member. First,
 * {@link LinkWarmth} — whether a dial to an address has ever
 * succeeded — because the budget for the NEXT request depends on whether a handshake has already been
 * paid for, and nothing outside this class knows that. It is transport bookkeeping, not state about a
 * member: it decides a timeout and never a verdict, it is never persisted, and losing it costs one
 * patient dial. Keyed by address, which is what the connection pool is keyed by; a member that moved
 * (`collie reconnect`) is a different connection and correctly starts cold again. Bounded by the
 * roster, since an address only ever comes from the trust store.
 *
 * Second, when a member's current run of answers carrying NO protocol header began, keyed by member
 * id. That one does reach a verdict, which is why it is documented on the field itself, bounded by
 * {@link HEADERLESS_PATIENCE_MS}, and dropped by {@link PeerClient.forget} when a member leaves.
 *
 * Zero tax otherwise — constructing one arms nothing, and a solo lead never constructs one because it
 * has no peers to hand it.
 */
export class PeerClient {
  private readonly now: () => number;
  private readonly warmth = new Map<string, LinkWarmth>();
  /**
   * When a member's current run of headerless answers STARTED, keyed by member id.
   *
   * This is the ONE memory here that reaches a verdict, and it is here rather than in the registry
   * because it is a fact about the ANSWERS this client has read, not a belief about the member:
   * nothing outside this class ever sees a header. It is never persisted, and losing it on a restart
   * costs at most one more patient minute, which is the safe direction to fail in. Bounded by the
   * roster, cleared by {@link PeerClient.forget} when a member leaves, and cleared by any answer that
   * names a version. See {@link HEADERLESS_PATIENCE_MS}.
   */
  private readonly headerless = new Map<string, number>();
  /**
   * REMOVE_IN_1_9_0 — which members this process has already said speak version 1 (§0.1).
   *
   * The FALLBACK is per dial and never cached; only the LOG LINE is remembered, so a journal gets one
   * sentence per lead rather than one per sweep. Bounded by the roster, cleared by
   * {@link PeerClient.forget}, and never persisted: a restart costs one more line.
   *
   * SHARED across the clients of one process when {@link PeerClientDeps.toldVersion1} is supplied,
   * because a lead builds more than one client for the same peer.
   */
  private readonly toldVersion1: Set<string>;

  constructor(private readonly deps: PeerClientDeps) {
    this.now = deps.now ?? Date.now;
    // REMOVE_IN_1_9_0: shared with every other client in this process when the wiring hands one over.
    this.toldVersion1 = deps.toldVersion1 ?? new Set<string>();
  }

  /** REMOVE_IN_1_9_0 — the fallback's one line. Injected so the test reads it without a journal. */
  private log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }

  /**
   * `GET /crew/v1/hello` — liveness, version and the peer's member id (§5).
   *
   * **The call that ALWAYS runs on the patient budget** ({@link crewHelloBudget}), where a data
   * request gets one such attempt per cold link ({@link takeDataBudget}) and the strict budget
   * thereafter. It is the verdict probe: `crew status` renders it, `reconnect` confirms with it, and
   * the lead re-probes a timed-out peer with it. It is never on the poll's hot path, so paying for a
   * cold handshake here costs the phone nothing — and the connection it warms is the one the next
   * strict-budget snapshot rides.
   */
  async hello(link: CrewLink): Promise<PeerOutcome<HelloResult>> {
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
    // §18.14's finding, read the same way: absent or empty is "no finding", which is the closed
    // reading — a lead that invented one would send the operator chasing a device that is not there.
    const pairingCollision = parseCollisionReport(outcome.value);
    // M22/03's optional block, read the same absent-means-the-lead's way. It rides `hello` rather
    // than `snapshot` because it changes only when the far side's bridge restarts, and the snapshot
    // is polled every 1500 ms (§10.1).
    const mux = parseMuxReport(outcome.value);
    return {
      ...outcome,
      value: {
        protocol,
        member,
        version,
        warrantGeneration,
        warrantActiveGeneration,
        pairingDigest,
        pairingCollision,
        mux,
      },
    };
  }

  /**
   * `POST /crew/v1/warrant` — deliver or refresh the warrant naming the crew's deputy (§18).
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
  warrant(link: CrewLink, payload: WarrantPush): Promise<PeerOutcome<JsonValue>> {
    return this.json(link, "warrant", undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /**
   * `POST /crew/v1/pairing` — sync the lead's paired-device registry to the DEPUTY (RFC §6.5, §18.14).
   *
   * An ordinary data dial on the ordinary budget. A `404` or a `401` is the answer, not a fault: a
   * pre-amendment member has no route, and a member that is not the deputy refuses the role — both
   * surface as the `unreachable` outcome the caller already handles, and neither is retried faster.
   */
  pairing(link: CrewLink, payload: PairingSync): Promise<PeerOutcome<JsonValue>> {
    return this.json(link, "pairing", undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /**
   * `POST /crew/v1/takeover` — the witness question, then the re-pin (RFC §7).
   *
   * **Never §8.6-signed, and that is not an omission.** The caller here is the DEPUTY, which is not in
   * the receiving peer's roster at all — so a signature could only ever fail to verify against it, and
   * a failed signature is the uniform 401 before the deputy path is reached. What authenticates this
   * dial is the pinned handshake against the anchored certificate plus the dial attestation that says
   * which of the two anchors is calling (§8.1's 2026-08-20 amendment), which is strictly the same key.
   */
  takeover(link: CrewLink, payload: TakeoverBody): Promise<PeerOutcome<JsonValue>> {
    return this.json(
      link,
      "takeover",
      undefined,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
      undefined,
      false,
    );
  }

  /**
   * `GET /crew/v1/snapshot` — the one merged route (§5). Shape is spec M4/04's business.
   *
   * `view` is how much of that machine to ask for (M22/06): `session=` as always, plus
   * `sessions=all` when the caller wants every session the peer runs. Both are additive and optional
   * — a peer too old to read either answers with its primary session and CREW_PROTOCOL_VERSION does
   * not move (§7.1). It defaults to {@link NARROW_VIEW}, the ask this method made before the
   * parameter existed.
   *
   * `freshPreflight` adds §19's one header and, with it, the PATIENT budget — the only data dial
   * that ever takes one by name. It is not a widening of the poll: the sweep that carries it is the
   * one the phone's own on-demand read fires (`GET /api/update/check`), which is bounded at the
   * route by `UPDATE_ON_DEMAND_POLL_TIMEOUT_MS` and answers with what it has past that. The periodic
   * sweep never sets it and keeps the strict budget §10.1 requires, unchanged.
   */
  snapshot(
    link: CrewLink,
    view: SnapshotView = NARROW_VIEW,
    freshPreflight = false,
    follow: FollowHeaders = {},
  ): Promise<PeerOutcome<JsonValue>> {
    const query: Record<string, string> = {};
    if (view.session !== undefined && view.session !== "") query[SESSION_PARAM] = view.session;
    // The widening switch, and only in its one exact spelling — the peer reads it the same way
    // `/api/snapshot` does (`bridge/sessions.ts`).
    if (view.widen) query[SESSIONS_PARAM] = SESSIONS_ALL;
    // No params at all is `undefined`, not an empty object: a narrow ask must put the same bytes on
    // the wire it has always put.
    const params = Object.keys(query).length === 0 ? undefined : query;
    const headers: Record<string, string> = {};
    if (freshPreflight) headers[PREFLIGHT_HEADER] = PREFLIGHT_FRESH;
    // §20's two, both additive-optional and both absent-means-closed. They are set on the sweep the
    // lead already makes because a running peer never dials its lead — there is no peer-side poll to
    // hang them on — and they never change the budget: a lead that has something to state must not
    // become a lead that polls more slowly.
    if (follow.leadRelease !== undefined && follow.leadRelease !== null) {
      headers[LEAD_RELEASE_HEADER] = follow.leadRelease;
    }
    if (follow.turn !== undefined && follow.turn !== null) headers[UPDATE_TURN_HEADER] = follow.turn;
    if (Object.keys(headers).length === 0) return this.json(link, "snapshot", params);
    return this.json(
      link,
      "snapshot",
      params,
      { headers },
      freshPreflight ? this.deps.patientTimeoutMs : undefined,
    );
  }

  /** A crew call whose JSON body the lead consumes. */
  async json(
    link: CrewLink,
    route: string,
    params?: Record<string, string>,
    init: CrewRequestInit = {},
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
   * A crew call whose `Response` the lead hands on untouched, with **every status the peer chose
   * preserved** — the proxied reads and forwarded writes of §9.1/§5.
   *
   * This is {@link PeerClient.raw} minus its `!res.ok ⇒ unreachable` rule, and the difference is the
   * entire point: `raw` is for bodies the lead consumes, where a 404 is a broken peer; `proxy` is for
   * responses the phone consumes, where the peer's `304`, `404`, `405`, `409`-from-a-handler and
   * `413` are the *answer* and flattening them into "unreachable" would destroy exactly the fidelity
   * §9.1 asks for — most sharply the `304`, which is the whole conditional-GET win.
   *
   * The link's own refusals are still failures, not answers: an unadmitted 401 carries no crew
   * headers by construction (§8.5), so it never reaches the phone as a 401 the operator would read as
   * *their* credentials failing. A peer's own gate refuses with crew headers attached and is passed
   * through, because that refusal is the peer's write-level check doing its job (§12).
   *
   * The body is never read here, so an ETag and a byte-for-byte mirror survive the hop.
   *
   * `budgetMs` is how a forwarded WRITE takes {@link WRITE_BUDGET_MS} instead of the poll budget
   * (§10.1). Absent — every forwarded read — is the poll budget plus a cold link's bootstrap credit,
   * exactly as before. `forward.ts` is the only caller that passes it, and it passes it on the same
   * read/write split §5 and §10.3 are already written in terms of.
   */
  async proxy(
    link: CrewLink,
    route: string,
    params?: Record<string, string>,
    init: CrewRequestInit = {},
    budgetMs?: number,
  ): Promise<PeerOutcome<Response>> {
    return this.dial(link, route, params, init, "passthrough", budgetMs, false);
  }

  /**
   * A crew call whose `Response` the lead hands on untouched, refusing any non-2xx.
   *
   * The body is not read here, so an ETag and a byte-for-byte mirror survive the hop.
   */
  async raw(
    link: CrewLink,
    route: string,
    params?: Record<string, string>,
    init: CrewRequestInit = {},
    budgetMs?: number,
    sign = true,
  ): Promise<PeerOutcome<Response>> {
    return this.dial(link, route, params, init, "consumed", budgetMs, sign);
  }

  /**
   * The one dial, and the version order on it: `/crew/v1/*` first, always (§0.1).
   *
   * REMOVE_IN_1_9_0 — the fallback. A member that is answered by a lead still on 1.7.0 learns it in
   * exactly two ways, and both are answers rather than guesses: an answer carrying NO crew protocol
   * header that is not JSON either ({@link routesNoCrewV1} — on a real 1.7.0 bridge that is a
   * `200 text/html` app shell, because the SPA catch-all owns every unrouted path), or §7's refusal
   * naming version 1. On either it re-dials `/pack/v1/*` ONCE, with version 1 headers and the
   * version 1 dial domain, and writes one journal line per lead per process.
   *
   * The first of those two is a HEURISTIC about a build already in the field, not a contract: a
   * 1.7.0 bridge cannot be patched after the fact to announce its version on a path it does not
   * route. It is measured rather than assumed (VM lab, 2026-09-09) and it goes in 1.9.0 with the
   * rest of the overlap.
   *
   * **Per dial, never cached.** The moment that lead updates, its answer on `/crew/v1` is a crew
   * answer and no fallback is taken — so the overlap costs one extra round trip against a lead that
   * has not updated yet, and nothing at all against one that has.
   */
  private async dial(
    link: CrewLink,
    route: string,
    params: Record<string, string> | undefined,
    init: CrewRequestInit,
    mode: "consumed" | "passthrough",
    budgetMs?: number,
    sign = true,
  ): Promise<PeerOutcome<Response>> {
    const answer = await this.dialAt(link, route, params, init, mode, CREW_PROTOCOL_VERSION, budgetMs, sign);
    // REMOVE_IN_1_9_0 — the fallback, top to bottom.
    if (answer.speaksVersion1 !== true) return answer;
    if (!this.toldVersion1.has(link.memberId)) {
      this.toldVersion1.add(link.memberId);
      this.log(version1FallbackLine(link.memberId));
    }
    return this.dialAt(link, route, params, init, mode, V1_PROTOCOL_VERSION, budgetMs, sign);
  }

  /**
   * One dial, at one protocol version. `mode` decides only what a non-2xx status means — everything
   * before that (the credential, the URL, the budget, the version check, §7's 409) is identical by
   * construction, because two dial paths would be two places for a crew request to forget its
   * `Authorization`.
   */
  private async dialAt(
    link: CrewLink,
    route: string,
    params: Record<string, string> | undefined,
    init: CrewRequestInit,
    mode: "consumed" | "passthrough",
    // REMOVE_IN_1_9_0: the wire version this dial speaks. Always {@link CREW_PROTOCOL_VERSION} once
    // the overlap is gone, at which point this argument and `DialAnswer` go with it.
    wire: number,
    // The one knob a caller may widen, and three callers do: the verdict probe's patient budget
    // (§10.4), §19's fresh preflight, and a forwarded WRITE on WRITE_BUDGET_MS (§10.1's 2026-09-08
    // amendment). Everything else runs on the strict per-poll one — except for the single bootstrap
    // attempt a cold link is owed, which is chosen below and can never repeat while the link stays
    // down. An explicit budget bypasses `takeDataBudget` outright, so a widened call spends no
    // bootstrap credit and never shows up in the sweep's budget accounting. Nothing on the SWEEP may
    // widen itself by hand; that rule is what keeps a slow peer from stalling the lead's snapshot
    // every poll.
    budgetMs?: number,
    // Whether a §8.6 REQUEST signature may ride this call, when this client holds a key. Two callers
    // say no, and for two different reasons: `proxy` streams its body (a signature over a stream
    // cannot be computed without buffering it, §8.6's own trade), and `takeover` is dialled by a
    // machine that is not in the receiver's roster, where a signature could only ever be a refusal.
    sign = true,
  ): Promise<DialAnswer> {
    const secret = this.deps.secret();
    if (secret === null || secret === "") {
      // Never send an unauthenticated crew request. A missing secret is a local fault (not in a crew,
      // or a store that failed to load), and probing a peer without a credential would teach an
      // operator's logs nothing while looking exactly like an attack.
      return this.fail({ state: "unreachable", reason: "no crew secret", attempted: false });
    }
    const built = crewUrl(link.address, route, params);
    if (built === null) {
      return this.fail({ state: "unreachable", reason: `unusable address: ${link.address}`, attempted: false });
    }
    // REMOVE_IN_1_9_0: the version 1 prefix, on the fallback dial only. The URL is otherwise the one
    // `crewUrl` built, so the address checks that function makes are made once and not twice.
    const url = wire === V1_PROTOCOL_VERSION ? version1Url(built) : built;
    // Chosen AFTER the two pre-flight refusals above, so a missing secret or an unusable address —
    // neither of which touches a socket — can never spend a link's one bootstrap credit.
    const timeoutMs = budgetMs ?? this.takeBudget(link);

    const device = this.deps.device?.() ?? null;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${secret}`);
    headers.set(PROTOCOL_HEADER, String(CREW_PROTOCOL_VERSION));
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
      // REMOVE_IN_1_9_0: `domain` — the version 1 dial's own domain tag, which is bytes both ends
      // hash (`signing.ts` → `canonicalDial`). Absent on every version 2 dial, which is every dial
      // once the overlap is gone.
      const domain = wire === V1_PROTOCOL_VERSION ? V1_DIAL_DOMAIN : undefined;
      headers.set(DIAL_HEADER, this.deps.dialSign({ method, path, timestamp: stampedAt, to: link.memberId, domain }));
    }

    // REMOVE_IN_1_9_0: the whole header set, restated in version 1's vocabulary, as ONE step at the
    // end — so nothing above this line has to know which version it is dialling, and a header added
    // there is carried by the fallback without being taught to it.
    const wireHeaders = wire === V1_PROTOCOL_VERSION ? toVersion1Headers(headers) : headers;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      // `tls` rides the init: Bun's fetch takes the pinned material per request, so there is no agent
      // to construct, cache or invalidate — the pin is read fresh on every dial, from the store.
      const tls = this.deps.tls?.(link);
      const dialInit: CrewRequestInit = { ...init, headers: wireHeaders, signal: controller.signal };
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

    // REMOVE_IN_1_9_0: a version 1 answer, restated in version 2's header vocabulary — so every line
    // below, and every caller that reads a crew header off this response, is version-agnostic. The
    // body is not read, so a proxied read stays a stream.
    if (wire === V1_PROTOCOL_VERSION) res = toVersion2Response(res);

    // ── Version first, before status and before the body ─────────────────────
    // §7: "The lead applies the same rule to a peer's RESPONSE header: a reply with a version it
    // cannot read is a mismatch, not a parse error." Reading the body first would turn a v2 peer's
    // perfectly well-formed answer into a parse failure and hide the real cause.
    const received = parseProtocolHeader(res.headers.get(PROTOCOL_HEADER));

    // REMOVE_IN_1_9_0 — the fallback's trigger, and it is only ever read on a version 2 dial (§0.1).
    //
    // What a 1.7.0 collie ACTUALLY answers `/crew/v1/hello` with, measured in the VM lab on
    // 2026-09-09: `200 OK`, `content-type: text/html`, `x-collie-build: 1.7.0+35b60df`, and ~9 KB of
    // the PWA's app shell. It is the SPA catch-all: `bridge/server.ts` hands every unrouted path the
    // built `index.html` so a deep link works, and a path it has never heard of is a deep link as far
    // as that fallthrough is concerned. It is never a 404.
    //
    // The first draft of this guard read 404 or 403 and fired on neither. The 403 arm cannot help
    // either: the non-loopback peer check that produces it is off whenever
    // `COLLIE_ALLOW_NON_LOOPBACK_BIND=1`, which every machine in a real crew sets. Both arms stay,
    // because a peer serving no web bundle does 404 and a loopback-strict one does 403, but the shape
    // that decides it in practice is the third.
    //
    // So the rule is: NO crew protocol header, and an answer that is not JSON. A crew answer is
    // always JSON and always stamped (`crewResponseHeaders`), so this cannot claim one. A 5xx is
    // excluded and stays excluded: that is a proxy or a peer mid-restart, not a version, and a second
    // dial there would double what every poll spends on a machine that is not answering.
    //
    // **It is a HEURISTIC, and it has to be.** What it reads is what a 1.7.0 bridge happens to answer
    // an unknown path with, and a 1.7.0 bridge cannot be patched after the fact to say so plainly.
    // That is why the whole trigger goes in 1.9.0 rather than being tightened.
    if (wire === CREW_PROTOCOL_VERSION && received === null && routesNoCrewV1(res)) {
      return { ...this.fail({ state: "unreachable", reason: `${route}: HTTP ${res.status}` }), speaksVersion1: true };
    }
    // An answer that NAMES a version tells us the peer is speaking, whatever it said. That ends any
    // headerless run, so a peer that restarts behind a proxy starts from zero the next time.
    if (received !== null) this.headerless.delete(link.memberId);
    if (received === null && res.status === 401) {
      // An unadmitted caller gets a bare 401 with NO version banner (§8.5, `unauthorizedResponse`).
      // That is the shape of a rotated secret or a dropped pin, and §10.2 files an auth failure under
      // `unreachable` — not `incompatible`, which would put it on the slow backoff and leave the
      // operator waiting ten minutes after fixing the very thing `crew status` told them to fix.
      //
      // It does NOT count as a headerless run. This branch already names the cause the operator can
      // act on, and a run counted here would put a wrong secret on the ten minute ladder, which is
      // the exact cost the branch above was written to avoid.
      // `authRefused` is what lets the operator-facing split call this Attention rather than
      // Reconnecting (§10.2): the peer answered, so there is nothing to wait for.
      return this.fail({
        state: "unreachable",
        reason: `${route}: refused by the peer (unauthorized)`,
        authRefused: true,
      });
    }
    if (received === null) {
      // MISSING is not FOREIGN (§7). A missing header says we learned NOTHING about this peer's
      // version: a proxy in front of a peer that is restarting, a 502 from a reverse proxy, a 404
      // from a wrong path, a solo collie that answers no crew route at all (§11). None of them is a
      // skew, and filing them as `incompatible` puts a peer that will be back in seconds on the
      // 30/120/600 s ladder.
      //
      // The MECHANISM is proved on the dev crew, 2026-09-08: a peer's port fronted by a plain 200
      // that carries no header made a 1.6.0 lead log `incompatible (snapshot: peer answered protocol
      // none, this build speaks 1), next dial in 30s`, then `in 120s`. That reproduction is induced.
      // It says what this branch does; it does NOT say this is what happened on 2026-09-07, and the
      // spec keeps the competing story open. See `.tracker/M20-crew-keeps-sight/03-*.md` → Evidence.
      //
      // The rule is BOUNDED by {@link HEADERLESS_PATIENCE_MS}, in seconds and not in answers: past
      // that the member falls onto the incompatible ladder, so a peer that is truly foreign is not
      // dialled at the poll rate for ever.
      const since = this.headerless.get(link.memberId) ?? this.now();
      this.headerless.set(link.memberId, since);
      const waited = this.now() - since;
      if (waited < HEADERLESS_PATIENCE_MS) {
        // The STATUS rides the reason: a 502 and a 503 are the same verdict and not the same story,
        // and the operator is the one who can tell a proxy from a peer. So does the time already
        // spent, once there is any, so the move onto the ladder is not a surprise when it comes.
        const seconds = Math.floor(waited / 1000);
        const plain = `${route}: peer answered ${res.status} with no crew protocol header`;
        return this.fail({
          state: "unreachable",
          reason: seconds < 1 ? plain : `${plain}, ${seconds}s so far`,
        });
      }
      return this.fail({
        state: "incompatible",
        reason: `${route}: peer answered ${res.status} with no crew protocol header for over ${Math.round(HEADERLESS_PATIENCE_MS / 1000)}s, this build speaks ${CREW_PROTOCOL_VERSION}`,
        expected: CREW_PROTOCOL_VERSION,
        received: null,
      });
    }
    if (received !== null && received !== CREW_PROTOCOL_VERSION) {
      const mismatch = this.fail({
        state: "incompatible",
        reason: `${route}: peer answered protocol ${received}, this build speaks ${CREW_PROTOCOL_VERSION}`,
        expected: CREW_PROTOCOL_VERSION,
        received,
      });
      // REMOVE_IN_1_9_0: a member that NAMED version 1 said so precisely, which is the second of the
      // two ways a 1.7.0 lead reveals itself (§0.1). Read on a version 2 dial only.
      if (wire === CREW_PROTOCOL_VERSION && received === V1_PROTOCOL_VERSION) {
        return { ...mismatch, speaksVersion1: true };
      }
      return mismatch;
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
      // string the operator sees verbatim in `crew status`, so it is read rather than paraphrased.
      // NOT a fallback trigger, and deliberately not: reaching this branch means the far side stamped
      // THIS build's version in the header (the mismatch above returned otherwise), so whatever its
      // body says about versions, it is not a 1.7.0 collie. The overlap reads the header and the
      // status, never a body (§0.1).
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
  private takeBudget(link: CrewLink): number {
    const patient = this.deps.patientTimeoutMs;
    if (patient === undefined) return this.deps.timeoutMs;
    const taken = takeDataBudget(this.warmth.get(link.address) ?? COLD_LINK, this.deps.timeoutMs, patient);
    this.warmth.set(link.address, taken.next);
    return taken.budgetMs;
  }

  /**
   * A member has left the roster: drop what this client remembers about it.
   *
   * Both maps are bounded by the ids and addresses this process has seen, so leaving them would be
   * untidy rather than a leak. It is the VERDICT that makes this worth a call: a member pruned while
   * its headerless run was nearly spent, then enrolled again under the same id, would inherit that
   * run and land on the ladder on its first headerless answer. The lead calls this where it prunes
   * its other per-member memory, so there is one place that forgets a member.
   */
  forget(memberId: string, address?: string): void {
    this.headerless.delete(memberId);
    // REMOVE_IN_1_9_0: a member enrolled again under the same id has not been told about yet.
    this.toldVersion1.delete(memberId);
    if (address !== undefined) this.warmth.delete(address);
  }

  /** Remember whether this link's transport reached the far side. See {@link foldWarmth}. */
  private settle(link: CrewLink, reached: boolean): void {
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
  links: readonly CrewLink[],
  run: (link: CrewLink) => Promise<T>,
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

/**
 * The reason string for a transport throw, with no secret and no stack in it — and in Collie's
 * voice rather than the runtime's.
 *
 * **Why the translation lives here.** Bun's connection error is written for a browser console:
 * "Unable to connect. Is the computer able to access the url?" — *the* computer, *the* url, a
 * question rather than a statement. It reached three surfaces verbatim: `crew status`'s link line,
 * the 503 body a phone reads, and `collie leave`'s warning. All three read this one field, so this
 * is the single funnel where a caught transport error becomes a Collie sentence; wrapping it at any
 * one of the three would have left the other two speaking browser.
 *
 * The raw string is NOT kept beside the translation. There is no debug channel in this process to
 * put it on, and inventing one to hold a string this table already names would be a worse trade
 * than losing it. An error the table does not recognise is passed through UNCHANGED — an unknown
 * failure the operator can search for beats a confident sentence that describes the wrong thing.
 */
function errorReason<T>(err: T): string {
  if (!(err instanceof Error)) return "request failed";
  return operatorReason(err.message === "" ? err.name : err.message);
}

/**
 * One runtime failure string as an operator reads it. Exported for its own test, and pure.
 *
 * Each entry says what the far side DID, in the fewest words that still distinguish it from the
 * others — because that distinction is the whole diagnostic value of this line. "Nothing accepted a
 * connection" sends the operator to the service; "does not resolve" sends them to the address;
 * "certificate was not accepted" sends them to the pin or the front door. Deliberately none of them
 * guesses a remedy: this string is rendered under a member row that already carries the address, the
 * role and the pin, and the surfaces that own a remedy print their own.
 */
export function operatorReason(raw: string): string {
  const text = raw.toLowerCase();
  for (const [pattern, reason] of TRANSPORT_REASONS) {
    if (pattern.test(text)) return reason;
  }
  return raw;
}

const TRANSPORT_REASONS: readonly (readonly [RegExp, string])[] = [
  // Bun's browser-voiced default, plus the platform spellings of the same event.
  [/unable to connect|connection refused|econnrefused|connectionrefused/, "nothing accepted a connection at this address"],
  [/unable to resolve|enotfound|getaddrinfo|dns/, "this address does not resolve"],
  [/econnreset|epipe|socket|closed unexpectedly|connection closed/, "the connection closed before an answer arrived"],
  // Anything the TLS layer refused: an unmatched pin, an expired or untrusted certificate, a front
  // door presenting one this member was never told to expect (§8.1).
  [/certificate|self.signed|tls|ssl|handshake/, "the TLS certificate was not accepted"],
  [/ehostunreach|enetunreach|network is unreachable|no route to host/, "there is no route to this address"],
  // ETIMEDOUT only. A message that already carries a DURATION ("timed out after 1200ms" — this
  // client's own abort, and the OS's own wording where it gives one) is passed through: the number
  // is the diagnostic, and §10.4's budget conversation cannot be had without it.
  [/etimedout/, "the connection timed out"],
];

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

/** The longest registry name this reader will republish. Every shipped adapter name is far shorter. */
const MUX_NAME_MAX = 64;

/** The most capability answers, refused key spellings and notes one member's block may carry. */
const MUX_ROWS_MAX = 256;

/** The longest single string inside a block: one refused key spelling, or one adapter note. */
const MUX_TEXT_MAX = 1024;

/**
 * One member's own multiplexer block off a `hello` answer, or `null` when that answer said nothing
 * about it (M22/03).
 *
 * `null` for every shape this build cannot read as a block, and `null` means **"use the lead's
 * answer"** — never "every capability present". A peer older than this amendment omits the field, a
 * peer whose bridge holds no adapter omits it too, and both keep producing exactly the reading the
 * phone gives them today.
 *
 * **Bounded, and re-checked field by field, because the lead REPUBLISHES this** to a phone on
 * `/api/config?host=<member>`. Every string is length-capped and every collection is row-capped, so
 * a member cannot make the lead serve an unbounded body on a route the phone polls on every page
 * load.
 *
 * **Unknown capability keys are KEPT, deliberately.** `capabilities` is total for the version of the
 * bridge that built it, not for every version a client may know (`bridge/types.ts`), so a key this
 * lead has never heard of is a NEWER member answering honestly. Filtering it out would erase an
 * answer for a phone that does know the key, and the whole module is built on an absent key reading
 * as capable. `logoUrl` is the one field dropped, and the peer already omits it: a path only answers
 * on the machine that serves it.
 */
export function parseMuxReport(value: JsonValue): MuxConfig | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  const block = asRecord(rec[CREW_MUX_FIELD]);
  if (block === null) return null;
  const name = typeof block.name === "string" ? block.name.trim() : "";
  if (name === "" || name.length > MUX_NAME_MAX) return null;
  const declared = asRecord(block.capabilities);
  if (declared === null) return null;
  const capabilities: Record<string, boolean> = {};
  for (const [key, answer] of Object.entries(declared).slice(0, MUX_ROWS_MAX)) {
    if (typeof answer === "boolean") capabilities[key] = answer;
  }
  const notes: Record<string, string> = {};
  for (const [key, note] of Object.entries(asRecord(block.notes) ?? {}).slice(0, MUX_ROWS_MAX)) {
    if (typeof note === "string" && note.length <= MUX_TEXT_MAX) notes[key] = note;
  }
  const unsupportedKeys = (Array.isArray(block.unsupportedKeys) ? block.unsupportedKeys : [])
    .filter((k): k is string => typeof k === "string" && k.length <= MUX_TEXT_MAX)
    .slice(0, MUX_ROWS_MAX);
  // SAFETY: both records are string-keyed collections of the value type the wire field declares,
  // checked entry by entry above. The nominal key type is a union of the capability names THIS build
  // knows, and the cast is what lets a newer member's extra key survive — see the note above.
  const wire: MuxConfig = {
    name,
    capabilities: capabilities as MuxConfig["capabilities"],
    unsupportedKeys,
    notes: notes as MuxConfig["notes"],
  };
  // Assigned, never conditionally spread: an unreadable value must leave NO key, so the phone's own
  // absent-means rule answers it rather than a null this reader invented.
  const spaces = block.spaces;
  if (spaces === "one" || spaces === "many") wire.spaces = spaces;
  const latency = asRecord(block.topologyLatency);
  if (latency?.kind === "push") wire.topologyLatency = { kind: "push" };
  if (latency?.kind === "bounded" && typeof latency.ms === "number" && Number.isFinite(latency.ms)) {
    wire.topologyLatency = { kind: "bounded", ms: latency.ms };
  }
  return wire;
}

/**
 * Read a member's own running version off the answer its `snapshot` rode on (§5, §19).
 *
 * `null` for every shape this build cannot read as a version — absent, blank, not a string — and
 * `null` means **"this answer said nothing about the version"**, never "this member has none". A
 * peer older than the 2026-09-04 amendment simply omits the field, and a sweep must not erase what
 * a `hello` already taught the lead. The caller is what makes that true: it passes a
 * `PeerObservation` only when this returns non-`null`, and the registry's absent-observation branch
 * then keeps the previous value (`bridge/crew/lead.ts`, `bridge/crew/registry.ts`).
 *
 * Nothing is re-derived here. The string is that machine's own spelling of its own build, passed
 * through untouched, exactly as `hello`'s is.
 */
export function parsePeerVersion(value: JsonValue): string | null {
  const rec = asRecord(value);
  if (rec === null) return null;
  const raw = rec[CREW_VERSION_FIELD];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
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
 * member can know, and the lead's `crew status` prints them as it received them.
 */
function pairingCollisionOf(body: JsonObject | null) {
  if (body === null || body.code !== PAIRING_LABEL_COLLISION) return null;
  const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === "string") : [];
  const error = typeof body.error === "string" ? body.error : "a device with that label already exists there";
  return { error, labels };
}

/** §7's `expected`/`received` reading, tolerating a peer that sends neither. */
function readMismatch(body: JsonObject | null) {
  const error = typeof body?.error === "string" ? body.error : "crew protocol mismatch";
  const expected = typeof body?.expected === "number" ? body.expected : CREW_PROTOCOL_VERSION;
  const received = typeof body?.received === "number" ? body.received : null;
  return { reason: error, expected, received };
}
