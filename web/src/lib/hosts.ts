// The host dimension, as data. lib/scope.ts owns ADDRESSING (what goes in the URL and on the wire);
// this module owns everything derived from the snapshot's `servers` array: is this even a pack, who
// leads it, what is a host called, and how do you key something per host.
//
// **The whole module answers "no pack" for a solo snapshot.** `servers` is optional-and-absent
// (PACK_PROTOCOL.md §11), so `isMultiHost(undefined)` is false, `hostKey({})` is `""`, and every
// host-qualified key degrades to a pure prefix of what shipped. That is what lets a solo install
// render byte-identically without a single `if (pack)` in a component — the hide rule is data, not a
// mode flag.
//
// React-free on purpose (same reason as lib/scope.ts): the pieces that need React live in
// components/pack-provider.tsx.

import type { Scope } from "./scope";
import type { AgentView, ServerSummary, SessionSummary } from "./types";

// NUL-joined, exactly as lib/scope.ts joins its cache keys: a member id and a workspace id are both
// opaque strings, and a separator either of them could contain would make two different pairs share
// a key.
const KEY_SEP = "\u0000";

/** The grouping-key component for a host: the member id, or `""` for "untagged" (i.e. solo). */
export function hostKey(v: { host?: string } | undefined): string {
  return v?.host ?? "";
}

/**
 * The key for anything scoped to one space on one machine. Herdr workspace ids (`w1`) are only
 * unique WITHIN one host, so two machines that both expose `w1` would otherwise merge their triage
 * dots and their last-seen times into one space row — silently, and only on a pack.
 */
export function spaceKey(host: string | undefined, workspaceId: string): string {
  return `${host ?? ""}${KEY_SEP}${workspaceId}`;
}

/** The same key, read off a pane. */
export function paneSpaceKey(pane: { host?: string; workspaceId: string }): string {
  return spaceKey(pane.host, pane.workspaceId);
}

/**
 * A pane's identity as a ROW in a list — the full `(host, session, paneId)` triple, which is the
 * only thing unique about it.
 *
 * This is a React `key`, and a React key is not decoration. A pane id is unique only within one
 * session on one machine, so a merged or widened list holds several rows that answer to `w1:p1`.
 * Keyed by the id alone, React recycles one row's element for another's between polls: the card you
 * are looking at keeps its position and quietly acquires a different row's `onClick`. On a list whose
 * whole purpose is "tap the thing that needs you", that is a tap landing in another terminal.
 *
 * Untagged panes degrade to `"\0\0" + paneId`, a pure prefix extension of the bare id, so a solo
 * un-widened list keys exactly as it always did.
 */
export function paneRowKey(pane: { host?: string; session?: string; paneId: string }): string {
  return `${hostKey(pane)}${KEY_SEP}${pane.session ?? ""}${KEY_SEP}${pane.paneId}`;
}

/**
 * True when the snapshot describes more than one machine — the ONE predicate that decides whether
 * any host chrome renders at all. Absent `servers` (solo, i.e. every install today) is false; so is
 * a one-entry array, which a lead with zero live peers can legitimately report.
 */
export function isMultiHost(servers: readonly ServerSummary[] | undefined): boolean {
  return (servers?.length ?? 0) > 1;
}

/** The pack's lead — the machine the phone is actually connected to. Undefined when solo. */
export function leadHost(servers: readonly ServerSummary[] | undefined): string | undefined {
  return servers?.find((s) => s.isLead)?.id;
}

/**
 * The `ServerSummary` a host id refers to. An absent id means the lead (`?h=` absent = the lead,
 * lib/scope.ts), so this resolves it the same way the bridge does.
 */
export function serverFor(
  servers: readonly ServerSummary[] | undefined,
  host: string | undefined,
): ServerSummary | undefined {
  if (!servers) return undefined;
  return host === undefined ? servers.find((s) => s.isLead) : servers.find((s) => s.id === host);
}

/**
 * The operator-facing name for a host id. Falls back to the id itself for a host the snapshot does
 * not list — a departed member must render as itself, never be silently relabelled or dropped
 * (lib/scope.ts's `normalizeHost` refuses the same rewrite for the same reason).
 */
export function hostName(
  servers: readonly ServerSummary[] | undefined,
  host: string | undefined,
): string | undefined {
  const found = serverFor(servers, host);
  if (found) return found.name || found.id;
  return host;
}

/**
 * The host a surface addressed by the AMBIENT scope is actually writing to: the scope's host, or —
 * on a pack — the lead, which is what an absent `?h=` means. Used by the write surfaces whose
 * subject carries no host of its own (a tab, a new space): they act on the machine you are pointed
 * at, and on a pack that machine has to be named.
 */
export function ambientHost(
  servers: readonly ServerSummary[] | undefined,
  host: string | undefined,
): string | undefined {
  return host ?? leadHost(servers);
}

/**
 * The scope to OPEN a pane with: the pane's own host, never the ambient one.
 *
 * This is the milestone's unforgivable-failure guard in one function. A pane id is unique only
 * within one machine, so opening a peer's row while the URL still says "lead" would point every
 * read, every key press and every reply at the lead's identically-named pane. The lead's own id
 * normalises back to `undefined` so a lead pane keeps producing today's bare URL.
 */
export function paneScope<S extends { host?: string; session?: string }>(
  scope: S,
  pane: { host?: string; session?: string } | undefined,
  servers: readonly ServerSummary[] | undefined,
  sessions?: readonly SessionSummary[],
): Scope {
  // BOTH halves of the address come from the PANE when the pane names them, and from the ambient
  // scope only when it does not. A pane names its session exactly on a widened body (`?all=1`), and
  // that is the case this exists for: the widened list holds panes from several sessions, their ids
  // collide, and opening one with the ambient session would point every read, key press and reply at
  // the identically-numbered pane in whichever session the URL happened to be on.
  //
  // Each half normalises its own "today" value back to undefined — the lead's id, and the primary
  // session's name — so a row opened from the widened list produces the SAME url it would have
  // produced from the narrow one. That is what keeps the breadth out of the address: you cannot tell
  // from a pane url which view you came from, and nothing downstream has to care.
  // Nothing to say: the pane names neither dimension, which is every pane on an un-widened solo
  // read. Return the SCOPE ITSELF, not a copy of it — `data.scope` is interned for referential
  // stability (lib/scope.ts) and handing back a fresh object would quietly undo that for every
  // caller that compares scopes by identity.
  if (pane?.host === undefined && pane?.session === undefined) return scope;
  const host = pane?.host === undefined ? scope.host : normalizeToday(pane.host, leadHost(servers));
  const session =
    pane?.session === undefined
      ? scope.session
      : // Resolved WITHIN the row's own machine. `sessions` is a merged registry on a pack and holds
        // one primary PER HOST, so asking it flatly would compare this row's session name against
        // whichever machine's primary happened to sort first — and normalise away a name that is
        // only primary somewhere else.
        normalizeToday(pane.session, primarySession(sessionsOnHost(sessions ?? [], { host }, servers)));
  return { host, session };
}

/** `value`, unless it is the dimension's implicit default — which is spelled as an absent param. */
function normalizeToday(value: string, today: string | undefined): string | undefined {
  return value === today ? undefined : value;
}

/**
 * The registry name of the primary session — the one `?s=` is absent for. `undefined` when the
 * bridge sent no session list (older bridge, or a body that never carried one), which makes
 * {@link normalizeToday} a no-op rather than a wrong guess: an un-normalised name still addresses
 * the right session, it just spells it out in the url.
 */
export function primarySession(
  sessions: readonly SessionSummary[] | undefined,
): string | undefined {
  return sessions?.find((s) => s.isPrimary)?.name;
}

/**
 * The {@link hostKey} the CURRENT scope resolves to: its `?h=`, or the lead's id when absent. This
 * is the value a pane's own `host` has to equal for the pane to be the one you are addressing.
 */
export function scopeHostKey(
  scope: { host?: string },
  servers: readonly ServerSummary[] | undefined,
): string {
  return scope.host ?? leadHost(servers) ?? "";
}

/**
 * Find a pane by id WITHIN the scope's host AND session.
 *
 * A NOTE ON MIXED BODIES, because one exists today. On a pack the lead merges peers' panes in after
 * assembling its own, and a peer is never asked to widen yet — so a widened body on a pack holds
 * TAGGED local panes and UNTAGGED peer ones. That is safe rather than lucky: a peer's panes carry a
 * `host`, the host predicate separates them first, and only one session per peer is represented, so
 * the untagged-matches-anything rule cannot reach across a machine. When the sweep learns to widen,
 * peer panes gain their tags and the mixed case goes away. `w1:p1` exists on every machine in the pack
 * and again in every named Herdr session on each of them, so a lookup by id alone over a merged or
 * widened list can return a different pane entirely — and the pane view would then render that
 * pane's space, tab and cwd while typing into this one's terminal.
 *
 * BOTH dimensions use the same rule, and it is the rule that keeps today's lookup exactly today's:
 * an UNTAGGED pane matches any scope. A pane carries a host only on a merged pack body and a session
 * only on a widened one, so on every un-widened solo read this is the id comparison it has always
 * been. It is also why the bridge tags ALL panes or none when it widens (bridge/sessions.ts
 * `widenedPanes`): a body where only the non-primary panes were tagged would let an untagged primary
 * pane answer a lookup for a named session's identically-numbered one.
 */
export function findPane<T extends { paneId: string; host?: string; session?: string }>(
  panes: readonly T[],
  paneId: string,
  scope: { host?: string; session?: string },
  servers: readonly ServerSummary[] | undefined,
  sessions?: readonly SessionSummary[],
): T | undefined {
  const wantHost = scopeHostKey(scope, servers);
  // The session the scope RESOLVES to: its `?s=`, or the primary's registry name when absent —
  // because an absent `?s=` and the primary's own name are the same session, and a tagged pane
  // always spells it out. `undefined` here means the body named no sessions at all, which is also
  // the only body in which no pane can be tagged, so the comparison below is skipped rather than
  // failed. Never guess a name: a wrong guess is a lookup that silently finds nothing.
  const wantSession =
    scope.session ??
    // Per host, for the reason `paneScope` resolves it per host: a merged registry holds one primary
    // per machine, and the flat first match is whichever one sorted first.
    primarySession(sessions && sessionsOnHost(sessions, scope, servers));
  return panes.find(
    (p) =>
      p.paneId === paneId &&
      (p.host === undefined || hostKey(p) === wantHost) &&
      (p.session === undefined || wantSession === undefined || p.session === wantSession),
  );
}

/**
 * The sessions belonging to the scope's host — what the session switcher lists.
 *
 * Sessions are a PER-HOST registry, so a merged snapshot can hold two "default"s. A flat list would
 * offer the same name twice with nothing to tell them apart, and picking the wrong one would move
 * you to another machine through a control that says it changes sessions. Two dimensions, two
 * switchers, each listing only what it owns.
 */
export function sessionsOnHost<T extends { host?: string }>(
  sessions: readonly T[],
  scope: { host?: string },
  servers: readonly ServerSummary[] | undefined,
): T[] {
  const want = scopeHostKey(scope, servers);
  return sessions.filter((s) => s.host === undefined || hostKey(s) === want);
}

/** The two pane lists, narrowed to one address. Named so the return type is a contract, not a shape. */
export interface AmbientPanes<T> {
  agents: T[];
  shellPanes: T[];
}

/**
 * The panes belonging to the AMBIENT address — the `(host, session)` the URL names — out of a body
 * that may hold more.
 *
 * The space navigator needs this and the triage lists must not have it. The lists are the whole
 * point of widening: one "what needs me?" across every session. The navigator is a TREE, and its
 * keys (`spaceKey`) carry a host and no session, because Herdr workspace ids collide across sessions
 * exactly as they collide across machines. Fed a widened body it would paint another session's
 * blocked dot and recency onto the ambient space of the same number, and drilling in would show a
 * space with nothing blocked in it — a screen contradicting itself.
 *
 * Both predicates are the same "untagged is ambient" rule the rest of this module uses, so on every
 * un-widened body every pane passes and the arrays come back BY IDENTITY, not as copies — worth
 * stating, because this runs on every poll and its result is memoised into props. A fresh array per
 * tick would re-render the space navigator on every poll of an un-widened dashboard, which is every
 * dashboard that exists today.
 */
export function ambientPanes<T extends { host?: string; session?: string }>(
  agents: readonly T[],
  shellPanes: readonly T[],
  scope: { host?: string; session?: string },
  servers: readonly ServerSummary[] | undefined,
  sessions: readonly SessionSummary[] | undefined,
): AmbientPanes<T> {
  const wantHost = scopeHostKey(scope, servers);
  const wantSession =
    scope.session ?? primarySession(sessions && sessionsOnHost(sessions, scope, servers));
  const here = (p: T): boolean =>
    (p.host === undefined || hostKey(p) === wantHost) &&
    (p.session === undefined || wantSession === undefined || p.session === wantSession);
  // The all-pass branch returns the SAME array, not a copy of it. This runs on every poll and its
  // result is memoised into a component's props; a fresh array each time would re-render the space
  // navigator on every tick of an un-widened dashboard, which is every dashboard that exists today.
  // SAFETY: the caller owns these arrays and this function neither writes to them nor hands the
  // mutable alias anywhere that does — `SpaceOverview` only reads. Widening `readonly T[]` to `T[]`
  // here is the price of returning the input BY IDENTITY on the all-pass branch, which is the whole
  // point: see the header.
  const pick = (panes: readonly T[]): T[] =>
    panes.every(here) ? (panes as T[]) : panes.filter(here);
  return { agents: pick(agents), shellPanes: pick(shellPanes) };
}

/**
 * The space and tab rows belonging to the AMBIENT host — the `?h=` the URL names, or the lead.
 *
 * The lead's merged snapshot now host-tags `workspaces` and `tabs` the way it has always tagged
 * panes and sessions, because Herdr numbers spaces PER MACHINE: two default installs both call
 * theirs `w1` and `w1:t1`, and an untagged merge collapsed them into one row carrying one machine's
 * counts. Tagged, the rows no longer collide — and the navigator, which is a TREE of one machine and
 * not a herd-wide list, narrows to the address the URL is on, exactly as {@link ambientPanes} does
 * for the panes it will be drawn beside. Switching host switches the spaces with it.
 *
 * Same "untagged is ambient" rule as everything else here, so a solo body — where no row carries a
 * host at all — passes wholesale and comes back BY IDENTITY, not as a copy. That matters on the poll
 * path: a fresh array per tick would re-render the space navigator on every poll of every solo
 * dashboard that exists today.
 */
export function ambientSpaces<T extends { host?: string }>(
  rows: readonly T[],
  scope: { host?: string },
  servers: readonly ServerSummary[] | undefined,
): T[] {
  const want = scopeHostKey(scope, servers);
  const here = (r: T): boolean => r.host === undefined || hostKey(r) === want;
  // SAFETY: the caller owns this array and this function neither writes to it nor hands the mutable
  // alias anywhere that does. Widening `readonly T[]` to `T[]` is the price of the identity return.
  return rows.every(here) ? (rows as T[]) : rows.filter(here);
}

/** Per-host agent counts, derived from the merged snapshot (a `ServerSummary` carries none). */
export interface HostCounts {
  agents: number;
  working: number;
  blocked: number;
}

const ZERO: HostCounts = { agents: 0, working: 0, blocked: 0 };

/**
 * Count agents per host in ONE pass, keyed by {@link hostKey}. Derived from the rows on screen
 * rather than reported per host, so an unreachable member's last-good panes still count (§10.2: a
 * peer's panes never vanish) instead of the switcher claiming it holds nothing.
 */
export function hostCounts(agents: readonly AgentView[]): Map<string, HostCounts> {
  const byHost = new Map<string, HostCounts>();
  for (const a of agents) {
    const key = hostKey(a);
    const held = byHost.get(key) ?? { ...ZERO };
    held.agents += 1;
    if (a.status === "working") held.working += 1;
    if (a.status === "blocked") held.blocked += 1;
    byHost.set(key, held);
  }
  return byHost;
}

/** Counts for one server, zeroed when it holds nothing. */
export function countsFor(counts: Map<string, HostCounts>, host: string): HostCounts {
  return counts.get(host) ?? ZERO;
}
