import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useRevalidator } from "react-router";

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
import { homePath, panePath, spacePath } from "@/lib/nav";
import { leadHost, paneScope } from "@/lib/hosts";
import type { AgentView } from "@/lib/types";
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
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const { newTab, newSpace } = useSpaceActions();
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

  const toDashboard = () => navigate(homePath(data.scope));
  const switchSpace = (id: string) => navigate(spacePath(id, data.scope));
  const switchTab = (id: string | null) => setTab(id);
  // Lead-local navigator (peer workspaces are not unioned), so its panes are the lead's — but the
  // pane still supplies its own host, so opening one can never point the URL at another machine.
  const navHost = leadHost(data.servers);
  const open = (pane: AgentView) =>
    navigate(panePath(pane.paneId, paneScope(data.scope, pane, data.servers, data.sessions)));

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
      navigate(homePath(data.scope), { replace: true });
    }
  }, [gone, data.bridge, data.error, data.scope, navigate]);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      {/* The space header: same shell as the dashboard, minus the session switcher (you switch
          sessions from home). Wordmark + shared pill + Settings gear. */}
      <RouteHeader
        onHome={toDashboard}
        wordmark
        width="column"
        rightTrail={<SettingsGear scope={data.scope} />}
      />

      {/* Content region below the header: the viewport-clipped scroller, the same shell the
          dashboard uses — the two are one list screen at two depths. `relative` for the reason
          home.tsx gives: an `sr-only` descendant must resolve against this scroller. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* Below the header, so it is content, not viewport chrome: an inset box on this route's
            gutter, like the dashboard's. See read-only-banner.tsx. */}
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
              host={navHost}
              tabs={data.tabs}
              agents={data.agents}
              selected={tab}
              onSelect={switchTab}
              onNewTab={newTab}
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
                onOpen={open}
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
      <ToastViewport dock="bottom">
        <StatusArea />
      </ToastViewport>

      <NewSpaceSheet open={newSpaceOpen} onClose={() => setNewSpaceOpen(false)} onCreate={newSpace} />
    </div>
  );
}
