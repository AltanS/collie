import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLoaderData, useNavigate, useParams } from "react-router";
import { ArrowUpToLine, ChevronDown, ChevronUp, Loader2, ScrollText, Search, X } from "lucide-react";

import { RouteHeader } from "@/components/app-header";
import { ChatMessageList, type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { FindBar } from "@/components/find-bar";
import { TranscriptView } from "@/components/transcript-view";
import { fetchHistory } from "@/lib/api";
import { HISTORY_PAGE_SIZE, type HistoryData } from "@/lib/loaders";
import { useMuxCapability } from "@/lib/mux-capability";
import { panePath } from "@/lib/nav";
import { setStatus } from "@/lib/status";
import { matchingEntries, step, userTurnIndices } from "@/lib/transcript-search";
import type { TranscriptEntry } from "@/lib/types";
import { useRootData } from "@/lib/route-data";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

// Pane history route — the agent's own transcript, which is the ONLY conversation history a Claude
// pane can have. Its terminal runs on the alternate screen, so Herdr retains no scrollback ring at
// all and `pane.read` can never return more than the visible viewport (see bridge/transcript.ts).
//
// FETCH ALL, RENDER SOME. The whole conversation arrives in one request (measured: 1500 turns =
// 1.3 MB raw / 335 KB gzipped / 128 ms — cheap, and it's what makes find-in-history and
// jump-to-user-message work across turns you haven't scrolled to yet). What is NOT cheap is the DOM:
// 1425 turns rendered at once is ~17k nodes, and the longest log on this machine is 3244 turns, which
// would be ~39k. So the rendered window starts small and grows upward as you scroll — the data is
// already in memory, so growing it is instant and needs no network.
//
// The loader is deliberately not revalidated (`shouldRevalidate: false` in router.tsx), so the 1.5 s
// poll never re-pulls a several-hundred-turn transcript out from under the reader.

/** Why the strip is empty, in the user's terms. Each is an ordinary state, not an error. Called
 *  fresh at render time (not a module-level const) so a language switch picks up the new copy. */
function unavailableCopy() {
  return {
    disabled: t("history.unavailable.disabled"),
    "no-session": t("history.unavailable.noSession"),
    "no-log": t("history.unavailable.noLog"),
    error: t("history.unavailable.error"),
  } satisfies Record<NonNullable<HistoryData["unavailable"]>, string>;
}

/** Turns rendered on open — a few screens, so first paint stays instant on the longest threads. */
const INITIAL_RENDER = 60;
/** Turns added per upward growth step. */
const RENDER_STEP = 120;
/** Distance from the top of the scroller that triggers growth, in px. */
const GROW_THRESHOLD = 800;

export function HistoryRoute() {
  // SAFETY: this is the `/pane/:paneId/history` route's element and `historyLoader` returns
  // `HistoryData`; React Router types a data-mode `useLoaderData()` as `unknown`.
  const data = useLoaderData() as HistoryData;
  useLocale();
  const root = useRootData();
  const { paneId = "" } = useParams();
  const navigate = useNavigate();
  // Whether an agent session log can exist here at all — a property of the multiplexer, not of this
  // pane. See the empty-state branch below for what it changes.
  const sessionLog = useMuxCapability("agentSessionRef");
  const scope = data.scope;

  const agent =
    root.agents.find((a) => a.paneId === paneId) ??
    root.shellPanes.find((p) => p.paneId === paneId);

  // Pages walked back beyond the first request (only reachable on a log longer than HISTORY_PAGE_SIZE).
  const [older, setOlder] = useState<TranscriptEntry[]>([]);
  const [hasMore, setHasMore] = useState(data.hasMore);
  const [loading, setLoading] = useState(false);
  const entries = useMemo(
    () => (older.length ? [...older, ...data.entries] : data.entries),
    [older, data.entries],
  );

  // How many of the NEWEST turns are rendered. Everything else is held in memory, unrendered.
  const [renderCount, setRenderCount] = useState(INITIAL_RENDER);
  const shown = useMemo(
    () => (renderCount >= entries.length ? entries : entries.slice(entries.length - renderCount)),
    [entries, renderCount],
  );
  const allRendered = renderCount >= entries.length;

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Index into `entries` (not `shown`) of the turn a find/jump landed on; -1 = nowhere yet.
  const [cursor, setCursor] = useState(-1);

  const matches = useMemo(() => matchingEntries(entries, query), [entries, query]);
  const userTurns = useMemo(() => userTurnIndices(entries), [entries]);
  const focusedUuid = cursor >= 0 ? entries[cursor]?.uuid : undefined;

  const listRef = useRef<ChatMessageListHandle>(null);
  // Growing upward inserts content ABOVE the viewport, which would yank what you're reading downward.
  // Measure before, restore after — the same anchoring the terminal mirror's "load older" uses.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const pendingRestore = useRef(false);

  const captureAnchor = () => {
    const el = listRef.current?.getScrollElement();
    anchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    pendingRestore.current = true;
  };

  /** Fetch turns older than everything held — only for logs beyond the initial request. */
  const loadOlder = useCallback(async () => {
    const oldest = entries[0]?.uuid;
    if (loading || !hasMore || !oldest) return;
    captureAnchor();
    setLoading(true);
    try {
      const res = await fetchHistory(paneId, { limit: HISTORY_PAGE_SIZE, before: oldest }, scope);
      if (!res.available) {
        setHasMore(false);
        return;
      }
      setOlder((prev) => [...res.entries, ...prev]);
      setRenderCount((c) => c + res.entries.length); // keep the newly-fetched turns visible
      setHasMore(res.hasMore);
    } catch {
      setStatus(t("history.loadOlderFailed"), "error");
    } finally {
      setLoading(false);
    }
  }, [entries, hasMore, loading, paneId, scope]);

  /** Reveal more of what we already hold; only hit the network once nothing is left in memory. */
  const growUpward = useCallback(() => {
    if (!allRendered) {
      captureAnchor();
      setRenderCount((c) => Math.min(c + RENDER_STEP, entries.length));
      return;
    }
    if (hasMore) void loadOlder();
  }, [allRendered, entries.length, hasMore, loadOlder]);

  // Auto-grow as the reader approaches the top, so scrolling back through a long thread feels
  // continuous instead of requiring a tap per window.
  useEffect(() => {
    const el = listRef.current?.getScrollElement();
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < GROW_THRESHOLD && !loading) growUpward();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [growUpward, loading]);

  // Restore the reading position once the newly-revealed turns have painted.
  useLayoutEffect(() => {
    if (!pendingRestore.current) return;
    pendingRestore.current = false;
    const a = anchor.current;
    const el = listRef.current?.getScrollElement();
    if (a && el) el.scrollTop = a.top + (el.scrollHeight - a.height);
    anchor.current = null;
  }, [shown]);

  /**
   * Send the reader to a turn by index, rendering far enough back to reach it first. React needs a
   * paint before the element exists, so the scroll runs in an effect keyed on the cursor.
   */
  const jumpTo = useCallback(
    (index: number | null) => {
      if (index === null) return;
      const needed = entries.length - index + 10; // a little context above the target
      setRenderCount((c) => Math.max(c, Math.min(needed, entries.length)));
      setCursor(index);
    },
    [entries.length],
  );

  useEffect(() => {
    if (cursor < 0) return;
    const uuid = entries[cursor]?.uuid;
    if (!uuid) return;
    const el = listRef.current?.getScrollElement();
    el?.querySelector(`[data-turn="${CSS.escape(uuid)}"]`)?.scrollIntoView({ block: "center" });
  }, [cursor, entries, shown]);

  // A new query invalidates the previous position, so the first Next starts from the top of the thread.
  useEffect(() => setCursor(-1), [query]);

  function closeFind() {
    setFindOpen(false);
    setQuery("");
    setCursor(-1);
  }

  // Open at the newest turn — you arrive from the live mirror, so the recent end is the continuation.
  useLayoutEffect(() => {
    listRef.current?.scrollToBottom();
  }, []);

  const title = agent?.paneLabel ?? agent?.sessionName ?? agent?.workspaceLabel ?? paneId;
  const matchCursor = matches.indexOf(cursor);

  return (
    // The same column as the pane this transcript belongs to, because it is the other half of that
    // screen and one navigation away from it: it keeps the pane's width and its left edge, or the
    // page jumps sideways on the hop. See AgentChat's wrapper for why the pane stops at 768px.
    // `max-w-[100dvw]` is the phone bound; `md:max-w-screen-md` only bites from 768px up, where it
    // is never the wider of the two.
    <div className="mx-auto flex min-h-0 w-full min-w-0 max-w-[100dvw] flex-1 flex-col md:max-w-screen-md">
      <RouteHeader
        onHome={() => navigate(panePath(paneId, scope))}
        width="wide"
        override={
          findOpen ? (
            <FindBar
              query={query}
              onQueryChange={setQuery}
              count={matches.length}
              current={matchCursor >= 0 ? matchCursor : 0}
              onPrev={() => jumpTo(step(matches, cursor, -1))}
              onNext={() => jumpTo(step(matches, cursor, 1))}
              onClose={closeFind}
              subject={t("find.subject.history")}
            />
          ) : undefined
        }
        rightLead={
          <>
            {/* A PWA has no browser find, so the view has to provide its own. */}
            <button
              type="button"
              onClick={() => setFindOpen(true)}
              aria-label={t("history.findAria")}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors active:bg-muted/60"
            >
              <Search className="size-4" />
            </button>
            {data.total > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {shown.length}/{data.total}
              </span>
            )}
          </>
        }
        // Explicit exit from reading mode. The Collie mark also returns to the pane, but this is a
        // full-screen reading view you deliberately entered — it should be as obvious to leave as it
        // was to open, without relying on the phone's back gesture.
        rightTrail={
          <button
            type="button"
            onClick={() => navigate(panePath(paneId, scope))}
            aria-label={t("history.closeAria")}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors active:bg-muted/60"
          >
            <X className="size-4" />
          </button>
        }
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <ScrollText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-semibold leading-tight">{t("history.title")}</span>
          </div>
          <div className="truncate text-xs leading-tight text-muted-foreground">{title}</div>
        </div>
      </RouteHeader>

      <div className="relative min-h-0 min-w-0 flex-1">
        <ChatMessageList ref={listRef} className="px-3 py-3">
          {entries.length === 0 ? (
            <div className="px-2 py-16 text-center text-sm leading-relaxed text-muted-foreground">
              {/* The route is reachable by URL — a bookmark, a back button, an older cached bundle
                  whose entry points had not yet learned to hide. So it EXPLAINS rather than 404s
                  (M10/06). When the multiplexer keeps no agent session log at all, its own words
                  replace the generic per-pane copy: "this pane has no agent session" is true but
                  reads as something the operator could fix by starting an agent, which here they
                  cannot. Empty on Herdr, so this is exactly today's copy there. */}
              {sessionLog.capable || sessionLog.note === ""
                ? unavailableCopy()[data.unavailable ?? "no-log"]
                : sessionLog.note}
            </div>
          ) : (
            <>
              {/* Sits at the very top of what's rendered, so scrolling up reaches it naturally. The
                  auto-grow above usually gets there first; this is the explicit fallback. */}
              {!allRendered || hasMore ? (
                <button
                  type="button"
                  onClick={growUpward}
                  disabled={loading}
                  className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50 disabled:opacity-60"
                >
                  {loading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ArrowUpToLine className="size-3.5" />
                  )}
                  {loading ? t("history.loading") : t("history.loadOlder")}
                </button>
              ) : (
                <div className="mb-3 text-center text-[11px] text-muted-foreground">
                  {data.fileTruncated ? t("history.startClipped") : t("history.startOfConversation")}
                </div>
              )}
              <TranscriptView
                entries={shown}
                agent={agent?.agent}
                query={query}
                focusedUuid={focusedUuid}
              />
            </>
          )}
        </ChatMessageList>

        {/* Jump between the turns YOU wrote — in a thousand-turn thread those are the only landmarks
            (20 human turns in 900 is typical). Bottom-right so it's thumb-reachable and clear of the
            centred "scroll to latest" button. Hidden while find is open, which owns prev/next then. */}
        {userTurns.length > 1 && !findOpen && (
          <div className="absolute bottom-3 right-3 z-10 flex flex-col overflow-hidden rounded-md border bg-background/90 shadow-md backdrop-blur">
            <button
              type="button"
              onClick={() => jumpTo(step(userTurns, cursor, -1))}
              aria-label={t("history.prevMessageAria")}
              className="flex size-9 items-center justify-center text-muted-foreground transition-colors active:bg-muted"
            >
              <ChevronUp className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => jumpTo(step(userTurns, cursor, 1))}
              aria-label={t("history.nextMessageAria")}
              className="flex size-9 items-center justify-center border-t text-muted-foreground transition-colors active:bg-muted"
            >
              <ChevronDown className="size-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
