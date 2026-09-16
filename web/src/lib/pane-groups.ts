// THE DASHBOARD'S SECOND AXIS: a pane sits under the WORKSPACE it lives in.
//
// `lib/triage.ts` answers "what needs me", and that answer stays on top of the dashboard because it
// is the dashboard's job. Everything it does NOT flag is answered here instead, by grouping: one
// group per workspace, headed by that workspace's name and counted, so a row no longer has to repeat
// an address eighteen times down the page. The workspace is the level the operator actually thinks
// in — it is the project — and a tab is a divider inside it, so a group per tab cut one project into
// three headings that each held two rows. The tab did not disappear: it moved onto the row, on line
// 2, where it tells two rows of one workspace apart and costs no heading.
//
// ── WHAT DECIDES THE ORDER ───────────────────────────────────────────────────
// Groups run by MACHINE first, in the order the bridge sent them (the lead leads), then by WORKSPACE
// NUMBER — the multiplexer's own numbering, the same order the space strip and the space navigator
// use. A crew's two machines therefore never interleave their workspaces, which numbering alone
// would do, because both machines number from 1.
//
// Inside a group the bridge's own arrangement is kept: the tabs in the order they were first met,
// and the panes of a tab in the order they arrived. That is the rule `triage()` already keeps for a
// bucket — the bridge sends one stable arrangement (status, workspace, tab, position in the tab) and
// it is the arrangement the operator made at the desk. A row therefore only ever moves when it
// changes GROUP, never because a clock ticked.
//
// ── SHELLS SIT WITH THEIR TAB ────────────────────────────────────────────────
// A bare shell is a pane of the tab it is in, so it lands after that tab's agents rather than in a
// trailing pen at the end of the workspace. That is the one place the given order is not preserved
// verbatim, and it is deliberate.
//
// Pure and host-aware, so a crew's two `w1`s are two workspaces (lib/hosts.ts § spaceKey).
import { hostKey } from "./hosts";
import { panePlaceParts } from "./pane-name";
import type { AgentView, TabView } from "./types";

/**
 * How the rows inside a group run.
 *   "bridge"  the order the lists arrived in (the bridge's: status first), as shipped;
 *   "fixed"   the multiplexer's own: tabs by their number, panes by id inside a tab, so a status
 *             change never moves a row (the dashboard trial's variant 5, agent-list.tsx).
 */
export interface GroupOptions {
  order?: "bridge" | "fixed";
  /** The raw tab list, for the tab numbers "fixed" runs by. A tab not in it sorts after the known ones. */
  tabs?: readonly TabView[];
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
  /** Where this tab was first met in the given lists. */
  seq: number;
  agents: AgentView[];
  shells: AgentView[];
}

interface Bucket {
  key: string;
  label: string;
  /** Where this pane's machine was first met — the outermost sort key. */
  hostSeq: number;
  /** The multiplexer's own workspace number — the sort key within one machine. */
  workspaceNumber: number;
  /** Where this workspace was first met, so two workspaces sharing a number still have an order. */
  seq: number;
  tabs: Map<string, TabBucket>;
}

/**
 * `(host, session, workspaceId)`. A workspace id is unique only within one session on one machine,
 * exactly as a pane id is (`paneRowKey`), so a widened body holds several workspaces answering to
 * `w1` and only the full address tells them apart. `hostKey` supplies the untagged-is-ambient half
 * of the rule, so a solo un-widened list keys as a pure prefix extension of the bare ids.
 */
/**
 * A pane's place inside its tab: the multiplexer's own position (`tabPosition`, from the bridge), with
 * the pane id only as a tiebreak for an older peer that sends no position. Neither changes with status.
 */
const byId = (a: AgentView, b: AgentView) =>
  (a.tabPosition ?? Number.MAX_SAFE_INTEGER) - (b.tabPosition ?? Number.MAX_SAFE_INTEGER) ||
  a.paneId.localeCompare(b.paneId);

export function workspaceGroupKey(pane: AgentView): string {
  return `${hostKey(pane)}${KEY_SEP}${pane.session ?? ""}${KEY_SEP}${pane.workspaceId}`;
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
  { order = "bridge", tabs }: GroupOptions = {},
): WorkspaceGroup[] {
  // A tab's own number, host-qualified the way panePlaceParts matches (an id is unique per machine).
  const tabNumber = (pane: AgentView): number => {
    const known = tabs?.find((tv) => tv.tabId === pane.tabId && (tv.host === undefined || tv.host === pane.host));
    return known?.number ?? Number.MAX_SAFE_INTEGER;
  };
  const byKey = new Map<string, Bucket>();
  const hostSeqs = new Map<string, number>();
  let workspaceSeq = 0;
  let tabSeq = 0;

  const tabOf = (pane: AgentView): TabBucket => {
    const key = workspaceGroupKey(pane);
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      const host = hostKey(pane);
      let hostSeq = hostSeqs.get(host);
      if (hostSeq === undefined) {
        hostSeq = hostSeqs.size;
        hostSeqs.set(host, hostSeq);
      }
      bucket = {
        key,
        // The workspace's own name, by the one place rule (lib/pane-name.ts) — the same string the
        // space strip and the crumb use, so the heading and the strip can never disagree.
        label: panePlaceParts(pane).space,
        hostSeq,
        workspaceNumber: pane.workspaceNumber,
        seq: workspaceSeq++,
        tabs: new Map(),
      };
      byKey.set(key, bucket);
    }
    let tab = bucket.tabs.get(pane.tabId);
    if (tab === undefined) {
      tab = { seq: order === "fixed" ? tabNumber(pane) * 1e6 + tabSeq++ : tabSeq++, agents: [], shells: [] };
      bucket.tabs.set(pane.tabId, tab);
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
        .toSorted((a, b) => a.seq - b.seq)
        .flatMap((tab) =>
          order === "fixed"
            ? tab.agents.toSorted(byId).concat(tab.shells.toSorted(byId))
            : tab.agents.concat(tab.shells),
        ),
    }));
}
