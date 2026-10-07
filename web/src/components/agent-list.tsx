import { Inbox, KeyRound, WifiOff } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { clockTime } from "@/lib/format";
import { useMuxCapability } from "@/lib/mux-capability";
import { SectionHeader } from "@/components/section-header";
import { ListGroup } from "@/components/ui/list-group";
import { groupPanesByWorkspace, type WorkspaceGroup } from "@/lib/pane-groups";
import { StatusCounts, StatusSummaryLine } from "@/components/status-counts";
import { ATTENTION, bucketOf, triage, worstTriage } from "@/lib/triage";
import { groupHost, pinnedRows, shownGroups, stripEntries } from "@/lib/dash-view";
import type { AgentView, BridgeStatus, ServerSummary, SessionSummary, TabView } from "@/lib/types";
import { paneRowKey, paneScope } from "@/lib/hosts";
import { machinesHiddenFrom } from "@/lib/hidden-machines";
import { pinMatcher, type Pin } from "@/lib/pins";
import { inRankOrder, type PaneOrder } from "@/lib/pane-order";
import { NeedsYouSwitch } from "@/components/needs-you-switch";
import { PaneOrderSelect, WorkspaceSelect } from "@/components/dash-selects";
import { useFrozenRanks } from "@/hooks/use-frozen-ranks";
import { showsPinHint, usePinHintRetired } from "@/lib/pin-hint";
import type { Scope } from "@/lib/scope";
import { tabCreateKey } from "@/hooks/use-spaces";
import { AgentCard } from "./agent-card";
import { PinHint } from "./pin-hint";
import { WorkspaceNewTab } from "./workspace-new-tab";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useLocale } from "@/hooks/use-locale";

interface AgentListProps {
  agents: AgentView[];
  /**
   * Bare shell panes. They join their own workspace's group, after that tab's agents — a shell is a
   * pane of the tab it sits in, not a species that deserves a pen of its own (lib/pane-groups.ts).
   * Omit and the list is agents alone, exactly as it was.
   */
  shellPanes?: AgentView[];
  bridge?: BridgeStatus | undefined;
  /**
   * Open a row. Takes the PANE, not its id: `w1:p1` names a different terminal on every machine in a
   * crew, and this list is one herd across all of them — an id alone cannot say which row was tapped.
   */
  onOpen: (pane: AgentView, row?: HTMLElement) => void;
  /** A row's glide key, its pane's path (lib/glide.ts, the `pane` pair). Omit and no row glides. */
  glideKeyOf?: (pane: AgentView) => string;
  /** The finger landed on a row (lib/pane-prefetch.ts). */
  onPress?: (pane: AgentView) => void;
  /** Show the "no agents" placeholder when the herd is empty (default true). */
  emptyState?: boolean;
  /**
   * The snapshot on screen is stale — the last fetch failed, or this is a cold boot rendering from the
   * write-through cache. An EMPTY herd then means "we don't know", never "nothing is running", so the
   * placeholder must not claim the latter.
   */
  error?: boolean;
  /**
   * The bridge refused this device for want of pairing (lib/pairing.ts latch). Reads need the token
   * (ADR 0086), so a cold open on an unpaired phone has no herd at all, and the placeholder then names
   * pairing rather than a lost connection: the bridge answered, it asked to be paired.
   */
  notPaired?: boolean;
  /** When the stale data was fetched, for the "last seen HH:MM" half of the disconnected placeholder. */
  lastSeenAt?: number;
  /**
   * The herd is the SAVED COPY (M46 spec 10, `HomeData.stale`): every row dims and says its status in
   * the past tense, and the summary line dims with them. The rows stay tappable; the pane they open
   * draws its own saved copy.
   */
  stale?: boolean;
  /** The raw tab list, for the multiplexer's own tab order inside a workspace. */
  tabs?: readonly TabView[];
  /** The snapshot's machine list, for the order machines run in: the lead first (lib/pane-groups.ts). */
  servers?: readonly ServerSummary[] | undefined;
  /**
   * The workspace heading's "+" (M40/03, issue 290): a new tab in that workspace, on the heading's
   * own machine and session. Omit and no heading carries one; every strong heading still reserves
   * the "+"'s height, so its presence never moves a row.
   */
  newTab?: HeadingNewTab;
  /**
   * The workspace filter the select on top drives, per device (hooks/use-dash-prefs.ts). `isolated`
   * shows one workspace alone; `hidden` drops workspaces from the list while their options stay in
   * the select, marked hidden, still carrying their state in words, so a hidden workspace that needs
   * you is never silent. Keys from `workspacePrefKey` (machine, session, workspace name). Omit both and the list shows everything.
   */
  isolated?: string | null;
  hidden?: readonly string[];
  /** Pick a workspace in the select: isolate it, or clear the filter (null). */
  onIsolate?: (key: string | null) => void;
  /** Flip a workspace's hidden state. The select calls it for each hidden workspace on "Show hidden workspaces". */
  onToggleHidden?: (key: string) => void;
  /**
   * The machines this device leaves off the dashboard, as STORED (lib/hidden-machines.ts, issue
   * #288). The list never hides `addressedHost`, and an id `servers` does not list filters nothing.
   * A hidden machine's workspace groups leave the list on every tab, and its workspaces give way to one
   * "Show <machine>'s panes" option in the select. Pins and isolate still win. On a solo list, nothing. Omit and
   * the list renders as it did.
   */
  hiddenMachines?: readonly string[];
  /** The machine the dashboard addresses, the scope's `?h=`: undefined is the lead. It always shows. */
  addressedHost?: string | undefined;
  /** Pick a hidden machine's "Show <machine>'s panes" option: show that machine again. */
  onShowMachine?: (host: string) => void;
  /**
   * The "needs you" switch (issue 270, ADR 0066; the old Focus tab, now a switch by ADR 0085): a group
   * shows only its panes that need you, and a group with none is dropped. A filter, never a sort. The
   * workspace select, the summary line and every heading's counts still count ALL panes, so the filter never
   * understates the herd.
   */
  needsYouOnly?: boolean;
  /**
   * Flip the needs-you switch. Given, the switch is drawn at the right end of the summary line;
   * withheld, it is not, and the list keeps whatever `needsYouOnly` says.
   */
  onNeedsYouOnlyChange?: (on: boolean) => void;
  /**
   * The Changes tab: draw its own body in place of the pane groups, from the workspaces the select
   * leaves shown. The summary line and the select row above stay exactly where they were. The Crew tab does
   * not come through here at all: it lists machines, so the dashboard draws it without this list and
   * with none of its pane chrome (ADR 0085).
   */
  renderBody?: (shown: readonly WorkspaceGroup[]) => ReactNode;
  /**
   * This device's pins (lib/pins.ts, ADR 0070). A pinned pane leads every view in a Pinned group
   * under the summary line, in place order, whatever the workspace filter and the needs-you switch say,
   * and leaves its workspace group. Omit, or pass none, and the list renders as it did.
   */
  pins?: readonly Pin[];
  /**
   * Which way the rows run (lib/pane-order.ts, ADR 0071): `place` is the dashboard as it always was,
   * `activity` and `cache` fold the workspace groups into ONE ranked list. The reading is taken once
   * and held (hooks/use-frozen-ranks.ts). Omit and the list runs in place order.
   */
  order?: PaneOrder;
  /**
   * Store a new order. Given, the order select is drawn at the right of the workspace select on the
   * Dashboard; withheld, it is not, and the list keeps whatever `order` says.
   */
  onOrderChange?: (order: PaneOrder) => void;
  /** A hold on a pane row: open that pane's actions sheet. Omit and the rows have no hold. */
  onHold?: (pane: AgentView) => void;
  /**
   * After a pin or unpin moved a row: scroll that row into view and focus it in its new place, once
   * per new object. A row the act took off the list (an idle pane unpinned with the needs-you switch on) hands focus to
   * the summary line instead, never to `body`.
   */
  reveal?: { rowKey: string } | null;
}

/** What a workspace heading's "+" needs from the route (AgentListProps.newTab). */
export interface HeadingNewTab {
  /** The ambient scope: the address a pane that names no machine or session falls back to. */
  scope: Scope;
  /** The session registry, so a widened list's pane resolves its own session (lib/hosts.ts). */
  sessions?: readonly SessionSummary[] | undefined;
  /** The tab creates in flight, keyed by `tabCreateKey` (hooks/use-spaces.ts). */
  creating: ReadonlySet<string>;
  onNewTab: (workspaceId: string, at: Scope) => void;
}

/** A module-level empty list: a fresh `[]` default per render is a new reference for nothing. */
const NO_PANES: AgentView[] = [];
const NO_KEYS: readonly string[] = [];
const NO_PINS: readonly Pin[] = [];
const NO_MACHINES: readonly string[] = [];

/** The heading's dot, in the worst URGENT status inside the group; none when quiet. */
function urgentDot(g: WorkspaceGroup): string | undefined {
  const worst = worstTriage(g.panes);
  if (worst === "needs") return "bg-status-blocked";
  return undefined;
}

function urgentCount(g: WorkspaceGroup): number {
  return g.panes.filter((p) => ATTENTION.has(bucketOf(p))).length;
}

/**
 * The key a device REMEMBERS a workspace by, for hide and isolate: its machine, session and NAME.
 * The group key carries Herdr's workspace id, which is opaque and can change when Herdr restarts, so
 * a preference keyed on it would quietly stop applying. The name is the project folder and stays.
 */
export function workspacePrefKey(g: WorkspaceGroup): string {
  const cut = g.key.lastIndexOf("\u0000");
  return `${cut === -1 ? "" : g.key.slice(0, cut)}\u0000${g.label}`;
}

/** A DOM id for a workspace group, so the summary line can scroll to it. */
function groupDomId(key: string): string {
  return `ws-group-${key.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

/** A DOM id for a pane row, so a pin or unpin can find the row again in its new place. */
function rowDomId(rowKey: string): string {
  return `pane-row-${rowKey.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

const PINNED_ID = "pinned-group";
const PINNED_HEADING_ID = "pinned-group-heading";
const RANKED_ID = "ranked-group";
const RANKED_HEADING_ID = "ranked-group-heading";
const SUMMARY_ID = "dash-summary-line";

/**
 * Scroll the moved row into view and focus it (ADR 0070): `block: "nearest"`, so a row already in
 * sight does not move the page, and instant under reduced motion. `preventScroll` on the focus keeps
 * the smooth scroll from being cut short by focus's own jump.
 */
function revealElement(el: HTMLElement): void {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  el.scrollIntoView({ block: "nearest", behavior: reduced ? "instant" : "smooth" });
  el.focus({ preventScroll: true });
}

// ── THE DASHBOARD, IN ONE FIXED ORDER (ADR 0063) ─────────────────────────────
// BY WORKSPACE, always. One group per workspace, headed by its name and counted, in machine and
// workspace-number order (lib/pane-groups.ts), with the panes inside in the order the bridge sent.
// Rows under one workspace heading are panes, because that is what a workspace holds. The workspace
// is the level the operator thinks in, so it is the level the heading names; the tab drops onto
// line 2 of the row (`AgentCard` at `scope="place"`), where it tells two rows apart without
// spending a heading, and the group reads as one 44px pitch.
//
// A PANE'S ROW NEVER MOVES WHEN ITS STATE CHANGES. The operator finds a pane by where it sits, not
// by what it is doing right now, and every arrangement that once reordered on a status change — a
// "Needs you" section pulled to the top, the Working and Recent sections, the sort toggle — broke
// exactly that and is gone (ADR 0063).
//
// URGENCY IS A MARK NOW, NEVER A POSITION. A workspace holding a pane that needs you lights its own
// heading (a dot) and its own count (`StatusCounts`); the pane's own row takes a full-colour wash
// (`AgentCard`'s `tint`) rather than moving anywhere; and ONE summary line above every group counts
// what needs you across the whole herd and jumps to the first of it. A row is listed once, in its
// one place, and its marks say the rest.
//
// THE ORDER IS THE OPERATOR'S, AND IT STILL DOES NOT MOVE (ADR 0071). Place is the default and is
// everything above. Activity and Cache, asked for with the order select under the summary line, fold the
// groups into one ranked list; the reading is taken once and held (hooks/use-frozen-ranks.ts), so a
// poll repaints a row where it stands and never moves it.
//
// A PIN IS ONE MORE PLACE, THE ONE THE OPERATOR CHOSE (ADR 0070). A pinned pane leads every tab in a
// Pinned group under the summary line, and leaves its workspace group, so it is still listed once.
// It moves when the operator pins or unpins it, and never because of a state.
export function AgentList({
  agents,
  shellPanes = NO_PANES,
  bridge,
  onOpen,
  glideKeyOf,
  onPress,
  emptyState = true,
  error = false,
  notPaired = false,
  lastSeenAt,
  stale = false,
  tabs,
  servers,
  newTab,
  isolated = null,
  hidden = NO_KEYS,
  onIsolate,
  onToggleHidden,
  hiddenMachines = NO_MACHINES,
  addressedHost,
  onShowMachine,
  needsYouOnly = false,
  onNeedsYouOnlyChange,
  renderBody,
  pins = NO_PINS,
  order = "place",
  onOrderChange,
  onHold,
  reveal = null,
}: AgentListProps) {
  useLocale();
  // THE FREEZE (ADR 0071 point 3, taken up by the dashboard 2026-10-05). Read once on mount, on an
  // order change, on a tap of the segment already selected, and when the page becomes visible again;
  // never on a poll. Above the early return, because a hook cannot sit behind one. It ranks the whole
  // herd, not what the filters leave, so a filter changing never needs a new reading.
  const { ranks, reread } = useFrozenRanks(order, [...agents, ...shellPanes], { rereadOnVisible: true });
  // Whether the multiplexer can say which agent a pane holds. Read unconditionally — a hook cannot
  // sit behind the early return below, and the answer is only consulted in the empty branch.
  const agentDetection = useMuxCapability("agentDetection");
  // Whether this device retired the pin hint (lib/pin-hint.ts). Read here for the same
  // reason: above the early return.
  const pinHintRetired = usePinHintRetired();
  // A pin or unpin just moved a row (ADR 0070). Runs after the commit that moved it, and after the
  // actions sheet's own focus-restore (a passive cleanup runs before any passive setup), so the row
  // in its new place is what ends up focused. The old element is gone with the move, so without this
  // focus would fall to `body`.
  useEffect(() => {
    if (reveal === null) return;
    const target = document.getElementById(rowDomId(reveal.rowKey)) ?? document.getElementById(SUMMARY_ID);
    if (target) revealElement(target);
  }, [reveal]);
  // A herd with nothing but bare shells in it is still something to show, and "No agents running."
  // is then true rather than empty — so the placeholder waits for BOTH lists to be empty.
  if (agents.length === 0 && shellPanes.length === 0) {
    if (!emptyState) return null;
    // "No agents running." is a claim about the herd, and only the bridge can make it. A stale render
    // (failed fetch, or a cold boot with nothing cached) knows nothing about the herd — saying the
    // herd is empty there is the bug this branch exists to prevent, so the outage is named instead.
    // `bridge` is no help on its own: a cached snapshot still says "connected".
    if (error && notPaired) {
      // The strip above the list is the link to the pair form; this names what to run on the host
      // first. The command stays literal, never translated, as on the pair form itself.
      return (
        <div className="flex flex-col items-center justify-center gap-3 px-4 py-24 text-muted-foreground">
          <KeyRound className="size-7" />
          <span className="text-sm font-medium text-foreground">{t("settings.devices.pair.title")}</span>
          <code className="font-mono text-[13px]">collie pair</code>
        </div>
      );
    }
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 px-4 py-24 text-muted-foreground">
          <WifiOff className="size-7" />
          <span className="text-sm">
            {lastSeenAt === undefined
              ? t("home.empty.disconnected")
              : t("home.empty.disconnectedAt", { time: clockTime(lastSeenAt) })}
          </span>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-4 py-24 text-muted-foreground">
        <Inbox className="size-7" />
        <span className="text-sm">
          {bridge === "connected" ? t("home.empty.noAgents") : t("home.empty.waiting")}
        </span>
        {/* PRESENTATION, not a gate (M10/06). Without `agentDetection` every pane arrives as a
            shell with an unknown status, so this list is empty on a machine that may be running
            plenty — and "No agents running." is then a claim the bridge cannot actually make. The
            adapter's own sentence says why, and the second line says where the panes went, so the
            dashboard reads as one coherent screen instead of an empty one. Renders nothing on a
            multiplexer that reports agents, i.e. nothing on Herdr. */}
        {bridge === "connected" && !agentDetection.capable && agentDetection.note !== "" && (
          <p className="max-w-xs text-center text-xs leading-snug">
            {agentDetection.note} {t("home.empty.panesHint")}
          </p>
        )}
      </div>
    );
  }

  // ONE PASS, NOTHING MOVES (2026-09-16, after four arrangements on the phone and a counsel).
  // Every pane stays in its workspace, in the multiplexer's own order: workspaces by number, tabs by
  // number, panes by id. A status change never moves a row or a group, because the operator finds a
  // pane by where it sits, and the urgent sections that used to pull a pane to the top broke exactly
  // that. Urgency is a MARK now, never a position: a full-row wash, a lit heading, a lit chip, and
  // the one summary line. Push and the badge carry the alarm; this screen answers "where".
  const all = triage(agents);
  const attention = all.filter((s) => ATTENTION.has(s.key) && s.agents.length > 0);
  const groups = groupPanesByWorkspace(agents, shellPanes, { order: "fixed", tabs, servers });
  if (groups.length === 0) return null;
  // A stale key (a workspace since closed) filters nothing: an isolation nobody can see is dropped.
  const isolatedGroup = isolated === null ? undefined : groups.find((g) => workspacePrefKey(g) === isolated);
  const hiddenSet = new Set(hidden);
  // THE MACHINE FILTER (issue #288), one clause beside hide: a group on a hidden machine leaves
  // `shown`, so the Dashboard, Crew and Changes follow at once. Isolate still wins, because the isolated
  // group was found among ALL groups above; the Pinned group below is drawn from all groups too
  // (ADR 0070). The addressed machine is never in this set, so the filter cannot empty the list, and
  // on a solo list the set is empty and the clause never matches (lib/hidden-machines.ts).
  const machineHidden = machinesHiddenFrom(hiddenMachines, servers, addressedHost);
  const shown = isolatedGroup
    ? [isolatedGroup]
    : groups.filter((g) => !hiddenSet.has(workspacePrefKey(g)) && !machineHidden.has(groupHost(g)));
  const strip = stripEntries(groups, machineHidden, isolatedGroup?.key);
  const allClear = attention.length === 0;
  // THE PINNED GROUP (ADR 0070). Drawn from EVERY workspace, before isolate and hide apply, and never
  // through the needs-you switch: a pin means "always show me this one", and the summary line above
  // still says what needs you. Place order, so no state moves a pinned row.
  const isPinned = pinMatcher(pins);
  const ranked = order !== "place";
  // A pinned pane ranks inside Pinned and leads the list (ADR 0071 point 7). Place order passes an
  // empty reading, which is the identity.
  const pinned = inRankOrder(pinnedRows(groups, isPinned), ranks);
  // The first urgent pane in DISPLAY order: in Pinned when a pinned pane needs you, else in the first
  // workspace holding an urgent pane, which then is not pinned and so is still in its group.
  const pinnedUrgent = pinned.some((p) => ATTENTION.has(bucketOf(p)));
  const firstUrgent = groups.find((g) => urgentCount(g) > 0);
  // What the body draws. Needs you narrows the rows, a pinned pane leaves its group, and a group left
  // empty is dropped; the group itself rides along whole, so its heading keeps counting every pane
  // (lib/dash-view.ts).
  const drawn = shownGroups(shown, needsYouOnly, isPinned);
  // THE RANKED LIST (ADR 0071, rule 2 of "The dashboard takes the setting"): Activity and Cache fold
  // the workspace groups into one list. The filters above (needs you, isolate, hide, hidden machines,
  // pins) have already run, so they decide WHICH rows and never their order; shells are in these
  // groups already and are ranked with everything else, as in the switcher.
  const rankedRows = ranked && !renderBody ? inRankOrder(drawn.flatMap((d) => d.rows), ranks) : NO_PANES;
  const firstUrgentRow = rankedRows.find((p) => ATTENTION.has(bucketOf(p)));
  const jumpTo = (g: WorkspaceGroup) => {
    // The target may be filtered out: isolate it, which is also the scroll.
    if (!drawn.some((d) => d.group === g)) {
      onIsolate?.(workspacePrefKey(g));
      return;
    }
    document.getElementById(groupDomId(g.key))?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const jumpToRow = (pane: AgentView) => {
    const el = document.getElementById(rowDomId(paneRowKey(pane)));
    if (el) revealElement(el);
  };
  const jumpToPinned = () =>
    document.getElementById(PINNED_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
  // THE PIN HINT (M38/02): one quiet line in the Pinned group's place that says a hold pins a pane.
  // The Dashboard with the switch off only: the other lists are narrower, and a list without a hold has nothing to teach.
  // It needs no pin stored, a device that never retired it, and enough rows on show to pin one above
  // the others; the count is the rows drawn after isolate and hide, the list the eye sees.
  const pinHintHere = !needsYouOnly && renderBody === undefined && onHold !== undefined;
  const shownRows = drawn.reduce((n, d) => n + d.rows.length, 0);
  const pinHintOpen = showsPinHint(pinHintRetired, pins.length, shownRows);
  const firstShownRow = ranked ? rankedRows[0] : drawn[0]?.rows[0];
  const focusFirstRow = () => {
    if (firstShownRow === undefined) return;
    document.getElementById(rowDomId(paneRowKey(firstShownRow)))?.focus({ preventScroll: true });
  };
  const onJump = renderBody
    ? undefined
    : pinnedUrgent
      ? jumpToPinned
      : ranked && firstUrgentRow !== undefined
        ? () => jumpToRow(firstUrgentRow)
        : firstUrgent
          ? () => jumpTo(firstUrgent)
          : undefined;

  // A workspace heading's "+", addressed to the heading's OWN machine and session, never the ambient
  // ones: this list holds every machine in a crew, and a crew's machines number their spaces from
  // `w1` each, so the ambient scope would open a peer's tab in the lead's `w1`. Every pane of a group
  // shares one workspace, machine and session, so its first pane addresses the whole workspace, as
  // the Changes tab's rows do (routes/home.tsx). A group is never empty; the guard is for the type.
  const headingNewTab = (g: WorkspaceGroup) => {
    const first = g.panes[0];
    if (newTab === undefined || first === undefined) return null;
    const at = paneScope(newTab.scope, first, servers, newTab.sessions);
    return (
      <WorkspaceNewTab
        workspaceId={first.workspaceId}
        label={g.label}
        at={at}
        host={first.host}
        busy={newTab.creating.has(tabCreateKey(first.workspaceId, at))}
        onNewTab={newTab.onNewTab}
      />
    );
  };

  // The FULL row identity, not the pane id — see `paneRowKey`. A pane id is unique only within one
  // session on one machine, so a merged or widened list holds several rows that answer to `w1:p1`;
  // keyed by the id alone React recycles one row's element for another's between polls, and the
  // card you are looking at acquires a different row's `onClick`. On this list, that is a tap
  // landing in another terminal.
  //
  // A pinned row is the same 44px row at `scope="herd"`: it sits outside its workspace heading, so
  // line 2 names the place (`space › tab`). Same tap, same scope (`onOpen` resolves it from the pane),
  // same hold.
  const row = (a: AgentView, scope: "place" | "herd" = "place") => (
    <AgentCard
      key={paneRowKey(a)}
      id={rowDomId(paneRowKey(a))}
      agent={a}
      onClick={(el) => onOpen(a, el)}
      glideKey={glideKeyOf?.(a)}
      onPress={onPress && (() => onPress(a))}
      onHold={onHold && (() => onHold(a))}
      scope={scope}
      statusStyle="dot"
      density="row"
      unseen={bucketOf(a) === "ready"}
      tint
      stale={stale}
    />
  );

  const summary = (
    <StatusSummaryLine
      id={SUMMARY_ID}
      panes={agents}
      allClear={allClear}
      onJump={onJump}
      // Focus (the keyboard's) lands here when an unpin takes a row off the list, so the line must be able to hold
      // it. Only once pins are in play: with none, the line renders exactly as it did.
      focusable={pins.length > 0 || reveal !== null}
      className={cn((onNeedsYouOnlyChange || onOrderChange) && "min-w-0 flex-1", "transition-opacity", stale && "opacity-50")}
    />
  );

  // THE SWITCH ENDS THE SUMMARY LINE'S ROW (ADR 0085). The same markup is drawn invisibly on a tab
  // that has none, so the row's width never depends on the tab. It is drawn only when the route gave
  // it a way to flip.
  const switchSlot = onNeedsYouOnlyChange && (
    <NeedsYouSwitch on={needsYouOnly} onChange={onNeedsYouOnlyChange} />
  );

  // The order select is drawn only when the route can store the answer; a change of order asks for
  // a new reading (the freeze, ADR 0071), and a re-read of the order already chosen is no longer a
  // gesture: a select reports a change, never a tap on the value it already shows.
  const orderSlot = onOrderChange && (
    <PaneOrderSelect
      order={order}
      className="shrink-0"
      onChange={(next) => {
        reread();
        onOrderChange(next);
      }}
    />
  );

  return (
    <div className="flex flex-col gap-5 px-4 pb-4 pt-1">
      {/* THE TOP OF THE DASHBOARD, one control block (2026-10-07, Altan's pick of "One control bar"):
          ONE line of state words with the needs-you switch at its right end, then ONE row of two
          selects, the workspace filter on the left and the pane order on the right. It replaced a chip
          strip, a counts line with no words and three glyph toggles, which spread the same four
          controls over three rows. Header unchanged above it, the list below.
          Every row of the block is 44px and the block draws the same on every pane tab: a tab with
          its own body (Changes) keeps the switch and the order select as invisible slots, so a switch
          between tabs moves neither the line nor the row nor anything below it (DESIGN.md §2,
          `e2e/dashboard-footer.spec.ts`). The workspace select stays live on Changes, where it
          narrows the workspaces that body lists.
          The workspace select is the old strip's filter, whole: the options run in the list's own order,
          each with its state in words, the isolated workspace shows alone, a hidden workspace or
          machine has its way back as an option (components/dash-selects.tsx). */}
      <div className="flex flex-col gap-1">
        {/* The twenty-times-a-day glance, in ONE slot of one height: every state counted, with its
            word where the line has room for it, once for the whole dashboard (the headings below
            repeat the numbers, not the words). The all-clear check leads when nothing needs you. A
            tap goes to the first workspace holding something urgent. The switch sits 8px into the
            gutter so its glyph, not its 44px box, lines up with the page edge. */}
        {switchSlot || orderSlot ? (
          <div className="flex min-h-11 items-center justify-between gap-2">
            {summary}
            {switchSlot && (
              <div className={cn("-mr-2 shrink-0", renderBody !== undefined && "invisible")} aria-hidden={renderBody !== undefined ? true : undefined}>
                {switchSlot}
              </div>
            )}
          </div>
        ) : (
          summary
        )}
        <div className="flex items-center gap-2">
          <WorkspaceSelect
            className="min-w-0 flex-1"
            entries={strip}
            isolatedKey={isolatedGroup?.key}
            isHidden={(g) => hiddenSet.has(workspacePrefKey(g))}
            servers={servers}
            onIsolate={(group) => onIsolate?.(group === null ? null : workspacePrefKey(group))}
            onShowHidden={onToggleHidden && ((hiddenGroups) => hiddenGroups.forEach((g) => onToggleHidden(workspacePrefKey(g))))}
            onShowMachine={onShowMachine}
          />
          {orderSlot && (
            <div className={cn("shrink-0", renderBody !== undefined && "invisible")} aria-hidden={renderBody !== undefined ? true : undefined}>
              {orderSlot}
            </div>
          )}
        </div>
      </div>

      {/* PINNED, the first group on every pane tab (ADR 0070; the Crew tab lists machines and draws none): under the summary line, so the strip and the
          line keep their place on every tab. The heading is the section voice the switcher's Shells
          and Launch wear, muted, with no dot and no count: a pinned pane is counted by its own
          workspace's heading, and no two headings count one pane. The muted voice also keeps it
          apart from a workspace that happens to be called "Pinned". No per-row glyph: the group is
          the mark. Nothing pinned, nothing drawn. On Changes these are panes, and a tap opens the
          pane; the workspace rows below keep their change rows. */}
      {pinned.length > 0 && (
        <section
          id={PINNED_ID}
          aria-labelledby={PINNED_HEADING_ID}
          className="flex scroll-mt-4 flex-col gap-2"
        >
          <SectionHeader id={PINNED_HEADING_ID} label={t("home.pinned.title")} />
          <ListGroup>{pinned.map((a) => row(a, "herd"))}</ListGroup>
        </section>
      )}

      {/* THE PIN HINT (M38/02), in the place the Pinned group takes: directly under the summary line
          while nothing is pinned. It sits AFTER the Pinned section, so on the first pin the group lands
          in its final place at once and the line slides shut below it, rather than the group sliding
          up as the line leaves above it. Mounted on the Dashboard with the switch off only, so a tab
          or switch change drops it with the rest of the body instead of playing its exit. */}
      {pinHintHere && <PinHint open={pinHintOpen} onFocusLeaves={focusFirstRow} />}

      {renderBody?.(shown)}

      {/* By workspace. The heading IS the landmark: full ink, its own case, and it lights up with a
          dot and a count when a pane inside needs you. Flat rows in ONE bordered group. Under Needs
          you with nothing urgent, no group is left, and the summary line's all-clear above is the
          whole answer (with the Pinned group under it, when pins exist): no empty list, no second
          message.
          The heading ends in a "+" that opens a new tab in that workspace (M40/03). `min-h-7` is the
          "+"'s 28px, reserved on EVERY strong heading, drawn or not, so no heading's height depends
          on a machine's capability or on a state (DESIGN.md §2). A workspace with no heading here (all
          its panes pinned, hidden or filtered out, or nothing of it urgent with the needs-you switch on) has no "+";
          the space view keeps its own. */}
      {/* IN ACTIVITY OR CACHE ORDER the workspace groups give way to ONE list under one heading that
          names the order in words, as the switcher's does (ADR 0071). No workspace heading and so no
          per-heading "+": a rank crosses every workspace, and a heading cannot answer a question
          asked across all of them. The strip above keeps its chips. Each row is a `herd` row, whose
          line 2 names its place (`space › tab`), so a row still says which workspace it is in. */}
      {!renderBody && ranked && rankedRows.length > 0 && (
        <section id={RANKED_ID} aria-labelledby={RANKED_HEADING_ID} className="flex scroll-mt-4 flex-col gap-2">
          <SectionHeader
            id={RANKED_HEADING_ID}
            label={t(order === "cache" ? "paneOrder.coldest" : "paneOrder.recent")}
            count={rankedRows.length}
            tone="strong"
            className="min-h-7"
          />
          <ListGroup>{rankedRows.map((a) => row(a, "herd"))}</ListGroup>
        </section>
      )}

      {!renderBody && !ranked && drawn.map(({ group: g, rows }) => (
        <section key={g.key} id={groupDomId(g.key)} className="flex scroll-mt-4 flex-col gap-2">
          <SectionHeader
            label={g.label}
            tone="strong"
            dot={urgentDot(g)}
            className="min-h-7"
            trailing={
              <>
                <StatusCounts panes={g.panes} className="shrink-0 text-[11px] text-muted-foreground" />
                {headingNewTab(g)}
              </>
            }
          />
          <ListGroup>{rows.map((a) => row(a))}</ListGroup>
        </section>
      ))}
    </div>
  );
}
