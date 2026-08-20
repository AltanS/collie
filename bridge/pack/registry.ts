import { isMemberId } from "./identity.ts";
import type { PackLink, PeerFailure, PeerOutcome } from "./peer-client.ts";
import type { TrustedMember } from "./trust-store.ts";
import type { SessionRuntime } from "../sessions.ts";

// The host dimension of the address triple `(host, session, paneId)` (PACK_PROTOCOL.md §4).
//
// `bridge/sessions.ts` already resolves `(session)`: absent/empty → primary, unknown → `undefined`
// and the caller 404s (`:154-157`). This module is that registry with one component in front of it,
// and it is written so the *shape* of the rule is visibly identical rather than merely similar.
//
// ── THE RULE THIS MODULE EXISTS TO KEEP ──────────────────────────────────────
// `bridge/sessions.ts:17-20` says a client-supplied session name is ONLY ever a Map key: it never
// becomes a filesystem path. The host carries the same rule plus one more, because a host names a
// *machine*:
//
//     A client-supplied host is only ever a registry key. It never becomes a path, and it never
//     becomes an address the lead dials.
//
// An address comes from the trust store or from nowhere: {@link PackRegistry.resolve} looks a host up
// among enrolled members and returns the member record, whose `address` the operator supplied at
// enrollment time. There is deliberately NO code path in this file from a URL parameter to a URL the
// client dials — a host that is not in the roster produces `undefined`, which the caller turns into
// the same 404 an unknown session gets today, and nothing is attempted.

/** The wire spelling of the host parameter, phone → lead (§4). The browser sends the short `?h=`. */
export const HOST_PARAM = "host";

/**
 * What a `host=` value selects.
 *
 * `invalid` and "unknown member" are deliberately NOT the same value here even though both 404: the
 * lead's audit log wants to distinguish a typo'd member id from a value that is not a member id at
 * all — the second is the shape an attacker's probe takes (a path, a URL, an IP).
 */
export type HostSelector =
  /** Absent or blank ⇒ **this collie**. The whole backward-compatibility story (§4). */
  | { readonly kind: "local" }
  /** Well-formed member id. Whether it is *enrolled* is the registry's question, not the parser's. */
  | { readonly kind: "member"; readonly id: string }
  /** Not a member id at all. Never looked up, never dialled. */
  | { readonly kind: "invalid"; readonly raw: string };

/**
 * Parse a `host=` value. Pure, total, and the only place the grammar is applied to client input.
 *
 * Absent, `null` and `""` all mean the lead — mirroring `SessionRegistry.get(undefined)` selecting
 * the primary, and mirroring `sessionSearch()` emitting `""` for the primary session in the browser
 * (`web/src/lib/session.ts:28-31`). A solo instance therefore never sees this function decide
 * anything: no client emits the parameter, so every request takes the `local` branch, which is the
 * branch that existed before this module did.
 */
export function selectHost(raw: string | null | undefined): HostSelector {
  if (raw === null || raw === undefined || raw === "") return { kind: "local" };
  if (isMemberId(raw)) return { kind: "member", id: raw };
  return { kind: "invalid", raw };
}

/** Read the host selector off a URL, for the one line in the bridge that consumes it. */
export function selectHostFrom(url: URL): HostSelector {
  return selectHost(url.searchParams.get(HOST_PARAM));
}

/**
 * What a `hello` observed about a member, folded in beside reachability. Absent from a `record()`
 * call means "this call learned nothing about the version" — see {@link PackRegistry.record}.
 */
export interface PeerObservation {
  /** The reported version, or `null` when the member answered without the optional field (§7.1). */
  readonly version: string | null;
}

/** How the lead currently sees a member (§10.2, §18.10). `reachable` until a call says otherwise. */
export type PeerHealth = "reachable" | PeerFailure["state"];

/**
 * Who a `conflicted` member says it follows (§18.10) — everything the lead may render about it, and
 * nothing more. The answering peer names a member id and a generation and is not a directory, so
 * there is no address and no certificate here to be tempted by.
 */
export interface PeerConflict {
  readonly leadMemberId: string;
  /** The generation that member holds, or `null` when it reported none. */
  readonly warrantGeneration: number | null;
}

/** The lead's belief about one peer — everything `pack status` and the `servers` array render. */
export interface PeerState {
  readonly memberId: string;
  readonly health: PeerHealth;
  /** The lead's receipt time of the last successful call. `null` until one lands (§10). */
  readonly lastSeenAt: number | null;
  /**
   * The failure reason, verbatim, for the operator. `null` while reachable **and keeping up**.
   *
   * A member can be reachable and still carry one: {@link PackRegistry.recordProbe}'s slow-link note
   * (§10.4), for a peer that answers a patient `hello` but whose snapshot misses the strict poll
   * budget. That is not a failure — it is the honest sentence for "the machine is there, its data is
   * old", which is exactly what `reachable: true` beside an old `lastSeenAt` renders.
   */
  readonly reason: string | null;
  /**
   * The version this member last reported over `hello` (§5), or `null` when it has reported none —
   * never polled, or a build older than the 2026-08-12 amendment (§7.1).
   *
   * **In memory only, and deliberately so.** A version describes a *process*, and a restart is
   * exactly what changes it, so a persisted one would survive the update it is meant to report. It
   * is dropped by `prune()` and `disposeAll()` with the rest of the state — no `TrustedMember`
   * field, and `TRUST_STORE_VERSION` stays `1`.
   *
   * It is an observation and nothing else: no route branches on it, and a difference refuses
   * nothing (§7.1 — the protocol integer is the only thing that refuses).
   */
  readonly version: string | null;
  /**
   * Set exactly when `health === "conflicted"`: the lead this member says it follows instead (§18.10).
   *
   * It is carried rather than folded into `reason` because the operator's next move depends on the
   * two fields, not on the sentence: a generation HIGHER than this lead's own is a takeover this
   * machine has not heard about, and a lower one is a peer that has not caught up. `pack status`
   * renders both; nothing else branches on it.
   */
  readonly conflict: PeerConflict | null;
}

/**
 * Which failure states survive into health as themselves.
 *
 * Only two do, and the rest project onto `unreachable` — which is not laziness but §10.2's own
 * table: the phone is shown three states, and a state the phone cannot act on differently must not
 * become a fourth badge it has to explain. `conflicted` earns its place because the remedy is
 * different in kind (a member has moved packs; no amount of waiting fixes it).
 */
function conflictHealth(state: PeerFailure["state"]): PeerHealth {
  if (state === "incompatible" || state === "conflicted") return state;
  return "unreachable";
}

/** The local session registry, narrowed to what host resolution needs (and what a fake can be). */
export interface LocalSessions {
  get(name?: string): SessionRuntime | undefined;
}

/** What a `(host, session)` pair resolves to. `undefined` ⇒ the caller 404s, exactly as today. */
export type HostResolution =
  | { readonly kind: "local"; readonly runtime: SessionRuntime }
  | { readonly kind: "peer"; readonly link: PackLink; readonly state: PeerState };

export interface PackRegistryDeps {
  /** This collie's own sessions. Untouched by federation — it is the `local` branch's whole answer. */
  readonly sessions: LocalSessions;
  /** This collie's own member id, so `host=<self>` is the lead, not a peer of itself. */
  readonly self: string;
  /** The roster, read from the trust store. Only `enrolled` members are addressable. */
  readonly members: () => readonly TrustedMember[];
}

/**
 * `(host, session)` resolution, plus the lead's per-peer health.
 *
 * Health lives here and not in `PeerClient` on purpose: the client is stateless, so there is exactly
 * one place that holds "what the lead believes about peer X", and disposal is a single call rather
 * than a hunt. Nothing in this class arms a timer — the peer sweep is *part of* the lead's existing
 * poll, never a second one (§10.1, §11).
 */
export class PackRegistry {
  private readonly peers = new Map<string, PeerState>();

  constructor(private readonly deps: PackRegistryDeps) {}

  /**
   * Resolve `(host, session)`.
   *
   * Reads as one expression on purpose: an absent host takes the identical call the bridge makes
   * today (`registry.get(sessionName)`) and returns the identical runtime object, so "absent host =
   * the lead" is not a re-implementation of local behaviour that could drift from it — it *is* local
   * behaviour, reached through one extra `if`.
   */
  resolve(host: HostSelector, session?: string): HostResolution | undefined {
    if (host.kind === "invalid") return undefined;
    if (host.kind === "local" || host.id === this.deps.self) {
      const runtime = this.deps.sessions.get(session);
      return runtime === undefined ? undefined : { kind: "local", runtime };
    }
    const member = this.enrolled().find((m) => m.memberId === host.id);
    // An unknown host — and an `unenrolled` tombstone, which is a member the operator has dropped —
    // is `undefined`. The address on a tombstone record is never dialled, which is what makes
    // revocation actually revoke rather than merely relabel.
    if (member === undefined) return undefined;
    // NOTE: the session name is NOT resolved here. It is the peer's OWN registry that resolves it,
    // with today's exact semantics (§5) — the lead has no knowledge of a peer's sessions beyond what
    // that peer's snapshot reported, and inventing one here would make the lead's roster the
    // authority on another machine's sessions.
    return { kind: "peer", link: linkFor(member), state: this.state(member.memberId) };
  }

  /** Every addressable peer, as links the client can dial. Empty ⇒ a solo lead sweeps nothing. */
  links(): PackLink[] {
    return this.enrolled()
      .filter((m) => m.memberId !== this.deps.self)
      .map(linkFor);
  }

  /** The lead's belief about one member. Unknown members read as never-seen, never as reachable. */
  state(memberId: string): PeerState {
    return (
      this.peers.get(memberId) ?? {
        memberId,
        health: "unreachable",
        lastSeenAt: null,
        reason: "never polled",
        version: null,
        conflict: null,
      }
    );
  }

  /** Every peer's state, member-id ordered — the stable order the `servers` array will render in. */
  list(): PeerState[] {
    return this.links()
      .map((l) => this.state(l.memberId))
      .toSorted((a, b) => a.memberId.localeCompare(b.memberId));
  }

  /**
   * Fold a call's outcome into the lead's belief about that member.
   *
   * **A failure never clears `lastSeenAt`.** §10.2: a peer's sessions never vanish — they are listed
   * from the last-good snapshot and marked stale with an age derived from `lastSeenAt`. Dropping the
   * timestamp on failure would render "stale since never", and a triage list that flickers is worse
   * than one that is honestly stale.
   */
  record(memberId: string, outcome: PeerOutcome<unknown>, observed?: PeerObservation): PeerState {
    const previous = this.peers.get(memberId);
    // An OBSERVATION is authoritative, including its `null`: only `hello` carries a version (§5), so
    // most calls pass none and the last one heard stands — but a member that came back on an older
    // build and reported nothing must read as reporting nothing, not as its remembered version.
    // Absent-means-closed (§7.1) applies to the wire field; here it is "observed nothing" vs
    // "observed absence", and only the second overwrites.
    const version = observed !== undefined ? observed.version : (previous?.version ?? null);
    const next: PeerState = outcome.ok
      ? {
          memberId,
          health: "reachable",
          lastSeenAt: outcome.receivedAt,
          reason: null,
          version,
          conflict: null,
        }
      : {
          memberId,
          version,
          // `refused` (§14.3's 403) is a CLI-only outcome — no route the lead's sweep calls answers
          // one — so it reads as unreachable here, which is the honest projection: the phone's answer
          // is the same. `conflicted` (§18.10) does NOT, and that is the 2026-08-20 amendment: the
          // member answered, and answered precisely, so folding it into `unreachable` would render
          // "this peer belongs to someone else's pack now" as "the laptop is shut". §10.2's three
          // states are not to be conflated, and this is the fourth.
          health: conflictHealth(outcome.state),
          lastSeenAt: previous?.lastSeenAt ?? null,
          reason: outcome.reason,
          conflict:
            outcome.state === "conflicted"
              ? { leadMemberId: outcome.leadMemberId, warrantGeneration: outcome.warrantGeneration }
              : null,
        };
    this.peers.set(memberId, next);
    return next;
  }

  /**
   * Fold a **verdict probe**'s outcome — a patient `hello` (§10.4) — into the lead's belief.
   *
   * Two rules separate it from {@link PackRegistry.record}, and both exist because a probe learns
   * about the MACHINE while the sweep learns about its DATA:
   *
   *   • **A successful probe never stamps `lastSeenAt`.** Freshness is the receipt time of a call
   *     that carried a snapshot (§10.2). A `hello` carries none, so crediting it would render a peer
   *     whose data is minutes old as live — the one thing the stale badge exists to prevent.
   *   • **A successful probe after a failed sweep is `reachable` with a slow-link reason.** The
   *     machine answered on a budget that allows a cold handshake; its snapshot did not fit the
   *     poll's. That is a link too slow for the cadence, not a peer that is gone, and §10.2's own
   *     table says the phone shows last-good-marked-stale either way.
   *
   * A FAILED probe is the ordinary failure fold: it had the patient budget and still did not answer,
   * which is the strongest evidence this lead can cheaply get that the host is not there.
   */
  recordProbe(memberId: string, outcome: PeerOutcome<unknown>, observed?: PeerObservation): PeerState {
    if (!outcome.ok) return this.record(memberId, outcome, observed);
    const previous = this.peers.get(memberId);
    const version = observed !== undefined ? observed.version : (previous?.version ?? null);
    const keepingUp = previous !== undefined && previous.health === "reachable" && previous.reason === null;
    const next: PeerState = {
      memberId,
      health: "reachable",
      lastSeenAt: previous?.lastSeenAt ?? null,
      reason: keepingUp ? null : SLOW_LINK_REASON,
      version,
      conflict: null,
    };
    this.peers.set(memberId, next);
    return next;
  }

  /**
   * Fold a successful **proxied exchange** into the freshness half of the ledger — and nothing else.
   *
   * The sweep is not the only time this lead hears from a member. Every phone read of a peer's pane
   * and every phone write to one is an authenticated round trip over the same pack link (§5, §9.1),
   * and one that *landed* is a receipt exactly as a sweep's is: same lead clock, same
   * "the response arrived here" meaning (§10.2 — freshness is the lead's receipt time).
   *
   * Crediting them matters because the two clocks are otherwise unrelated. A phone watching a peer's
   * pane polls at the hot cadence (1.5 s) while the sweep, with a healthy event stream, runs at the
   * idle one (12 s) — so the phone's own presented-stale tolerance (`3 × pollMs`) was being measured
   * against a receipt only the 12 s sweep refreshed, and a perfectly healthy peer spent most of every
   * sweep interval reading stale. With this fold the receipt refreshes at whatever cadence somebody
   * is actually watching, and the sweep stays the floor for a member nobody is looking at.
   *
   * **Two rules keep this from becoming a second classifier:**
   *
   *   • **Successes only, and only for a member already believed `reachable`.** A failed or ambiguous
   *     forward changes nothing here — `forwardToPeer` classifies those for the *phone* (§10.3), on a
   *     different budget than the sweep's, and letting it also move the ledger would mean two code
   *     paths deciding what "unreachable" means. A member the sweep believes down is likewise not
   *     revived by a lucky proxy: that verdict is the sweep's and the probe's (§10.4), and it clears
   *     on the next tick anyway.
   *   • **`lastSeenAt` only ever moves forward.** Forwards are concurrent by nature — several pane
   *     reads can be in flight at once and may land out of order — so an older receipt must never
   *     overwrite a newer one.
   *
   * Nothing else on the state is touched: health, reason and version stay exactly as the sweep and
   * the probe left them (a slow-link note therefore survives, which is honest — the machine answers,
   * its *snapshot* still misses the poll budget).
   */
  recordExchange(memberId: string, receivedAt: number): PeerState {
    const previous = this.peers.get(memberId);
    if (previous === undefined || previous.health !== "reachable") return this.state(memberId);
    if (receivedAt <= (previous.lastSeenAt ?? 0)) return previous;
    const next: PeerState = { ...previous, lastSeenAt: receivedAt };
    this.peers.set(memberId, next);
    return next;
  }

  /**
   * Drop the state of every member no longer in the roster — a `leave`, a revocation, or a member
   * dropped by a rotation. Mirrors `SessionRegistry.dispose()`'s contract (`bridge/sessions.ts:222`):
   * what a vanished member owned stops existing rather than lingering as a stale row.
   */
  prune(): string[] {
    const live = new Set(this.enrolled().map((m) => m.memberId));
    const dropped: string[] = [];
    for (const id of this.peers.keys()) {
      if (live.has(id)) continue;
      this.peers.delete(id);
      dropped.push(id);
    }
    return dropped;
  }

  /** Forget everything. For process shutdown and for `leave`. */
  disposeAll(): void {
    this.peers.clear();
  }

  private enrolled(): readonly TrustedMember[] {
    return this.deps.members().filter((m) => m.status === "enrolled");
  }
}

/**
 * What the operator reads for a member that is there but cannot keep up with the poll (§10.4).
 *
 * It names both halves on purpose — the machine answered, the data did not arrive in time — because
 * the sentence it replaces ("timed out after 1200ms") reads as "your peer is down" and sent at least
 * one operator hunting a healthy laptop across a DERP relay.
 */
export const SLOW_LINK_REASON =
  "slow link — it answers, but its snapshot misses the poll budget; showing its last-good state";

/** A member record becomes a dialable link — the ONLY place an address enters the client's hands. */
function linkFor(member: TrustedMember): PackLink {
  return { memberId: member.memberId, address: member.address };
}
