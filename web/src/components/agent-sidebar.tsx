import { Loader2, TerminalSquare, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { AgentIcon } from "@/components/agent-icon";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { AGENT_GROUPS } from "@/lib/agent-groups";
import { shortCwd } from "@/lib/format";
import type { AgentView } from "@/lib/types";

interface ThreadSidebarProps {
  agents: AgentView[];
  /** Bare shell panes (no agent) — listed in a trailing "Shells" group so fresh spaces are reachable. */
  shellPanes?: AgentView[];
  currentPaneId: string;
  onSelect: (paneId: string) => void;
  /** When set, each row gets a ✕ that closes that pane (two-tap confirm). Omit to hide it. */
  onClose?: (paneId: string) => void;
  /** The pane currently being closed — shows a spinner on its row. */
  closingId?: string;
  /** Override the list container padding (e.g. flush inside a bottom sheet). */
  className?: string;
}

// The pane switcher reused by both the side drawer's PANES section and the swipe-up bottom sheet:
// every agent pane grouped/sorted like the home triage, then any bare shell panes under a "Shells"
// group, scrollable, with the open one highlighted. Mirrors the Herdr TUI's pane list. When onClose
// is given, each row carries its own close affordance so it's always unambiguous which pane you end.
export function ThreadSidebar({
  agents,
  shellPanes = [],
  currentPaneId,
  onSelect,
  onClose,
  closingId,
  className,
}: ThreadSidebarProps) {
  // Two-tap confirm, keyed by paneId, so arming one row's ✕ doesn't arm the others.
  const { pending, confirm } = usePendingConfirm();
  const requestClose = onClose
    ? (paneId: string) => {
        if (confirm(paneId)) onClose(paneId);
      }
    : undefined;
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
                onClose={requestClose}
                confirming={pending === a.paneId}
                closing={closingId === a.paneId}
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
              onClose={requestClose}
              confirming={pending === p.paneId}
              closing={closingId === p.paneId}
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
  onClose,
  confirming,
  closing,
}: {
  pane: AgentView;
  active: boolean;
  onSelect: (paneId: string) => void;
  onClose?: (paneId: string) => void;
  confirming?: boolean;
  closing?: boolean;
}) {
  const isShell = pane.kind === "shell";
  // A user-set pane label leads (the icon still conveys the agent); falls back to the agent/shell name.
  const name = pane.paneLabel ?? (isShell ? "shell" : pane.agent);
  // A row is a container, not one big button: the select tap and the ✕ are separate controls, so they
  // can't be nested <button>s. The active/hover highlight lives on the container; the inner button is
  // transparent and carries aria-current.
  return (
    <div
      className={cn(
        "flex w-full items-center gap-1 rounded-lg pr-1 transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60 active:bg-muted",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(pane.paneId)}
        aria-current={active ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left"
      >
        {isShell ? (
          <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          // Status is conveyed by the section grouping; the row leads with the agent's logo.
          <AgentIcon agent={pane.agent} className="size-5" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{name}</span>
            <span className="truncate text-[11px] text-muted-foreground">· {pane.workspaceLabel}</span>
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {shortCwd(pane.cwd)}
          </div>
        </div>
      </button>
      {onClose && (
        <button
          type="button"
          onClick={() => onClose(pane.paneId)}
          disabled={closing}
          aria-label={confirming ? `Confirm closing ${name}` : `Close ${name}`}
          className={cn(
            "shrink-0 rounded-md text-[11px] font-medium transition-colors disabled:opacity-60",
            confirming
              ? "bg-destructive px-2 py-1.5 text-destructive-foreground"
              : "flex size-8 items-center justify-center text-muted-foreground/50 hover:bg-muted hover:text-destructive",
          )}
        >
          {closing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : confirming ? (
            "Close?"
          ) : (
            <X className="size-4" />
          )}
        </button>
      )}
    </div>
  );
}
