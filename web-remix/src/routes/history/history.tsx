// Pane history (web/src/routes/history.tsx): the agent's own transcript, the ONLY conversation history a
// Claude pane can have. Its terminal runs on the alternate screen, so the multiplexer keeps no scrollback
// and `pane.read` never returns more than the viewport (bridge/transcript.ts).
//
// FETCH ALL, RENDER SOME (`window.ts`). The whole conversation arrives in one request, which is what makes
// find and jump-to-your-message work across turns not yet scrolled to. The DOM is the cost, so the window
// starts at the newest 60 turns and grows upward as the reader nears the top. Not polled.
//
// The route is keyed by the pane (routes/frame/map.tsx), so it fetches once in setup. The scroller is an
// inner column, not the Frame's own `<main>`: the Frame's scroll memory would otherwise fight the opening
// position, which is the newest turn. Growing upward inserts content ABOVE the viewport, so the height
// is measured before and the scroll restored after, the same anchoring "load older" uses. The browser's own
// scroll anchoring is switched off on the scroller, or it would correct the same shift a second time.
import { on, ref, type Handle } from "remix/component";
import { ArrowUpToLine, ChevronDown, ChevronUp, LoaderCircle, Search } from "lucide";

import { t } from "@web/lib/i18n";
import { panePath } from "@web/lib/nav";
import { muxCapability } from "@web/lib/mux-capability";
import { matchingEntries, step, userTurnIndices } from "@web/lib/transcript-search";
import type { TranscriptEntry } from "@web/lib/types";

import { config, address, snapshot } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { setStatus } from "../../lib/status";
import { scheduleUpdate, useStore } from "../../lib/store";
import { Icon } from "../../ui/icon";
import { Frame } from "../frame/frame";
import { FindBar } from "./find-bar";
import { FIRST_PAGE_QUERY, fetchHistoryPage, type HistoryUnavailable } from "./history-data";
import { TranscriptView } from "./transcript";
import { GROW_THRESHOLD, INITIAL_RENDER, countToReach, grownCount, heldEntries, olderQuery, visibleEntries } from "./window";

/** Why the column is empty, in the reader's terms. Each is an ordinary state, not an error. */
function unavailableCopy(reason: HistoryUnavailable): string {
  switch (reason) {
    case "disabled":
      return t("history.unavailable.disabled");
    case "no-session":
      return t("history.unavailable.noSession");
    case "no-log":
      return t("history.unavailable.noLog");
    case "error":
      return t("history.unavailable.error");
  }
}

export function HistoryRoute(handle: Handle<{ paneId: string }>) {
  const paneId = handle.props.paneId;
  const where = useStore(handle, address);
  const readSnapshot = useStore(handle, snapshot);
  const readConfig = useStore(handle, config);
  useLocale(handle);
  const scope = where().scope;

  let phase: "loading" | "ready" = "loading";
  let first: TranscriptEntry[] = [];
  let older: TranscriptEntry[] = [];
  let hasMore = false;
  let total = 0;
  let fileTruncated = false;
  let unavailable: HistoryUnavailable | undefined;
  let loadingOlder = false;
  let renderCount = INITIAL_RENDER;
  let findOpen = false;
  let query = "";
  /** Index into the held entries (not the drawn ones) of the turn a find or jump landed on; -1 is nowhere. */
  let cursor = -1;
  let scroller: HTMLElement | null = null;
  let anchor: { height: number; top: number } | null = null;
  let toBottom = true;
  let toCursor = false;

  const held = (): TranscriptEntry[] => heldEntries(older, first);
  const captureAnchor = (): void => {
    anchor = scroller === null ? null : { height: scroller.scrollHeight, top: scroller.scrollTop };
  };

  const loadOlder = async (): Promise<void> => {
    const q = olderQuery(held()[0]?.uuid);
    if (loadingOlder || !hasMore || q === null) return;
    captureAnchor();
    loadingOlder = true;
    scheduleUpdate(handle);
    try {
      const res = await fetchHistoryPage(paneId, q, scope, handle.signal);
      if (handle.signal.aborted) return;
      if (!res.available) {
        hasMore = false;
      } else {
        older = [...res.entries, ...older];
        renderCount += res.entries.length; // keep the newly fetched turns visible
        hasMore = res.hasMore;
      }
    } catch {
      if (handle.signal.aborted) return;
      anchor = null;
      setStatus(t("history.loadOlderFailed"), "error");
    }
    loadingOlder = false;
    scheduleUpdate(handle);
  };

  /** Reveal more of what is held; only hit the network once nothing is left in memory. */
  const growUpward = (): void => {
    const heldCount = held().length;
    if (renderCount < heldCount) {
      captureAnchor();
      renderCount = grownCount(renderCount, heldCount);
      scheduleUpdate(handle);
      return;
    }
    if (hasMore) void loadOlder();
  };

  const jumpTo = (index: number | null): void => {
    if (index === null) return;
    renderCount = countToReach(index, held().length, renderCount);
    cursor = index;
    toCursor = true;
    scheduleUpdate(handle);
  };

  const closeFind = (): void => {
    findOpen = false;
    query = "";
    cursor = -1;
    scheduleUpdate(handle);
  };

  const load = async (): Promise<void> => {
    try {
      const res = await fetchHistoryPage(paneId, FIRST_PAGE_QUERY, scope, handle.signal);
      if (handle.signal.aborted) return;
      if (!res.available) {
        unavailable = res.reason;
      } else {
        first = res.entries;
        hasMore = res.hasMore;
        total = res.total;
        fileTruncated = res.fileTruncated;
      }
    } catch {
      if (handle.signal.aborted) return;
      // A failed read is "could not read", never a blank page.
      unavailable = "error";
    }
    phase = "ready";
    scheduleUpdate(handle);
  };
  void load();

  return () => {
    const entries = held();
    const shown = visibleEntries(entries, renderCount);
    const allRendered = renderCount >= entries.length;
    const snap = readSnapshot().data;
    const agent = snap?.agents.find((a) => a.paneId === paneId) ?? snap?.shellPanes?.find((p) => p.paneId === paneId);
    const title = agent === undefined ? paneId : (("paneLabel" in agent ? agent.paneLabel : undefined) ?? agent.sessionName ?? agent.workspaceLabel ?? paneId);
    const matches = matchingEntries(entries, query);
    const userTurns = userTurnIndices(entries);
    const focusedUuid = cursor >= 0 ? entries[cursor]?.uuid : undefined;
    const matchCursor = matches.indexOf(cursor);
    const sessionLog = muxCapability(readConfig().data?.mux ?? null, "agentSessionRef");

    handle.queueTask(() => {
      if (scroller === null) return;
      if (toBottom && entries.length > 0) {
        // Open at the newest turn: you arrive from the live mirror, so the recent end is the continuation.
        toBottom = false;
        scroller.scrollTop = scroller.scrollHeight;
      } else if (anchor !== null) {
        scroller.scrollTop = anchor.top + (scroller.scrollHeight - anchor.height);
        anchor = null;
      }
      if (toCursor) {
        toCursor = false;
        const uuid = entries[cursor]?.uuid;
        if (uuid !== undefined) scroller.querySelector(`[data-turn="${CSS.escape(uuid)}"]`)?.scrollIntoView({ block: "center" });
      }
    });

    return (
      <Frame title={t("history.title")} backLabel={t("history.closeAria")} up={panePath(paneId, scope)} width="wide" class="p-0">
        {/* One slim row: the pane's name, how many turns are drawn, and the find button. A PWA has no
            browser find, so the view provides its own. */}
        {findOpen ? (
          <FindBar
            query={query}
            count={matches.length}
            current={matchCursor >= 0 ? matchCursor : 0}
            subject={t("find.subject.history")}
            onQueryChange={(next) => {
              // A new query invalidates the previous position: the first Next starts from the top.
              query = next;
              cursor = -1;
              scheduleUpdate(handle);
            }}
            onPrev={() => jumpTo(step(matches, cursor, -1))}
            onNext={() => jumpTo(step(matches, cursor, 1))}
            onClose={closeFind}
          />
        ) : (
          <div class="flex items-center gap-2 border-b px-3 py-1.5">
            <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-testid="history-pane">
              {title}
            </span>
            {total > 0 ? (
              <span class="text-xs text-muted-foreground tabular-nums" data-testid="history-count">
                {shown.length}/{total}
              </span>
            ) : null}
            <button
              type="button"
              aria-label={t("history.findAria")}
              class="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors active:bg-muted/60"
              mix={on("click", () => {
                findOpen = true;
                scheduleUpdate(handle);
              })}
            >
              <Icon icon={Search} class="size-4" />
            </button>
          </div>
        )}

        <div class="relative min-h-0 min-w-0 flex-1">
          <div
            data-testid="history-scroller"
            class="absolute inset-0 overflow-y-auto px-3 py-3 [overflow-anchor:none]"
            mix={ref((node: HTMLElement, signal) => {
              scroller = node;
              // Auto-grow as the reader nears the top, so scrolling back feels continuous.
              node.addEventListener(
                "scroll",
                () => {
                  if (node.scrollTop < GROW_THRESHOLD && !loadingOlder && phase === "ready") growUpward();
                },
                { passive: true, signal },
              );
            })}
          >
            {phase === "loading" ? (
              <div class="space-y-3" data-testid="history-skeleton" aria-hidden="true">
                <div class="h-16 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
                <div class="h-24 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
                <div class="h-12 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
              </div>
            ) : entries.length === 0 ? (
              <div class="px-2 py-16 text-center text-sm leading-relaxed text-muted-foreground" data-testid="history-empty" data-reason={unavailable ?? "no-log"}>
                {/* The route is reachable by URL, so it EXPLAINS rather than 404s. When the multiplexer keeps
                    no agent session log at all, its own words replace the generic per-pane copy. */}
                {sessionLog.capable || sessionLog.note === "" ? unavailableCopy(unavailable ?? "no-log") : sessionLog.note}
              </div>
            ) : (
              <>
                {!allRendered || hasMore ? (
                  <button
                    type="button"
                    data-testid="history-load-older"
                    disabled={loadingOlder}
                    class="mb-3 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50 disabled:opacity-60"
                    mix={on("click", () => growUpward())}
                  >
                    <Icon icon={loadingOlder ? LoaderCircle : ArrowUpToLine} class={loadingOlder ? "size-3.5 motion-safe:animate-spin" : "size-3.5"} />
                    {loadingOlder ? t("history.loading") : t("history.loadOlder")}
                  </button>
                ) : (
                  <div class="mb-3 text-center text-[11px] text-muted-foreground" data-testid="history-start">
                    {fileTruncated ? t("history.startClipped") : t("history.startOfConversation")}
                  </div>
                )}
                <TranscriptView entries={shown} agent={agent?.agent} query={query} focusedUuid={focusedUuid} scope={scope} />
              </>
            )}
          </div>

          {/* Jump between the turns YOU wrote: in a thousand-turn thread those are the only landmarks.
              Hidden while find is open, which owns prev and next then. */}
          {userTurns.length > 1 && !findOpen ? (
            <div class="absolute right-3 bottom-3 z-10 flex flex-col overflow-hidden rounded-md border bg-background/90 shadow-md backdrop-blur" data-testid="history-jump">
              <button
                type="button"
                aria-label={t("history.prevMessageAria")}
                class="flex size-9 items-center justify-center text-muted-foreground transition-colors active:bg-muted"
                mix={on("click", () => jumpTo(step(userTurns, cursor, -1)))}
              >
                <Icon icon={ChevronUp} class="size-4" />
              </button>
              <button
                type="button"
                aria-label={t("history.nextMessageAria")}
                class="flex size-9 items-center justify-center border-t text-muted-foreground transition-colors active:bg-muted"
                mix={on("click", () => jumpTo(step(userTurns, cursor, 1)))}
              >
                <Icon icon={ChevronDown} class="size-4" />
              </button>
            </div>
          ) : null}
        </div>
      </Frame>
    );
  };
}
