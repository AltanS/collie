import { useState } from "react";
import { FolderPlus, LayoutGrid, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/section-header";
import { StatusDot } from "@/components/status-badge";
import { filterSpaces, sortSpacesByRecency, spaceLastSeenMap, spaceTriageMap } from "@/lib/spaces";
import { TRIAGE_STATUS } from "@/lib/triage";
import { timeAgo } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/types";
import type { AgentView, WorkspaceView } from "@/lib/types";

interface SpaceOverviewProps {
  workspaces: WorkspaceView[];
  agents: AgentView[];
  /** Bare shells too — a space you only ever opened a shell in still counts as used. */
  shellPanes?: AgentView[];
  onOpen: (workspaceId: string) => void;
  onNewSpace: () => void;
  /** Fold state, owned by the dashboard so it can be persisted. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// The dashboard's navigator, and the LAST section on the page: everything you might act on comes
// first. It folds to a single line — with 45 spaces that's the difference between a dashboard and a
// scroll — and expands to a recency-ordered, filterable list.
export function SpaceOverview({
  workspaces,
  agents,
  shellPanes = [],
  onOpen,
  onNewSpace,
  open,
  onOpenChange,
}: SpaceOverviewProps) {
  // Ephemeral view state, like SpaceRoute's tab selection — a filter you typed yesterday should not
  // greet you today with most of your spaces missing.
  const [query, setQuery] = useState("");

  const panes = [...agents, ...shellPanes];
  // One pass over the panes, then map lookups — this component re-renders on every poll.
  const lastSeen = spaceLastSeenMap(panes);
  // One pass for "what's the most urgent thing in each space", shared with the chips so a row and a
  // chip can never mean different things by the same colour (lib/spaces.ts).
  const worstBySpace = spaceTriageMap(agents);
  const blockedSpaces = [...worstBySpace.values()].filter((b) => b === "needs").length;
  const visible = filterSpaces(sortSpacesByRecency(workspaces, panes, lastSeen), query);

  return (
    <section className="flex flex-col gap-2 px-3 py-4">
      <SectionHeader
        label="Spaces"
        // While filtering, the count reports what you can SEE — a header reading (45) above four
        // rows makes you doubt the filter rather than trust it.
        count={query.trim() ? visible.length : workspaces.length}
        open={open}
        onToggle={onOpenChange}
        controls="spaces-body"
        trailing={
          <>
            {/* Why you'd bother expanding — stays visible while folded. */}
            {blockedSpaces > 0 && (
              <span
                className="flex items-center gap-1 text-[11px] font-semibold tabular-nums text-status-blocked"
                aria-label={`${blockedSpaces} ${blockedSpaces === 1 ? "space needs" : "spaces need"} you`}
              >
                <span className="size-2 rounded-full bg-status-blocked" aria-hidden />
                {blockedSpaces}
              </span>
            )}
            <button
              type="button"
              onClick={onNewSpace}
              aria-label="New space"
              className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95"
            >
              <FolderPlus className="size-4" />
            </button>
          </>
        }
      />

      {open && (
        <div id="spaces-body" className="flex flex-col divide-y divide-border/60">
          {/* Deliberately NOT autofocused: on a phone that would throw the keyboard over the list
              you just asked to see. */}
          {/* Sticky: at 45 spaces the list is five screens, and a filter that scrolls away turns
              "wrong part of the list" into scroll-up, type, scroll-down. */}
          {workspaces.length > 1 && (
            <label className="sticky top-0 z-10 flex items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter spaces…"
                aria-label="Filter spaces"
                // min-h-9 so the control itself clears the 36px touch floor, not just its padded label.
                className="min-h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </label>
          )}

          {workspaces.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">No spaces yet.</p>
          ) : visible.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              No space matches “{query}”.
            </p>
          ) : (
            visible.map((w) => {
              const bucket = worstBySpace.get(w.workspaceId);
              const status = bucket ? TRIAGE_STATUS[bucket] : null;
              const blocked = bucket === "needs";
              const seen = lastSeen.get(w.workspaceId) ?? 0;
              return (
                <button
                  key={w.workspaceId}
                  type="button"
                  onClick={() => onOpen(w.workspaceId)}
                  className={cn(
                    "w-full rounded-lg text-left transition-colors active:scale-[0.99]",
                    !blocked && "hover:bg-muted/50",
                  )}
                >
                  {/* Flat rows, not cards: these are single-line entries, so a card is 100% chrome
                      around one string, forty-five times. Card treatment is reserved for the agent
                      sections that mean "a human is required here". A blocked space still gets the
                      tint — that's the one cue worth the weight. */}
                  <div
                    className={cn(
                      "flex flex-row items-center gap-3 px-2.5 py-2.5",
                      blocked && "rounded-lg border border-status-blocked/40 bg-status-blocked/5",
                    )}
                  >
                    {status ? (
                      <>
                        <StatusDot status={status} />
                        {/* The dot alone is colour-only; give SR users the status word. */}
                        <span className="sr-only">{STATUS_LABEL[status]}</span>
                      </>
                    ) : (
                      <span className="size-2.5 shrink-0 rounded-full border border-muted-foreground/40" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium">{w.label}</span>
                    {/* One count plus a relative time is what a 390px row has room for — the tab
                        count went, the pane count is the useful one. */}
                    <span
                      aria-label={`${w.paneCount} ${w.paneCount === 1 ? "pane" : "panes"}`}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
                    >
                      <LayoutGrid className="size-3.5" aria-hidden />
                      {w.paneCount}
                    </span>
                    {seen > 0 && (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {timeAgo(seen)}
                      </span>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
