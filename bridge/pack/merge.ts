import type { JsonObject, JsonValue } from "../json.ts";
import { STATUS_RANK } from "../types.ts";
import type { PaneWire, ServerSummary, SessionSummary, SnapshotResponse, TabView, WorkspaceView } from "../types.ts";
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
 * Deliberately NOT `SnapshotResponse`: a peer's `bridge`, `device`, `notifications`, `update` and
 * `ts` are all statements about a link the phone does not have. Taking only the fields the merge
 * uses means a peer cannot contribute a field the lead did not ask for, which is the same discipline
 * `toPaneWire` applies to a pane leaving the bridge.
 *
 * **`workspaces` and `tabs` are among them since the F14 fix, and nothing new goes on the wire for
 * it.** A peer's `/pack/v1/snapshot` has always answered with its own whole browser body, these two
 * lists included; the lead simply threw them away and rendered its own. §9.2 says every session and
 * every pane is host-tagged, and a space and a tab are the two things left that the phone navigates
 * by, so they are read now and tagged the same way.
 */
export interface PeerSnapshotBody {
  readonly sessions: readonly SessionSummary[];
  readonly agents: readonly PaneWire[];
  readonly shellPanes: readonly PaneWire[];
  readonly workspaces: readonly WorkspaceView[];
  readonly tabs: readonly TabView[];
}

/**
 * Sanity caps on one peer's contribution. A peer is a trusted member, but the lead re-serialises its
 * body into every phone poll, so a peer that has gone haywire must not be able to make the lead's
 * snapshot unbounded. Generous enough that no real herd notices: a machine with 500 panes has
 * problems the pack cannot fix.
 */
export const MAX_PEER_PANES = 500;
export const MAX_PEER_SESSIONS = 50;
/** A space or a tab per pane is the worst honest case, so the pane cap is the right order here. */
export const MAX_PEER_WORKSPACES = 500;
export const MAX_PEER_TABS = 500;

/**
 * A peer's `GET /pack/v1/snapshot` body exactly as it arrives off the wire: three lists, none of
 * them checked until {@link parsePeerSnapshot} runs. Named so the parser's input has a contract of
 * its own rather than being `unknown`.
 */
export type PeerSnapshotWire = {
  sessions?: unknown;
  agents?: unknown;
  shellPanes?: unknown;
  workspaces?: unknown;
  tabs?: unknown;
};

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
export function parsePeerSnapshot(
  value: PeerSnapshotWire | JsonValue | null | undefined,
): PeerSnapshotBody | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const sessions = Array.isArray(value.sessions) ? value.sessions : null;
  const agents = Array.isArray(value.agents) ? value.agents : null;
  const shellPanes = Array.isArray(value.shellPanes) ? value.shellPanes : null;
  // All three are required. A body missing one is not a partial snapshot to salvage — it is a peer
  // answering something other than a snapshot, and salvaging it would render half a machine.
  if (sessions === null || agents === null || shellPanes === null) return null;
  // The navigator's two lists are ABSENT-MEANS-EMPTY, not required (§7.1's absent-means-closed).
  // A peer that omits them is one whose panes still render — every pane carries its own denormalised
  // `workspaceLabel`/`workspaceNumber`/`tabLabel` — so refusing the whole body over them would trade
  // a missing switcher row for a missing MACHINE, which is invariant 1 exactly backwards.
  const workspaces = Array.isArray(value.workspaces) ? value.workspaces : [];
  const tabs = Array.isArray(value.tabs) ? value.tabs : [];
  return {
    sessions: sessions.filter(isSessionSummary).slice(0, MAX_PEER_SESSIONS).map(untagSession),
    agents: agents.filter(isPaneWire).slice(0, MAX_PEER_PANES).map(untagPane),
    shellPanes: shellPanes.filter(isPaneWire).slice(0, MAX_PEER_PANES).map(untagPane),
    workspaces: workspaces.filter(isWorkspaceView).slice(0, MAX_PEER_WORKSPACES).map(untagWorkspace),
    tabs: tabs.filter(isTabView).slice(0, MAX_PEER_TABS).map(untagTab),
  };
}

/**
 * `servers[].name` for the lead's own entry (§9.2: "operator-chosen label"). A peer is labelled by
 * its `join` member id (`lead.ts`), so the lead's own entry must be a machine label too — never the
 * PACK's name, which is not a member of the roster and would collide visually with every peer's
 * per-machine label (the bug this function fixes).
 *
 * A bare short hostname: everything before the first `.`, so a peer's FQDN doesn't leak the local
 * domain into a label the operator reads as "which machine". An empty `hostname()` (containers, some
 * minimal images) falls back to the member id — still unique, just not as legible.
 */
export function leadLabel(hostname: string, memberId: string): string {
  const short = hostname.split(".")[0];
  return short !== undefined && short !== "" ? short : memberId;
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
  const summary: ServerSummary = {
    id: c.state.memberId,
    name: c.name,
    isLead: false,
    reachable: c.state.health === "reachable",
    protocol,
    lastSeenAt: c.state.lastSeenAt ?? 0,
  };
  // The peer's refusal reason, verbatim (§9.2) — never paraphrased, because the operator's next
  // move is to read it and go fix a version somewhere. Assigned, never conditionally spread: a
  // reachable peer's entry carries no `protocolDetail` key at all.
  if (incompatible && c.state.reason !== null) summary.protocolDetail = c.state.reason;
  return summary;
}

/**
 * Fold the lead's own snapshot body and every peer's contribution into the merged body the phone
 * polls (§9.2).
 *
 * Only called when a pack exists. `local` is returned structurally unchanged except for the host tag
 * on its sessions, panes, spaces and tabs, and the added `servers` — `bridge`, `device`,
 * `notifications`, `update` and `ts` are the lead's own statements about the lead and are not merged.
 *
 * **The navigator used to stay lead-local, and that was the bug (F14).** The reasoning was that a
 * space id is only unique per machine and that a pane carries enough denormalised labels to render
 * the home list without one — both true, and neither an argument for DROPPING the peer's rows. The
 * observable result was that a pack of two default Herdr installs showed one space and one tab,
 * because both machines call theirs `w1` and `w1:t1`; the member's space had no row of its own and
 * every count on the surviving row was the lead's. Host-tagging makes `(host, id)` the identity and
 * the collision impossible, which is the same move `host` already makes for a pane.
 */
export function mergeSnapshot(local: SnapshotResponse, ctx: MergeContext): SnapshotResponse {
  const self = ctx.self.id;
  const peers = ctx.peers.toSorted((a, b) => a.state.memberId.localeCompare(b.state.memberId));

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
    ...peers.flatMap((p) => (p.body?.sessions ?? []).map((s) => Object.assign({}, s, { host: p.state.memberId }))),
  ];

  // The space and tab navigators, host-tagged and unioned — F14. Herdr numbers spaces and tabs PER
  // MACHINE, so two default installs both call theirs `w1` and `w1:t1`. Before this, the lead's own
  // lists were passed through untouched and the peer's rows never appeared at all: the member's
  // space and tab had no row, every count on the surviving row was the lead's, and a pack of two
  // machines with one pane each rendered as one space claiming one pane. The panes routed correctly
  // the whole time, which is why this reads as a counting and rendering fault rather than a link one.
  //
  // The lead's rows keep their order and come first, matching `servers` and `hostRank`; a peer's
  // follow in member-id order, each machine's own ordering preserved inside its block. No id is
  // rewritten — `(host, workspaceId)` is the identity, exactly as `(host, paneId)` already is for a
  // pane, so a pane still joins its space by the id Herdr gave it on the machine it lives on.
  const workspaces: WorkspaceView[] = [
    ...local.workspaces.map((w) => ({ ...w, host: self })),
    ...peers.flatMap((p) => (p.body?.workspaces ?? []).map((w) => Object.assign({}, w, { host: p.state.memberId }))),
  ];
  const tabs: TabView[] = [
    ...local.tabs.map((t) => ({ ...t, host: self })),
    ...peers.flatMap((p) => (p.body?.tabs ?? []).map((t) => Object.assign({}, t, { host: p.state.memberId }))),
  ];

  return {
    ...local,
    workspaces,
    tabs,
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
  return panes.toSorted(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      hostRank(a, b, self) ||
      a.workspaceNumber - b.workspaceNumber ||
      a.paneId.localeCompare(b.paneId),
  );
}

/** Shell panes: same rule minus the status key, mirroring `bridge/state-engine.ts:271`. */
function spaceSorted(panes: PaneWire[], self: string): PaneWire[] {
  return panes.toSorted(
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

function untagWorkspace(w: WorkspaceView): WorkspaceView {
  const { host: _ignored, ...rest } = w;
  return rest;
}

function untagTab(t: TabView): TabView {
  const { host: _ignored, ...rest } = t;
  return rest;
}

/**
 * A space row worth rendering. `workspaceId` is what the phone ADDRESSES by and `number` is what the
 * merged list SORTS by within a host, so a row missing either cannot be shown or navigated to and is
 * dropped rather than defaulted into the switcher — the same rule {@link isPaneWire} applies.
 *
 * `repoRoot`/`isWorktree` are not checked: both are optional by design, and absence is already the
 * closed reading ("no repo here"), so a peer that omits them nests nothing rather than being dropped.
 */
function isWorkspaceView(value: JsonValue | undefined): value is JsonValue & WorkspaceView {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const w: JsonObject = value;
  return typeof w.workspaceId === "string" && w.workspaceId.length > 0 && typeof w.number === "number";
}

/** Same rule for a tab, plus the parent it hangs under — an orphan tab has nothing to render into. */
function isTabView(value: JsonValue | undefined): value is JsonValue & TabView {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const t: JsonObject = value;
  return (
    typeof t.tabId === "string" &&
    t.tabId.length > 0 &&
    typeof t.workspaceId === "string" &&
    t.workspaceId.length > 0 &&
    typeof t.number === "number"
  );
}

function isSessionSummary(value: JsonValue | undefined): value is JsonValue & SessionSummary {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const s: JsonObject = value;
  return typeof s.name === "string" && typeof s.reachable === "boolean";
}

function isPaneWire(value: JsonValue | undefined): value is JsonValue & PaneWire {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const p: JsonObject = value;
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
