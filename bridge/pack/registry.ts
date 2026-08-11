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

/** How the lead currently sees a member (§10.2). `reachable` until a call says otherwise. */
export type PeerHealth = "reachable" | PeerFailure["state"];

/** The lead's belief about one peer — everything `pack status` and the `servers` array render. */
export interface PeerState {
  readonly memberId: string;
  readonly health: PeerHealth;
  /** The lead's receipt time of the last successful call. `null` until one lands (§10). */
  readonly lastSeenAt: number | null;
  /** The failure reason, verbatim, for the operator. `null` while reachable. */
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
      }
    );
  }

  /** Every peer's state, member-id ordered — the stable order the `servers` array will render in. */
  list(): PeerState[] {
    return this.links()
      .map((l) => this.state(l.memberId))
      .sort((a, b) => a.memberId.localeCompare(b.memberId));
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
      ? { memberId, health: "reachable", lastSeenAt: outcome.receivedAt, reason: null, version }
      : {
          memberId,
          version,
          // `refused` (§14.3's 403) is a CLI-only outcome — no route the lead's sweep calls answers
          // one — and health has three values by §10.2. Anything that is not a version skew reads as
          // unreachable here, which is the honest projection: the phone's answer is the same.
          health: outcome.state === "incompatible" ? "incompatible" : "unreachable",
          lastSeenAt: previous?.lastSeenAt ?? null,
          reason: outcome.reason,
        };
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
    for (const id of [...this.peers.keys()]) {
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

/** A member record becomes a dialable link — the ONLY place an address enters the client's hands. */
function linkFor(member: TrustedMember): PackLink {
  return { memberId: member.memberId, address: member.address };
}
