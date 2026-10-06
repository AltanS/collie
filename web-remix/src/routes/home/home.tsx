import { navigate, type Handle } from "remix/component";
import { ListTree, Network, Rows3 } from "lucide";

import { buildLabel } from "@web/lib/build";
import { coerceDashView } from "@web/lib/dash-view";
import { ambientPanes, isMultiHost, paneScope } from "@web/lib/hosts";
import { t, tn } from "@web/lib/i18n";
import { panePath } from "@web/lib/nav";
import { countBlocked, hasReady } from "@web/lib/triage";
import type { AgentView, BridgeConfig } from "@web/lib/types";

import { address, config, snapshot } from "../../lib/data";
import { useStore } from "../../lib/store";
import { href } from "../../routes";
import { Icon } from "../../ui/icon";
import { TabBar } from "../../ui/tab-bar";
import { AgentList } from "./agent-list";
import { dashPrefs, setDashView, setIsolated, toggleHidden } from "./prefs";

// Port of web/src/routes/home.tsx: the list in a scroller, the footer under it, and the tab bar
// outside the scroller. Crew and Files are placeholders here; the dashboard is the full list.
//
// Every read is a store (lib/data.ts), refreshed by the Shell's polling sources, so this screen
// fetches nothing itself. A tap opens the pane in-page through the Navigation API (remix/spa owns
// the transition), at the pane's own scope, as web/'s usePaneOpen does.

/** The multiplexer's sentence for why it cannot tell agents apart, or "" when it can (mux-capability.ts). */
function agentDetectionNote(cfg: BridgeConfig | undefined): string {
  const mux = cfg?.mux;
  if (mux?.capabilities?.agentDetection !== false) return "";
  return mux.notes?.agentDetection ?? "";
}

/** Open a pane in-page, at the pane's own scope (web/'s usePaneOpen without the glide). */
function openPane(pane: AgentView): void {
  const body = snapshot.get().data;
  const scope = paneScope(address.get().scope, pane, body?.servers, body?.sessions);
  void navigate(href(panePath(pane.paneId, scope)));
}

export function HomeRoute(handle: Handle) {
  const snap = useStore(handle, snapshot);
  const cfg = useStore(handle, config);
  const where = useStore(handle, address);
  const prefs = useStore(handle, dashPrefs);

  return () => {
    const loaded = snap();
    const body = loaded.data;
    const scope = where().scope;
    const servers = body?.servers;
    const sessions = body?.sessions;
    const multi = isMultiHost(servers);
    const view = prefs().dashView === "crew" && !multi ? "dashboard" : prefs().dashView;
    const panes = ambientPanes(body?.agents ?? [], body?.shellPanes ?? [], scope, servers, sessions);
    const blocked = countBlocked(panes.agents);
    const readyUnseen = blocked === 0 && hasReady(panes.agents);
    return (
      <div class="flex min-h-0 flex-1 flex-col" data-testid="home">
        <div class="min-h-0 flex-1 overflow-y-auto">
          <main class="mx-auto w-full max-w-screen-sm">
            {view === "dashboard" ? (
              <AgentList
                agents={panes.agents}
                shellPanes={panes.shellPanes}
                bridge={body?.bridge}
                error={loaded.error !== undefined || body === undefined}
                lastSeenAt={loaded.at === 0 ? undefined : loaded.at}
                tabs={body?.tabs ?? []}
                servers={servers}
                sessions={sessions}
                agentDetectionNote={agentDetectionNote(cfg().data)}
                isolated={prefs().isolated}
                hidden={prefs().hidden}
                onIsolate={setIsolated}
                onToggleHidden={toggleHidden}
                onOpen={openPane}
              />
            ) : (
              <p class="px-4 py-24 text-center text-sm text-muted-foreground" data-testid="tab-placeholder">
                {view === "crew" ? t("crew.title") : t("files.title")}
              </p>
            )}
          </main>
          {/* The crew line and the update ribbon go here (web/'s CrewFooterLink and UpdateBanner);
              both are later work. The build stamp is the static half of web/'s BuildStamp. */}
          <div data-slot="update-ribbon" />
          <div class="px-4 pt-3 pb-2 text-center text-[11px] leading-relaxed text-muted-foreground">
            <span class="font-mono">{buildLabel()}</span>
          </div>
        </div>
        <TabBar
          label={t("home.tabs.aria")}
          active={view}
          onSelect={(value) => setDashView(coerceDashView(value))}
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
      </div>
    );
  };
}
