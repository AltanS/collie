import { groupPanesByTab } from "@/lib/spaces";
import type { AgentView, TabView, WorkspaceView } from "@/lib/types";
import { AgentCard } from "./agent-card";
import { t, tn } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface SpaceViewProps {
  workspace: WorkspaceView;
  tabs: TabView[];
  agents: AgentView[];
  shellPanes: AgentView[];
  /** Selected tab id, or null for "All" (every tab as a labelled section). */
  selectedTab: string | null;
  /** Open a row — the PANE, not its id (ids repeat across machines). */
  onOpen: (pane: AgentView) => void;
  /** The machine this space is on (the lead — peer workspaces aren't unioned). Undefined when solo. */
  host?: string;
}

// One space's panes, grouped by tab (agents AND bare shells). Tab selection + creation live in the
// TabStrip header row above; here we render either the selected tab's panes, or every tab as a
// labelled section when "All" is active. A freshly-created tab's shell shows up here so you can open
// it and launch your own agent.
export function SpaceView({ workspace, tabs, agents, shellPanes, selectedTab, onOpen, host }: SpaceViewProps) {
  useLocale();
  // Host-qualified: another machine's `w1` is not this space, however identically it is numbered.
  const allGroups = groupPanesByTab(workspace.workspaceId, tabs, agents, shellPanes, host);
  const groups = selectedTab ? allGroups.filter((g) => g.tabId === selectedTab) : allGroups;

  return (
    <div className="flex flex-col gap-5 px-3 py-4">
      <div className="px-1">
        <h2 className="truncate text-sm font-semibold">{workspace.label}</h2>
        <p className="text-xs text-muted-foreground">
          {tn("space.view.tabCount", workspace.tabCount)} ·{" "}
          {tn("space.view.paneCount", workspace.paneCount)}
        </p>
      </div>

      {groups.map((g) => (
        <section key={g.tabId} className="flex flex-col gap-2">
          {selectedTab === null && (
            <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {g.label}
            </h3>
          )}
          {g.panes.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">{t("space.view.emptyTab")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {/* scope="tab": this list already sits under its space heading and per-tab section,
                  so the cards lead with each pane's own name rather than repeating both. */}
              {g.panes.map((p) => (
                <AgentCard
                  key={p.paneId}
                  agent={p}
                  onClick={() => onOpen(p)}
                  scope="tab"
                />
              ))}
            </div>
          )}
        </section>
      ))}

      {groups.length === 0 && (
        <p className="px-1 py-8 text-center text-sm text-muted-foreground">
          {selectedTab ? t("space.view.noPanesInTab") : t("space.view.noPanesInSpace")}
        </p>
      )}
    </div>
  );
}
