import { ListTree, Network, Rows3 } from "lucide-react";
import { useEffect, useMemo, useState, type RefObject } from "react";
import { useRevalidator } from "react-router";

import { RouteHeader, SettingsGear } from "@/components/app-header";
import { SessionSwitcher } from "@/components/session-switcher";
import { ServerSwitcher } from "@/components/server-switcher";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { AgentList } from "@/components/agent-list";
import { PaneActionsSheet } from "@/components/pane-actions-sheet";
import { LaunchStrip } from "@/components/launch-strip";
import { SpaceOverview } from "@/components/space-overview";
import { StatusArea } from "@/components/status-area";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { BuildStamp } from "@/components/build-stamp";
import { CrewFooterLink } from "@/components/crew-footer-link";
import { useCrew } from "@/components/crew-provider";
import { CrewTab } from "@/components/crew-tab";
import { UpdateBanner } from "@/components/update-banner";
import { Fab } from "@/components/ui/fab";
import { useAnySheetOpen } from "@/components/ui/sheet";
import { TabBar } from "@/components/ui/tab-bar";
import { WorkspaceChangesList, type WorkspaceChangesRow } from "@/components/workspace-changes-list";
import { useDashPrefs, openForCount } from "@/hooks/use-dash-prefs";
import { useKeyboardOpen } from "@/hooks/use-keyboard";
import { useLocale } from "@/hooks/use-locale";
import { useWorkspaceChangeCounts } from "@/hooks/use-workspace-change-counts";
import { useSpaceActions } from "@/hooks/use-spaces";
import { useNav } from "@/hooks/use-nav";
import { usePaneOpen } from "@/hooks/use-pane-open";
import { useScrollMemory } from "@/hooks/use-scroll-memory";
import { useLaunchers } from "@/lib/launchers";
import { useMuxCapability } from "@/lib/mux-capability";
import { setStatus } from "@/lib/status";
import { isolateSpaces } from "@/lib/spaces";
import { ambientHost, ambientPanes, isMultiHost, paneRowKey, paneScope, sessionsOnHost } from "@/lib/hosts";
import { setMachineHidden, useHiddenMachines } from "@/lib/hidden-machines";
import type { ChangesLookup } from "@/lib/api";
import type { DashView } from "@/lib/dash-view";
import { t, tn } from "@/lib/i18n";
import { prefetchFolders } from "@/lib/folders";
import { glideForward } from "@/lib/glide";
import { newPath, spaceChangesPath, spacePath } from "@/lib/nav";
import type { WorkspaceGroup } from "@/lib/pane-groups";
import { scopeKey, type Scope } from "@/lib/scope";
import { countBlocked, hasReady } from "@/lib/triage";
import { usePairing } from "@/lib/pairing";
import { usePins } from "@/lib/pins";
import { isReadOnly, type AgentView, type ServerSummary, type SessionSummary } from "@/lib/types";
import { useRootData } from "@/lib/route-data";

/**
 * The Changes tab's body (ADR 0066). Mounted only while that tab is selected, so its 5-second
 * refresh starts when the tab opens and stops when the operator leaves it. One row per workspace the
 * strip leaves shown, each asked on the machine and session its panes live on.
 */
function ChangesTabBody({
  groups,
  scope,
  servers,
  sessions,
  lookup,
}: {
  groups: readonly WorkspaceGroup[];
  scope: Scope;
  servers: readonly ServerSummary[] | undefined;
  sessions: readonly SessionSummary[] | undefined;
  lookup: ChangesLookup;
}) {
  const nav = useNav();
  const rows = useMemo<WorkspaceChangesRow[]>(
    () =>
      groups.flatMap((g) => {
        // A group is never empty (it exists because a pane is in it), and every pane of it shares
        // one workspace, machine and session, so its first pane addresses the whole workspace.
        const first = g.panes[0];
        if (first === undefined) return [];
        return [{ key: g.key, label: g.label, workspaceId: first.workspaceId, scope: paneScope(scope, first, servers, sessions) }];
      }),
    [groups, scope, servers, sessions],
  );
  const counts = useWorkspaceChangeCounts(rows, lookup, true);
  return (
    <WorkspaceChangesList
      rows={rows}
      counts={counts}
      onOpen={(row, from) => {
        const to = spaceChangesPath(row.workspaceId, row.scope);
        glideForward("changes", to, () => nav.down(to), from);
      }}
    />
  );
}

// Dashboard home screen. Every pane sits under the workspace it lives in, in the multiplexer's own
// order (lib/pane-groups.ts, ADR 0063); urgency is a mark on a row and a heading and one summary
// line on top, never a position. The operator may ask for Activity or Cache order instead, with the
// order select under that line (ADR 0071): one ranked list, read once and held. The Spaces navigator sits
// last, under the thing it navigates to.
// Launchers sit directly above Spaces: they are one-tap act-on-able actions like the herd above
// them, but they CREATE rather than triage, so they sit under the herd and above the navigator
// their new Space will appear in. Tapping an agent opens its pane; tapping a space drills into
// /space/:id; tapping a launcher creates a throwaway Space and types its command.
export function HomeRoute() {
  const data = useRootData();
  const nav = useNav();
  const { creatingSpace, newTab, creatingTab, launching } = useSpaceActions();
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
    setIsolatedSpace,
    toggleHiddenSpace,
    setDashView,
    setNeedsYouOnly,
    setPaneOrder,
  } = useDashPrefs();
  // The Crew tab exists only while a crew is configured, the condition CrewFooterLink uses. A device
  // that stored "crew" and then lost its crew sees the Dashboard, and the stored choice is left alone,
  // so the tab is back where it was when the crew returns (ADR 0085).
  const { multi } = useCrew();
  const view: DashView = prefs.dashView === "crew" && !multi ? "dashboard" : prefs.dashView;
  // The needs-you switch filters the Dashboard list only: Crew and Changes draw their own bodies.
  const needsYouOnly = view === "dashboard" && prefs.needsYouOnly;
  // The Dashboard tab's corner mark (ADR 0066, carried by the Focus tab until ADR 0085 moved it): a red count of the panes
  // blocked on you, or, when none is blocked, a quiet dot for finished panes you have not opened. A
  // count means something waits on you; the dot only says there is something new. The list itself
  // still holds both kinds.
  const blockedCount = countBlocked(data.agents);
  const readyUnseen = blockedCount === 0 && hasReady(data.agents);
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
  const canCreateSpace = useMuxCapability("createSpace").capable;
  const fabOffered = view === "dashboard" && !readOnly && (canCreateSpace || launchers.length > 0);
  const openNew = () => {
    if (data.stale === true) return setStatus(t("space.readOnly.savedCopy"), "error");
    // THE ONE NEW PAGE (M48 spec 01): the floating button, the Spaces header's folder button and the
    // empty dashboard's first-agent card all go to it, on the machine this view shows.
    nav.down(newPath({ machine: data.scope.host, session: data.scope.session }));
  };
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
  // "+ New" shrinks to the round "+" once the list has scrolled, and grows back at the top (card 3.2).
  const scrolled = useScrolledPast(scrollRef, 24);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      {/* The dashboard header: wordmark + the session switcher (dashboard-only), then the shared pill
          and the Settings gear. The switcher self-hides on a single-session install. */}
      <RouteHeader
        wordmark
        width="column"
        rightLead={
          <>
            {/* Host first, then session — outer dimension first, and the two are deliberately
                different shapes (bordered server pill vs filled layers capsule) so a glance can tell
                "change machine" from "change session on this machine". Both self-hide. */}
            <ServerSwitcher servers={data.servers} scope={data.scope} agents={data.agents} />
            <SessionSwitcher sessions={sessionsHere} scope={data.scope} viewAll={data.viewAll} />
          </>
        }
        rightTrail={<SettingsGear scope={data.scope} />}
      />

      {/* Content region below the header: a viewport-clipped internal scroller. `relative` is
          load-bearing: it makes this scroller the containing block for its absolutely-positioned
          descendants. Tailwind's `sr-only` is `position: absolute`, so every status label in the
          list would otherwise escape this scroller's clip and grow the document's own scrollbar. */}
      <div ref={scrollRef} className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        {/* A notice BELOW the header is content, not viewport chrome: it is an inset box on the
            page gutter, not a full-bleed strip. Full-bleed it ran its left edge 16px outside the
            list it sat on top of — two left edges stacked, the loudest misalignment on the page. */}
        <ReadOnlyBanner device={data.device} />

        <main className="flex-1">
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
            <div className="px-4 py-4">
              <CrewTab />
            </div>
          ) : (
            <AgentList
              agents={data.agents}
              shellPanes={data.shellPanes}
              bridge={data.bridge}
              onOpen={paneOpen.open}
              glideKeyOf={paneOpen.glideKeyOf}
              onPress={paneOpen.press}
              error={data.error}
              notPaired={notPaired}
              lastSeenAt={data.lastSeenAt}
              stale={data.stale === true}
              tabs={data.tabs}
              servers={data.servers}
              // Each workspace heading's "+" (M40/03): the list resolves each heading's own machine and
              // session from these, the way a row's tap does, and sends the create there.
              newTab={{
                scope: data.scope,
                sessions: data.sessions,
                creating: creatingTab,
                onNewTab: (workspaceId, at) => void newTab(workspaceId, at),
              }}
              isolated={prefs.isolatedSpace}
              hidden={prefs.hiddenSpaces}
              onIsolate={setIsolatedSpace}
              onToggleHidden={toggleHiddenSpace}
              hiddenMachines={hiddenMachines}
              addressedHost={data.scope.host}
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
              renderBody={
                view === "changes"
                  ? (shown) => (
                      <ChangesTabBody
                        groups={shown}
                        scope={data.scope}
                        servers={data.servers}
                        sessions={data.sessions}
                        lookup={lookup}
                      />
                    )
                  : undefined
              }
            />
          )}
          {/* Launch and the Spaces navigator belong to the whole herd, so they sit under the Dashboard
              with the needs-you switch off. The filtered list and the other tabs are narrower, and
              a launcher under them would read as part of that list. */}
          {view === "dashboard" && !needsYouOnly && (
            <>
              <LaunchStrip open={launchOpen} onOpenChange={setLaunchOpen} scope={data.scope} />
              <SpaceOverview
                workspaces={isolateSpaces(data.workspaces, prefs.isolatedSpace)}
                agents={navPanes.agents}
                shellPanes={navPanes.shellPanes}
                host={navHost}
                onOpen={drillInto}
                onNewSpace={openNew}
                creatingSpace={creatingSpace}
                open={spacesOpen}
                onOpenChange={setSpacesOpen}
              />
            </>
          )}
        </main>

        {/* The footer is the dashboard's meta zone, in widening order: the crew you're part of, an
            available update / needed restart, then the build stamp (which bundle you're running,
            with a stale-cache nudge). The crew line self-hides on a solo install. */}
        <CrewFooterLink scope={data.scope} className="px-4 pt-3" />
        <UpdateBanner className="px-4 pt-3" />
        {/* The footer below owns the safe area now, so the stamp only keeps its own air. */}
        {/* With the New button drawn, the stamp's air grows so the last row scrolls clear of it:
            16px gap + 56px button + 8px, from the footer's top edge. Set by capability, not by the
            button's transient hides, so a sheet or the keyboard never moves the list. */}
        <BuildStamp className={fabOffered ? "px-4 pt-3 pb-20" : "px-4 pt-3 pb-2"} />
      </div>

      {/* The dashboard's footer (ADR 0066, ADR 0085): lists, each named for what it holds. Crew
          first while a crew is configured, then Dashboard, the default, in the middle under the
          thumb, then Files. It sits OUTSIDE the scroller, so the content scrolls above it and a
          switch moves neither it nor the strip and summary line at the top of the list. At every width: the dashboard has no sidebar on a wide screen (it is one
          centred column), so nothing else offers these views. */}
      <TabBar<DashView>
        label={t("home.tabs.aria")}
        active={view}
        onSelect={setDashView}
        items={[
          // Crew leads, drawn only while a crew is configured (ADR 0085). Network is the Crew icon
          // the Settings card, the switcher sheet and the footer line wear.
          ...(multi ? [{ value: "crew" as const, label: t("crew.title"), icon: <Network className="size-5" /> }] : []),
          // The Dashboard tab carries the corner mark the Focus tab wore (ADR 0066 point 7), always:
          // it is information about the herd, not a nag, so it shows with the switch on or off.
          {
            value: "dashboard",
            label: t("home.tabs.dashboard"),
            icon: <Rows3 className="size-5" />,
            badge: blockedCount,
            dot: readyUnseen,
            badgeLabel: blockedCount > 0 ? tn("home.tabs.blocked", blockedCount) : t("home.tabs.unseen"),
          },
          // The Files tab (2026-10-06, ADR 0085): the stored value stays `changes`. ListTree is the
          // one Files icon: the pane belt's pill and the Files screen's Tree toggle wear it.
          { value: "changes", label: t("files.title"), icon: <ListTree className="size-5" /> },
        ]}
      />

      {/* Status overlay, anchored to the bottom of the viewport (no input here) — same slim line,
          floating so it never shifts the list. Stays outside the scroller so it never scrolls away.

          `dock="bottom"` because this screen has no composer for a toast to collide with; the pane
          screen docks its own to the top for the opposite reason. The positioning — the portal, the
          z-rung, the safe-area inset — belongs to ToastViewport and is stated there once, which is
          what stopped it being three hand-rolled copies of the same four utilities. DESIGN.md §1. */}
      {/* Lifted by the footer's 56px row and its 1px rule, so a toast floats above the tabs. */}
      {/* With the New button drawn, the lift also clears it: the footer's 56px and 1px rule, the
          button's 16px gap and 56px face (the `bottom-` of the Fab below), so a toast floats above
          the button's top edge, never over it. Capability, not the button's transient hides. */}
      <ToastViewport className={fabOffered ? "bottom-[calc(3.5rem+1px+1rem+3.5rem)]" : "bottom-[calc(3.5rem+1px)]"}>
        <StatusArea />
      </ToastViewport>

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

      {fabOffered && !sheetOpen && !keyboardOpen && (
        <Fab
          label={t("home.new.label")}
          // The footer's 56px row and 1px rule and the safe area under it, then 16px of air.
          bottom="bottom-[calc(3.5rem_+_1px_+_env(safe-area-inset-bottom)_+_1rem)]"
          busy={creatingSpace || launching.size > 0}
          collapsed={scrolled}
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
