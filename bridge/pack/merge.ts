import { STATUS_RANK } from "../types.ts";
import type { PaneWire, ServerSummary, SessionSummary, SnapshotResponse } from "../types.ts";
import type { PeerState } from "./registry.ts";

// The ONE place the lead re-serialises (PACK_PROTOCOL.md §9.2). Everything else a pack link carries
// is proxied byte-for-byte; this file folds N peers' snapshots plus the lead's own into the single
// body `/api/snapshot` answers.
//
// ── WHY THIS FILE IS PURE ────────────────────────────────────────────────────
// It takes a local body, a list of peer contributions and a clock reading, and returns a body. No
// fetch, no timer, no `Bun.serve`, no registry. That is what lets merge.test.ts exercise the three
// states of §10.2 (reachable / unreachable / incompatible) as data rather than as a network, and it
// is the CLAUDE.md testability rule applied to the most consequential function in the pack.
//
// ── THE THREE INVARIANTS IT EXISTS TO HOLD ───────────────────────────────────
//  1. UNREACHABLE IS A VALUE, NEVER AN ERROR (§10.2). Nothing here throws or omits a member. A peer
//     that is down, slow, skewed or refusing becomes a `reachable:false` row with zeroed-nothing —
//     its sessions and panes are still listed, from the last-good body.
//  2. A PEER'S SESSIONS NEVER VANISH (§10.2). The lead renders the last-good snapshot and marks it
//     stale from `lastSeenAt`; a triage list that flickers is worse than one that is honestly stale.
//     Concretely: {@link mergeSnapshot} reads `contribution.body`, which the sweep only ever
//     REPLACES on success and never clears on failure.
//  3. FRESHNESS IS THE LEAD'S RECEIPT TIME (§10.2). `lastSeenAt` comes from `PeerState`, which
//     `PeerClient` stamps from the lead's own clock on every branch. A peer's clock is never read —
//     nothing in this file touches a timestamp that arrived over the wire, and `parsePeerSnapshot`
//     drops the peer's own `ts` on the floor for exactly that reason.
//
// ── AND THE ONE IT HOLDS FOR SOLO ────────────────────────────────────────────
// A solo instance never calls this function. `servers` is optional-and-absent (§11) and the host tag
// is added HERE, not upstream, so with no pack the body that leaves server.ts is the object literal
// it has always been — same keys, same order, same bytes, same ETag.

/**
 * A peer's snapshot, narrowed to what the lead merges.
 *
 * Deliberately NOT `SnapshotResponse`: a peer's `bridge`, `device`, `notifications`, `update`,
 * `workspaces`, `tabs` and `ts` are all statements about a link the phone does not have. Taking only
 * the three fields the merge uses means a peer cannot contribute a field the lead did not ask for,
 * which is the same discipline `toPaneWire` applies to a pane leaving the bridge.
 */
export interface PeerSnapshotBody {
  readonly sessions: readonly SessionSummary[];
  readonly agents: readonly PaneWire[];
  readonly shellPanes: readonly PaneWire[];
}

/**
 * Sanity caps on one peer's contribution. A peer is a trusted member, but the lead re-serialises its
 * body into every phone poll, so a peer that has gone haywire must not be able to make the lead's
 * snapshot unbounded. Generous enough that no real herd notices: a machine with 500 panes has
 * problems the pack cannot fix.
 */
export const MAX_PEER_PANES = 500;
export const MAX_PEER_SESSIONS = 50;

/**
 * Coerce a peer's `GET /pack/v1/snapshot` body into {@link PeerSnapshotBody}, or `null` if it is not
 * one at all.
 *
 * **A peer never asserts its own host.** Any `host` field arriving on a session or a pane is
 * stripped here and re-stamped by {@link mergeSnapshot} from the registry key the lead dialled. This
 * is the wire-level half of §4's rule that a member id is minted by the lead and carries no routing
 * information: if a peer could label its panes with another member's id, the phone would address a
 * write to the wrong machine, and the lead would have handed it the address to do so.
 */
export function parsePeerSnapshot(value: unknown): PeerSnapshotBody | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : null;
  const agents = Array.isArray(raw.agents) ? raw.agents : null;
  const shellPanes = Array.isArray(raw.shellPanes) ? raw.shellPanes : null;
  // All three are required. A body missing one is not a partial snapshot to salvage — it is a peer
  // answering something other than a snapshot, and salvaging it would render half a machine.
  if (sessions === null || agents === null || shellPanes === null) return null;
  return {
    sessions: sessions.filter(isSessionSummary).slice(0, MAX_PEER_SESSIONS).map(untagSession),
    agents: agents.filter(isPaneWire).slice(0, MAX_PEER_PANES).map(untagPane),
    shellPanes: shellPanes.filter(isPaneWire).slice(0, MAX_PEER_PANES).map(untagPane),
  };
}

/** What the lead knows about one peer at merge time: its health, and its last-good body. */
export interface PeerContribution {
  /** From the registry — the single owner of "what the lead believes about peer X" (M4/03). */
  readonly state: PeerState;
  /** Operator-facing label. Today the member id, which IS the operator's `join` label, slugified. */
  readonly name: string;
  /** The most recent body that parsed, or `null` if none ever has. Never cleared by a failure. */
  readonly body: PeerSnapshotBody | null;
}

export interface MergeContext {
  /** This collie: its member id and label. Always the first entry in `servers` (§9.2). */
  readonly self: { readonly id: string; readonly name: string };
  readonly peers: readonly PeerContribution[];
  /** The lead's clock, for its own `lastSeenAt`. Peers' timestamps come from their `PeerState`. */
  readonly now: number;
}

/**
 * `ServerSummary` for one peer — §9.2's shape, exactly, and nothing more.
 *
 * `protocol` is derived rather than stored: `incompatible` when the last call said so, `ok` once the
 * peer has answered a call this build could read (which is precisely "there is a last-good body, or
 * it is answering right now"), `unknown` before that has ever happened. Deriving it means there is
 * no second piece of state that can disagree with `health` about the same peer.
 */
export function serverSummaryFor(c: PeerContribution): ServerSummary {
  const incompatible = c.state.health === "incompatible";
  const protocol: ServerSummary["protocol"] = incompatible
    ? "incompatible"
    : c.state.health === "reachable" || c.body !== null
      ? "ok"
      : "unknown";
  return {
    id: c.state.memberId,
    name: c.name,
    isLead: false,
    reachable: c.state.health === "reachable",
    protocol,
    // The peer's refusal reason, verbatim (§9.2) — never paraphrased, because the operator's next
    // move is to read it and go fix a version somewhere.
    ...(incompatible && c.state.reason !== null ? { protocolDetail: c.state.reason } : {}),
    lastSeenAt: c.state.lastSeenAt ?? 0,
  };
}

/**
 * Fold the lead's own snapshot body and every peer's contribution into the merged body the phone
 * polls (§9.2).
 *
 * Only called when a pack exists. `local` is returned structurally unchanged except for the host tag
 * on its sessions and panes and the added `servers` — `bridge`, `device`, `workspaces`, `tabs`,
 * `notifications`, `update` and `ts` are the lead's own statements about the lead and are not merged.
 * (Peer workspaces/tabs are deliberately NOT unioned into the navigator: their ids are only unique
 * per machine, and a pane already carries the denormalised `workspaceLabel`/`workspaceNumber`/
 * `tabLabel` the home list renders. The space navigator staying lead-local is M5's to revisit.)
 */
export function mergeSnapshot(local: SnapshotResponse, ctx: MergeContext): SnapshotResponse {
  const self = ctx.self.id;
  const peers = [...ctx.peers].sort((a, b) => a.state.memberId.localeCompare(b.state.memberId));

  const servers: ServerSummary[] = [
    {
      id: self,
      name: ctx.self.name,
      isLead: true,
      // The lead is answering this very request, so it is reachable, current and speaking its own
      // protocol by construction. Listing it (§9.2: "the lead's own entry is present too") is what
      // lets the phone render one uniform host list instead of special-casing "here".
      reachable: true,
      protocol: "ok",
      lastSeenAt: ctx.now,
    },
    ...peers.map(serverSummaryFor),
  ];

  const sessions: SessionSummary[] = [
    ...local.sessions.map((s) => ({ ...s, host: self })),
    ...peers.flatMap((p) => (p.body?.sessions ?? []).map((s) => ({ ...s, host: p.state.memberId }))),
  ];

  return {
    ...local,
    agents: triageSorted([
      ...local.agents.map((p) => tag(p, self)),
      ...peers.flatMap((p) => (p.body?.agents ?? []).map((pane) => tag(pane, p.state.memberId))),
    ], self),
    shellPanes: spaceSorted([
      ...local.shellPanes.map((p) => tag(p, self)),
      ...peers.flatMap((p) => (p.body?.shellPanes ?? []).map((pane) => tag(pane, p.state.memberId))),
    ], self),
    sessions,
    servers,
  };
}

/**
 * The home list's order, across hosts (§9.2: "the phone's NEEDS YOU list must not hide a blocked
 * agent behind a host tab").
 *
 * The first three keys are `bridge/state-engine.ts:260-265`'s comparator verbatim, with the host
 * inserted as the tiebreak *between* status and space — status is the only thing that outranks which
 * machine you are looking at, and `workspaceNumber` is meaningless across machines (every host has a
 * space 1). The lead sorts first among hosts so a solo-shaped herd reads unchanged.
 *
 * TOTALLY ORDERED ON PURPOSE. `(host, paneId)` is unique across the pack, so no two rows can compare
 * equal — the spec's open question about jitter is closed by making a tie impossible rather than by
 * hoping the sort is stable.
 */
function triageSorted(panes: PaneWire[], self: string): PaneWire[] {
  return panes.sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      hostRank(a, b, self) ||
      a.workspaceNumber - b.workspaceNumber ||
      a.paneId.localeCompare(b.paneId),
  );
}

/** Shell panes: same rule minus the status key, mirroring `bridge/state-engine.ts:271`. */
function spaceSorted(panes: PaneWire[], self: string): PaneWire[] {
  return panes.sort(
    (a, b) =>
      hostRank(a, b, self) ||
      a.workspaceNumber - b.workspaceNumber ||
      a.paneId.localeCompare(b.paneId),
  );
}

/** The lead first, then peers by member id. Never zero for two different hosts. */
function hostRank(a: PaneWire, b: PaneWire, self: string): number {
  const ha = a.host ?? self;
  const hb = b.host ?? self;
  if (ha === hb) return 0;
  if (ha === self) return -1;
  if (hb === self) return 1;
  return ha.localeCompare(hb);
}

/** Stamp the host the lead dialled onto a pane. The pane's own claim, if any, was already dropped. */
function tag(pane: PaneWire, host: string): PaneWire {
  return { ...pane, host };
}

function untagSession(s: SessionSummary): SessionSummary {
  const { host: _ignored, ...rest } = s;
  return rest;
}

function untagPane(p: PaneWire): PaneWire {
  const { host: _ignored, ...rest } = p;
  return rest;
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (value === null || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return typeof s.name === "string" && typeof s.reachable === "boolean";
}

function isPaneWire(value: unknown): value is PaneWire {
  if (value === null || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  // paneId and status are what the merge SORTS by and what the phone ADDRESSES by; a row missing
  // either cannot be rendered or driven, so it is dropped rather than defaulted into the list.
  return (
    typeof p.paneId === "string" &&
    p.paneId.length > 0 &&
    typeof p.status === "string" &&
    p.status in STATUS_RANK &&
    typeof p.workspaceNumber === "number"
  );
}
