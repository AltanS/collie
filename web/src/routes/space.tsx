import { useEffect, useRef, useState } from "react";
import { useParams, useRevalidator } from "react-router";

import { RouteHeader, SettingsGear } from "@/components/app-header";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { SpaceStrip } from "@/components/space-strip";
import { SpaceView } from "@/components/space-view";
import { TabStrip } from "@/components/tab-strip";
import { NewSpaceSheet } from "@/components/new-space-sheet";
import { StatusArea } from "@/components/status-area";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { BuildStamp } from "@/components/build-stamp";
import { UpdateBanner } from "@/components/update-banner";
import { useSpaceActions } from "@/hooks/use-spaces";
import { useNav } from "@/hooks/use-nav";
import { usePaneOpen } from "@/hooks/use-pane-open";
import { useScrollMemory } from "@/hooks/use-scroll-memory";
import { homePath, spacePath } from "@/lib/nav";
import { ambientHost } from "@/lib/hosts";
import { scopeKey } from "@/lib/scope";
import { setStatus } from "@/lib/status";
import { isReadOnly } from "@/lib/types";
import { usePairing } from "@/lib/pairing";
import { useRootData } from "@/lib/route-data";

// Space detail route: one space's tabs + panes, with the space/tab strips for in-space navigation.
// Shares the root snapshot (no own loader), reading :spaceId from the URL — a deep-linkable,
// back-button-friendly drill-in. The SpaceStrip's "All" chip returns to the dashboard.
export function SpaceRoute() {
  const data = useRootData();
  const { spaceId = "" } = useParams();
  const nav = useNav();
  const revalidator = useRevalidator();
  const { newTab, newSpace, creatingTab, creatingSpace } = useSpaceActions();
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  // Either write gate refusing locks the tab strip's rename/close the same way (see ReadOnlyBanner).
  const { refused: notPaired } = usePairing();

  // Tab selection is ephemeral view state (no deep-link need). Reset it when the space changes:
  // navigating /space/a → /space/b does NOT remount this route (same element, new param), so without
  // this the prior space's tab id would leak across. Adjusting during render keeps it in sync with
  // no effect / no extra paint.
  const [tab, setTab] = useState<string | null>(null);
  const [tabSpace, setTabSpace] = useState(spaceId);
  if (tabSpace !== spaceId) {
    setTabSpace(spaceId);
    setTab(null);
  }

  const selectedWs = data.workspaces.find((w) => w.workspaceId === spaceId);

  // ADR 0067: the dashboard is up, another space is sideways, a pane is down.
  const toDashboard = () => nav.up(homePath(data.scope));
  const switchSpace = (id: string) => nav.side(spacePath(id, data.scope));
  const switchTab = (id: string | null) => setTab(id);
  // The machine THIS space is addressed on, not necessarily the one leading the crew. The loader's
  // `ambientSpaces` narrows `data.workspaces`/`data.tabs` to the host `?h=` names before this route
  // ever sees them (or the lead, absent one; untagged rows, i.e. every solo snapshot, pass
  // regardless) — so `selectedWs`, found in that already-narrowed list, is always the addressed
  // host's own space, and pane grouping (keyed on `(host, workspaceId)`) must use the SAME host, not
  // re-derive one from the workspace row. Keying on the lead instead matched nothing and drew every
  // tab as "(empty tab)" (#209). Undefined when solo, which is `undefined` both ways.
  const navHost = ambientHost(data.servers, data.scope.host);
  // A pane is down, and its tap glides the row into the pane header when the pane's read is in time
  // (use-pane-open.ts); the header's back arrow glides it back into this list.
  const paneOpen = usePaneOpen(data.scope, data.servers, data.sessions);

  // Same fix as home.tsx's dashboard scroller, same cause: ScreenTransition remounts this route on
  // every space<->pane move, so the scroller below is a fresh DOM node each time. Keyed on scope +
  // spaceId — a workspace id is host-scoped, so two crew members (or two herdr sessions) can each
  // have their own "space a" with independent positions. See lib/scroll-memory.ts.
  const scrollRef = useScrollMemory<HTMLDivElement>(`space:${scopeKey(data.scope)}:${spaceId}`);

  // Recover from a deleted space: once a healthy snapshot no longer has it, bounce to the dashboard
  // instead of leaving you on an empty shell. Guarded on a connected, non-stale snapshot so a
  // transient poll failure or a reconnect (or an idle-lock remount where the space died while locked)
  // doesn't evict a still-valid one. Mirrors DetailRoute's closed-pane recovery.
  // Tell "closed under you" apart from "deep-link that never resolved": track whether we ever saw
  // this space (ref write during render is idempotent — same pattern as the tab reset above). "Space
  // closed" would misdescribe /space/<bad-id>, which was never open.
  const gone = !selectedWs;
  const everExisted = useRef(false);
  if (selectedWs) everExisted.current = true;
  // Up, once per space: an up can be a step back, and a second one would climb past the dashboard.
  const exited = useRef<string | null>(null);
  useEffect(() => {
    if (gone && data.bridge === "connected" && !data.error && exited.current !== spaceId) {
      exited.current = spaceId;
      setStatus(everExisted.current ? "Space closed" : "Space not found", "info");
      nav.up(homePath(data.scope));
    }
  }, [gone, data.bridge, data.error, data.scope, nav, spaceId]);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      {/* The space header: same shell as the dashboard, minus the session switcher (you switch
          sessions from home). Wordmark + shared pill + Settings gear. Launchers live on the
          dashboard's own strip and in the pane switcher sheet, not here. */}
      <RouteHeader
        onHome={toDashboard}
        wordmark
        width="column"
        rightTrail={<SettingsGear scope={data.scope} />}
      />

      {/* Content region below the header: the viewport-clipped scroller, the same shell the
          dashboard uses — the two are one list screen at two depths. `relative` for the reason
          home.tsx gives: an `sr-only` descendant must resolve against this scroller. */}
      <div ref={scrollRef} className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        {/* Below the header, so it is content, not viewport chrome: an inset box on this route's
            gutter, like the dashboard's. See read-only-banner.tsx. */}
        <ReadOnlyBanner device={data.device} />

        {selectedWs && (
          <>
            <SpaceStrip
              workspaces={data.workspaces}
              agents={data.agents}
              host={navHost}
              selected={spaceId}
              onSelect={(id) => (id === null ? toDashboard() : switchSpace(id))}
              onNewSpace={() => setNewSpaceOpen(true)}
              creatingSpace={creatingSpace}
              onBack={toDashboard}
            />
            <TabStrip
              workspaceId={selectedWs.workspaceId}
              host={navHost}
              tabs={data.tabs}
              agents={data.agents}
              selected={tab}
              onSelect={switchTab}
              onNewTab={newTab}
              creatingTab={creatingTab.has(selectedWs.workspaceId)}
              scope={data.scope}
              readOnly={isReadOnly(data.device) || notPaired}
              onRenamed={() => revalidator.revalidate()}
              // Closing the tab you're filtered to would strand you on an empty view — fall back to
              // "All" (setTab(null)) in that case; either way revalidate so it drops out of the strip.
              onClosed={(tabId) => {
                if (tab === tabId) setTab(null);
                revalidator.revalidate();
              }}
            />
            <main className="flex-1">
              <SpaceView
                workspace={selectedWs}
                tabs={data.tabs}
                agents={data.agents}
                shellPanes={data.shellPanes}
                selectedTab={tab}
                onOpen={paneOpen.open}
                glideKeyOf={paneOpen.glideKeyOf}
                onPress={paneOpen.press}
                host={navHost}
              />
            </main>
          </>
        )}

        {/* An available update / needed restart, then the build stamp (which bundle you're
            running, with a stale-cache nudge). */}
        <UpdateBanner className="px-4 pt-3" />
        <BuildStamp className="px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]" />
      </div>

      {/* Status overlay, anchored to the bottom of the viewport. Stays outside the scroller. Same
          call as the dashboard's, and for the same reason: no composer down there to collide with.
          ToastViewport owns the position — see the note on home.tsx's copy. */}
      <ToastViewport>
        <StatusArea />
      </ToastViewport>

      <NewSpaceSheet open={newSpaceOpen} onClose={() => setNewSpaceOpen(false)} onCreate={newSpace} />
    </div>
  );
}
