import type { Handle } from "remix/component";
import { Inbox, WifiOff } from "lucide";

import { groupHost, shownGroups, stripEntries } from "@web/lib/dash-view";
import { clockTime } from "@web/lib/format";
import { hostName, paneRowKey } from "@web/lib/hosts";
import { t } from "@web/lib/i18n";
import { groupPanesByWorkspace, type WorkspaceGroup } from "@web/lib/pane-groups";
import { ATTENTION, bucketOf, triage, worstTriage } from "@web/lib/triage";
import type { AgentView, BridgeStatus, ServerSummary, SessionSummary, TabView } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { Chip } from "../../ui/chip";
import { Icon } from "../../ui/icon";
import { STRIP_SCROLLER } from "../../ui/labelled-strip";
import { ListGroup } from "../../ui/list-group";
import { AgentRow } from "./agent-row";
import { SectionHeader } from "./section-header";
import { StatusCounts, StatusSummaryLine } from "./status-counts";

// Port of web/src/components/agent-list.tsx, in place order (ADR 0063).
//
// BY WORKSPACE, always, in the multiplexer's own order (lib/pane-groups.ts). A row never moves when
// its state changes: urgency is a MARK, never a position. A workspace holding a pane that needs you
// lights its heading (a dot, its counts), the pane's row takes the blocked wash, a finished pane you
// have not opened wears the unseen square, and ONE summary line on top counts what needs you across
// the whole herd and jumps to the first of it. The strip above is a filter: tap a chip to see that
// workspace alone, hold it to hide it (it stays in the strip, dimmed, with its dot).
//
// Not ported yet: pins and the Pinned group, the Activity/Cache order toggle, the needs-you switch,
// the per-heading "+" (new tab), and the hidden-machine stand-in chips. Each is a feature of its own
// in web/ with its own store, and the list renders as web/ does with none of them set.

export interface AgentListProps {
  agents: AgentView[];
  shellPanes: AgentView[];
  bridge: BridgeStatus | undefined;
  /** The snapshot on screen is stale (the last poll failed, or none has landed). */
  error: boolean;
  lastSeenAt: number | undefined;
  tabs: readonly TabView[];
  servers: readonly ServerSummary[] | undefined;
  sessions: readonly SessionSummary[] | undefined;
  /** The multiplexer's own sentence for why it cannot tell agents apart, or "" when it can. */
  agentDetectionNote: string;
  isolated: string | null;
  hidden: readonly string[];
  onIsolate: (key: string | null) => void;
  onToggleHidden: (key: string) => void;
  onOpen: (pane: AgentView) => void;
}

/** The key a device remembers a workspace by: machine, session and NAME (web/'s workspacePrefKey). */
export function workspacePrefKey(g: WorkspaceGroup): string {
  const cut = g.key.lastIndexOf("\u0000");
  return `${cut === -1 ? "" : g.key.slice(0, cut)}\u0000${g.label}`;
}

function groupDomId(key: string): string {
  return `ws-group-${key.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

function rowDomId(rowKey: string): string {
  return `pane-row-${rowKey.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

function urgentCount(g: WorkspaceGroup): number {
  return g.panes.filter((p) => ATTENTION.has(bucketOf(p))).length;
}

const NO_MACHINES: ReadonlySet<string> = new Set();

export function AgentList(handle: Handle<AgentListProps>) {
  return () => {
    const p = handle.props;
    if (p.agents.length === 0 && p.shellPanes.length === 0) return <EmptyHerd {...p} />;

    const attention = triage(p.agents).filter((s) => ATTENTION.has(s.key) && s.agents.length > 0);
    const groups = groupPanesByWorkspace(p.agents, p.shellPanes, { order: "fixed", tabs: p.tabs, servers: p.servers });
    if (groups.length === 0) return null;
    const isolatedGroup = p.isolated === null ? undefined : groups.find((g) => workspacePrefKey(g) === p.isolated);
    const hiddenSet = new Set(p.hidden);
    const shown = isolatedGroup ? [isolatedGroup] : groups.filter((g) => !hiddenSet.has(workspacePrefKey(g)));
    const strip = stripEntries(groups, NO_MACHINES, isolatedGroup?.key);
    const drawn = shownGroups(shown, false);
    const firstUrgent = groups.find((g) => urgentCount(g) > 0);
    const onJump =
      firstUrgent === undefined
        ? undefined
        : () => {
            if (!drawn.some((d) => d.group === firstUrgent)) {
              p.onIsolate(workspacePrefKey(firstUrgent));
              return;
            }
            document.getElementById(groupDomId(firstUrgent.key))?.scrollIntoView({ behavior: "smooth", block: "start" });
          };

    return (
      <div class="flex flex-col gap-5 px-4 py-4" data-testid="agent-list">
        <nav aria-label={t("space.strip.title")} class="-mx-4">
          <div class={cn(STRIP_SCROLLER, "px-4")}>
            <Chip label={t("space.tabStrip.all")} active={!isolatedGroup} onClick={() => handle.props.onIsolate(null)} />
            {strip.map((entry) => {
              if (entry.kind === "machine") {
                const name = hostName(p.servers, entry.host) ?? entry.host;
                return <Chip key={`machine\u0000${entry.host}`} label={name} active={false} dimmed status={worstTriage(entry.panes)} onClick={() => {}} />;
              }
              const g = entry.group;
              const key = workspacePrefKey(g);
              return (
                <Chip
                  key={g.key}
                  label={g.label}
                  active={isolatedGroup?.key === g.key}
                  dimmed={!isolatedGroup && hiddenSet.has(key)}
                  status={worstTriage(g.panes)}
                  onClick={() => handle.props.onIsolate(isolatedGroup?.key === g.key ? null : key)}
                  onLongPress={() => handle.props.onToggleHidden(key)}
                />
              );
            })}
          </div>
        </nav>

        <StatusSummaryLine id="dash-summary-line" panes={p.agents} allClear={attention.length === 0} onJump={onJump} />

        {drawn.map(({ group: g, rows }) => (
          <section key={g.key} id={groupDomId(g.key)} data-testid="workspace-group" data-host={groupHost(g)} class="flex scroll-mt-4 flex-col gap-2">
            <SectionHeader
              label={g.label}
              tone="strong"
              dot={worstTriage(g.panes) === "needs" ? "bg-status-blocked" : undefined}
              class="min-h-7"
              trailing={<StatusCounts panes={g.panes} class="shrink-0 text-[11px] text-muted-foreground" />}
            />
            <ListGroup>
              {rows.map((a) => (
                <AgentRow
                  key={paneRowKey(a)}
                  id={rowDomId(paneRowKey(a))}
                  agent={a}
                  scope="place"
                  unseen={bucketOf(a) === "ready"}
                  servers={p.servers}
                  sessions={p.sessions}
                  onOpen={(pane) => handle.props.onOpen(pane)}
                />
              ))}
            </ListGroup>
          </section>
        ))}
      </div>
    );
  };
}

function EmptyHerd(handle: Handle<AgentListProps>) {
  return () => {
    const { error, lastSeenAt, bridge, agentDetectionNote } = handle.props;
    if (error) {
      return (
        <div class="flex flex-col items-center justify-center gap-3 px-4 py-24 text-muted-foreground" data-testid="herd-empty">
          <Icon icon={WifiOff} class="size-7" />
          <span class="text-sm">
            {lastSeenAt === undefined ? t("home.empty.disconnected") : t("home.empty.disconnectedAt", { time: clockTime(lastSeenAt) })}
          </span>
        </div>
      );
    }
    return (
      <div class="flex flex-col items-center justify-center gap-3 px-4 py-24 text-muted-foreground" data-testid="herd-empty">
        <Icon icon={Inbox} class="size-7" />
        <span class="text-sm">{bridge === "connected" ? t("home.empty.noAgents") : t("home.empty.waiting")}</span>
        {bridge === "connected" && agentDetectionNote !== "" && (
          <p class="max-w-xs text-center text-xs leading-snug">
            {agentDetectionNote} {t("home.empty.panesHint")}
          </p>
        )}
      </div>
    );
  };
}
