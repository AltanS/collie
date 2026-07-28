import { TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { ShellBadge, StatusBadge, StatusDot } from "@/components/status-badge";
import { AgentIcon } from "@/components/agent-icon";
import { timeAgo } from "@/lib/format";
import { paneParts, paneTitleInTab } from "@/lib/pane-name";
import { STATUS_LABEL } from "@/lib/types";
import type { AgentView } from "@/lib/types";

interface AgentCardProps {
  agent: AgentView;
  onClick: () => void;
  /**
   * Show "how long ago" on the second line, and which timestamp it means: "seen" for the Recent
   * section (when you last opened it), "active" for Ready · unseen (when it finished). Omitted
   * elsewhere — a blocked agent's age is noise next to the fact that it's blocked.
   */
  age?: "seen" | "active";
  /**
   * Where the row is being shown. "herd" (default) is a flat list across every space, so the title
   * carries `project · tab`. "tab" is a list already grouped under its space and tab — repeating
   * them would say nothing, so the pane's own name leads instead.
   */
  scope?: "herd" | "tab";
  /**
   * How to show status. "badge" (default) spells it out. "dot" is for a list already GROUPED by
   * status — the section heading says "Working", so eighteen rows repeating it in a pill buys
   * nothing and costs a third of the row's width, which is exactly the width the title needs.
   */
  statusStyle?: "badge" | "dot";
}

// A pane row, used by the triage home and the space view. Usually an agent; for a bare shell pane
// (kind:"shell") it shows a terminal glyph and a muted "shell" tag instead of a status badge.
//
// The title is `project · tab` — NOT the agent name, which every row would otherwise share. The two
// parts render as separate spans on purpose: eight panes in one project all start `moonward_os · `,
// so truncating the joined string would eat the tab and leave every row identical. The project
// gives up width first; the tab, the only discriminator, survives.
export function AgentCard({
  agent,
  onClick,
  age,
  scope = "herd",
  statusStyle = "badge",
}: AgentCardProps) {
  const isShell = agent.kind === "shell";
  const blocked = agent.status === "blocked";
  const inTab = scope === "tab";
  const parts = paneParts(agent);
  const tabTitle = paneTitleInTab(agent);
  const stamp = age === "seen" ? agent.lastSeenAt : age === "active" ? agent.lastActiveAt : undefined;
  const secondary = inTab ? tabTitle.secondary : parts.secondary;

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left transition-transform active:scale-[0.99]"
    >
      <Card
        className={cn(
          "flex-row items-center gap-3 rounded-xl px-3.5 py-3 shadow-sm",
          blocked && "border-status-blocked/40 bg-status-blocked/5",
        )}
      >
        {isShell ? (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-muted">
            <TerminalSquare className="size-4 text-muted-foreground" />
          </div>
        ) : (
          <AgentIcon agent={agent.agent} className="size-9" />
        )}

        <div className="min-w-0 flex-1">
          {inTab ? (
            <div className="truncate font-medium">{tabTitle.primary}</div>
          ) : (
            <div className="flex min-w-0 items-baseline gap-1">
              {/* The project yields first: capped and truncatable. */}
              <span className="max-w-[45%] shrink truncate text-muted-foreground">
                {parts.project}
              </span>
              {parts.tab && (
                <>
                  <span className="shrink-0 text-muted-foreground/60" aria-hidden>
                    ·
                  </span>
                  {/* The tab is the discriminator — it gets the remaining width. */}
                  <span className="min-w-0 flex-1 truncate font-medium">{parts.tab}</span>
                </>
              )}
            </div>
          )}

          <div className="flex min-w-0 items-baseline gap-2 font-mono text-xs text-muted-foreground">
            {secondary && <span className="min-w-0 flex-1 truncate">{secondary}</span>}
            {stamp !== undefined && (
              <span className={cn("shrink-0 tabular-nums", !secondary && "flex-1")}>
                {timeAgo(stamp)}
              </span>
            )}
          </div>
        </div>

        {isShell ? (
          <ShellBadge />
        ) : statusStyle === "dot" ? (
          <>
            <StatusDot status={agent.status} />
            {/* The dot alone is colour-only; give SR users the word the badge would have shown. */}
            <span className="sr-only">{STATUS_LABEL[agent.status]}</span>
          </>
        ) : (
          <StatusBadge status={agent.status} />
        )}
      </Card>
    </button>
  );
}
