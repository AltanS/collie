import { ArrowDown, ArrowUp, Inbox } from "lucide-react";

import { SectionHeader } from "@/components/section-header";
import { flipDir, triage, type RecentDir, type TriageKey } from "@/lib/triage";
import type { AgentView, BridgeStatus } from "@/lib/types";
import { AgentCard } from "./agent-card";

interface AgentListProps {
  agents: AgentView[];
  bridge?: BridgeStatus | undefined;
  onOpen: (paneId: string) => void;
  /** Which way Recent runs, and how to flip it. Omit to render Recent newest-first with no toggle. */
  recentDir?: RecentDir;
  onRecentDirChange?: (dir: RecentDir) => void;
  /** Whether Recent is expanded, and how to fold it. Omit to leave it always open (the sidebar). */
  recentOpen?: boolean;
  onRecentOpenChange?: (open: boolean) => void;
  /** Show the "no agents" placeholder when the herd is empty (default true). */
  emptyState?: boolean;
}

/** Which timestamp a section's rows date themselves by. Attention rows show none — a blocked
 *  agent's age is noise beside the fact that it's blocked. */
const AGE_BY_SECTION: Partial<Record<TriageKey, "seen" | "active">> = {
  ready: "active",
  recent: "seen",
};

// The herd in the one order the app agrees on: Needs you → Ready · unseen → Working → Recent
// (lib/triage.ts). Only Recent folds, and only Recent takes the direction toggle; the three
// attention sections are pinned open and never invert.
export function AgentList({
  agents,
  bridge,
  onOpen,
  recentDir = "newest",
  onRecentDirChange,
  recentOpen = true,
  onRecentOpenChange,
  emptyState = true,
}: AgentListProps) {
  if (agents.length === 0) {
    if (!emptyState) return null;
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
        <Inbox className="size-7" />
        <span className="text-sm">
          {bridge === "connected" ? "No agents running." : "Waiting for Herdr…"}
        </span>
      </div>
    );
  }

  const sections = triage(agents, recentDir).filter((s) => s.agents.length > 0);
  if (sections.length === 0) return null;

  return (
    <div className="flex flex-col gap-5 px-3 py-4">
      {sections.map((s) => {
        // Recent is the only foldable section, and only where the parent wired the state.
        const foldable = !!s.collapsible && onRecentOpenChange !== undefined;
        const open = foldable ? recentOpen : true;
        const bodyId = `agent-section-${s.key}`;
        const age = AGE_BY_SECTION[s.key];

        return (
          <section key={s.key} className="flex flex-col gap-2">
            <SectionHeader
              label={s.label}
              count={s.agents.length}
              accent={s.accent}
              {...(foldable ? { open, onToggle: onRecentOpenChange, controls: bodyId } : {})}
              trailing={
                // A sibling of the fold button, never a child: nesting would be invalid markup and
                // would make flipping the sort also fold the section. Hidden while folded, since
                // sorting rows nobody can see does nothing.
                s.key === "recent" && onRecentDirChange && open ? (
                  <SortToggle dir={recentDir} onChange={onRecentDirChange} />
                ) : undefined
              }
            />
            {open && (
              <div id={bodyId} className="flex flex-col gap-2">
                {s.agents.map((a) => (
                  <AgentCard
                    key={a.paneId}
                    agent={a}
                    onClick={() => onOpen(a.paneId)}
                    {...(age ? { age } : {})}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

// One tap flips the Recent order. Deliberately not a menu — the design offers a direction, not a
// choice of sort keys. min-h-9 keeps it on the 36px touch floor.
function SortToggle({ dir, onChange }: { dir: RecentDir; onChange: (dir: RecentDir) => void }) {
  const newest = dir === "newest";
  const Icon = newest ? ArrowDown : ArrowUp;
  return (
    <button
      type="button"
      onClick={() => onChange(flipDir(dir))}
      aria-label={
        newest
          ? "Sorted by most recently used first — switch to oldest first"
          : "Sorted by oldest first — switch to most recently used first"
      }
      className="flex min-h-9 items-center gap-1 rounded-md px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95"
    >
      <Icon className="size-3.5" aria-hidden />
      {newest ? "Newest" : "Oldest"}
    </button>
  );
}
