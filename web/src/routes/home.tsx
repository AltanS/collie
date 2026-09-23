import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { RouteHeader, SettingsGear } from "@/components/app-header";
import { SessionSwitcher } from "@/components/session-switcher";
import { ServerSwitcher } from "@/components/server-switcher";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { AgentList } from "@/components/agent-list";
import { LaunchStrip } from "@/components/launch-strip";
import { SpaceOverview } from "@/components/space-overview";
import { NewSpaceSheet, type WorktreeRepo } from "@/components/new-space-sheet";
import { StatusArea } from "@/components/status-area";
import { ToastViewport } from "@/components/ui/toast-viewport";
import { BuildStamp } from "@/components/build-stamp";
import { CrewFooterLink } from "@/components/crew-footer-link";
import { UpdateBanner } from "@/components/update-banner";
import { useDashPrefs, openForCount } from "@/hooks/use-dash-prefs";
import { useSpaceActions } from "@/hooks/use-spaces";
import { useScrollMemory } from "@/hooks/use-scroll-memory";
import { useMuxCapability } from "@/lib/mux-capability";
import { ambientHost, ambientPanes, paneScope, sessionsOnHost } from "@/lib/hosts";
import { panePath, spacePath } from "@/lib/nav";
import { scopeKey } from "@/lib/scope";
import type { AgentView } from "@/lib/types";
import { useRootData } from "@/lib/route-data";

// Dashboard home screen. Everything you might ACT on comes first — Needs you → Ready · unseen (see
// lib/triage.ts) — then every other pane under the `space › tab` it lives in (lib/pane-groups.ts),
// and the Spaces navigator sits last, under the thing it navigates to.
// Launchers sit directly above Spaces: they are one-tap act-on-able actions like the herd above
// them, but they CREATE rather than triage, so they sit under the triaged herd and above the
// navigator their new Space will appear in. Tapping an agent opens its pane; tapping a space
// drills into /space/:id; tapping a launcher creates a throwaway Space and types its command.
export function HomeRoute() {
  const data = useRootData();
  const navigate = useNavigate();
  const { newSpace, newWorktree, showWorktree, creatingSpace } = useSpaceActions();

  // Which repos a worktree could be branched from: one entry per repo, taken from the space that
  // shows the repo ITSELF (a worktree's own space would branch from the same repo, so listing both
  // would offer the same thing twice under two names). In the spaces list's order, so the first
  // entry — the sheet's default — is the repo most recently used.
  // Asked of the machine this view is showing (M22/03): absent `?h=` is the lead, as everywhere.
  const canCreateWorktree = useMuxCapability("createWorktree", data.scope);
  const worktreeRepos: WorktreeRepo[] = canCreateWorktree
    ? data.workspaces
        .filter((w) => w.repoRoot !== undefined && w.isWorktree === false)
        .map((w) => ({ workspaceId: w.workspaceId, repoRoot: w.repoRoot!, label: w.label }))
    : [];
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const { prefs, setSpacesOpen, setLaunchOpen, setIsolatedSpace, toggleHiddenSpace } = useDashPrefs();
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
  const open = (pane: AgentView) =>
    navigate(panePath(pane.paneId, paneScope(data.scope, pane, data.servers, data.sessions)));
  const drillInto = (id: string) => navigate(spacePath(id, data.scope));
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

  // ScreenTransition remounts this whole route on every dashboard<->pane move (both directions), so
  // the scroller below is a fresh DOM node with scrollTop 0 each time — the document itself never
  // scrolls, so nothing else restores this. Keyed on the scope (host + session), so two herdr
  // sessions — or two crew members — keep independent positions. See lib/scroll-memory.ts.
  const scrollRef = useScrollMemory<HTMLDivElement>(`home:${scopeKey(data.scope)}`);

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
          {/* One list: what needs you first, then every other pane under the tab it lives in
              (components/agent-list.tsx). Bare shells go in with the agents — grouped by place they
              sit beside the work they belong to, which is what stopped them being a pen of their
              own at the bottom of the sheet. */}
          <AgentList
            agents={data.agents}
            shellPanes={data.shellPanes}
            bridge={data.bridge}
            onOpen={open}
            error={data.error}
            lastSeenAt={data.lastSeenAt}
            tabs={data.tabs}
            servers={data.servers}
            isolated={prefs.isolatedSpace}
            hidden={prefs.hiddenSpaces}
            onIsolate={setIsolatedSpace}
            onToggleHidden={toggleHiddenSpace}
          />
          <LaunchStrip open={launchOpen} onOpenChange={setLaunchOpen} scope={data.scope} />
          <SpaceOverview
            workspaces={data.workspaces}
            agents={navPanes.agents}
            shellPanes={navPanes.shellPanes}
            host={navHost}
            onOpen={drillInto}
            onNewSpace={() => setNewSpaceOpen(true)}
            creatingSpace={creatingSpace}
            open={spacesOpen}
            onOpenChange={setSpacesOpen}
          />
        </main>

        {/* The footer is the dashboard's meta zone, in widening order: the crew you're part of, an
            available update / needed restart, then the build stamp (which bundle you're running,
            with a stale-cache nudge). The crew line self-hides on a solo install. */}
        <CrewFooterLink scope={data.scope} className="px-4 pt-3" />
        <UpdateBanner className="px-4 pt-3" />
        <BuildStamp className="px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]" />
      </div>

      {/* Status overlay, anchored to the bottom of the viewport (no input here) — same slim line,
          floating so it never shifts the list. Stays outside the scroller so it never scrolls away.

          `dock="bottom"` because this screen has no composer for a toast to collide with; the pane
          screen docks its own to the top for the opposite reason. The positioning — the portal, the
          z-rung, the safe-area inset — belongs to ToastViewport and is stated there once, which is
          what stopped it being three hand-rolled copies of the same four utilities. DESIGN.md §1. */}
      <ToastViewport>
        <StatusArea />
      </ToastViewport>

      <NewSpaceSheet
        open={newSpaceOpen}
        onClose={() => setNewSpaceOpen(false)}
        onCreate={newSpace}
        repos={worktreeRepos}
        scope={data.scope}
        onOpenWorktree={(workspaceId, path) => void showWorktree(workspaceId, path)}
        onCreateWorktree={(workspaceId, branch) => void newWorktree(workspaceId, branch)}
      />
    </div>
  );
}
