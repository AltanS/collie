import { groupPanesByTab } from "@/lib/spaces";
import { tabTitle } from "@/lib/pane-name";
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
  /** Open a row — the PANE, not its id (ids repeat across machines). Handed the row's button. */
  onOpen: (pane: AgentView, row?: HTMLElement) => void;
  /** A row's glide key, its pane's path (lib/glide.ts, the `pane` pair). Omit and no row glides. */
  glideKeyOf?: (pane: AgentView) => string;
  /** The finger landed on a row (lib/pane-prefetch.ts). */
  onPress?: (pane: AgentView) => void;
  /** The machine this space is on — the WORKSPACE's host, not the crew's lead. Undefined when solo. */
  host?: string;
}

// One space's panes, grouped by tab (agents AND bare shells). Tab selection + creation live in the
// TabStrip header row above; here we render either the selected tab's panes, or every tab as a
// labelled section when "All" is active. A freshly-created tab's shell shows up here so you can open
// it and launch your own agent.
export function SpaceView({
  workspace,
  tabs,
  agents,
  shellPanes,
  selectedTab,
  onOpen,
  glideKeyOf,
  onPress,
  host,
}: SpaceViewProps) {
  useLocale();
  // Host-qualified: another machine's `w1` is not this space, however identically it is numbered.
  const allGroups = groupPanesByTab(workspace.workspaceId, tabs, agents, shellPanes, host);
  const groups = selectedTab ? allGroups.filter((g) => g.tabId === selectedTab) : allGroups;

  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      <div>
        <h2 className="truncate text-sm font-semibold">{workspace.label}</h2>
        <p className="text-xs text-muted-foreground">
          {tn("space.view.tabCount", workspace.tabCount)} ·{" "}
          {tn("space.view.paneCount", workspace.paneCount)}
        </p>
      </div>

      {groups.map((g) => (
        <section key={g.tabId} className="flex flex-col gap-2">
          {selectedTab === null && (
            <h3 className="flex items-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {/* A positional label is not a name (lib/pane-name.ts § tabTitle): a tab the
                  multiplexer only numbered heads its group with `tab 2`, the same words and the
                  same lighter ink every other surface gives it, instead of with the multiplexer's
                  raw number. Only an empty label falls to the dot the tab strip gives it. The label
                  stays the heading's spoken text either way. */}
              {(() => {
                const title = tabTitle(g.label);
                if (title === null) {
                  return (
                    <>
                      <span aria-hidden="true" className="size-1 rounded-full bg-current opacity-50" />
                      <span className="sr-only">{g.label}</span>
                    </>
                  );
                }
                return title.positional ? (
                  <span className="text-muted-foreground/70">{title.text}</span>
                ) : (
                  g.label
                );
              })()}
            </h3>
          )}
          {g.panes.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("space.view.emptyTab")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {/* scope="tab": this list already sits under its space heading and per-tab section,
                  so the cards lead with each pane's own name rather than repeating both. */}
              {g.panes.map((p) => (
                <AgentCard
                  key={p.paneId}
                  agent={p}
                  onClick={(el) => onOpen(p, el)}
                  glideKey={glideKeyOf?.(p)}
                  onPress={onPress && (() => onPress(p))}
                  scope="tab"
                />
              ))}
            </div>
          )}
        </section>
      ))}

      {groups.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {selectedTab ? t("space.view.noPanesInTab") : t("space.view.noPanesInSpace")}
        </p>
      )}
    </div>
  );
}
