import { useState } from "react";
import { useNavigate } from "react-router";

import { AppHeader, SettingsGear } from "@/components/app-header";
import { SessionSwitcher } from "@/components/session-switcher";
import { ServerSwitcher } from "@/components/server-switcher";
import { PullToRefresh } from "@/components/pull-to-refresh";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { AgentList } from "@/components/agent-list";
import { SpaceOverview } from "@/components/space-overview";
import { NewSpaceSheet, type WorktreeRepo } from "@/components/new-space-sheet";
import { StatusArea } from "@/components/status-area";
import { BuildStamp } from "@/components/build-stamp";
import { PackFooterLink } from "@/components/pack-footer-link";
import { UpdateBanner } from "@/components/update-banner";
import { useDashPrefs, openForCount } from "@/hooks/use-dash-prefs";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { useSpaceActions } from "@/hooks/use-spaces";
import { useMuxCapability } from "@/lib/mux-capability";
import { createWorktree } from "@/lib/api";
import { describeApiError } from "@/lib/api-error-message";
import { setStatus } from "@/lib/status";
import { leadHost, paneScope, sessionsOnHost } from "@/lib/hosts";
import { panePath, spacePath } from "@/lib/nav";
import type { AgentView } from "@/lib/types";
import { useRootData } from "@/lib/route-data";

// Dashboard home screen. Everything you might ACT on comes first — Needs you → Ready · unseen →
// Working → Recent (see lib/triage.ts) — and the Spaces navigator sits last, under the thing it
// navigates to. Recent and Spaces fold; fold both and the page is the triaged herd and nothing else.
// Tapping an agent opens its pane; tapping a space drills into /space/:id.
export function HomeRoute() {
  const data = useRootData();
  // A stalled load (a black-holed poll, or a pane-open tap whose navigation hangs) gallops the
  // Collie mark within the threshold — instant feedback while you're still on the dashboard, even
  // though the tap otherwise shows no visual change until its loader finally settles or times out.
  const stalled = useLoadingStalled();
  const navigate = useNavigate();
  const { newSpace } = useSpaceActions();

  // Which repos a worktree could be branched from: one entry per repo, taken from the space that
  // shows the repo ITSELF (a worktree's own space would branch from the same repo, so listing both
  // would offer the same thing twice under two names). In the spaces list's order, so the first
  // entry — the sheet's default — is the repo most recently used.
  const canCreateWorktree = useMuxCapability("createWorktree");
  const worktreeRepos: WorktreeRepo[] = canCreateWorktree
    ? data.workspaces
        .filter((w) => w.repoRoot !== undefined && w.isWorktree === false)
        .map((w) => ({ workspaceId: w.workspaceId, repoRoot: w.repoRoot!, label: w.label }))
    : [];
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const { prefs, setSpacesOpen, setRecentOpen, setRecentDir } = useDashPrefs();
  // No stored choice yet? The space count decides — a two-space install shouldn't be handed a
  // mystery collapsed header, and a forty-space one shouldn't be handed a wall.
  const spacesOpen = openForCount(prefs.spacesOpen, data.workspaces.length);

  // A row is opened with the PANE's host, never the ambient one: the dashboard is one list across
  // every machine (hosts are a label, not a split), so the row you tapped may well live somewhere
  // other than where the URL currently points. Resolving it here is what stops a reply landing on the
  // right pane name on the wrong terminal. Solo: every pane is untagged, so this is `data.scope`.
  const open = (pane: AgentView) =>
    navigate(panePath(pane.paneId, paneScope(data.scope, pane, data.servers)));
  const drillInto = (id: string) => navigate(spacePath(id, data.scope));
  // The space navigator is LEAD-LOCAL (the merge deliberately does not union peer workspaces — their
  // ids are only unique per machine), so the spaces on screen belong to the lead and their panes must
  // be looked up under the lead's host. Undefined when solo, which keys everything exactly as before.
  const navHost = leadHost(data.servers);
  // Sessions are a per-host registry, so the session switcher only ever lists this host's.
  const sessionsHere = sessionsOnHost(data.sessions ?? [], data.scope, data.servers);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      {/* The dashboard header: wordmark + the session switcher (dashboard-only), then the shared pill
          and the Settings gear. The switcher self-hides on a single-session install. */}
      <AppHeader
        bridge={data.bridge}
        error={data.error}
        stalled={stalled}
        wordmark
        rightLead={
          <>
            {/* Host first, then session — outer dimension first, and the two are deliberately
                different shapes (bordered server pill vs filled layers capsule) so a glance can tell
                "change machine" from "change session on this machine". Both self-hide. */}
            <ServerSwitcher servers={data.servers} scope={data.scope} agents={data.agents} />
            <SessionSwitcher sessions={sessionsHere} scope={data.scope} />
          </>
        }
        rightTrail={<SettingsGear scope={data.scope} />}
      />

      {/* Content region below the header: a viewport-clipped internal scroller, with the pull
          gesture on it — one thumb asking the bridge to look at its multiplexer now. */}
      <PullToRefresh scope={data.scope} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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
            error={data.error}
            lastSeenAt={data.lastSeenAt}
          />
          <SpaceOverview
            workspaces={data.workspaces}
            agents={data.agents}
            shellPanes={data.shellPanes}
            host={navHost}
            onOpen={drillInto}
            onNewSpace={() => setNewSpaceOpen(true)}
            open={spacesOpen}
            onOpenChange={setSpacesOpen}
          />
        </main>

        {/* The footer is the dashboard's meta zone, in widening order: the pack you're part of, an
            available update / needed restart, then the build stamp (which bundle you're running,
            with a stale-cache nudge). The pack line self-hides on a solo install. */}
        <PackFooterLink scope={data.scope} className="px-3 pt-3" />
        <UpdateBanner className="px-3 pt-3" />
        <BuildStamp className="px-3 pt-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]" />
      </PullToRefresh>

      {/* Status overlay, anchored to the bottom of the viewport (no input here) — same slim line,
          floating so it never shifts the list. Stays outside the scroller so it never scrolls away. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-screen-sm px-3 pb-[calc(env(safe-area-inset-bottom)_+_0.75rem)]">
        <StatusArea />
      </div>

      <NewSpaceSheet
        open={newSpaceOpen}
        onClose={() => setNewSpaceOpen(false)}
        onCreate={newSpace}
        repos={worktreeRepos}
        onCreateWorktree={(workspaceId, branch) => {
          void (async () => {
            const res = await createWorktree(workspaceId, branch, data.scope);
            // Same promise the sheet on a space makes: the phone goes to the new pane, the
            // operator's own screen is not moved.
            if (res.ok) navigate(panePath(res.pane.paneId, data.scope));
            else setStatus(describeApiError(res), "error");
          })();
        }}
      />
    </div>
  );
}
