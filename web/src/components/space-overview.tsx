import { useState } from "react";
import { FolderPlus, LayoutGrid, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { useMuxCapability } from "@/lib/mux-capability";
import { SectionHeader } from "@/components/section-header";
import { ListGroup } from "@/components/ui/list-group";
import { StatusDot } from "@/components/status-badge";
import {
  filterSpaces,
  nestWorktrees,
  sortSpacesByRecency,
  spaceLastSeenMap,
  spaceTriageMap,
} from "@/lib/spaces";
import { spaceKey } from "@/lib/hosts";
import { TRIAGE_STATUS } from "@/lib/triage";
import { timeAgo } from "@/lib/format";
import { statusLabel } from "@/lib/types";
import type { AgentView, WorkspaceView } from "@/lib/types";
import { t, tn } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface SpaceOverviewProps {
  workspaces: WorkspaceView[];
  agents: AgentView[];
  /** Bare shells too — a space you only ever opened a shell in still counts as used. */
  shellPanes?: AgentView[];
  onOpen: (workspaceId: string) => void;
  onNewSpace: () => void;
  /**
   * The machine these workspaces belong to — the lead, since the merged snapshot deliberately does
   * not union peer workspaces. Undefined on a solo install. Without it, a peer's `w1` would pour its
   * triage dot and its last-seen time into the lead's `w1` row (lib/spaces.ts).
   */
  host?: string;
  /** Fold state, owned by the dashboard so it can be persisted. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// The dashboard's navigator, and the LAST section on the page: everything you might act on comes
// first. It folds to a single line — with 45 spaces that's the difference between a dashboard and a
// scroll — and expands to a recency-ordered, filterable list.
// A module-level empty list, not a `= []` default in the parameter list: a fresh array literal on
// every render is a new reference, which defeats memoisation downstream for no benefit here.
const NO_PANES: AgentView[] = [];

export function SpaceOverview({
  workspaces,
  agents,
  shellPanes = NO_PANES,
  onOpen,
  onNewSpace,
  host,
  open,
  onOpenChange,
}: SpaceOverviewProps) {
  // Ephemeral view state, like SpaceRoute's tab selection — a filter you typed yesterday should not
  // greet you today with most of your spaces missing.
  useLocale();
  const [query, setQuery] = useState("");
  // Whether this multiplexer can open a new space at all. See the two decision sites below.
  const newSpace = useMuxCapability("createSpace");

  const panes = [...agents, ...shellPanes];
  // One pass over the panes, then map lookups — this component re-renders on every poll.
  const lastSeen = spaceLastSeenMap(panes);
  // One pass for "what's the most urgent thing in each space", shared with the chips so a row and a
  // chip can never mean different things by the same colour (lib/spaces.ts).
  const worstBySpace = spaceTriageMap(agents);
  const blockedSpaces = [...worstBySpace.values()].filter((b) => b === "needs").length;
  const visible = filterSpaces(sortSpacesByRecency(workspaces, panes, lastSeen, host), query);
  // Worktrees sit under the space holding their repo — but NOT while filtering: a filter that
  // matched only the child would indent a row under a parent that is not on screen, which reads as
  // a rendering fault rather than as structure.
  const rows = query.trim() ? visible.map((space) => ({ space, depth: 0 as const })) : nestWorktrees(visible);

  return (
    <section className="flex flex-col gap-2 px-4 py-4">
      <SectionHeader
        label={t("space.overview.title")}
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
                aria-label={tn("space.overview.needsYou", blockedSpaces)}
              >
                <span className="size-2 rounded-full bg-status-blocked" aria-hidden />
                {blockedSpaces}
              </span>
            )}
            {/* HIDDEN, and explained one line further down (M10/06). An icon has nowhere to put a
                sentence, and a "+" that always refuses is worse than no "+" at all — the pane sheet
                makes the same argument about greying out a control that cannot work. But an
                operator looking at a list of spaces WILL go looking for how to add one, so the
                reason cannot simply vanish with the button: it moves into the body, where there is
                room for words. Present on Herdr, which declares the capability. */}
            {newSpace.capable && (
              <button
                type="button"
                onClick={onNewSpace}
                aria-label={t("space.overview.new.aria")}
                className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95"
              >
                <FolderPlus className="size-4" />
              </button>
            )}
          </>
        }
      />

      {open && (
        <ListGroup id="spaces-body">
          {/* The other half of the hidden "+" above: the adapter's own reason, where the operator
              who went looking for it is already reading. Renders nothing on a multiplexer that can
              create a space, and nothing on one that declined without saying why. */}
          {!newSpace.capable && newSpace.note !== "" && (
            <p className="px-3.5 py-2 text-xs leading-snug text-muted-foreground">{newSpace.note}</p>
          )}
          {/* Deliberately NOT autofocused: on a phone that would throw the keyboard over the list
              you just asked to see. */}
          {/* Sticky: at 45 spaces the list is five screens, and a filter that scrolls away turns
              "wrong part of the list" into scroll-up, type, scroll-down. */}
          {/* A ROW of the group, not a card inside it — a bordered box inside a bordered group is
              a box in a box. Opaque background, not transparent, so the rows scroll UNDER it while
              it is stuck. */}
          {workspaces.length > 1 && (
            <label className="sticky top-0 z-10 flex items-center gap-2 bg-background px-3.5 py-2">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("space.overview.filter.placeholder")}
                aria-label={t("space.overview.filter.aria")}
                // min-h-9 so the control itself clears the 36px touch floor, not just its padded label.
                // Focus is the app's outside channel (DESIGN.md §2): outline-2 offset-2 outline-ring,
                // never `outline-none` alone — that cancels this ring with no replacement (trap #2).
                className="min-h-9 min-w-0 flex-1 bg-transparent text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
            </label>
          )}

          {workspaces.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-sm text-muted-foreground">
              {t("space.overview.empty.none")}
            </p>
          ) : visible.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-sm text-muted-foreground">
              {t("space.overview.empty.noMatch", { query })}
            </p>
          ) : (
            rows.map(({ space: w, depth }) => {
              // (host, workspaceId): these rows are the lead's spaces, so a peer that happens to
              // expose the same workspace id contributes nothing to them.
              const key = spaceKey(host, w.workspaceId);
              const bucket = worstBySpace.get(key);
              const status = bucket ? TRIAGE_STATUS[bucket] : null;
              const blocked = bucket === "needs";
              const seen = lastSeen.get(key) ?? 0;
              return (
                <button
                  key={w.workspaceId}
                  type="button"
                  onClick={() => onOpen(w.workspaceId)}
                  className={cn(
                    // Square, like the herd rows: this is a divide-y list, and a rounded fill under
                    // a straight hairline reads as a fault. That holds for EVERY state — corners
                    // belong to the row's place in the list, never to what the row is doing.
                    "w-full text-left transition-colors active:scale-[0.99]",
                    !blocked && "hover:bg-muted/50",
                    // A worktree of the space above it. Indented rather than labelled: the nesting
                    // IS the sentence, and a badge would repeat it once per row.
                    depth === 1 && "pl-5",
                  )}
                >
                  {/* Flat rows, not cards: these are single-line entries, so a card is 100% chrome
                      around one string, forty-five times. Card treatment is reserved for the agent
                      sections that mean "a human is required here". A blocked space still gets the
                      tint — that's the one cue worth the weight. */}
                  <div
                    className={cn(
                      // A 2px left rail, present in every state and transparent at rest, instead of
                      // a four-sided border: the box is then identical whether the row is blocked or
                      // not, so the text can't step sideways and the row can't grow. A full border
                      // would also land its bottom edge 1px above the list's own divide-y hairline
                      // and read as a 2px double line under one row.
                      // 14px, matching every other row in the app: inside a 1px-bordered group
                      // that lands the content on the same x as a card row's content.
                      "flex flex-row items-center gap-3 px-3.5 py-2.5 shadow-[inset_2px_0_0_0_transparent]",
                      blocked &&
                        "bg-status-blocked/5 shadow-[inset_2px_0_0_0_var(--color-status-blocked)]",
                    )}
                  >
                    {status ? (
                      <>
                        <StatusDot status={status} />
                        {/* The dot alone is colour-only; give SR users the status word. */}
                        <span className="sr-only">{statusLabel(status)}</span>
                      </>
                    ) : (
                      <span className="size-2.5 shrink-0 rounded-full border border-muted-foreground/40" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium">{w.label}</span>
                    {/* One count plus a relative time is what a 390px row has room for — the tab
                        count went, the pane count is the useful one. */}
                    <span
                      aria-label={tn("space.overview.paneCount", w.paneCount)}
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
        </ListGroup>
      )}
    </section>
  );
}

