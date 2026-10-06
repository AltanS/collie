import type { Handle } from "remix/component";

import { paneRowKey } from "@web/lib/hosts";
import { t, tn } from "@web/lib/i18n";
import { tabTitle } from "@web/lib/pane-name";
import { groupPanesByTab } from "@web/lib/spaces";
import type { AgentView, TabView, WorkspaceView } from "@web/lib/types";

import { useLocale } from "../../lib/i18n-store";
import { AgentRow } from "../home/agent-row";

// Port of web/src/components/space-view.tsx: one space's panes (agents AND bare shells) grouped by
// tab. The open tab shows its panes alone; "All" shows every tab as a labelled section. A fresh tab's
// shell shows up here so it can be opened. Rows are `AgentRow` cards (`density="card"`, `statusStyle="badge"`, `scope="tab"`), as web/'s
// `AgentCard` draws them here: a status pill at the end and the working directory on line 2. The
// order is still `groupPanesByTab`'s, by place in the tab, never by status, so a poll moves nothing.
export interface SpaceViewProps {
  workspace: WorkspaceView;
  tabs: readonly TabView[];
  agents: readonly AgentView[];
  shellPanes: readonly AgentView[];
  /** The open tab's id, or null for "All". */
  selectedTab: string | null;
  /** The machine this space is on (the workspace's host, not the crew's lead); undefined when solo. */
  host: string | undefined;
  onOpen: (pane: AgentView, row: HTMLElement) => void;
  onPress: (pane: AgentView) => void;
  glideKeyOf: (pane: AgentView) => string;
  onHold: (pane: AgentView) => void;
}

export function SpaceView(handle: Handle<SpaceViewProps>) {
  useLocale(handle);
  return () => {
    const { workspace, tabs, agents, shellPanes, selectedTab, host, glideKeyOf } = handle.props;
    // Host-qualified: another machine's `w1` is not this space, however identically it is numbered.
    const allGroups = groupPanesByTab(workspace.workspaceId, [...tabs], [...agents], [...shellPanes], host);
    const groups = selectedTab === null ? allGroups : allGroups.filter((g) => g.tabId === selectedTab);
    return (
      <div class="flex flex-col gap-5 px-4 py-4" data-testid="space-view">
        <div>
          <h2 class="truncate text-sm font-semibold">{workspace.label}</h2>
          <p class="text-xs text-muted-foreground">
            {tn("space.view.tabCount", workspace.tabCount)} · {tn("space.view.paneCount", workspace.paneCount)}
          </p>
        </div>

        {groups.map((g) => (
          <section key={g.tabId} class="flex flex-col gap-2" data-testid="space-tab-group" data-tab-id={g.tabId}>
            {selectedTab === null && (
              <h3 class="flex items-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <TabHeading label={g.label} />
              </h3>
            )}
            {g.panes.length === 0 ? (
              <p class="text-xs text-muted-foreground">{t("space.view.emptyTab")}</p>
            ) : (
              <div class="flex flex-col gap-2">
                {/* scope="tab": this list already sits under its space heading and per-tab section,
                    so the cards lead with each pane's own name and carry its path on line 2. */}
                {g.panes.map((p) => (
                  <AgentRow
                    key={paneRowKey(p)}
                    agent={p}
                    scope="tab"
                    density="card"
                    statusStyle="badge"
                    glideKey={glideKeyOf(p)}
                    onOpen={(pane, row) => handle.props.onOpen(pane, row)}
                    onPress={(pane) => handle.props.onPress(pane)}
                    onHold={(pane) => handle.props.onHold(pane)}
                  />
                ))}
              </div>
            )}
          </section>
        ))}

        {groups.length === 0 && (
          <p class="py-8 text-center text-sm text-muted-foreground">
            {selectedTab === null ? t("space.view.noPanesInSpace") : t("space.view.noPanesInTab")}
          </p>
        )}
      </div>
    );
  };
}

// A positional label is not a name (lib/pane-name.ts, `tabTitle`): a tab the multiplexer only
// numbered heads its group with `tab 2`, in the lighter ink every surface gives it. Only an empty
// label falls to the dot the tab strip gives it; the label stays the spoken text either way.
function TabHeading(handle: Handle<{ label: string }>) {
  return () => {
    const { label } = handle.props;
    const title = tabTitle(label);
    if (title === null) {
      return (
        <>
          <span aria-hidden="true" class="size-1 rounded-full bg-current opacity-50" />
          <span class="sr-only">{label}</span>
        </>
      );
    }
    return title.positional ? <span class="text-muted-foreground/70">{title.text}</span> : <>{label}</>;
  };
}
