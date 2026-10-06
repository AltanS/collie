import { type Handle } from "remix/component";
import { ListTree, Network, Rows3 } from "lucide";

import { buildLabel } from "@web/lib/build";
import { coerceDashView, type DashView } from "@web/lib/dash-view";
import { ambientHost, ambientPanes, isMultiHost, paneRowKey, paneScope } from "@web/lib/hosts";
import { t, tn } from "@web/lib/i18n";
import { spacePath } from "@web/lib/nav";
import { isolateSpaces } from "@web/lib/spaces";
import { countBlocked, hasReady } from "@web/lib/triage";
import { isReadOnly, type AgentView, type BridgeConfig } from "@web/lib/types";

import { navigate } from "../../lib/navigate";
import { PaneActionsSheet } from "../../chips/pane-actions-sheet";
import { creating, newTab, SPACE_CREATE_KEY } from "../../chips/space-actions";
import { UpdateBanner } from "../../chips/update-banner";
import { address, config, snapshot, snapshotAt } from "../../lib/data";
import { hiddenMachines, setMachineHidden } from "../../lib/hidden-machines";
import { useLocale } from "../../lib/i18n-store";
import { isNotPaired } from "../../lib/pairing";
import type { PaneOrder } from "../../lib/pane-order";
import { pins } from "../../lib/pins";
import { dashPrefs, setDashPref } from "../../lib/prefs";
import { scrollMemory } from "../../lib/scroll";
import { countRender } from "../../lib/render-count";
import { useStore } from "../../lib/store";
import { href } from "../../routes";
import { ReadOnlyBanner } from "../../shell/connection-banner";
import { headerOf } from "../../shell/context";
import { SettingsGear } from "../../shell/header";
import type { CustomSlot } from "../../shell/header-model";
import { Icon } from "../../ui/icon";
import { TabBar } from "../../ui/tab-bar";
import { AgentList, type HeadingNewTab } from "./agent-list";
import { CrewFooterLink } from "./crew-footer-link";
import { CrewTab } from "./crew-tab";
import { FilesTab } from "./files-tab";
import { LaunchStrip } from "./launch-strip";
import { NewSpaceSheet } from "./new-space-sheet";
import { openPane, paneTarget, prefetchPane } from "./open-pane";
import { ServerSwitcher } from "./server-switcher";
import { SessionSwitcher } from "./session-switcher";
import { SpaceOverview } from "./space-overview";

// Port of web/src/routes/home.tsx: the dashboard. The header is CLAIMED (wordmark, the column width,
// and the right cluster: server switcher, session switcher, gear; each switcher hides itself on one
// machine or one session). Under it one inner scroller (scroll memory per history entry) holds the
// list, Launch and Spaces, then the footer zone: the crew line, the update banner and the build
// stamp. The tab bar (Crew while a crew exists, Dashboard, Files) sits outside the scroller.
//
// Every read is a store (lib/data.ts, lib/prefs.ts), so this screen fetches nothing for the list;
// the Files tab and the Crew tab read their own while they are up. Prefs are the same localStorage
// keys web/ writes (`collie:dash-prefs:v1`, `collie:pins:v1`, `collie:hidden-machines:v1`), read
// before the first render, so a cold open draws what the last session left.

/** The multiplexer's sentence for why it cannot tell agents apart, or "" when it can (mux-capability.ts). */
function agentDetectionNote(cfg: BridgeConfig | undefined): string {
  const mux = cfg?.mux;
  if (mux?.capabilities?.agentDetection !== false) return "";
  return mux.notes?.agentDetection ?? "";
}

/** web/'s `openForCount`: an explicit fold choice wins, else a short list opens (COLLAPSE_THRESHOLD). */
const COLLAPSE_THRESHOLD = 8;
const NO_PANES: AgentView[] = [];
function openForCount(pref: boolean | null, count: number): boolean {
  return pref ?? count <= COLLAPSE_THRESHOLD;
}

function toggleHiddenSpace(key: string): void {
  const hidden = dashPrefs.get().hiddenSpaces;
  setDashPref("hiddenSpaces", hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]);
}

const onNewTab: HeadingNewTab["onNewTab"] = (workspaceId, at) => void newTab(workspaceId, at);
const setOrder = (order: PaneOrder): void => setDashPref("paneOrder", order);
const setView = (value: string): void => setDashPref("dashView", coerceDashView(value));

export function HomeRoute(handle: Handle) {
  useLocale(handle);
  const snap = useStore(handle, snapshot);
  const cfg = useStore(handle, config);
  const where = useStore(handle, address);
  const prefs = useStore(handle, dashPrefs);
  const readPins = useStore(handle, pins);
  const readHidden = useStore(handle, hiddenMachines);
  const readCreating = useStore(handle, creating);

  let held: AgentView | null = null;
  let reveal: { rowKey: string } | null = null;
  let newSpaceOpen = false;

  // The header claim: plain data and slots made ONCE here (a fresh closure per render is a change).
  const header = headerOf(handle).owner(handle.signal);
  const right: CustomSlot = {
    kind: "custom",
    render: () => (
      <>
        <ServerSwitcher />
        <SessionSwitcher />
        <SettingsGear />
      </>
    ),
  };

  const onHold = (pane: AgentView): void => {
    held = pane;
    void handle.update();
  };
  const closeHeld = (): void => {
    held = null;
    void handle.update();
  };
  const onPinChange = (pane: AgentView): void => {
    reveal = { rowKey: paneRowKey(pane) };
    void handle.update();
  };

  return () => {
    countRender("HomeRoute");
    handle.queueTask(() => header.claim({ wordmark: true, width: "column", right }));
    const loaded = snap();
    const body = loaded.data;
    // Nothing has answered yet: no verdict is drawn (not "Disconnected", not "No spaces yet."). The
    // first-connect cover holds the screen until the bridge says something (shell/boot-splash.tsx);
    // an HTTP answer, even a refusal, ends the wait.
    const pending = body === undefined && loaded.status === undefined;
    const p = prefs();
    const scope = where().scope;
    const servers = body?.servers;
    const sessions = body?.sessions;
    const multi = isMultiHost(servers);
    const view: DashView = p.dashView === "crew" && !multi ? "dashboard" : p.dashView;
    const needsYouOnly = view === "dashboard" && p.needsYouOnly;
    // The list takes the whole herd the snapshot carries (every machine; a hidden machine folds into
    // its stand-in chip); the Spaces navigator takes the addressed machine's panes only, as web/ does.
    const agents = body?.agents ?? NO_PANES;
    const shellPanes = body?.shellPanes ?? NO_PANES;
    const nav = ambientPanes(agents, shellPanes, scope, servers, sessions);
    const herd = [...agents, ...shellPanes];
    const blocked = countBlocked(agents);
    const readyUnseen = blocked === 0 && hasReady(agents);
    const workspaces = body?.workspaces ?? [];
    const readOnly = isReadOnly(body?.device) || isNotPaired();
    const lookup = { depth: p.changesDepth, nested: p.changesNested };
    const newTabProps: HeadingNewTab = { scope, sessions, creating: readCreating(), onNewTab };
    return (
      <div class="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col" data-testid="home">
        <div class="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" data-testid="home-scroller" mix={scrollMemory()}>
          {/* Content below the header, not viewport chrome: an inset strip on the page, as web/'s. */}
          <ReadOnlyBanner />
          <main class="flex-1">
            {view === "crew" ? (
              <div class="px-4 py-4">
                <CrewTab />
              </div>
            ) : (
              <AgentList
                agents={agents}
                shellPanes={shellPanes}
                bridge={body?.bridge}
                error={loaded.error !== undefined}
                pending={pending}
                // Read, not subscribed: the time shows only beside a failed poll, and the failure itself
                // is what re-renders this screen (freshness cannot move while polls fail).
                lastSeenAt={snapshotAt.get() === 0 ? undefined : snapshotAt.get()}
                tabs={body?.tabs ?? []}
                servers={servers}
                agentDetectionNote={agentDetectionNote(cfg().data)}
                isolated={p.isolatedSpace}
                hidden={p.hiddenSpaces}
                onIsolate={(key) => setDashPref("isolatedSpace", key)}
                onToggleHidden={toggleHiddenSpace}
                hiddenMachines={readHidden()}
                addressedHost={scope.host}
                onShowMachine={(host) => setMachineHidden(host, false, snapshot.get().data?.servers)}
                needsYouOnly={needsYouOnly}
                onNeedsYouOnlyChange={(on) => setDashPref("needsYouOnly", on)}
                pins={readPins()}
                order={p.paneOrder}
                onOrderChange={setOrder}
                newTab={newTabProps}
                onOpen={openPane}
                onPress={prefetchPane}
                glideKeyOf={paneTarget}
                onHold={onHold}
                reveal={reveal}
                renderBody={
                  view === "changes"
                    ? (shown) => <FilesTab groups={shown} scope={scope} servers={servers} sessions={sessions} lookup={lookup} />
                    : undefined
                }
              />
            )}
            {view === "dashboard" && !needsYouOnly && !pending && (
              <>
                <LaunchStrip open={p.launchOpen} onOpenChange={(open) => setDashPref("launchOpen", open)} />
                <SpaceOverview
                  workspaces={isolateSpaces(workspaces, p.isolatedSpace)}
                  agents={nav.agents}
                  shellPanes={nav.shellPanes}
                  host={ambientHost(servers, scope.host)}
                  onOpen={(id) => void navigate(href(spacePath(id, scope)))}
                  onNewSpace={() => {
                    newSpaceOpen = true;
                    void handle.update();
                  }}
                  creatingSpace={readCreating().has(SPACE_CREATE_KEY)}
                  open={openForCount(p.spacesOpen, workspaces.length)}
                  onOpenChange={(open) => setDashPref("spacesOpen", open)}
                />
              </>
            )}
          </main>
          <CrewFooterLink class="px-4 pt-3" />
          <UpdateBanner class="px-4 pt-3" />
          <div class="px-4 pt-3 pb-2 text-center text-[11px] leading-relaxed text-muted-foreground" data-testid="build-stamp">
            <span class="font-mono">{buildLabel()}</span>
          </div>
        </div>
        <TabBar
          label={t("home.tabs.aria")}
          active={view}
          onSelect={setView}
          items={[
            ...(multi ? [{ value: "crew" as const, label: t("crew.title"), icon: <Icon icon={Network} class="size-5" /> }] : []),
            {
              value: "dashboard" as const,
              label: t("home.tabs.dashboard"),
              icon: <Icon icon={Rows3} class="size-5" />,
              badge: blocked,
              dot: readyUnseen,
              badgeLabel: blocked > 0 ? tn("home.tabs.blocked", blocked) : t("home.tabs.unseen"),
            },
            { value: "changes" as const, label: t("files.title"), icon: <Icon icon={ListTree} class="size-5" /> },
          ]}
        />
        <PaneActionsSheet
          open={held !== null}
          onClose={closeHeld}
          pane={held}
          scope={held === null ? scope : paneScope(scope, held, servers, sessions)}
          readOnly={readOnly}
          herd={herd}
          onPinChange={onPinChange}
        />
        <NewSpaceSheet
          open={newSpaceOpen}
          onClose={() => {
            newSpaceOpen = false;
            void handle.update();
          }}
        />
      </div>
    );
  };
}
