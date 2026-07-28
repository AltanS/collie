import { useState } from "react";
import { useNavigate, useRouteLoaderData } from "react-router";

import { AppHeader, SettingsGear } from "@/components/app-header";
import { ThemeToggle } from "@/components/theme-control";
import { SessionSwitcher } from "@/components/session-switcher";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { AgentList } from "@/components/agent-list";
import { SpaceOverview } from "@/components/space-overview";
import { NewSpaceSheet } from "@/components/new-space-sheet";
import { StatusArea } from "@/components/status-area";
import { BuildStamp } from "@/components/build-stamp";
import { UpdateBanner } from "@/components/update-banner";
import { useDashPrefs, spacesOpenFor } from "@/hooks/use-dash-prefs";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { useSpaceActions } from "@/hooks/use-spaces";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { panePath, spacePath } from "@/lib/nav";

// Dashboard home screen. Everything you might ACT on comes first — Needs you → Ready · unseen →
// Working → Recent (see lib/triage.ts) — and the Spaces navigator sits last, under the thing it
// navigates to. Recent and Spaces fold; fold both and the page is the triaged herd and nothing else.
// Tapping an agent opens its pane; tapping a space drills into /space/:id.
export function HomeRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  // A stalled load (a black-holed poll, or a pane-open tap whose navigation hangs) gallops the
  // Collie mark within the threshold — instant feedback while you're still on the dashboard, even
  // though the tap otherwise shows no visual change until its loader finally settles or times out.
  const stalled = useLoadingStalled();
  const navigate = useNavigate();
  const { newSpace } = useSpaceActions();
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const { prefs, setSpacesOpen, setRecentOpen, setRecentDir } = useDashPrefs();
  // No stored choice yet? The space count decides — a two-space install shouldn't be handed a
  // mystery collapsed header, and a forty-space one shouldn't be handed a wall.
  const spacesOpen = spacesOpenFor(prefs.spacesOpen, data.workspaces.length);

  const open = (id: string) => navigate(panePath(id, data.session));
  const drillInto = (id: string) => navigate(spacePath(id, data.session));

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      {/* The dashboard header: wordmark + the session switcher (dashboard-only), then the shared pill
          and the Settings gear. The switcher self-hides on a single-session install. */}
      <AppHeader
        bridge={data.bridge}
        error={data.error}
        stalled={stalled}
        wordmark
        rightLead={<SessionSwitcher sessions={data.sessions ?? []} current={data.session} />}
        rightTrail={
          <>
            <ThemeToggle />
            <SettingsGear session={data.session} />
          </>
        }
      />

      {/* Content region below the header: a viewport-clipped internal scroller. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ReadOnlyBanner device={data.device} />

        <main className="flex-1">
          {/* One list, every section, in triage order. It used to be split in two so "Needs you"
              could be hoisted above the spaces overview; with Spaces last there is nothing to
              straddle. */}
          <AgentList
            agents={data.agents}
            bridge={data.bridge}
            onOpen={open}
            recentDir={prefs.recentDir}
            onRecentDirChange={setRecentDir}
            recentOpen={prefs.recentOpen}
            onRecentOpenChange={setRecentOpen}
          />
          <SpaceOverview
            workspaces={data.workspaces}
            agents={data.agents}
            shellPanes={data.shellPanes}
            onOpen={drillInto}
            onNewSpace={() => setNewSpaceOpen(true)}
            open={spacesOpen}
            onOpenChange={setSpacesOpen}
          />
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
