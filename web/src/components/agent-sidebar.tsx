import { TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { AgentIcon } from "@/components/agent-icon";
import { paneTitle } from "@/lib/pane-name";
import { triage } from "@/lib/triage";
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
// group, scrollable, with the open one highlighted. Mirrors the Herdr TUI's pane list. Switching is
// the ONLY action here — closing a pane lives in the pane pill's long-press sheet (with its own
// confirm), so a fat-thumbed switch can never destroy a pane.
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
      {/* The same triage the dashboard uses (lib/triage.ts) — the two lists must not disagree about
          what needs you. Recent renders newest-first here and doesn't fold: the sidebar is a
          switcher you're already inside, not a page you're triaging. */}
      {triage(agents).map((g) => {
        const members = g.agents;
        if (members.length === 0) return null;
        return (
          <Section key={g.key} label={g.label} count={members.length} accent={g.accent} dot={g.dot}>
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
        <Section label="Shells" count={shellPanes.length} dot="bg-status-unknown">
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
  dot,
  children,
}: {
  label: string;
  count: number;
  accent?: boolean;
  /** Status-palette bullet beside the header — the same colors the status badges use, so each
   *  section carries its at-a-glance color key. */
  dot: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-0.5">
      <h3
        className={cn(
          "flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide",
          accent ? "text-status-blocked" : "text-muted-foreground",
        )}
      >
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dot)} />
        {label} <span className="text-muted-foreground">({count})</span>
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
  // project · tab, with the pane's own name (or cwd) beneath — see paneTitle. The agent's identity
  // stays in the icon, which is why the title line is free to say where the work is.
  const { primary, secondary } = paneTitle(pane);
  return (
    <button
      type="button"
      onClick={() => onSelect(pane.paneId)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60 active:bg-muted",
      )}
    >
      {isShell ? (
        <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        // Status is conveyed by the section grouping; the row leads with the agent's logo.
        <AgentIcon agent={pane.agent} className="size-5" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{primary}</div>
        {secondary && (
          <div className="truncate font-mono text-[11px] text-muted-foreground">{secondary}</div>
        )}
      </div>
    </button>
  );
}
