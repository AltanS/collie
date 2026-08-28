import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { RouteHeader, SettingsGear } from "@/components/app-header";
import { SessionSwitcher } from "@/components/session-switcher";
import { ServerSwitcher } from "@/components/server-switcher";
import { PullToRefresh } from "@/components/pull-to-refresh";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { AgentList } from "@/components/agent-list";
import { SpaceOverview } from "@/components/space-overview";
import { NewSpaceSheet, type WorktreeRepo } from "@/components/new-space-sheet";
import { StatusArea } from "@/components/status-area";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { BuildStamp } from "@/components/build-stamp";
import { PackFooterLink } from "@/components/pack-footer-link";
import { UpdateBanner } from "@/components/update-banner";
import { useDashPrefs, openForCount } from "@/hooks/use-dash-prefs";
import { useSpaceActions } from "@/hooks/use-spaces";
import { useMuxCapability } from "@/lib/mux-capability";
import { createWorktree, openWorktree } from "@/lib/api";
import { describeApiError } from "@/lib/api-error-message";
import { setStatus } from "@/lib/status";
import { ambientPanes, leadHost, paneScope, sessionsOnHost } from "@/lib/hosts";
import { panePath, spacePath } from "@/lib/nav";
import type { AgentView } from "@/lib/types";
import { useRootData } from "@/lib/route-data";

// Dashboard home screen. Everything you might ACT on comes first — Needs you → Ready · unseen →
// Working → Recent (see lib/triage.ts) — and the Spaces navigator sits last, under the thing it
// navigates to. Recent and Spaces fold; fold both and the page is the triaged herd and nothing else.
// Tapping an agent opens its pane; tapping a space drills into /space/:id.
export function HomeRoute() {
  const data = useRootData();
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
    navigate(panePath(pane.paneId, paneScope(data.scope, pane, data.servers, data.sessions)));
  const drillInto = (id: string) => navigate(spacePath(id, data.scope));
  // The space navigator is LEAD-LOCAL (the merge deliberately does not union peer workspaces — their
  // ids are only unique per machine), so the spaces on screen belong to the lead and their panes must
  // be looked up under the lead's host. Undefined when solo, which keys everything exactly as before.
  const navHost = leadHost(data.servers);
  // Sessions are a per-host registry, so the session switcher only ever lists this host's.
  const sessionsHere = sessionsOnHost(data.sessions ?? [], data.scope, data.servers);
  // …AND LEAD-LOCAL IS ALSO SESSION-LOCAL, which is the half the widened view would otherwise break.
  // Workspace ids collide across sessions exactly as they collide across machines, and the space
  // navigator keys by `(host, workspaceId)` with no session in it — so on a widened body another
  // session's `w1` panes would paint their blocked dot and their recency onto the AMBIENT `w1` row,
  // and drilling in would show a space with nothing blocked in it. The list widens; the navigation
  // tree does not (that is the whole shape of this feature, and the shape the pack merge already
  // has), so the tree is fed ambient panes only. Untagged panes are ambient by definition, which
  // makes this the identity filter on every un-widened body.
  const navPanes = useMemo(
    () => ambientPanes(data.agents, data.shellPanes, data.scope, data.servers, data.sessions),
    [data.agents, data.shellPanes, data.scope, data.servers, data.sessions],
  );

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

      {/* Content region below the header: a viewport-clipped internal scroller, with the pull
          gesture on it — one thumb asking the bridge to look at its multiplexer now. */}
      <PullToRefresh scope={data.scope} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* A notice BELOW the header is content, not viewport chrome: it is an inset box on the
            page gutter, not a full-bleed strip. Full-bleed it ran its left edge 16px outside the
            list it sat on top of — two left edges stacked, the loudest misalignment on the page. */}
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
            agents={navPanes.agents}
            shellPanes={navPanes.shellPanes}
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
        <PackFooterLink scope={data.scope} className="px-4 pt-3" />
        <UpdateBanner className="px-4 pt-3" />
        <BuildStamp className="px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]" />
      </PullToRefresh>

      {/* Status overlay, anchored to the bottom of the viewport (no input here) — same slim line,
          floating so it never shifts the list. Stays outside the scroller so it never scrolls away.

          `dock="bottom"` because this screen has no composer for a toast to collide with; the pane
          screen docks its own to the top for the opposite reason. The positioning — the portal, the
          z-rung, the safe-area inset — belongs to ToastViewport and is stated there once, which is
          what stopped it being three hand-rolled copies of the same four utilities. DESIGN.md §1. */}
      <ToastViewport dock="bottom">
        <StatusArea />
      </ToastViewport>

      <NewSpaceSheet
        open={newSpaceOpen}
        onClose={() => setNewSpaceOpen(false)}
        onCreate={newSpace}
        repos={worktreeRepos}
        scope={data.scope}
        onOpenWorktree={(workspaceId, path) => {
          void (async () => {
            const res = await openWorktree(workspaceId, path, data.scope);
            // `alreadyOpen` is an answer, not a failure — either way the pane is where to go.
            if (res.ok) navigate(panePath(res.pane.paneId, data.scope));
            else setStatus(describeApiError(res), "error");
          })();
        }}
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
