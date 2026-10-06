import { on, type Handle } from "remix/component";
import { FolderPlus, LayoutGrid, LoaderCircle, Search } from "lucide";

import { timeAgo } from "@web/lib/format";
import { spaceKey } from "@web/lib/hosts";
import { t, tn } from "@web/lib/i18n";
import { filterSpaces, nestWorktrees, spaceLastSeenMap, spaceTriageMap } from "@web/lib/spaces";
import { TRIAGE_STATUS } from "@web/lib/triage";
import { statusLabel, type AgentView, type WorkspaceView } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { config } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { useStore } from "../../lib/store";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { ListGroup } from "../../ui/list-group";
import { StatusDot } from "../../ui/status-dot";
import { FoldHeader } from "./fold-header";

// Port of web/src/components/space-overview.tsx: the dashboard's Spaces navigator, and the LAST
// section on the page: everything you might act on comes first. It folds to a single line (with 45
// spaces that is the difference between a dashboard and a scroll) and expands to a filterable list in
// the multiplexer's own space order. The fold is a Collapse, so it opens and closes on the one 240 ms
// ease, holding its last rows through the exit (D §1).
//
// The fold state belongs to the dashboard, which persists it (`open` / `onOpenChange`). The filter
// text is this component's own and dies with it: a filter you typed yesterday should not greet you
// today with most of your spaces missing. It is a controlled field, because the input leaves the DOM
// when the fold closes and must come back holding what was typed.
//
// Rows keep the multiplexer's own space-number order, the same order the strip shows, and they are
// keyed by workspace id: a poll never moves a row.
export interface SpaceOverviewProps {
  workspaces: WorkspaceView[];
  agents: AgentView[];
  /** Bare shells too: a space you only ever opened a shell in still counts as used. */
  shellPanes?: AgentView[];
  /**
   * The machine these workspaces belong to: the ADDRESSED host (`?h=`, or the lead absent one), since
   * `workspaces` is already narrowed to it. Undefined on a solo install. Without it, a peer's `w1`
   * would pour its triage dot and its last-seen time into another host's `w1` row (lib/spaces.ts).
   */
  host?: string;
  onOpen: (workspaceId: string) => void;
  onNewSpace: () => void;
  /** True while a Space create is in flight. */
  creatingSpace?: boolean;
  /** Fold state, owned by the dashboard so it can be persisted. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const NO_PANES: AgentView[] = [];

export function SpaceOverview(handle: Handle<SpaceOverviewProps>) {
  useLocale(handle);
  const cfg = useStore(handle, config);
  let query = "";

  return () => {
    const { workspaces, agents, shellPanes = NO_PANES, host, open, creatingSpace = false } = handle.props;

    // Whether this multiplexer can open a new space at all. Absent data reads as capable (the
    // fail-open direction of lib/mux-capability.ts): a control that works must not vanish for the
    // length of a page cache. Only a bridge that said `false` hides the "+".
    const mux = cfg().data?.mux;
    const canCreate = mux?.capabilities?.createSpace !== false;
    const createNote = canCreate ? "" : (mux?.notes?.createSpace ?? "");

    const filtering = query.trim() !== "";
    const panes = [...agents, ...shellPanes];
    // One pass over the panes, then map lookups: this component re-renders on every poll.
    const lastSeen = spaceLastSeenMap(panes);
    // One pass for "the most urgent thing in each space", shared with the chips so a row and a chip
    // can never mean different things by the same colour.
    const worstBySpace = spaceTriageMap(agents);
    const blockedSpaces = [...worstBySpace.values()].filter((b) => b === "needs").length;
    const visible = filterSpaces(workspaces, query);
    // Worktrees sit under the space holding their repo, but NOT while filtering: a filter that
    // matched only the child would indent a row under a parent that is not on screen.
    const rows = filtering ? visible.map((space) => ({ space, depth: 0 as const })) : nestWorktrees(visible);

    return (
      <section class="flex flex-col gap-2 px-4 py-4" data-testid="space-overview">
        <FoldHeader
          label={t("space.overview.title")}
          // While filtering, the count reports what you can SEE.
          count={filtering ? visible.length : workspaces.length}
          open={open}
          onToggle={(next) => handle.props.onOpenChange(next)}
          controls="spaces-body"
          testId="space-overview-toggle"
          trailing={
            <>
              {/* Why you would bother expanding: stays visible while folded. */}
              {blockedSpaces > 0 && (
                <span
                  class="flex items-center gap-1 text-[11px] font-semibold tabular-nums text-status-blocked"
                  aria-label={tn("space.overview.needsYou", blockedSpaces)}
                >
                  <span class="size-2 rounded-full bg-status-blocked" aria-hidden="true" />
                  {blockedSpaces}
                </span>
              )}
              {/* HIDDEN, and explained one line further down (M10/06): a "+" that always refuses is
                  worse than no "+", but the reason cannot simply vanish with the button, so it moves
                  into the body, where there is room for words. */}
              {canCreate && (
                <button
                  type="button"
                  data-testid="space-overview-new"
                  disabled={creatingSpace}
                  aria-label={t("space.overview.new.aria")}
                  aria-busy={creatingSpace ? "true" : "false"}
                  class="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95 disabled:opacity-100"
                  mix={on("click", () => handle.props.onNewSpace())}
                >
                  {creatingSpace ? <Icon icon={LoaderCircle} class="size-4 animate-spin" /> : <Icon icon={FolderPlus} class="size-4" />}
                </button>
              )}
            </>
          }
        />

        <Collapse open={open}>
          <ListGroup id="spaces-body">
            {/* The other half of the hidden "+": the adapter's own reason, where the operator who
                went looking for it is already reading. */}
            {!canCreate && createNote !== "" && <p class="px-3.5 py-2 text-xs leading-snug text-muted-foreground">{createNote}</p>}
            {/* Deliberately NOT autofocused: on a phone that would throw the keyboard over the list
                you just asked to see. Sticky, so a filter does not scroll away at 45 spaces; it is a
                ROW of the group, with an opaque ground so rows scroll UNDER it. It stays bare
                (not a Collapse): a Collapse wrapper would end the sticky range at its own box. */}
            {workspaces.length > 1 && (
              <label class="sticky top-0 z-10 flex items-center gap-2 bg-background px-3.5 py-2">
                <Icon icon={Search} class="size-4 shrink-0 text-muted-foreground" />
                <input
                  type="search"
                  value={query}
                  placeholder={t("space.overview.filter.placeholder")}
                  aria-label={t("space.overview.filter.aria")}
                  // min-h-9 so the control itself clears the 36px touch floor. Focus is the app's
                  // outside channel (D §2): never `outline-none` alone.
                  class="min-h-9 min-w-0 flex-1 bg-transparent text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  mix={on("input", (event) => {
                    query = event.currentTarget.value;
                    void handle.update();
                  })}
                />
              </label>
            )}

            {workspaces.length === 0 ? (
              <p class="px-3.5 py-6 text-center text-sm text-muted-foreground">{t("space.overview.empty.none")}</p>
            ) : visible.length === 0 ? (
              <p class="px-3.5 py-6 text-center text-sm text-muted-foreground">{t("space.overview.empty.noMatch", { query })}</p>
            ) : (
              rows.map(({ space: w, depth }) => {
                // (host, workspaceId): these rows are the addressed machine's spaces, so a peer that
                // happens to expose the same workspace id contributes nothing to them.
                const key = spaceKey(host, w.workspaceId);
                const bucket = worstBySpace.get(key);
                const status = bucket ? TRIAGE_STATUS[bucket] : null;
                const blocked = bucket === "needs";
                const seen = lastSeen.get(key) ?? 0;
                return (
                  <button
                    key={w.workspaceId}
                    type="button"
                    data-testid="space-row"
                    data-space={w.workspaceId}
                    class={cn(
                      // Square, like the herd rows: this is a divide-y list, and a rounded fill under
                      // a straight hairline reads as a fault, in EVERY state.
                      "w-full text-left transition-colors active:scale-[0.99]",
                      !blocked && "hover:bg-muted/50",
                      // A worktree of the space above it. Indented rather than labelled: the nesting
                      // IS the sentence.
                      depth === 1 && "pl-5",
                    )}
                    mix={on("click", () => handle.props.onOpen(w.workspaceId))}
                  >
                    <div
                      class={cn(
                        // A 2px left rail, present in every state and transparent at rest, instead of
                        // a four-sided border: the box is identical whether the row is blocked or
                        // not, so the text cannot step sideways and the row cannot grow. 14px, like
                        // every other row in the app.
                        "flex flex-row items-center gap-3 px-3.5 py-2.5 shadow-[inset_2px_0_0_0_transparent]",
                        blocked && "bg-status-blocked/5 shadow-[inset_2px_0_0_0_var(--color-status-blocked)]",
                      )}
                    >
                      {status ? (
                        <>
                          <StatusDot status={status} />
                          {/* The dot alone is colour-only; give SR users the status word. */}
                          <span class="sr-only">{statusLabel(status)}</span>
                        </>
                      ) : (
                        <span class="size-2.5 shrink-0 rounded-full border border-muted-foreground/40" />
                      )}
                      <span class="min-w-0 flex-1 truncate font-medium">{w.label}</span>
                      {/* One count plus a relative time is what a 390px row has room for. Time before
                          count, count last: the count chip anchors the right edge, so rows with and
                          without a timestamp still line up. */}
                      {seen > 0 && <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{timeAgo(seen)}</span>}
                      <span
                        aria-label={tn("space.overview.paneCount", w.paneCount)}
                        class="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
                      >
                        <Icon icon={LayoutGrid} class="size-3.5" />
                        {w.paneCount}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </ListGroup>
        </Collapse>
      </section>
    );
  };
}
