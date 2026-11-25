import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useRevalidator } from "react-router";

import { RouteHeader, SettingsGear } from "@/components/app-header";
import { SessionSwitcher } from "@/components/session-switcher";
import { ServerSwitcher } from "@/components/server-switcher";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { AgentList } from "@/components/agent-list";
import { DurableHome } from "@/components/durable-home";
import { PaneActionsSheet } from "@/components/pane-actions-sheet";
import { ProgramSection } from "@/components/program-section";
import { TrickSpaceSection } from "@/components/trick-session";
import { LaunchStrip } from "@/components/launch-strip";
import { SpaceOverview } from "@/components/space-overview";
import { StatusArea } from "@/components/status-area";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { BuildStamp } from "@/components/build-stamp";
import { CrewFooterLink } from "@/components/crew-footer-link";
import { CrewTab } from "@/components/crew-tab";
import { TelemetryNotice } from "@/components/telemetry-notice";
import { useTelemetryNoticeRead } from "@/hooks/use-telemetry-notice";
import { UpdateBanner, arriveAtUpdateLine } from "@/components/update-banner";
import { TrickCardsLine } from "@/components/trick-cards";
import { Fab } from "@/components/ui/fab";
import { useAnySheetOpen } from "@/components/ui/sheet";
import { DashboardTabBar } from "@/components/dashboard-tab-bar";
import { TrickDashboardStrip } from "@/components/trick-place-items";
import { WorkspaceChangesList, type WorkspaceChangesRow } from "@/components/workspace-changes-list";
import { useDashPrefs, openForCount } from "@/hooks/use-dash-prefs";
import { useDashboardBar } from "@/hooks/use-dashboard-bar";
import { useKeyboardOpen } from "@/hooks/use-keyboard";
import { useLocale } from "@/hooks/use-locale";
import { useNotifyPrefs } from "@/hooks/use-notify-prefs";
import { useWorkspaceChangeCounts } from "@/hooks/use-workspace-change-counts";
import { useNewTabOrSheet } from "@/hooks/use-new-tab-or-sheet";
import { useSpaceActions } from "@/hooks/use-spaces";
import { useNav } from "@/hooks/use-nav";
import { useNewEntry } from "@/hooks/use-new-entry";
import { usePaneOpen } from "@/hooks/use-pane-open";
import { useScrollMemory } from "@/hooks/use-scroll-memory";
import { useElementWidth } from "@/hooks/use-element-width";
import { useWidthClass } from "@/hooks/use-width-class";
import { showBadge } from "@/lib/app-badge";
import { takeBundleFocus, useBundleFocusPending } from "@/lib/bundle-apply";
import { useLaunchers } from "@/lib/launchers";
import { isolateSpaces } from "@/lib/spaces";
import { ambientHost, ambientPanes, isMultiHost, paneRowKey, paneScope, sessionsOnHost } from "@/lib/hosts";
import { setMachineHidden, useHiddenMachines } from "@/lib/hidden-machines";
import type { ChangesLookup } from "@/lib/api";
import { t, tn } from "@/lib/i18n";
import { prefetchFolders } from "@/lib/folders";
import { glideForward } from "@/lib/glide";
import { hillPath, homePath, newPath, trickSessionPath, spaceChangesPath, spacePath } from "@/lib/nav";
import { useShortcutHandler } from "@/hooks/use-shortcut-handler";
import { ActionsButton } from "@/components/actions-palette";
import { resolveIsolatedPrefKeys, workspaceGroupKey, type WorkspaceGroup } from "@/lib/pane-groups";
import { panePlaceParts } from "@/lib/pane-name";
import { scopeKey, type Scope } from "@/lib/scope";
import { countAlerting } from "@/lib/triage";
import { usePairing } from "@/lib/pairing";
import { usePins } from "@/lib/pins";
import { programScope, programSessions, programsAbove, waitingPrograms } from "@/lib/session-cards";
import { cn } from "@/lib/utils";
import { contentWidth, gridWidth, SPACE_WIDTH, spaceColumns, WIDE_GUTTER } from "@/lib/wide-dashboard";
import { isReadOnly, type AgentView, type ServerSummary, type SessionSummary } from "@/lib/types";
import { useRootData } from "@/lib/route-data";
import { Button } from "@/components/ui/button";
import { FabButton } from "@/components/ui/fab";
import { Icon } from "@/components/icons/icon";
import { DashboardViews } from "@/components/dashboard-views";

const NO_TRICK_SESSIONS: readonly AgentView[] = [];

/**
 * The Changes tab's body (ADR 0066). Mounted only while that tab is selected, so its 5-second
 * refresh starts when the tab opens and stops when the operator leaves it. One row per workspace the
 * strip leaves shown, each asked on the machine and session its panes live on.
 */
/** The large screen's Files view: its column's widest, in CSS px. */
const FILES_VIEW_MAX = 720;

function ChangesTabBody({
  groups,
  scope,
  servers,
  sessions,
  lookup,
  line,
}: {
  groups: readonly WorkspaceGroup[];
  scope: Scope;
  servers: readonly ServerSummary[] | undefined;
  sessions: readonly SessionSummary[] | undefined;
  lookup: ChangesLookup;
  /** The large screen: one line a space, its counts at the right. */
  line: boolean;
}) {
  const nav = useNav();
  const rows = useMemo<WorkspaceChangesRow[]>(
    () =>
      groups.flatMap((g) => {
        // A root workspace group also holds the panes of its linked worktrees (issue #587); each
        // checkout has its own working tree, so each distinct workspace in `g.panes` gets its row.
        const seen = new Set<string>();
        const out: WorkspaceChangesRow[] = [];
        for (const pane of g.panes) {
          const key = workspaceGroupKey(pane);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            key,
            label: key === g.key ? g.label : panePlaceParts(pane).space,
            workspaceId: pane.workspaceId,
            scope: paneScope(scope, pane, servers, sessions),
          });
        }
        return out;
      }),
    [groups, scope, servers, sessions],
  );
  const counts = useWorkspaceChangeCounts(rows, lookup, true);
  return (
    <WorkspaceChangesList
      rows={rows}
      counts={counts}
      line={line}
      onOpen={(row, from) => {
        const to = spaceChangesPath(row.workspaceId, row.scope);
        glideForward("changes", to, () => nav.down(to), from);
      }}
    />
  );
}

/**
 * The dashboard's column on a large screen (ADR 0158): `width` px, centred, with the large-screen gutter, so
 * the grid of Spaces inside it is `gridWidth` wide. The phone's parts (the banners, the Spaces navigator, the
 * footer lines) carry their own 16px gutter, and `PhoneParts` takes it back so they stand on the grid's edge.
 */
function WideColumn({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div className="mx-auto w-full" style={{ maxWidth: width, paddingInline: WIDE_GUTTER }}>
      {children}
    </div>
  );
}

function PhoneParts({ on, children }: { on: boolean; children: ReactNode }) {
  return on ? <div className="-mx-4">{children}</div> : <>{children}</>;
}

// Dashboard home screen. Every pane sits under the workspace it lives in, in the multiplexer's own
// order (lib/pane-groups.ts, ADR 0063); urgency is a mark on a row and a heading and one summary
// line on top, never a position (the one exception: on a large screen a band above the grid repeats the
// sessions that need you, and no row leaves its place, ADR 0158). The operator may ask for Activity or Cache order instead, with the
// order select under that line (ADR 0071): one ranked list, read once and held. The Spaces navigator sits
// under the thing it navigates to, and the Programs section (M55 spec 13) sits after it, or above Launch
// while a program has a question that waits on you.
// Launchers sit directly above Spaces: they are one-tap act-on-able actions like the herd above
// them, but they CREATE rather than triage, so they sit under the herd and above the navigator
// their new Space will appear in. Tapping an agent opens its pane; tapping a space drills into
// /space/:id; tapping a launcher creates a throwaway Space and types its command.
export function HomeRoute() {
  const data = useRootData();
  const nav = useNav();
  const spaceActions = useSpaceActions();
  const { creatingSpace, creatingTab, launching } = spaceActions;
  // A workspace heading's "+" offers that machine's agents in a sheet, or makes the shell (M91). One
  // sheet for the whole list, keyed on the heading tapped.
  const plus = useNewTabOrSheet(spaceActions, data.scope);
  // The New page's Favourites and Recent, read once ahead of the tap so the page opens at its final
  // height (lib/folders.ts). Once per mount, for the machine this view shows.
  const folderHost = data.scope?.host;
  const folderSession = data.scope?.session;
  useEffect(() => {
    prefetchFolders({ host: folderHost, session: folderSession });
  }, [folderHost, folderSession]);
  useLocale();
  const {
    prefs,
    setSpacesOpen,
    setLaunchOpen,
    setIsolatedSpaces,
    toggleHiddenSpace,
    setDashView,
    setNeedsYouOnly,
    setPaneOrder,
  } = useDashPrefs();
  // THE BOTTOM BAR'S READING (hooks/use-dashboard-bar.ts), shared with the Hill and a trick's Session: the
  // tabs (Crew while a crew is configured, Files on a machine with a screen), the view the stored choice
  // resolves to, the Dashboard tab's mark (ADR 0066 point 7: a red count of the panes blocked on you, else a
  // quiet dot for finished panes nobody opened), the Hill item and its count, the tricks' items, and
  // whether the bar is drawn at all. A device that stored "crew" and then lost its crew sees the Dashboard
  // (ADR 0085).
  const bar = useDashboardBar(prefs.dashView);
  const { view, screenless, blockedCount, readyUnseen } = bar;
  const multi = bar.crew;
  const tabsShown = bar.shown;
  // The needs-you switch filters the Dashboard list only: Crew and Changes draw their own bodies.
  const needsYouOnly = view === "dashboard" && prefs.needsYouOnly;
  // The installed app's icon counts what has an alert out instead (lib/app-badge.ts), so it waits for
  // the bridge's notification kinds rather than guess them.
  const { prefs: notifyKinds } = useNotifyPrefs();
  const alerting = notifyKinds === null ? null : countAlerting(data.agents, notifyKinds);
  const lookup = useMemo<ChangesLookup>(
    () => ({ depth: prefs.changesDepth, nested: prefs.changesNested }),
    [prefs.changesDepth, prefs.changesNested],
  );
  // No stored choice yet? The space count decides — a two-space install shouldn't be handed a
  // mystery collapsed header, and a forty-space one shouldn't be handed a wall.
  const spacesOpen = openForCount(prefs.spacesOpen, data.workspaces.length);
  // The Launch section folds on the same terms. Its count comes from the component (it owns the
  // config read), so the un-chosen default is decided there against the same threshold.
  const launchOpen = prefs.launchOpen;

  // A row is opened with the PANE's host, never the ambient one: the dashboard is one list across
  // every machine (hosts are a label, not a split), so the row you tapped may well live somewhere
  // other than where the URL currently points. Resolving it here is what stops a reply landing on the
  // right pane name on the wrong terminal. Solo: every pane is untagged, so this is `data.scope`.
  // The tap glides the row into the pane header when the pane's read is in time (use-pane-open.ts).
  const paneOpen = usePaneOpen(data.scope, data.servers, data.sessions);
  const drillInto = (id: string) => nav.down(spacePath(id, data.scope));
  // The space navigator shows the ADDRESSED machine's spaces — the loader's `ambientSpaces` has
  // already narrowed `data.workspaces`/`data.tabs` to the host `?h=` names (or the lead, absent one;
  // untagged rows, i.e. every solo snapshot, pass regardless). Their panes must be looked up under
  // that same host, so the navigator and the loader agree on which machine is on screen. Undefined
  // when solo, which keys everything exactly as before.
  const navHost = ambientHost(data.servers, data.scope.host);
  // Sessions are a per-host registry, so the session switcher only ever lists this host's.
  const sessionsHere = sessionsOnHost(data.sessions ?? [], data.scope, data.servers);
  // WHO SETS THE ICON'S COUNT WHILE THIS PAGE IS OPEN. The service worker sets it on every herd push from
  // the sum of every slot, and the slots count every session and machine. This page counts only the
  // panes in the view it shows, so on one session of several it would write a smaller number, and the
  // next push would replace it with the sum anyway: the last writer wins. The page therefore writes only
  // when it holds the whole picture (all sessions shown, or the only session on a solo machine), and
  // otherwise leaves the worker's sum standing.
  const wholeHerd = data.viewAll || (!multi && sessionsHere.length <= 1);
  useEffect(() => {
    if (alerting !== null && wholeHerd) void showBadge(navigator, alerting);
  }, [alerting, wholeHerd]);
  // …AND THE ADDRESSED HOST IS ALSO SESSION-LOCAL, which is the half the widened view would otherwise break.
  // Workspace ids collide across sessions exactly as they collide across machines, and the space
  // navigator keys by `(host, workspaceId)` with no session in it — so on a widened body another
  // session's `w1` panes would paint their blocked dot and their recency onto the AMBIENT `w1` row,
  // and drilling in would show a space with nothing blocked in it. The list widens; the navigation
  // tree does not (that is the whole shape of this feature, and the shape the crew merge already
  // has), so the tree is fed ambient panes only. Untagged panes are ambient by definition, which
  // makes this the identity filter on every un-widened body.
  const navPanes = useMemo(
    () => ambientPanes(data.agents, data.shellPanes, data.scope, data.servers, data.sessions),
    [data.agents, data.shellPanes, data.scope, data.servers, data.sessions],
  );
  const herdWorkspaces = data.herdWorkspaces ?? data.workspaces;
  const isolatedSpaces = useMemo(
    () =>
      resolveIsolatedPrefKeys(prefs.isolatedSpaces, {
        workspaces: herdWorkspaces,
        scope: data.scope,
        servers: data.servers,
        sessions: data.sessions,
      }),
    [prefs.isolatedSpaces, herdWorkspaces, data.scope, data.servers, data.sessions],
  );
  // THE PROGRAMS SECTION (M55 spec 13): every program session in the snapshot, this machine's and each
  // crew member's, in a section of its own, and a tap opens its home, the conversation list, on the
  // machine that runs it. None on a snapshot with no program session, and the section then draws
  // nothing. It sits above the spaces while any program has a conversation that waits on you, below
  // them otherwise, and moves on the snapshot that changes that count.
  const programs = useMemo(() => programSessions(data.sessions ?? []), [data.sessions]);
  const programsFirst = programsAbove(programs);
  // With the needs-you filter on, the section keeps only the programs that wait on you, in the slot it
  // takes above Launch when a question waits, and draws nothing when none does.
  const programsWaiting = useMemo(() => waitingPrograms(programs), [programs]);
  const openProgram = (session: SessionSummary) => nav.down(homePath(programScope(session, data.servers)));
  const openTrickSession = useCallback((pane: AgentView) => nav.down(trickSessionPath(pane.paneId)), [nav]);

  // THE ROW HOLD (ADR 0070): a hold on a dashboard row opens that pane's own actions sheet, Pin to
  // top / Unpin first, then the writes. The sheet writes with the PANE's scope, for the reason a tap
  // opens with it (`paneScope`). A pin or unpin moves the row right here, so the answer is the row
  // itself, scrolled into view and focused in its new place (`reveal`), not a toast.
  const pins = usePins();
  const [held, setHeld] = useState<AgentView | null>(null);
  const [reveal, setReveal] = useState<{ rowKey: string } | null>(null);
  const revalidator = useRevalidator();
  const { refused: notPaired } = usePairing();
  const readOnly = isReadOnly(data.device) || notPaired;

  // THE FLOATING NEW BUTTON (DESIGN.md §1, M48 spec 01), on the Dashboard tab only: Crew and Files
  // are other lists, and a create entry over them would read as theirs. Drawn when this machine can
  // open a space at all, which every start on the New page does, or has rows to run. A device that
  // may not write gets none of it. A saved copy keeps the button drawn and refuses on the tap
  // (`workspace-new-tab.tsx` does the same): a control that comes and goes moves what is around it.
  const { launchers } = useLaunchers(data.scope);
  const durableHome = view === "dashboard" && screenless;
  // The New button stays on the durable home: the New page lists the program's starters there. When it
  // is drawn and where a tap goes is `useNewEntry`'s, shared with the Switch pane sheet's New button
  // (THE ONE NEW PAGE, M48 spec 01: the floating button, the Spaces header's folder button and the empty
  // dashboard's first-agent card all go to it, on the machine this view shows).
  const newEntry = useNewEntry({
    scope: data.scope,
    saved: data.stale === true,
    readOnly,
    launcherCount: launchers.length,
  });
  const fabOffered = view === "dashboard" && newEntry.offered;
  const openNew = newEntry.open;
  // The Actions palette's New agent… and New shell on the dashboard (ADR 0165): the New page, as the New
  // button opens it, and for New shell the same page with Shell already chosen. Offered where that button is.
  useShortcutHandler("new_agent", fabOffered ? openNew : undefined);
  useShortcutHandler(
    "new_shell",
    fabOffered && !screenless
      ? () => {
          if (data.stale === true) return openNew();
          nav.down(newPath({ machine: data.scope.host, session: data.scope.session, pick: "shell" }));
        }
      : undefined,
  );
  // Hidden while a sheet is up (it would sit dimmed under the backdrop, a second create entry next
  // to the one being used) and while the keyboard is (the dashboard's filter field raises it, and
  // the button would ride up over the list). Neither moves anything: the layer is fixed.
  const sheetOpen = useAnySheetOpen();
  const keyboardOpen = useKeyboardOpen();
  const herd = useMemo(() => [...data.agents, ...data.shellPanes], [data.agents, data.shellPanes]);
  // THE MACHINE FILTER (issue #288): the machines this device leaves off the list, as stored. The
  // list itself keeps the addressed machine and drops ids off the roster (lib/hidden-machines.ts). A
  // solo snapshot reads nothing. The stand-in chip's tap is the second place it is written, beside
  // the Machines sheet's switch.
  const hiddenMachines = useHiddenMachines(isMultiHost(data.servers));

  // ScreenTransition remounts this whole route on every dashboard<->pane move (both directions), so
  // the scroller below is a fresh DOM node with scrollTop 0 each time — the document itself never
  // scrolls, so nothing else restores this. Keyed on the scope (host + session), so two herdr
  // sessions — or two crew members — keep independent positions. See lib/scroll-memory.ts.
  const scrollRef = useScrollMemory<HTMLDivElement>(`home:${scopeKey(data.scope)}`);
  // THE DASHBOARD ON A LARGE SCREEN (ADR 0158). In the window's `expanded` width class, and with Large-screen
  // layout not Off (the class reads compact then, `useWidthClass`), the home route is no longer the phone's
  // 640px column: the header, the grid of Spaces and the tab bar are as wide as the grid. The number of
  // columns is read from the width of the scroller itself, the room inside it without its scrollbar, and never
  // from the window. Compact and medium, and Off at any width, draw the phone's column exactly as before.
  const wide = useWidthClass() === "expanded";
  const [measureScroller, scrollerWidth] = useElementWidth<HTMLDivElement>(window.innerWidth, "client");
  const setScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el;
      measureScroller(el);
    },
    [scrollRef, measureScroller],
  );
  const columns = spaceColumns(scrollerWidth);
  const columnWidth = contentWidth(columns);
  // ON A LARGE SCREEN THERE IS NO TAB BAR AT THE FOOT (ADR 0158, addendum 2026-11-21). The views, and the tricks'
  // items after them, are the views control in the header, and the New button is the last control of the
  // command row over the grid, so nothing floats. The phone, the tablet and Off keep the bar and the button.
  const footBar = tabsShown && !wide;
  const herdEmpty = data.agents.length === 0 && data.shellPanes.length === 0;
  // An empty dashboard on a large screen is one column, centred both ways: the pairing words, the outage, or the
  // first-start card, which is then the one way to the New page.
  const emptyHome = wide && herdEmpty && view === "dashboard" && !screenless;
  const fabFloat = fabOffered && !wide;
  // The install-count notice's one read: a device that has not spent the notice keeps the list unseen for
  // at most 400 ms while it answers, so the notice never opens above a list that has painted (calm load).
  const telemetry = useTelemetryNoticeRead();
  // THE UPDATE LINE, BROUGHT INTO VIEW ONCE (2026-11-06). A tap on the header mark while the app is
  // updating opens this screen and asks for the line that says what is happening
  // (`lib/bundle-apply.ts`). Taken after mount, so the scroll memory's layout effect has already put
  // the list back where it was and this moves it on from there; and taken in place too, for a tap
  // made on this screen. A plain visit sets no flag and scrolls nowhere. Centred, because the New
  // button floats over the foot of the list and `nearest` would park the line under it.
  const updateLine = useRef<HTMLDivElement>(null);
  const focusPending = useBundleFocusPending();
  useEffect(() => {
    if (!focusPending || !takeBundleFocus()) return;
    arriveAtUpdateLine(updateLine.current);
  }, [focusPending]);
  // "+ New" shrinks to the round "+" once the list has scrolled, and grows back at the top (card 3.2).
  const scrolled = useScrolledPast(scrollRef, 24);
  // Only the Dashboard tab with herd rows is the grid. Crew, Files and the durable home keep the phone's column,
  // centred under the wide header, and the parts under the grid (Launch, the Spaces navigator, Programs, the
  // Tricks Space) stand in one Space's width after the last Space.
  const gridList = wide && view === "dashboard" && !screenless;
  const inColumn = (node: ReactNode) => (wide ? <WideColumn width={columnWidth}>{node}</WideColumn> : node);
  // The Files view on a large screen (ADR 0173): one line a space, in a column of at most
  // FILES_VIEW_MAX px that starts at the grid's left edge, under the mark, and scrolls with the page.
  const filesWide = wide && view === "changes";
  const filesWidth = Math.min(gridWidth(columns), FILES_VIEW_MAX);
  const narrowed = (node: ReactNode) =>
    wide && !gridList ? (
      filesWide ? (
        <div style={{ width: filesWidth }}>
          <PhoneParts on>{node}</PhoneParts>
        </div>
      ) : (
        <div className="mx-auto max-w-screen-sm">{node}</div>
      )
    ) : (
      node
    );
  const underGrid = (node: ReactNode) =>
    gridList ? (
      <div className={cn(emptyHome && "mx-auto")} style={{ width: SPACE_WIDTH }}>
        <PhoneParts on>{node}</PhoneParts>
      </div>
    ) : (
      node
    );
  // The scroller's foot, in the phone's order, and on a large screen in one Space's width under the grid.
  const footer = (
    <>
      {/* The footer is the dashboard's meta zone, in widening order: the crew you're part of, an
          available update / needed restart, then the build stamp (which bundle you're running,
          with a stale-cache nudge). The crew line self-hides on a solo install. */}
      <CrewFooterLink scope={data.scope} className="px-4 pt-3" />
      {/* With the Hill off, a card of Collie's own about a trick waits here (M96 spec 14), in the update line's box. */}
      <TrickCardsLine className="px-4 pt-3" />
      <UpdateBanner ref={updateLine} className="px-4 pt-3" />
      {/* The footer below owns the safe area now, so the stamp only keeps its own air. */}
      {/* With the New button drawn, the stamp's air grows so the last row scrolls clear of it:
          16px gap + 56px button + 8px, from the footer's top edge. Set by capability, not by the
          button's transient hides, so a sheet or the keyboard never moves the list. On a large screen
          the same room holds: the button sits at the grid's right edge, and the stamp is the last
          thing in the scroller. */}
      <BuildStamp
        className={cn(
          "px-4 pt-3",
          fabFloat ? (footBar ? "pb-20" : "pb-[calc(5rem_+_env(safe-area-inset-bottom))]") : footBar ? "pb-2" : "pb-[calc(0.5rem_+_env(safe-area-inset-bottom))]",
        )}
      />
    </>
  );
  const tabBar = footBar && (
    <DashboardTabBar
      view={view}
      onSelect={setDashView}
      crew={multi}
      files={!screenless}
      blockedCount={blockedCount}
      readyUnseen={readyUnseen}
      hill={bar.hill}
      hillNow={bar.hillNow}
      onOpenHill={() => nav.down(hillPath(data.scope))}
      tabbarParts={bar.tabbarParts}
      sessions={bar.sessions}
      onOpenSession={openTrickSession}
    />
  );
  // The Hill's way in on a large screen: an icon button in the header's right cluster, with the bar's red count.
  const hillButton = wide && bar.hill !== null && (
    <Button
      variant="ghost"
      size="lg"
      data-slot="header-hill"
      className="relative size-11 px-0"
      aria-label={bar.hill > 0 ? `${t("hill.title")}, ${tn("home.tabs.hill", bar.hill)}` : t("hill.title")}
      onClick={() => nav.down(hillPath(data.scope))}
    >
      <Icon name={bar.hillNow ? "hill-now" : "hill"} className={cn("size-5", bar.hillNow && "text-status-working")} />
      {bar.hill > 0 && (
        <span aria-hidden className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-sm bg-status-blocked px-1 text-[10px] leading-none font-semibold tabular-nums text-white">
          {bar.hill}
        </span>
      )}
    </Button>
  );
  return (
    <div className={wide ? "mx-auto flex min-h-0 w-full flex-1 flex-col" : "mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col"}>
      {/* The dashboard header: wordmark + the session switcher (dashboard-only), then the shared pill
          and the Settings gear. The switcher self-hides on a single-session install. */}
      <RouteHeader
        wordmark
        width={wide ? columnWidth : "column"}
        span={wide}
        rightLead={
          <>
            {hillButton}
            {/* Host first, then session — outer dimension first, and the two are deliberately
                different shapes (bordered server pill vs filled layers capsule) so a glance can tell
                "change machine" from "change session on this machine". Both self-hide. */}
            {/* The Actions palette (ADR 0165): this screen's commands and the panes to go to, in one list. */}
            <ActionsButton />
            <ServerSwitcher servers={data.servers} scope={data.scope} agents={data.agents} />
            <SessionSwitcher sessions={sessionsHere} scope={data.scope} viewAll={data.viewAll} />
          </>
        }
        rightTrail={<SettingsGear scope={data.scope} />}
      >
        {wide && tabsShown && (
          <DashboardViews
            view={view}
            onSelect={setDashView}
            crew={multi}
            files={!screenless}
            blockedCount={blockedCount}
            tabbarParts={bar.tabbarParts}
            sessions={bar.sessions}
            onOpenSession={openTrickSession}
          />
        )}
      </RouteHeader>

      {/* Content region below the header: a viewport-clipped internal scroller. `relative` is
          load-bearing: it makes this scroller the containing block for its absolutely-positioned
          descendants. Tailwind's `sr-only` is `position: absolute`, so every status label in the
          list would otherwise escape this scroller's clip and grow the document's own scrollbar. */}
      <div ref={setScroller} data-slot="home-scroller" className={cn("relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto", telemetry.held && "invisible")}>
        {/* A notice BELOW the header is content, not viewport chrome: it is an inset box on the
            page gutter, not a full-bleed strip. Full-bleed it ran its left edge 16px outside the
            list it sat on top of — two left edges stacked, the loudest misalignment on the page. */}
        {inColumn(
          <PhoneParts on={wide}>
            {/* Not paired on a large screen: the centred block below says it, with the command and the phone card,
                so the strip would say it twice. The pane and Space screens keep the strip. */}
            {!(wide && notPaired && data.error) && <ReadOnlyBanner device={data.device} />}
            {/* Once per device: the install count is on by default (M86 spec 02). Self-hides. */}
            <TelemetryNotice read={telemetry} />
          </PhoneParts>,
        )}

        <main className={cn("flex-1", emptyHome && "flex flex-col justify-center")}>
          {inColumn(
            <>
          {/* THE TRICKS' TILES (the `dashboard` place, 2026-11-10): one per trick, in a strip at the top
              of the Dashboard view, above the summary line. Not on Crew or Files. Nothing at all while
              no trick has a tile; it arrives and leaves through Collapse (DESIGN.md §11). */}
          {view === "dashboard" && <TrickDashboardStrip sessions={data.trickSessions ?? NO_TRICK_SESSIONS} onOpenSession={openTrickSession} />}
          {/* One list: every pane under the workspace it lives in, or one ranked list in Activity and
              Cache order (components/agent-list.tsx). Bare shells go in with the agents — grouped by
              place they sit beside the work they belong to, which is what stopped them being a pen
              of their own at the bottom of the sheet. */}
          {view === "crew" ? (
            // Crew is a different list: machines, not panes. The pane list's chrome (the space strip,
            // the summary line with its controls slot, the Pinned group) filters and counts panes, so
            // none of it is drawn here and the tab's body starts with the machine cards (ADR 0085).
            // It also covers a crew with no pane anywhere, which the pane list would answer with its
            // empty placeholder.
            narrowed(
              <div className="px-4 py-4">
                <CrewTab />
              </div>,
            )
          ) : durableHome ? (
            narrowed(
              <DurableHome
                scope={data.scope}
                panes={navPanes.agents}
                workspaces={data.workspaces}
                paneOpen={paneOpen}
                stale={data.stale === true}
              />,
            )
          ) : (
            narrowed(
            <AgentList
              agents={data.agents}
              shellPanes={data.shellPanes}
              bridge={data.bridge}
              onOpen={paneOpen.open}
              glideKeyOf={paneOpen.glideKeyOf}
              onPress={paneOpen.press}
              error={data.error}
              notPaired={notPaired}
              refused={data.authError}
              lastSeenAt={data.lastSeenAt}
              stale={data.stale === true}
              tabs={data.tabs}
              servers={data.servers}
              workspaces={herdWorkspaces}
              // Each workspace heading's "+" (M40/03): the list resolves each heading's own machine and
              // session from these, the way a row's tap does, and sends the create there.
              newTab={{
                scope: data.scope,
                sessions: data.sessions,
                creating: creatingTab,
                onNewTab: plus.request,
              }}
              isolated={isolatedSpaces}
              hidden={prefs.hiddenSpaces}
              onIsolate={setIsolatedSpaces}
              onToggleHidden={toggleHiddenSpace}
              hiddenMachines={hiddenMachines}
              addressedHost={data.scope.host}
              scope={data.scope}
              sessions={data.sessions}
              onShowMachine={(host) => setMachineHidden(host, false, data.servers)}
              pins={pins}
              // The same per-device preference the pane switcher and Settings write (ADR 0071).
              order={prefs.paneOrder}
              onOrderChange={setPaneOrder}
              onHold={setHeld}
              // The empty dashboard's large "Start your first agent" card opens the same sheet.
              onFirstStart={fabOffered ? openNew : undefined}
              reveal={reveal}
              needsYouOnly={needsYouOnly}
              onNeedsYouOnlyChange={setNeedsYouOnly}
              narrowFilter={filesWide}
              renderBody={
                view === "changes"
                  ? (shown) => (
                      <ChangesTabBody
                        groups={shown}
                        scope={data.scope}
                        servers={data.servers}
                        sessions={data.sessions}
                        lookup={lookup}
                        line={filesWide}
                      />
                    )
                  : undefined
              }
              wide={
                gridList
                  ? {
                      columns,
                      tail:
                        fabOffered ? (
                          <FabButton size="compact" label={t("home.new.label")} busy={creatingSpace || launching.size > 0} onClick={openNew} />
                        ) : undefined,
                    }
                  : undefined
              }
            />,
            )
          )}
          {/* Launch and the Spaces navigator belong to the whole herd, so they sit under the Dashboard
              with the needs-you switch off. The filtered list and the other tabs are narrower, and
              a launcher under them would read as part of that list. */}
          {view === "dashboard" && needsYouOnly && !screenless &&
            underGrid(<ProgramSection programs={programsWaiting} servers={data.servers} onOpen={openProgram} />)}
          {view === "dashboard" && !needsYouOnly && !screenless &&
            underGrid(
            <>
              {/* Above Launch, so Launch keeps its place directly over the Spaces it creates into. */}
              {programsFirst && <ProgramSection programs={programs} servers={data.servers} onOpen={openProgram} />}
              <LaunchStrip open={launchOpen} onOpenChange={setLaunchOpen} scope={data.scope} />
              {/* With no Space and no session the centred empty state is the whole page: no "Spaces (0)" beside it. */}
              {!(wide && herdEmpty && data.workspaces.length === 0) && (
              <SpaceOverview
                workspaces={isolateSpaces(data.workspaces, isolatedSpaces)}
                agents={navPanes.agents}
                shellPanes={navPanes.shellPanes}
                host={navHost}
                onOpen={drillInto}
                onNewSpace={openNew}
                creatingSpace={creatingSpace}
                open={spacesOpen}
                onOpenChange={setSpacesOpen}
                scope={data.scope}
              />
              )}
              {!programsFirst && <ProgramSection programs={programs} servers={data.servers} onOpen={openProgram} />}
              {/* The Tricks Space (M94 slice 03): a trick's own sessions, after the Programs, outside the
                  herd's groups and counts. Nothing when no trick has a session part. */}
              <TrickSpaceSection sessions={data.trickSessions ?? NO_TRICK_SESSIONS} onOpen={openTrickSession} />
            </>,
            )}
            </>,
          )}
        </main>

        {wide ? (
          <WideColumn width={columnWidth}>
            {/* Under the grid the foot lines stand in the first Space's column; under a centred column (Files, Crew,
                the durable home, an empty dashboard) they centre with it. */}
            <div className={cn((emptyHome || !gridList) && !filesWide && "mx-auto")} style={{ width: SPACE_WIDTH }}>
              <PhoneParts on>{footer}</PhoneParts>
            </div>
          </WideColumn>
        ) : (
          footer
        )}
      </div>

      {/* The dashboard's footer (ADR 0066, ADR 0085, both amended 2026-11-10): lists, each named for what
          it holds. Crew first while a crew is configured, then Dashboard, the default, then Files, then
          the Hill, a fixed item that opens its own route, and the tricks' items after it. It sits OUTSIDE
          the scroller, so the content scrolls above it and a switch moves neither it nor the strip and
          summary line at the top of the list. Not on a large screen, where the views control in the header
          offers the same views and items (ADR 0158, addendum 2026-11-21). Its height is the same 56px row in both of its
          modes, so the sums below hold. */}
      {tabBar}

      {/* Status overlay, anchored to the bottom of the viewport (no input here) — same slim line,
          floating so it never shifts the list. Stays outside the scroller so it never scrolls away.

          `dock="bottom"` because this screen has no composer for a toast to collide with; the pane
          screen docks its own to the top for the opposite reason. The positioning — the portal, the
          z-rung, the safe-area inset — belongs to ToastViewport and is stated there once, which is
          what stopped it being three hand-rolled copies of the same four utilities. DESIGN.md §1. */}
      {/* Lifted by the footer's 56px row and its 1px rule, so a toast floats above the tabs. */}
      {/* With the New button drawn, the lift also clears it: the footer's 56px and 1px rule, the
          button's 16px gap and 48px face (the `bottom-` of the Fab below), so a toast floats above
          the button's top edge, never over it. Capability, not the button's transient hides. */}
      <ToastViewport
        className={
          footBar
            ? fabFloat
              ? "bottom-[calc(3.5rem+1px+1rem+3rem)]"
              : "bottom-[calc(3.5rem+1px)]"
            : fabFloat
              ? "bottom-[calc(env(safe-area-inset-bottom)_+_1rem_+_3rem)]"
              : "bottom-[env(safe-area-inset-bottom)]"
        }
      >
        <StatusArea />
      </ToastViewport>

      {/* A workspace heading's New tab sheet (M91), one for the list. */}
      {plus.sheet}
      {/* The pane menu a row's hold opens: the pane pill's sheet, with no read rows, so Pin to top
          leads. Mounted at the route's root, a sibling of the other sheets, for the stacking reason
          agent-chat.tsx gives for its own. */}
      <PaneActionsSheet
        open={held !== null}
        onClose={() => setHeld(null)}
        pane={held}
        scope={held === null ? data.scope : paneScope(data.scope, held, data.servers, data.sessions)}
        readOnly={readOnly}
        // The herd on screen is the saved copy: its ids may have been reused, so nothing is renamed,
        // focused or closed from it (the sheet shows a note, `useSpaceActions` refuses the creates).
        savedCopy={data.stale === true}
        onRenamed={() => revalidator.revalidate()}
        onClosed={() => revalidator.revalidate()}
        herd={herd}
        onPinChange={(pane) => setReveal({ rowKey: paneRowKey(pane) })}
      />

      {fabFloat && !sheetOpen && !keyboardOpen && (
        <Fab
          label={t("home.new.label")}
          // The footer's 56px row and 1px rule and the safe area under it, then 16px of air.
          bottom={
            footBar
              ? "bottom-[calc(3.5rem_+_1px_+_env(safe-area-inset-bottom)_+_1rem)]"
              : "bottom-[calc(env(safe-area-inset-bottom)_+_1rem)]"
          }
          busy={creatingSpace || launching.size > 0}
          collapsed={scrolled}
          columnWidth={wide ? columnWidth : undefined}
          onClick={openNew}
        />
      )}
    </div>
  );
}

/**
 * Whether the element's scroll position is past `threshold` px. One passive listener, and a state
 * change only when the answer flips, so a scroll repaints the button twice per trip, not per frame.
 */
function useScrolledPast(ref: RefObject<HTMLElement | null>, threshold: number): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const read = () => setPast(el.scrollTop > threshold);
    read();
    el.addEventListener("scroll", read, { passive: true });
    return () => el.removeEventListener("scroll", read);
  }, [ref, threshold]);
  return past;
}
