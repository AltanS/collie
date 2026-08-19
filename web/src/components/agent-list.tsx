import { ArrowDown, ArrowUp, Check, Inbox, WifiOff } from "lucide-react";

import { cn } from "@/lib/utils";
import { clockTime } from "@/lib/format";
import { useMuxCapability } from "@/lib/mux-capability";
import { SectionHeader } from "@/components/section-header";
import { flipDir, sectionHeaderProps, triage, type RecentDir, type TriageKey } from "@/lib/triage";
import type { AgentView, BridgeStatus } from "@/lib/types";
import { AgentCard } from "./agent-card";

interface AgentListProps {
  agents: AgentView[];
  bridge?: BridgeStatus | undefined;
  /**
   * Open a row. Takes the PANE, not its id: `w1:p1` names a different terminal on every machine in a
   * pack, and this list is one herd across all of them — an id alone cannot say which row was tapped.
   */
  onOpen: (pane: AgentView) => void;
  /** Which way Recent runs, and how to flip it. Omit to render Recent newest-first with no toggle. */
  recentDir?: RecentDir;
  onRecentDirChange?: (dir: RecentDir) => void;
  /** Whether Recent is expanded, and how to fold it. Omit to leave it always open (the sidebar). */
  recentOpen?: boolean;
  onRecentOpenChange?: (open: boolean) => void;
  /** Show the "no agents" placeholder when the herd is empty (default true). */
  emptyState?: boolean;
  /**
   * The snapshot on screen is stale — the last fetch failed, or this is a cold boot rendering from the
   * write-through cache. An EMPTY herd then means "we don't know", never "nothing is running", so the
   * placeholder must not claim the latter.
   */
  error?: boolean;
  /** When the stale data was fetched, for the "last seen HH:MM" half of the disconnected placeholder. */
  lastSeenAt?: number;
}

/** Which timestamp a section's rows date themselves by. Attention rows show none — a blocked
 *  agent's age is noise beside the fact that it's blocked. */
const AGE_BY_SECTION = new Map<TriageKey, "seen" | "active">([
  ["ready", "active"],
  // "working for 3h" and "working for 40s" are very different facts, and now that the age rides
  // the title row it costs no vertical space to say which.
  ["working", "active"],
  ["recent", "seen"],
]);

/** The sections that mean "a human is required here" — the only ones that get card chrome. */
const ATTENTION: ReadonlySet<TriageKey> = new Set<TriageKey>(["needs", "ready"]);

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
  error = false,
  lastSeenAt,
}: AgentListProps) {
  // Whether the multiplexer can say which agent a pane holds. Read unconditionally — a hook cannot
  // sit behind the early return below, and the answer is only consulted in the empty branch.
  const agentDetection = useMuxCapability("agentDetection");
  if (agents.length === 0) {
    if (!emptyState) return null;
    // "No agents running." is a claim about the herd, and only the bridge can make it. A stale render
    // (failed fetch, or a cold boot with nothing cached) knows nothing about the herd — saying the
    // herd is empty there is the bug this branch exists to prevent, so the outage is named instead.
    // `bridge` is no help on its own: a cached snapshot still says "connected".
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
          <WifiOff className="size-7" />
          <span className="text-sm">
            {lastSeenAt === undefined
              ? "Disconnected"
              : `Disconnected — last seen ${clockTime(lastSeenAt)}`}
          </span>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
        <Inbox className="size-7" />
        <span className="text-sm">
          {bridge === "connected" ? "No agents running." : "Waiting for Herdr…"}
        </span>
        {/* PRESENTATION, not a gate (M10/06). Without `agentDetection` every pane arrives as a
            shell with an unknown status, so this list is empty on a machine that may be running
            plenty — and "No agents running." is then a claim the bridge cannot actually make. The
            adapter's own sentence says why, and the second line says where the panes went, so the
            dashboard reads as one coherent screen instead of an empty one. Renders nothing on a
            multiplexer that reports agents, i.e. nothing on Herdr. */}
        {bridge === "connected" && !agentDetection.capable && agentDetection.note !== "" && (
          <p className="max-w-xs px-6 text-center text-xs leading-snug">
            {agentDetection.note} Your panes are under Spaces.
          </p>
        )}
      </div>
    );
  }

  const all = triage(agents, recentDir);
  const sections = all.filter((s) => s.agents.length > 0);
  if (sections.length === 0) return null;
  // "What needs me right now?" deserves an answer even when the answer is "nothing". Without this
  // the section simply doesn't render, and an absence reads the same as a stale load.
  const allClear = all.find((s) => s.key === "needs")!.agents.length === 0;

  return (
    <div className="flex flex-col gap-5 px-3 py-4">
      {/* The product of the twenty-times-a-day glance. Rendered with presence, not as a caption:
          you should be able to resolve it one-handed at arm's length without focusing. */}
      {allClear && (
        <p className="flex items-center gap-2 px-1 py-1 text-sm font-medium">
          <Check className="size-5 shrink-0 text-status-done" aria-hidden />
          Nothing needs you
        </p>
      )}
      {sections.map((s) => {
        // Recent is the only foldable section, and only where the parent wired the state.
        const foldable = !!s.collapsible && onRecentOpenChange !== undefined;
        const open = foldable ? recentOpen : true;
        const bodyId = `agent-section-${s.key}`;
        const age = AGE_BY_SECTION.get(s.key);

        return (
          <section key={s.key} className="flex flex-col gap-2">
            <SectionHeader
              {...sectionHeaderProps(s)}
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
              <div
                id={bodyId}
                className={cn(
                  "flex flex-col",
                  // Cards mean "a human is required here", so only the attention sections get them.
                  // The rest are flat rows divided by a hairline — which also gives the page a
                  // second boundary cue, so section gaps aren't doing that job alone.
                  ATTENTION.has(s.key) ? "gap-2" : "divide-y divide-border/60",
                )}
              >
                {/* statusStyle="dot": the section heading already says the status, so a pill on
                    every row restates it and costs the width the title needs. */}
                {s.agents.map((a) => (
                  <AgentCard
                    key={a.paneId}
                    agent={a}
                    onClick={() => onOpen(a)}
                    statusStyle="dot"
                    density={ATTENTION.has(s.key) ? "card" : "row"}
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
      // A bordered chip, not bare text: unstyled it read as an annotation ("sorted newest") rather
      // than something you can press. Fixed width so flipping it doesn't shift the header. No fill —
      // filled, it outweighed the heading it sits beside, which is backwards for a control that
      // reorders the section you care least about.
      className="flex min-h-9 items-center justify-center gap-1 rounded-full border px-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95"
    >
      <Icon className="size-3.5" aria-hidden />
      <span className="w-[3.25rem] text-left">{newest ? "Newest" : "Oldest"}</span>
    </button>
  );
}
