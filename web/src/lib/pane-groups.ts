// THE DASHBOARD'S SECOND AXIS: a pane sits under the WORKSPACE it lives in.
//
// `lib/triage.ts` answers "what needs me", and that answer is a MARK on the dashboard (a row's wash,
// a heading's dot, one summary line), never a position (ADR 0063). Where a pane SITS is answered
// here instead, by grouping: one group per workspace, headed by that workspace's name and counted,
// so a row no longer has to repeat an address eighteen times down the page. The workspace is the
// level the operator actually thinks in — it is the project — and a tab is a divider inside it, so a
// group per tab cut one project into three headings that each held two rows. The tab did not disappear: it moved onto the row, on line
// 2, where it tells two rows of one workspace apart and costs no heading.
//
// ── WHAT DECIDES THE ORDER ───────────────────────────────────────────────────
// Groups run by MACHINE first, in the order of the snapshot's `servers` list (the lead leads, then
// peers by member id), then by WORKSPACE NUMBER — the multiplexer's own numbering, the same order
// the space strip and the space navigator use. A crew's two machines therefore never interleave
// their workspaces, which numbering alone would do, because both machines number from 1. A machine
// the caller passes no `servers` for falls back to the order its first pane was met in, which the
// bridge now sends in place order too.
//
// NOTHING HERE READS STATUS (ADR 0063). The machine order used to be the order a machine's first
// pane arrived in, and the bridge sent panes status-first, so a peer whose pane blocked had its
// whole block of groups jump above the lead's. Inside a group, "fixed" orders tabs by number and
// panes by their position in the tab; "bridge" keeps the arrival order, which is now place order.
// A row never moves because a pane changed state.
//
// ── SHELLS SIT WITH THEIR TAB ────────────────────────────────────────────────
// A bare shell is a pane of the tab it is in, so it lands after that tab's agents rather than in a
// trailing pen at the end of the workspace. That is the one place the given order is not preserved
// verbatim, and it is deliberate.
//
// Pure and host-aware, so a crew's two `w1`s are two workspaces (lib/hosts.ts § spaceKey).
import { hostKey, leadHost, primarySession, scopeHostKey, sessionsOnHost } from "./hosts";
import { panePlaceParts } from "./pane-name";
import type { AgentView, ServerSummary, SessionSummary, TabView, WorkspaceView } from "./types";

/**
 * How the rows inside a group run.
 *   "bridge"  the order the lists arrived in (the bridge's place order);
 *   "fixed"   the multiplexer's own, recomputed here: tabs by their number, panes by their position
 *             in the tab, so no arrival order can move a row (agent-list.tsx, agent-sidebar.tsx).
 */
export interface GroupOptions {
  order?: "bridge" | "fixed";
  /** The raw tab list, for the tab numbers "fixed" runs by. A tab not in it sorts after the known ones. */
  tabs?: readonly TabView[] | undefined;
  /**
   * The snapshot's machine list, for the order machines run in: this list's own, the lead first.
   * A host it does not name sorts after the named ones, in the order its first pane was met.
   */
  servers?: readonly ServerSummary[] | undefined;
  /**
   * The snapshot's workspace records (issue #587). When given, a linked git worktree whose repo is
   * also open as a root workspace on the same machine and session folds its panes under that root
   * workspace's group, after the root's own panes, so the workspace filter and the pane list agree
   * with Spaces.
   */
  workspaces?: readonly WorkspaceView[] | undefined;
  /** The view's scope (`?h=` and `?s=`), so a widened (`?all=1`) list matches `workspaces` to the session they came from. */
  scope?: { readonly host?: string; readonly session?: string } | undefined;
  /** The session registry, for resolving the primary session on each machine in a widened (`?all=1`) list. */
  sessions?: readonly SessionSummary[] | undefined;
}

/** The same separator `lib/hosts.ts` composes its keys with: a byte no label may contain. */
const KEY_SEP = "\u0000";

/** One workspace and the panes of it that this list is showing. */
export interface WorkspaceGroup {
  /** `(host, session, workspaceId)` — the only triple that names one workspace in a merged herd. */
  key: string;
  /** The heading's text: the workspace's own name. */
  label: string;
  /** Tab by tab in the order they were met, each tab's agents then that tab's bare shells. */
  panes: AgentView[];
}

/** One tab inside a workspace bucket. Never a heading — only an order. */
interface TabBucket {
  /** 0 for the root workspace's own tabs; 1 for a linked worktree's tabs, so the root leads its group. */
  worktreeRank: number;
  /** The workspace's own order among checkouts in this bucket. */
  spaceOrder: number;
  /** Where this tab was first met in the given lists. */
  seq: number;
  agents: AgentView[];
  shells: AgentView[];
}

interface Bucket {
  key: string;
  label: string;
  /** The machine's place in `servers`, or after them in first-met order — the outermost sort key. */
  hostSeq: number;
  /** The multiplexer's own workspace number — the sort key within one machine. */
  workspaceNumber: number;
  /** Where this workspace was first met, so two workspaces sharing a number still have an order. */
  seq: number;
  spaceSeqs: Map<string, number>;
  tabs: Map<string, TabBucket>;
}

/**
 * A pane's place inside its tab: the multiplexer's own position (`tabPosition`, from the bridge), with
 * the pane id only as a tiebreak for an older peer that sends no position. Neither changes with status.
 */
export const byPlaceInTab = (a: AgentView, b: AgentView) =>
  (a.tabPosition ?? Number.MAX_SAFE_INTEGER) - (b.tabPosition ?? Number.MAX_SAFE_INTEGER) ||
  a.paneId.localeCompare(b.paneId);

/**
 * `(host, session, workspaceId)`. A workspace id is unique only within one session on one machine,
 * exactly as a pane id is (`paneRowKey`), so a widened body holds several workspaces answering to
 * `w1` and only the full address tells them apart. `hostKey` supplies the untagged-is-ambient half
 * of the rule, so a solo un-widened list keys as a pure prefix extension of the bare ids.
 */
export function workspaceGroupKey(pane: AgentView): string {
  return `${hostKey(pane)}${KEY_SEP}${pane.session ?? ""}${KEY_SEP}${pane.workspaceId}`;
}

/**
 * Whether a pane on `host` with `paneSession` (`pane.session`, or `undefined` when unwidened)
 * belongs to the session that `workspaces` on `host` came from.
 *
 * On the lead (or solo), `localSnapshot` reads `workspaces` from `scope.session` when the lead is
 * addressed and from its primary session when a peer is addressed. On a crew peer, `SWEEP_VIEW`
 * (`bridge/crew/merge.ts`) always sweeps `workspaces` from the peer's primary session, while
 * `narrowPeerBody` strips `pane.session` after filtering to `scope.session` — so an untagged pane
 * on an addressed peer belongs to `scope.session`, which matches `workspaces` only when
 * `scope.session` is absent or is that peer's primary session.
 */
function isInWorkspaceMetadataSession(
  host: string,
  paneSession: string | undefined,
  scope: { readonly host?: string; readonly session?: string } | undefined,
  servers: readonly ServerSummary[] | undefined,
  sessions: readonly SessionSummary[] | undefined,
): boolean {
  const lead = leadHost(servers) ?? "";
  const addressed = scopeHostKey(scope ?? {}, servers);
  const primary = primarySession(sessions && sessionsOnHost(sessions, { host }, servers));
  const metaSession = host === lead && host === addressed ? (scope?.session ?? primary) : primary;
  if (paneSession !== undefined) {
    return metaSession !== undefined && paneSession === metaSession;
  }
  if (host !== addressed || scope?.session === undefined) return true;
  if (host === lead) return true;
  return primary !== undefined && scope.session === primary;
}

/**
 * Promote any stored `isolated` preference key (`host\0session\0label`) that names a linked git
 * worktree to its open root workspace's preference key on the same machine and session (issue #587).
 * When an orphan worktree is isolated first and its root repo is opened later, the worktree folds
 * into the root group; promoting the key keeps the root group isolated in both the pane list and
 * `Spaces` rather than dropping the selection as stale on one side.
 */
export function resolveIsolatedPrefKeys(
  isolated: readonly string[],
  { workspaces, scope, servers, sessions }: Pick<GroupOptions, "workspaces" | "scope" | "servers" | "sessions"> = {},
): string[] {
  if (isolated.length === 0 || workspaces === undefined || workspaces.length === 0) return [...isolated];
  const rootByRepo = new Map<string, WorkspaceView>();
  for (const w of workspaces) {
    if (w.repoRoot !== undefined && w.isWorktree === false) {
      const repoKey = `${hostKey(w)}${KEY_SEP}${w.repoRoot}`;
      if (!rootByRepo.has(repoKey)) rootByRepo.set(repoKey, w);
    }
  }
  if (rootByRepo.size === 0) return [...isolated];
  return isolated.map((key) => {
    const firstCut = key.indexOf(KEY_SEP);
    const lastCut = key.lastIndexOf(KEY_SEP);
    if (firstCut === -1 || lastCut === firstCut) return key;
    const host = key.slice(0, firstCut);
    const session = key.slice(firstCut + 1, lastCut);
    const label = key.slice(lastCut + 1);
    if (!isInWorkspaceMetadataSession(host, session === "" ? undefined : session, scope, servers, sessions)) {
      return key;
    }
    const match = workspaces.find(
      (w) => hostKey(w) === host && (w.label.trim() || w.workspaceId) === label,
    );
    if (match === undefined || match.isWorktree !== true || match.repoRoot === undefined) return key;
    const parent = rootByRepo.get(`${host}${KEY_SEP}${match.repoRoot}`);
    if (parent === undefined) return key;
    return `${host}${KEY_SEP}${session}${KEY_SEP}${parent.label.trim() || parent.workspaceId}`;
  });
}

/**
 * Bucket a herd by workspace. Every pane handed in appears exactly once, empty groups do not exist,
 * and a caller that hands the same two lists twice gets the same groups in the same order.
 *
 * The caller decides what is IN the two lists: the dashboard withholds the panes it has already
 * listed under "needs you", so a group counts the rows actually under its heading and a workspace
 * whose every pane is urgent gets no heading at all.
 */
export function groupPanesByWorkspace(
  agents: readonly AgentView[],
  shellPanes: readonly AgentView[] = [],
  { order = "bridge", tabs, servers, workspaces, scope, sessions }: GroupOptions = {},
): WorkspaceGroup[] {
  // A tab's own number, host-qualified the way panePlaceParts matches (an id is unique per machine).
  const tabNumber = (pane: AgentView): number => {
    const known = tabs?.find((tv) => tv.tabId === pane.tabId && (tv.host === undefined || tv.host === pane.host));
    return known?.number ?? Number.MAX_SAFE_INTEGER;
  };
  // Issue #587: map each linked git worktree to the open workspace holding its repo root on the same
  // machine, using the same `repoRoot` + `isWorktree` predicate `nestWorktrees` and `isolateSpaces`
  // use (lib/spaces.ts). An orphan worktree whose repo is not open has no entry here and stays its
  // own group. `minNumberBySpace` records the lowest workspace number among a root and all its open
  // worktrees, so even an empty worktree with a lower number pulls its root group to the same
  // position `nestWorktrees` gives it.
  const parentBySpace = new Map<string, WorkspaceView>();
  const minNumberBySpace = new Map<string, number>();
  if (workspaces !== undefined && workspaces.length > 0) {
    const rootByRepo = new Map<string, WorkspaceView>();
    for (const w of workspaces) {
      if (w.repoRoot !== undefined && w.isWorktree === false) {
        const host = hostKey(w);
        const repoKey = `${host}${KEY_SEP}${w.repoRoot}`;
        if (!rootByRepo.has(repoKey)) {
          rootByRepo.set(repoKey, w);
          minNumberBySpace.set(`${host}${KEY_SEP}${w.workspaceId}`, w.number);
        }
      }
    }
    for (const w of workspaces) {
      if (w.repoRoot === undefined || w.isWorktree !== true) continue;
      const host = hostKey(w);
      const parent = rootByRepo.get(`${host}${KEY_SEP}${w.repoRoot}`);
      if (parent !== undefined) {
        parentBySpace.set(`${host}${KEY_SEP}${w.workspaceId}`, parent);
        const parentSpaceKey = `${host}${KEY_SEP}${parent.workspaceId}`;
        const prev = minNumberBySpace.get(parentSpaceKey) ?? parent.number;
        if (w.number < prev) minNumberBySpace.set(parentSpaceKey, w.number);
      }
    }
  }
  const byKey = new Map<string, Bucket>();
  // Seeded from `servers`, so a named machine's rank never depends on which pane arrived first. The
  // lead's own panes may arrive untagged (a solo body), which `hostKey` reads as "".
  const hostSeqs = new Map<string, number>(servers?.map((sv, i) => [sv.id, i]));
  const leadRank = servers?.findIndex((sv) => sv.isLead) ?? -1;
  if (leadRank >= 0 && !hostSeqs.has("")) hostSeqs.set("", leadRank);
  let workspaceSeq = 0;
  let tabSeq = 0;

  const tabOf = (pane: AgentView): TabBucket => {
    const host = hostKey(pane);
    const inMetaSession = isInWorkspaceMetadataSession(host, pane.session, scope, servers, sessions);
    const parent = inMetaSession ? parentBySpace.get(`${host}${KEY_SEP}${pane.workspaceId}`) : undefined;
    const rootWorkspaceId = parent !== undefined ? parent.workspaceId : pane.workspaceId;
    const groupMinNumber = inMetaSession
      ? minNumberBySpace.get(`${host}${KEY_SEP}${rootWorkspaceId}`)
      : undefined;
    const effectiveNumber =
      groupMinNumber !== undefined ? Math.min(groupMinNumber, pane.workspaceNumber) : pane.workspaceNumber;
    const key =
      parent !== undefined
        ? `${host}${KEY_SEP}${pane.session ?? ""}${KEY_SEP}${parent.workspaceId}`
        : workspaceGroupKey(pane);
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      let hostSeq = hostSeqs.get(host);
      if (hostSeq === undefined) {
        hostSeq = (servers?.length ?? 0) + hostSeqs.size;
        hostSeqs.set(host, hostSeq);
      }
      bucket = {
        key,
        // The workspace's own name, by the one place rule (lib/pane-name.ts) — the same string the
        // space strip and the crumb use, so the heading and the strip can never disagree.
        label: parent !== undefined ? parent.label.trim() || parent.workspaceId : panePlaceParts(pane).space,
        hostSeq,
        workspaceNumber: effectiveNumber,
        seq: workspaceSeq++,
        spaceSeqs: new Map(),
        tabs: new Map(),
      };
      byKey.set(key, bucket);
    } else if (effectiveNumber < bucket.workspaceNumber) {
      bucket.workspaceNumber = effectiveNumber;
    }
    let spaceSeq = bucket.spaceSeqs.get(pane.workspaceId);
    if (spaceSeq === undefined) {
      spaceSeq = bucket.spaceSeqs.size;
      bucket.spaceSeqs.set(pane.workspaceId, spaceSeq);
    }
    const tabKey = `${pane.workspaceId}${KEY_SEP}${pane.tabId}`;
    let tab = bucket.tabs.get(tabKey);
    if (tab === undefined) {
      tab = {
        worktreeRank: parent !== undefined && pane.workspaceId !== parent.workspaceId ? 1 : 0,
        spaceOrder: order === "fixed" ? pane.workspaceNumber * 1e6 + spaceSeq : spaceSeq,
        seq: order === "fixed" ? tabNumber(pane) * 1e6 + tabSeq++ : tabSeq++,
        agents: [],
        shells: [],
      };
      bucket.tabs.set(tabKey, tab);
    }
    return tab;
  };

  for (const a of agents) tabOf(a).agents.push(a);
  for (const s of shellPanes) tabOf(s).shells.push(s);

  return [...byKey.values()]
    .toSorted(
      (a, b) =>
        a.hostSeq - b.hostSeq || a.workspaceNumber - b.workspaceNumber || a.seq - b.seq,
    )
    .map((g) => ({
      key: g.key,
      label: g.label,
      panes: [...g.tabs.values()]
        .toSorted((a, b) => a.worktreeRank - b.worktreeRank || a.spaceOrder - b.spaceOrder || a.seq - b.seq)
        .flatMap((tab) =>
          order === "fixed"
            ? tab.agents.toSorted(byPlaceInTab).concat(tab.shells.toSorted(byPlaceInTab))
            : tab.agents.concat(tab.shells),
        ),
    }));
}
