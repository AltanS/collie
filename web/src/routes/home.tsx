import { useState } from "react";
import { useLocation, useNavigate, useRouteLoaderData } from "react-router";

import { ConnectionBar } from "@/components/connection-bar";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { AgentList } from "@/components/agent-list";
import { SpaceOverview } from "@/components/space-overview";
import { SpaceStrip } from "@/components/space-strip";
import { SpaceView } from "@/components/space-view";
import { TabStrip } from "@/components/tab-strip";
import { NewSpaceSheet } from "@/components/new-space-sheet";
import { StatusArea } from "@/components/status-area";
import { BuildStamp } from "@/components/build-stamp";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { useOnline } from "@/hooks/use-online";
import { useSpaceActions } from "@/hooks/use-spaces";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import { navigateWithTransition, viewTransition } from "@/lib/view-transition";

// Dashboard home screen. Reads the herd from the root loader. Default view = a Spaces overview (each
// space with its tab/pane counts and worst-agent status) over the agent triage (Needs you / Working
// / Idle · done); tapping an agent opens its pane. Tapping a space drills into its tab/pane view
// (where shell panes live and you create new tabs), with a SpaceStrip whose "All" chip returns here.
export function HomeRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const online = useOnline();
  // A stalled load (a black-holed poll, or a pane-open tap whose navigation hangs) gallops the
  // Collie mark within the threshold — instant feedback while you're still on the dashboard, even
  // though the tap otherwise shows no visual change until its loader finally settles or times out.
  const stalled = useLoadingStalled();
  const navigate = useNavigate();
  const location = useLocation();
  const { newTab, newSpace } = useSpaceActions();

  // A space can be pre-selected by the nav hub (it navigates here with `{ state: { space } }`).
  const initialSpace = (location.state as { space?: string } | null)?.space ?? null;
  const [space, setSpace] = useState<string | null>(initialSpace);
  const [tab, setTab] = useState<string | null>(null);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);

  const open = (id: string) => navigateWithTransition(navigate, panePath(id, data.session), "forward");
  // Drill into a space (forward), pop back to the dashboard (backward), or switch sibling space/tab
  // (lateral crossfade) — all are React-state swaps on this one route, so they animate via
  // viewTransition() rather than the router. The persistent header stays pinned (app-header group).
  const drillInto = (id: string) => viewTransition("forward", () => { setSpace(id); setTab(null); });
  const toDashboard = () => viewTransition("backward", () => { setSpace(null); setTab(null); });
  const switchSpace = (id: string) => viewTransition("none", () => { setSpace(id); setTab(null); });
  const switchTab = (id: string | null) => viewTransition("none", () => setTab(id));
  const selectedWs = space ? data.workspaces.find((w) => w.workspaceId === space) : undefined;

  return (
    <div className="mx-auto flex h-[100dvh] max-w-screen-sm flex-col">
      <ConnectionBar
        online={online}
        bridge={data.bridge}
        error={data.error}
        stalled={stalled}
        onHome={toDashboard}
        sessions={data.sessions}
        session={data.session}
        showSessionSwitcher={!selectedWs}
      />

      {/* Content region below the header: a viewport-clipped internal scroller that owns the `page`
          view-transition snapshot. Because it captures its visible box (not the full document
          height), a slide shows exactly what's on screen, and the sticky header stays out of the
          animation entirely (see index.css → View transitions). */}
      <div className="vt-page flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ReadOnlyBanner device={data.device} />

        {selectedWs ? (
          // Drill-in: one space's tabs + panes, with the space/tab strips for in-space navigation.
          // The SpaceStrip's "All" chip clears the selection and returns to the dashboard.
          <>
            <SpaceStrip
              workspaces={data.workspaces}
              agents={data.agents}
              selected={space}
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
        ) : (
          // Dashboard: spaces (with tab/pane counts) on top, the agent triage below.
          <main className="flex-1">
            <SpaceOverview
              workspaces={data.workspaces}
              agents={data.agents}
              onOpen={drillInto}
              onNewSpace={() => setNewSpaceOpen(true)}
            />
            <AgentList agents={data.agents} bridge={data.bridge} onOpen={open} />
          </main>
        )}

        {/* Build stamp: which bundle you're running, with a stale-cache nudge. */}
        <BuildStamp className="px-3 pt-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]" />
      </div>

      {/* Status overlay, anchored to the bottom of the viewport (no input here) — same slim line,
          floating so it never shifts the list. Stays outside the scroller so it never scrolls away. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-screen-sm px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)]">
        <StatusArea />
      </div>

      <NewSpaceSheet open={newSpaceOpen} onClose={() => setNewSpaceOpen(false)} onCreate={newSpace} />
    </div>
  );
}
