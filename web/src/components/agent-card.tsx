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
  /**
   * "card" (default) is the bordered, shadowed treatment. "row" is flat — no border, no shadow,
   * separated by a hairline instead.
   *
   * Card chrome on 100% of rows is wallpaper, not emphasis: a Working row and a Recent row rendered
   * pixel-identically, throwing away the four-level priority `triage()` had just computed. Reserving
   * the card for the sections that mean "a human is required here" makes the shape itself carry the
   * signal — see a card, something wants you; all flat, nothing does.
   */
  density?: "card" | "row";
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
  density = "card",
}: AgentCardProps) {
  const isShell = agent.kind === "shell";
  const blocked = agent.status === "blocked";
  const inTab = scope === "tab";
  const flat = density === "row";
  const parts = paneParts(agent);
  const tabTitle = paneTitleInTab(agent);
  const stamp = age === "seen" ? agent.lastSeenAt : age === "active" ? agent.lastActiveAt : undefined;
  const secondary = inTab ? tabTitle.secondary : parts.secondary;
  // The dot rides the avatar's corner rather than the far right: at the right edge the eye read a
  // title, then crossed 200px of empty card to a 10px mark describing it.
  const cornerDot = statusStyle === "dot" && !isShell;

  const Shell = flat ? "div" : Card;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left transition-transform active:scale-[0.99]",
        flat && "rounded-lg transition-colors hover:bg-muted/50",
      )}
    >
      <Shell
        className={cn(
          flat
            ? "flex flex-row items-center gap-3 px-2.5 py-2.5"
            : "flex-row items-center gap-3 rounded-xl px-3.5 py-3 shadow-sm",
          // The blocked tint survives both treatments — it's the one cue that reads at a glance.
          blocked && "border-status-blocked/40 bg-status-blocked/5",
        )}
      >
        <div className="relative shrink-0">
          {isShell ? (
            <div className="flex size-9 items-center justify-center rounded-full border bg-muted">
              <TerminalSquare className="size-4 text-muted-foreground" />
            </div>
          ) : (
            <AgentIcon agent={agent.agent} className="size-9" />
          )}
          {cornerDot && (
            <StatusDot
              status={agent.status}
              // Ringed in the surface colour so it reads as a badge on the avatar, not a smudge.
              className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-background"
            />
          )}
        </div>

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
        ) : cornerDot ? (
          /* The dot itself is colour-only and lives on the avatar; give SR users the word. */
          <span className="sr-only">{STATUS_LABEL[agent.status]}</span>
        ) : (
          <StatusBadge status={agent.status} />
        )}
      </Shell>
    </button>
  );
}
