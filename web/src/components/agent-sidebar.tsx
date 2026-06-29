import { TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/status-badge";
import { AGENT_GROUPS } from "@/lib/agent-groups";
import { shortCwd } from "@/lib/format";
import type { AgentView } from "@/lib/types";

interface ThreadSidebarProps {
  agents: AgentView[];
  /** Bare shell panes (no agent) — listed in a trailing "Shells" group so fresh spaces are reachable. */
  shellPanes?: AgentView[];
  currentPaneId: string;
  onSelect: (paneId: string) => void;
  /** Override the list container padding (e.g. flush inside a bottom sheet). */
  className?: string;
}

// The pane switcher reused by both the side drawer's PANES section and the swipe-up bottom sheet:
// every agent pane grouped/sorted like the home triage, then any bare shell panes under a "Shells"
// group, scrollable, with the open one highlighted. Mirrors the Herdr TUI's pane list.
export function ThreadSidebar({
  agents,
  shellPanes = [],
  currentPaneId,
  onSelect,
  className,
}: ThreadSidebarProps) {
  if (agents.length === 0 && shellPanes.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-sm text-muted-foreground">No agents running.</div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-4 px-2 py-3", className)}>
      {AGENT_GROUPS.map((g) => {
        const members = agents.filter((a) => g.match(a.status));
        if (members.length === 0) return null;
        return (
          <Section key={g.key} label={g.label} count={members.length} accent={g.accent}>
            {members.map((a) => (
              <PaneRow
                key={a.paneId}
                pane={a}
                active={a.paneId === currentPaneId}
                onSelect={onSelect}
              />
            ))}
          </Section>
        );
      })}

      {shellPanes.length > 0 && (
        <Section label="Shells" count={shellPanes.length}>
          {shellPanes.map((p) => (
            <PaneRow
              key={p.paneId}
              pane={p}
              active={p.paneId === currentPaneId}
              onSelect={onSelect}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  label,
  count,
  accent,
  children,
}: {
  label: string;
  count: number;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-0.5">
      <h3
        className={cn(
          "px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide",
          accent ? "text-status-blocked" : "text-muted-foreground",
        )}
      >
        {label} <span className="opacity-60">({count})</span>
      </h3>
      {children}
    </section>
  );
}

function PaneRow({
  pane,
  active,
  onSelect,
}: {
  pane: AgentView;
  active: boolean;
  onSelect: (paneId: string) => void;
}) {
  const isShell = pane.kind === "shell";
  return (
    <button
      type="button"
      onClick={() => onSelect(pane.paneId)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60 active:bg-muted",
      )}
    >
      {isShell ? (
        <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <StatusDot status={pane.status} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{isShell ? "shell" : pane.agent}</span>
          <span className="truncate text-[11px] text-muted-foreground">· {pane.workspaceLabel}</span>
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {shortCwd(pane.cwd)}
        </div>
      </div>
    </button>
  );
}
