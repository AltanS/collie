import type { Handle } from "remix/component";

import { buildLabel } from "@web/lib/build";
import { ambientHost, ambientPanes, ambientSpaces, paneScope } from "@web/lib/hosts";
import { homePath, spacePath } from "@web/lib/nav";
import { isReadOnly, type AgentView } from "@web/lib/types";

import { PaneActionsSheet } from "../../chips/pane-actions-sheet";
import { UpdateBanner } from "../../chips/update-banner";
import { address, snapshot } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { isNotPaired } from "../../lib/pairing";
import { scrollMemory } from "../../lib/scroll";
import { setStatus } from "../../lib/status";
import { useStore } from "../../lib/store";
import { headerOf } from "../../shell/context";
import { SettingsGear } from "../../shell/header";
import type { CustomSlot } from "../../shell/header-model";
import { goSide, goUp } from "../frame/up";
import { NewSpaceSheet } from "../home/new-space-sheet";
import { openPane, paneTarget, prefetchPane } from "../home/open-pane";
import { SpaceStrip } from "./space-strip";
import { SpaceView } from "./space-view";
import { TabStrip } from "./tab-strip";

// Port of web/src/routes/space.tsx: one space's tabs and panes, with the space strip and the tab strip
// for moving about in it. It paints from the snapshot store and fetches nothing; the router keys it by
// machine, session and space id (router.tsx), so the tab filter below is born fresh per space.
//
// THE HEADER IS CLAIMED: the wordmark (Collie over "on <mux>"), the column width, the Settings gear on
// the right, and the mark's tap goes UP to the dashboard (ADR 0067: the dashboard is up, another space
// is sideways, a pane is down). Launchers live on the dashboard and in the pane switcher, not here.
//
// THE SPACE IS GONE: once a healthy snapshot no longer holds it, the screen goes up once, with a line
// saying why. "Space closed" (we saw it open) and "Space not found" (a deep link that never resolved)
// are told apart. A transient failed poll or a reconnect never evicts a space that is still valid.

const toDashboard = (): void => goUp(homePath(address.get().scope));
const switchSpace = (id: string): void => goSide(spacePath(id, address.get().scope));

export function SpaceRoute(handle: Handle<{ spaceId: string }>) {
  useLocale(handle);
  const readSnapshot = useStore(handle, snapshot);
  const readAddress = useStore(handle, address);

  // The header claim: plain data and slots made ONCE here (a fresh closure per render is a change).
  const header = headerOf(handle).owner(handle.signal);
  const right: CustomSlot = { kind: "custom", render: () => <SettingsGear /> };

  // The tab filter is view state with no deep-link need: the route is keyed per space, so it resets
  // by remounting. null is "All".
  let tab: string | null = null;
  let held: AgentView | null = null;
  let newSpaceOpen = false;
  let everExisted = false;
  let exited = false;

  const selectTab = (id: string | null): void => {
    tab = id;
    void handle.update();
  };
  // Closing the tab you are filtered to would strand you on an empty view: fall back to "All". The
  // sheet has already kicked the poll, so the tab drops out of the strip on the next read.
  const onTabClosed = (tabId: string): void => {
    if (tab === tabId) selectTab(null);
  };
  const onHold = (pane: AgentView): void => {
    held = pane;
    void handle.update();
  };
  const closeHeld = (): void => {
    held = null;
    void handle.update();
  };
  const openNewSpace = (): void => {
    newSpaceOpen = true;
    void handle.update();
  };
  const closeNewSpace = (): void => {
    newSpaceOpen = false;
    void handle.update();
  };

  return () => {
    handle.queueTask(() => header.claim({ wordmark: true, width: "column", right, home: toDashboard }));
    const { spaceId } = handle.props;
    const loaded = readSnapshot();
    const body = loaded.data;
    const scope = readAddress().scope;
    const servers = body?.servers;
    const sessions = body?.sessions;
    // The navigator is a tree of ONE machine: narrowed to the address the URL is on, by identity on a
    // solo body, so nothing here is a fresh array per poll (lib/hosts.ts).
    const workspaces = ambientSpaces(body?.workspaces ?? [], scope, servers);
    const tabs = ambientSpaces(body?.tabs ?? [], scope, servers);
    const panes = ambientPanes(body?.agents ?? [], body?.shellPanes ?? [], scope, servers, sessions);
    const selectedWs = workspaces.find((w) => w.workspaceId === spaceId);
    // The machine THIS space is addressed on, not necessarily the one leading the crew. `selectedWs`
    // was found in the already-narrowed list, so it is that host's own space, and pane grouping (keyed
    // on `(host, workspaceId)`) must use the SAME host. Keying on the lead matched nothing and drew
    // every tab as "(empty tab)" (#209). Undefined when solo.
    const navHost = ambientHost(servers, scope.host);
    const readOnly = isReadOnly(body?.device) || isNotPaired();

    if (selectedWs !== undefined) everExisted = true;
    // Up, once: an up can be a step back, and a second one would climb past the dashboard. Only a
    // connected snapshot without an error counts as evidence the space is gone.
    if (selectedWs === undefined && body?.bridge === "connected" && loaded.error === undefined && !exited) {
      exited = true;
      const line = everExisted ? "Space closed" : "Space not found";
      handle.queueTask(() => {
        setStatus(line, "info");
        toDashboard();
      });
    }

    return (
      <div class="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col" data-testid="space">
        <div class="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" data-testid="space-scroller" mix={scrollMemory()}>
          {selectedWs !== undefined && (
            <>
              <SpaceStrip
                workspaces={workspaces}
                agents={panes.agents}
                host={navHost}
                selected={spaceId}
                onSelect={switchSpace}
                onNewSpace={openNewSpace}
                onBack={toDashboard}
              />
              <TabStrip
                workspaceId={selectedWs.workspaceId}
                tabs={tabs}
                agents={panes.agents}
                host={navHost}
                selected={tab}
                onSelect={selectTab}
                scope={scope}
                readOnly={readOnly}
                onClosed={onTabClosed}
              />
              <main class="flex-1">
                <SpaceView
                  workspace={selectedWs}
                  tabs={tabs}
                  agents={panes.agents}
                  shellPanes={panes.shellPanes}
                  selectedTab={tab}
                  host={navHost}
                  onOpen={openPane}
                  onPress={prefetchPane}
                  glideKeyOf={paneTarget}
                  onHold={onHold}
                />
              </main>
            </>
          )}
          {/* An available update or a needed restart, then the build stamp. */}
          <UpdateBanner class="px-4 pt-3" />
          <div class="px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] text-center text-[11px] leading-relaxed text-muted-foreground" data-testid="build-stamp">
            <span class="font-mono">{buildLabel()}</span>
          </div>
        </div>
        <PaneActionsSheet
          open={held !== null}
          onClose={closeHeld}
          pane={held}
          scope={held === null ? scope : paneScope(scope, held, servers, sessions)}
          readOnly={readOnly}
          herd={[...panes.agents, ...panes.shellPanes]}
        />
        <NewSpaceSheet open={newSpaceOpen} onClose={closeNewSpace} />
      </div>
    );
  };
}
