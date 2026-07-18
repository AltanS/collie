import { useState } from "react";
import { useNavigate, useRouteLoaderData } from "react-router";

import { ConnectionBar } from "@/components/connection-bar";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { AgentList } from "@/components/agent-list";
import { SpaceOverview } from "@/components/space-overview";
import { NewSpaceSheet } from "@/components/new-space-sheet";
import { StatusArea } from "@/components/status-area";
import { BuildStamp } from "@/components/build-stamp";
import { UpdateBanner } from "@/components/update-banner";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { useOnline } from "@/hooks/use-online";
import { useSpaceActions } from "@/hooks/use-spaces";
import { AGENT_GROUPS } from "@/lib/agent-groups";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { panePath, spacePath } from "@/lib/nav";

// "Needs you" is the urgent triage (accented group); hoist it above everything else. The rest of the
// triage (working / idle · done) renders below the spaces overview.
const ATTENTION_GROUPS = AGENT_GROUPS.filter((g) => g.accent);
const REST_GROUPS = AGENT_GROUPS.filter((g) => !g.accent);

// Dashboard home screen. Reads the herd from the root loader. "Needs you" sits at the very top (the
// most important thing to act on), then the Spaces overview (each space with its tab/pane counts and
// worst-agent status), then the rest of the agent triage: tapping an agent opens its pane, tapping a
// space drills into its detail route (/space/:id).
export function HomeRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const online = useOnline();
  // A stalled load (a black-holed poll, or a pane-open tap whose navigation hangs) gallops the
  // Collie mark within the threshold — instant feedback while you're still on the dashboard, even
  // though the tap otherwise shows no visual change until its loader finally settles or times out.
  const stalled = useLoadingStalled();
  const navigate = useNavigate();
  const { newSpace } = useSpaceActions();
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);

  const open = (id: string) => navigate(panePath(id, data.session));
  const drillInto = (id: string) => navigate(spacePath(id, data.session));

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <ConnectionBar
        online={online}
        bridge={data.bridge}
        error={data.error}
        stalled={stalled}
        sessions={data.sessions}
        session={data.session}
      />

      {/* Content region below the header: a viewport-clipped internal scroller. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ReadOnlyBanner device={data.device} />

        <main className="flex-1">
          {/* Needs-you first — the most urgent triage, hoisted above the spaces overview. Renders
              nothing when no agent is blocked (emptyState off, so the placeholder shows only once
              below). */}
          <AgentList
            agents={data.agents}
            onOpen={open}
            groups={ATTENTION_GROUPS}
            emptyState={false}
          />
          <SpaceOverview
            workspaces={data.workspaces}
            agents={data.agents}
            onOpen={drillInto}
            onNewSpace={() => setNewSpaceOpen(true)}
          />
          <AgentList agents={data.agents} bridge={data.bridge} onOpen={open} groups={REST_GROUPS} />
        </main>

        {/* An available update / needed restart, then the build stamp (which bundle you're
            running, with a stale-cache nudge). */}
        <UpdateBanner className="px-3 pt-3" />
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
