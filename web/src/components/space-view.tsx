import { groupPanesByTab } from "@/lib/spaces";
import type { AgentView, TabView, WorkspaceView } from "@/lib/types";
import { AgentCard } from "./agent-card";

interface SpaceViewProps {
  workspace: WorkspaceView;
  tabs: TabView[];
  agents: AgentView[];
  shellPanes: AgentView[];
  /** Selected tab id, or null for "All" (every tab as a labelled section). */
  selectedTab: string | null;
  onOpen: (paneId: string) => void;
}

// One space's panes, grouped by tab (agents AND bare shells). Tab selection + creation live in the
// TabStrip header row above; here we render either the selected tab's panes, or every tab as a
// labelled section when "All" is active. A freshly-created tab's shell shows up here so you can open
// it and launch your own agent.
export function SpaceView({ workspace, tabs, agents, shellPanes, selectedTab, onOpen }: SpaceViewProps) {
  const allGroups = groupPanesByTab(workspace.workspaceId, tabs, agents, shellPanes);
  const groups = selectedTab ? allGroups.filter((g) => g.tabId === selectedTab) : allGroups;

  return (
    <div className="flex flex-col gap-5 px-3 py-4">
      <div className="px-1">
        <h2 className="truncate text-sm font-semibold">{workspace.label}</h2>
        <p className="text-xs text-muted-foreground">
          {workspace.tabCount} {workspace.tabCount === 1 ? "tab" : "tabs"} ·{" "}
          {workspace.paneCount} {workspace.paneCount === 1 ? "pane" : "panes"}
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
            <p className="px-1 text-xs text-muted-foreground">(empty tab)</p>
          ) : (
            <div className="flex flex-col gap-2">
              {g.panes.map((p) => (
                <AgentCard key={p.paneId} agent={p} onClick={() => onOpen(p.paneId)} />
              ))}
            </div>
          )}
        </section>
      ))}

      {groups.length === 0 && (
        <p className="px-1 py-8 text-center text-sm text-muted-foreground">
          {selectedTab ? "This tab has no panes." : "This space has no panes."}
        </p>
      )}
    </div>
  );
}
