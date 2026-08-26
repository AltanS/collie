import { deriveMode } from "./mode.ts";
import { enrollmentOf, type TrustStoreData, type TrustedMember } from "./trust-store.ts";
import { currentWarrant } from "./warrant.ts";
import type { PeerContribution } from "./merge.ts";
import type { PeerHealth } from "./registry.ts";
import type { PackMemberStatus, PackStatusResponse } from "../types.ts";

// The body of `GET /api/pack` (bridge/types.ts, {@link PackStatusResponse}) — the browser's read-only
// view of what `collie pack status` prints, composed from what the RUNNING lead already holds.
//
// ── WHY THIS FILE IS PURE, AND WHY THAT IS THE WHOLE POINT ───────────────────
// It takes a trust store snapshot, the lead's own identity, its per-peer beliefs and a clock
// reading, and returns a body. No fetch, no timer, no disk, no registry — which is not a testing
// convenience here but the route's actual guarantee: a surface the phone polls must not be able to
// make the lead dial a member. The sweep is the ONLY thing that talks to peers (PACK_PROTOCOL.md
// §10.1, §11 — "no second timer"), and a function with no transport in its signature cannot become
// a second one no matter what a later caller does.
//
// ── IT REPORTS; IT NEVER DECIDES ─────────────────────────────────────────────
// Every value below is copied from somewhere that already owns it. Health, reason, freshness,
// version and the conflict come from {@link PeerState}, which is the single owner of "what the lead
// believes about member X" (registry.ts). Mode comes from `deriveMode`, the same function the whole
// process hangs off (mode.ts). The deputy comes from the DESIGNATION, for the reason
// `cli/pack-status-deputy.ts` states at length. Nothing here re-derives a verdict, so this page and
// `pack status` cannot disagree about the same machine.
//
// ── AND WHAT IT MAY NOT CARRY ────────────────────────────────────────────────
// The store handed in holds the pack secret, every member's certificate and every fingerprint. None
// of them is a field of {@link PackStatusResponse} and none may become one — the same discipline
// `toPaneWire` applies to a pane and `merge.ts` applies to a peer's snapshot.

/** Everything the body is composed from. One argument per source, so the sources are the signature. */
export interface PackStatusSources {
  /**
   * The trust store as this process last read it — `TrustStore.current()`, which touches no disk.
   * `null` on an instance that never enrolled, which is the whole solo answer.
   */
  readonly store: TrustStoreData | null;
  /**
   * This collie's own id and operator-facing machine label — **the same object `mergeSnapshot` is
   * given** (merge.ts, `MergeContext`). Shared rather than re-derived so `members[0]` and
   * `servers[0]` cannot come to name the lead two different things.
   */
  readonly self: { readonly id: string; readonly name: string };
  /** This build's version, bare (bridge/version.ts) — the exact string `hello` answers with (§7.1). */
  readonly version: string;
  /** `PackLead.contributions()`: registry health per member, already member-id ordered. */
  readonly peers: readonly PeerContribution[];
  /** The lead's clock, for its own `lastSeenAt` and the body's `ts` (§10.2). */
  readonly now: number;
}

/**
 * Compose the pack overview, or `null` when this collie has no pack to describe.
 *
 * `null` is the route's 404 (`pack.not_lead`), and it covers both refusals: a solo instance, and a
 * peer — which is not a front door at all (ADR 0013). The test is `deriveMode`, never a local
 * re-reading of the roster: mode is decided in one place for the whole process (§3), so a machine
 * this function calls a lead is a machine that IS one.
 */
export function packStatusBody(src: PackStatusSources): PackStatusResponse | null {
  const { store } = src;
  if (store === null || store.pack === null) return null;
  if (deriveMode(enrollmentOf(store)).mode !== "lead") return null;
  const pack = store.pack;
  return {
    pack: {
      id: pack.packId,
      name: pack.name,
      secretGeneration: pack.secretGeneration,
      rotatedAt: pack.rotatedAt,
    },
    self: { id: src.self.id, name: src.self.name, version: src.version },
    deputy: deputyOf(store),
    members: [leadRow(src), ...peerRows(src, store, pack.secretGeneration)],
    ts: src.now,
  };
}

/**
 * The named deputy (ADR 0027), or `null` when this lead names nobody.
 *
 * The DESIGNATION is the source and the warrant is only its generation counter. Reading the name off
 * the warrant is the bug the live drill found: a takeover leaves the new lead holding a warrant that
 * names ITSELF, so a warrant-sourced deputy renders a lead as its own deputy. `cli/
 * pack-status-deputy.ts` carries the full argument; this is the same rule, one line of it.
 *
 * `warrantGeneration` is nullable rather than omitted because its absence is a STATE, not a gap: a
 * designation with no warrant behind it is a half-armed deputy, and a key that quietly vanished
 * would hide exactly that.
 */
function deputyOf(store: TrustStoreData): PackStatusResponse["deputy"] {
  const designated = store.deputy ?? null;
  if (designated === null) return null;
  return { id: designated, warrantGeneration: currentWarrant(store)?.warrant.generation ?? null };
}

/**
 * The lead's own row, and it is FIRST — the order `servers[]` uses (§9.2), so one phone list can
 * render both without a second sort.
 *
 * It carries no `address` and no `enrolledAt` because a lead is not in its own roster: there is no
 * enrollment record to read them from, and inventing them would be inventing a membership. Health is
 * `reachable` by construction (this process is answering the request that asks), `secretBehind` is
 * false because the lead IS where the current secret lives, and `provisional` is false because the
 * lead never joined anything.
 */
function leadRow(src: PackStatusSources): PackMemberStatus {
  return {
    id: src.self.id,
    name: src.self.name,
    isLead: true,
    health: "reachable",
    lastSeenAt: src.now,
    version: src.version,
    secretBehind: false,
    provisional: false,
  };
}

/**
 * One row per enrolled peer, in member-id order.
 *
 * The join is on the roster: `contributions()` is built from the registry, which lists only enrolled
 * members, so a contribution with no enrolled record is a member revoked between the two reads. It
 * is DROPPED rather than rendered without its roster half — a row missing its address and its
 * enrollment time reads as a broken member rather than as an absent one.
 */
function peerRows(
  src: PackStatusSources,
  store: TrustStoreData,
  secretGeneration: number,
): PackMemberStatus[] {
  const roster = new Map(store.peers.filter((m) => m.status === "enrolled").map((m) => [m.memberId, m]));
  return src.peers
    .toSorted((a, b) => a.state.memberId.localeCompare(b.state.memberId))
    .flatMap((c) => {
      const record = roster.get(c.state.memberId);
      return record === undefined ? [] : [peerRow(c, record, secretGeneration)];
    });
}

/** One peer: its {@link PeerState} re-spelled, plus the three facts only the roster holds. */
function peerRow(
  contribution: PeerContribution,
  record: TrustedMember,
  secretGeneration: number,
): PackMemberStatus {
  const { state } = contribution;
  const row: PackMemberStatus = {
    id: state.memberId,
    name: contribution.name,
    isLead: false,
    address: record.address,
    enrolledAt: record.enrolledAt,
    health: wireHealth(state.health),
    // The lead's receipt time, `0` for a member that has never answered — the same spelling
    // `ServerSummary.lastSeenAt` uses, so the phone derives staleness one way (§10.2).
    lastSeenAt: state.lastSeenAt ?? 0,
    secretBehind: record.secretGeneration !== secretGeneration,
    // Enrolled but never once contacted, and not answering now: the shape a half-finished join takes
    // (§8.2). STRICTLY `null` — an ABSENT `contactedAt` is a record written before the field existed
    // and must never read as provisional, which is the rule `pack status` applies to the same field.
    provisional: record.contactedAt === null && state.health !== "reachable",
  };
  // Assigned, never conditionally spread: an optional key is OMITTED when there is nothing to say,
  // never sent as null (PACK_PROTOCOL.md §11).
  if (state.reason !== null) row.reason = state.reason;
  if (state.version !== null) row.version = state.version;
  // Only in the state it describes, and only from the registry's own record of it — the answering
  // peer named a member and a generation and is not a directory, so there is nothing else to carry.
  if (state.health === "conflicted" && state.conflict !== null) {
    row.conflict = {
      leadMemberId: state.conflict.leadMemberId,
      warrantGeneration: state.conflict.warrantGeneration,
    };
  }
  return row;
}

/**
 * {@link PeerHealth} narrowed to the four states the wire names.
 *
 * The TYPE is wider than the values: `PeerHealth` is `"reachable" | PeerFailure["state"]`, and the
 * registry projects every failure but `incompatible` and `conflicted` onto `unreachable` before it
 * stores one (registry.ts, `conflictHealth`). This applies the same projection here rather than
 * trusting that it already happened — §10.2's rule is that the phone is shown three states plus
 * `conflicted`, and a fourth badge nobody can act on differently is a badge somebody has to explain.
 */
function wireHealth(health: PeerHealth): PackMemberStatus["health"] {
  if (health === "reachable" || health === "incompatible" || health === "conflicted") return health;
  return "unreachable";
}
