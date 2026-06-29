import { useState } from "react";
import { useLocation, useNavigate, useRouteLoaderData } from "react-router-dom";

import { ConnectionBar } from "@/components/connection-bar";
import { AgentList } from "@/components/agent-list";
import { SpaceStrip } from "@/components/space-strip";
import { SpaceView } from "@/components/space-view";
import { TabStrip } from "@/components/tab-strip";
import { NewSpaceSheet } from "@/components/new-space-sheet";
import { StatusArea } from "@/components/status-area";
import { useOnline } from "@/hooks/use-online";
import { useSpaceActions } from "@/hooks/use-spaces";
import type { HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";

// Triage home screen. Reads the herd from the root loader; tapping an agent navigates to its pane.
// A space strip at the top switches between the agent triage ("All") and a single space's tab/pane
// view (where shell panes live, and you create new tabs).
export function HomeRoute() {
  const data = useRouteLoaderData("root") as HomeData;
  const online = useOnline();
  const navigate = useNavigate();
  const location = useLocation();
  const { newTab, newSpace } = useSpaceActions();

  // A space can be pre-selected by the nav hub (it navigates here with `{ state: { space } }`).
  const initialSpace = (location.state as { space?: string } | null)?.space ?? null;
  const [space, setSpace] = useState<string | null>(initialSpace);
  const [tab, setTab] = useState<string | null>(null);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);

  const open = (id: string) => navigate(panePath(id));
  const selectedWs = space ? data.workspaces.find((w) => w.workspaceId === space) : undefined;

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-screen-sm flex-col">
      <ConnectionBar online={online} bridge={data.bridge} error={data.error} />

      {data.workspaces.length > 0 && (
        <SpaceStrip
          workspaces={data.workspaces}
          agents={data.agents}
          selected={space}
          onSelect={(id) => {
            setSpace(id);
            setTab(null);
          }}
          onNewSpace={() => setNewSpaceOpen(true)}
        />
      )}

      {selectedWs && (
        <TabStrip
          workspaceId={selectedWs.workspaceId}
          tabs={data.tabs}
          agents={data.agents}
          selected={tab}
          onSelect={setTab}
          onNewTab={newTab}
        />
      )}

      <main className="flex-1">
        {selectedWs ? (
          <SpaceView
            workspace={selectedWs}
            tabs={data.tabs}
            agents={data.agents}
            shellPanes={data.shellPanes}
            selectedTab={tab}
            onOpen={open}
          />
        ) : (
          <AgentList agents={data.agents} bridge={data.bridge} onOpen={open} />
        )}
      </main>

      {/* Status overlay, anchored to the bottom of the viewport (no input here) — same slim line,
          floating so it never shifts the list. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-screen-sm px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)]">
        <StatusArea />
      </div>

      <NewSpaceSheet open={newSpaceOpen} onClose={() => setNewSpaceOpen(false)} onCreate={newSpace} />
    </div>
  );
}
