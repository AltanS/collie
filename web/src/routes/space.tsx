import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useRouteLoaderData } from "react-router";

import { ConnectionBar } from "@/components/connection-bar";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { SpaceStrip } from "@/components/space-strip";
import { SpaceView } from "@/components/space-view";
import { TabStrip } from "@/components/tab-strip";
import { NewSpaceSheet } from "@/components/new-space-sheet";
import { StatusArea } from "@/components/status-area";
import { BuildStamp } from "@/components/build-stamp";
import { UpdateBanner } from "@/components/update-banner";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { useOnline } from "@/hooks/use-online";
import { useSpaceActions } from "@/hooks/use-spaces";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { homePath, panePath, spacePath } from "@/lib/nav";
import { setStatus } from "@/lib/status";

// Space detail route: one space's tabs + panes, with the space/tab strips for in-space navigation.
// Shares the root snapshot (no own loader), reading :spaceId from the URL — a deep-linkable,
// back-button-friendly drill-in. The SpaceStrip's "All" chip returns to the dashboard.
export function SpaceRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { spaceId = "" } = useParams();
  const online = useOnline();
  const stalled = useLoadingStalled();
  const navigate = useNavigate();
  const { newTab, newSpace } = useSpaceActions();
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);

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

  const toDashboard = () => navigate(homePath(data.session));
  const switchSpace = (id: string) => navigate(spacePath(id, data.session));
  const switchTab = (id: string | null) => setTab(id);
  const open = (id: string) => navigate(panePath(id, data.session));

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
  useEffect(() => {
    if (gone && data.bridge === "connected" && !data.error) {
      setStatus(everExisted.current ? "Space closed" : "Space not found", "info");
      navigate(homePath(data.session), { replace: true });
    }
  }, [gone, data.bridge, data.error, data.session, navigate]);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <ConnectionBar
        online={online}
        bridge={data.bridge}
        error={data.error}
        stalled={stalled}
        onHome={toDashboard}
        sessions={data.sessions}
        session={data.session}
        showSessionSwitcher={false}
      />

      {/* Content region below the header: the viewport-clipped scroller. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ReadOnlyBanner device={data.device} />

        {selectedWs && (
          <>
            <SpaceStrip
              workspaces={data.workspaces}
              agents={data.agents}
              selected={spaceId}
              onSelect={(id) => (id === null ? toDashboard() : switchSpace(id))}
              onNewSpace={() => setNewSpaceOpen(true)}
              onBack={toDashboard}
            />
            <TabStrip
              workspaceId={selectedWs.workspaceId}
              tabs={data.tabs}
              agents={data.agents}
              selected={tab}
              onSelect={switchTab}
              onNewTab={newTab}
            />
            <main className="flex-1">
              <SpaceView
                workspace={selectedWs}
                tabs={data.tabs}
                agents={data.agents}
                shellPanes={data.shellPanes}
                selectedTab={tab}
                onOpen={open}
              />
            </main>
          </>
        )}

        {/* An available update / needed restart, then the build stamp (which bundle you're
            running, with a stale-cache nudge). */}
        <UpdateBanner className="px-3 pt-3" />
        <BuildStamp className="px-3 pt-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]" />
      </div>

      {/* Status overlay, anchored to the bottom of the viewport. Stays outside the scroller. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-screen-sm px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)]">
        <StatusArea />
      </div>

      <NewSpaceSheet open={newSpaceOpen} onClose={() => setNewSpaceOpen(false)} onCreate={newSpace} />
    </div>
  );
}
