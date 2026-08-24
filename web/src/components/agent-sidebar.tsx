import { TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { AgentIcon } from "@/components/agent-icon";
import { SectionHeader } from "@/components/section-header";
import { paneParts } from "@/lib/pane-name";
import { isAttention, sectionHeaderProps, triage } from "@/lib/triage";
import type { AgentView } from "@/lib/types";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface ThreadSidebarProps {
  agents: AgentView[];
  /** Bare shell panes (no agent) — listed in a trailing "Shells" group so fresh spaces are reachable. */
  shellPanes?: AgentView[];
  currentPaneId: string;
  onSelect: (paneId: string) => void;
  /** Whether the Recent section is expanded, and how to fold it. Omit to leave it always open. */
  recentOpen?: boolean;
  onRecentOpenChange?: (open: boolean) => void;
  /** Whether the Shells section is expanded, and how to fold it. Omit to leave it always open. */
  shellsOpen?: boolean;
  onShellsOpenChange?: (open: boolean) => void;
  /** Override the list container padding (e.g. flush inside a bottom sheet). */
  className?: string;
}

// The pane switcher behind the swipe-up "Switch pane" sheet: every agent pane grouped and sorted
// exactly like the dashboard (lib/triage.ts — the two must not disagree about what needs you), then
// any bare shell panes under a trailing "Shells" group, with the open one highlighted. Switching is
// the ONLY action here — closing a pane lives in the pane pill's long-press sheet (with its own
// confirm), so a fat-thumbed switch can never destroy a pane.
//
// This sheet sees the WHOLE herd, so it has the same problem the dashboard had: the two long tails
// (Recent, and 30-odd bare shells) bury the handful of agents you actually came to switch to. Both
// fold, and both remember it, using the dashboard's own header primitive.
// A module-level empty list, not a `= []` default in the parameter list: a fresh array literal on
// every render is a new reference, which defeats memoisation downstream for no benefit here.
const NO_PANES: AgentView[] = [];

export function ThreadSidebar({
  agents,
  shellPanes = NO_PANES,
  currentPaneId,
  onSelect,
  recentOpen = true,
  onRecentOpenChange,
  shellsOpen = true,
  onShellsOpenChange,
  className,
}: ThreadSidebarProps) {
  useLocale();
  if (agents.length === 0 && shellPanes.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-sm text-muted-foreground">
        {t("home.empty.noAgents")}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-4 px-2 py-3", className)}>
      {triage(agents).map((g) => {
        const members = g.agents;
        if (members.length === 0) return null;
        // Recent is the only foldable triage section, and only where the parent wired the state.
        const foldable = !!g.collapsible && onRecentOpenChange !== undefined;
        const open = foldable ? recentOpen : true;
        return (
          <Section
            key={g.key}
            id={`switch-${g.key}`}
            {...sectionHeaderProps(g)}
            {...(foldable ? { open, onToggle: onRecentOpenChange } : {})}
          >
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
        <Section
          id="switch-shells"
          label={t("home.sidebar.shells")}
          count={shellPanes.length}
          dot="bg-status-unknown"
          {...(onShellsOpenChange ? { open: shellsOpen, onToggle: onShellsOpenChange } : {})}
        >
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

// Uses the dashboard's own header primitive so the fold affordance is identical in both places —
// level 3 because the sheet's own title is the h2. Passing no `open`/`onToggle` renders a plain
// pinned heading with nothing to press.
function Section({
  id,
  label,
  count,
  accent,
  dot,
  open,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  count: number;
  accent?: boolean;
  /** Status-palette bullet beside the header — the same colors the status badges use, so each
   *  section carries its at-a-glance color key. */
  dot: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const foldable = open !== undefined && onToggle !== undefined;
  return (
    <section className="flex flex-col gap-0.5">
      <SectionHeader
        level={3}
        label={label}
        count={count}
        dot={dot}
        className="px-2"
        {...(accent ? { accent } : {})}
        {...(foldable ? { open, onToggle, controls: id } : {})}
      />
      {(!foldable || open) && <div id={id}>{children}</div>}
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
  // project · tab as separate spans so the TAB survives truncation — see paneParts. The agent's
  // identity stays in the icon, which is why the title line is free to say where the work is.
  const { project, tab, secondary } = paneParts(pane);
  return (
    <button
      type="button"
      onClick={() => onSelect(pane.paneId)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60 active:bg-muted",
        // The switcher is exactly where you jump TO the thing that needs you, so it must be able to
        // SHOW that — it renders every pane identically otherwise. Staying denser than the dashboard
        // is fine; being unable to mark a blocked pane is not. (isAttention, so the rule isn't
        // re-derived here.)
        //
        // The border is applied even to the ACTIVE row, so the two cues compose: the pane you're in
        // AND blocked keeps both its accent fill and its alarm edge. Only the fill is withheld,
        // because two backgrounds can't both win.
        isAttention(pane.status) && "border border-status-blocked/40",
        !active && isAttention(pane.status) && "bg-status-blocked/5",
      )}
    >
      {isShell ? (
        <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        // Status is conveyed by the section grouping; the row leads with the agent's logo.
        <AgentIcon agent={pane.agent} className="size-5" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1 text-sm">
          <span className="max-w-[45%] shrink truncate text-muted-foreground">{project}</span>
          {tab && (
            <>
              <span className="shrink-0 text-muted-foreground/60" aria-hidden>
                ·
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{tab}</span>
            </>
          )}
        </div>
        {secondary && (
          <div className="truncate font-mono text-[11px] text-muted-foreground">{secondary}</div>
        )}
      </div>
    </button>
  );
}
