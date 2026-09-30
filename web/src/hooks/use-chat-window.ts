import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import { fetchChat } from "@/lib/api";
import {
  EMPTY_CHAT_WINDOW,
  mergeChat,
  type ChatAnswer,
  type ChatWindow,
} from "@/lib/chat-window";
import { t } from "@/lib/i18n";
import { paneScopeKey, type Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";

// One pane's live session, held on the phone and moved by the poll that already exists.
//
// ── THERE IS NO TIMER HERE, AND THAT IS THE RULE ─────────────────────────────
// ADR 0073 point 1: the transport is the poll, answered 304 when nothing moved. On this side of the
// wire that means riding `useRevalidator()`'s own loading→idle edge rather than starting a second
// interval. `hooks/use-polling.ts` owns the cadence — five rules resolved from what the operator is
// doing — and it already refuses to fetch behind a hidden tab. A timer here would have to rebuild
// both, would disagree with the first one to be tuned, and would keep reading a session on a phone
// in a pocket.
//
// ── THE MERGE IS NOT HERE EITHER ─────────────────────────────────────────────
// `lib/chat-window.ts` is pure and holds all three merge rules. This hook is the part that cannot
// be pure: a fetch, a cursor and the answer handed to that function. Keeping the split means the
// rules that are easy to get wrong are the ones with no DOM and no clock in them.
//
// ── WHAT A FAILURE COSTS ─────────────────────────────────────────────────────
// A thrown fetch leaves the held window exactly as it was and says nothing. The connection strip
// above the header is already the app's one answer to "the bridge is not answering" (DESIGN.md
// §11), and a second sentence inside the stream would be the same fact twice. A 404 and an
// `available: false` are NOT failures: they are readings, they come back as {@link ChatWindow.status},
// and the view says them in words.

/** How many older turns one "load older" tap asks for. The live first page takes the bridge's own
 *  default (40), which is what ADR 0073 sized a first paint at. */
const OLDER_PAGE = 40;

export interface ChatFeed {
  /** What this pane's session is, as the last answer left it. */
  readonly window: ChatWindow;
  /** Ask for the page before the oldest turn held. Does nothing without one to ask for. */
  readonly loadOlder: () => void;
  /** A `?before=` page is in flight — the top affordance says so rather than repeating the tap. */
  readonly loadingOlder: boolean;
}

/**
 * Hold one pane's live session window, moved on the existing poll.
 *
 * `enabled` false answers the empty window and fetches nothing, which is what a pane with no
 * journal, and every pane while Chat is off, costs.
 */
export function useChatWindow({
  paneId,
  scope,
  enabled,
}: {
  paneId: string;
  /** Which machine + which named session this pane lives in — every other pane read carries it. */
  scope?: Scope;
  /** False for a pane with no journal, and for every pane while the operator is on the terminal. */
  enabled: boolean;
}): ChatFeed {
  const revalidator = useRevalidator();
  const [held, setHeld] = useState<ChatWindow>(EMPTY_CHAT_WINDOW);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // The window as the NEXT answer must merge into it. A ref beside the state because the poll reads
  // it from inside an async callback: reading the state there would close over whatever it was when
  // the effect ran, and merging an answer into a stale window replaces turns that never moved.
  const window = useRef<ChatWindow>(EMPTY_CHAT_WINDOW);
  // One request at a time. A slow answer must not have a second one started on top of it: both
  // would carry the same cursor and the later one would merge an answer the first already merged.
  const busy = useRef(false);
  const alive = useRef(true);

  // A window belongs to the pane it was read from. Keyed on the ADDRESS, not the pane id: `w1:p1`
  // is a different terminal in every session and on every machine, and merging one machine's turns
  // into another's is the one mistake this whole module exists to avoid. Reset during render rather
  // than in an effect, so the first paint after a switch is empty rather than the previous pane's.
  const address = paneScopeKey(scope, paneId);
  const [shownAddress, setShownAddress] = useState(address);
  if (shownAddress !== address) {
    setShownAddress(address);
    window.current = EMPTY_CHAT_WINDOW;
    setHeld(EMPTY_CHAT_WINDOW);
    setLoadingOlder(false);
  }

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apply = useCallback((answer: ChatAnswer) => {
    const next = mergeChat(window.current, answer);
    window.current = next;
    if (alive.current) setHeld(next);
  }, []);

  // The poll's own edge. `idle` flips false while a revalidation is in flight and true when it
  // lands, so this effect runs once per poll — and once on mount, which is the first paint.
  const idle = revalidator.state === "idle";
  useEffect(() => {
    if (!enabled || !idle) return;
    void (async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const cursor = window.current;
        // `gen` 0 means nothing has been placed yet — a first paint, a pane just switched to, or a
        // session that answered 404 or `available: false` last time and may answer differently now.
        const answer = await fetchChat(
          paneId,
          cursor.gen === 0 ? {} : { after: { gen: cursor.gen, rev: cursor.rev } },
          scope,
        );
        apply(answer);
      } catch {
        // Keep what we hold — see the module header.
      } finally {
        busy.current = false;
      }
    })();
    // `scope` is safe in a dependency array: scopes read off a URL are interned to one frozen
    // instance per (host, session), so its identity is as stable as the string it replaced.
  }, [enabled, idle, paneId, scope, address, apply]);

  const loadOlder = useCallback(() => {
    const cursor = window.current;
    const oldest = cursor.entries[0];
    if (loadingOlder || !cursor.hasOlder || oldest === undefined) return;
    setLoadingOlder(true);
    void (async () => {
      try {
        // Both of the oldest turn's names. The bridge resolves the uuid against the store the
        // History page reads, so a tap after a History visit is a cache hit (ADR 0073).
        const answer = await fetchChat(
          paneId,
          { limit: OLDER_PAGE, before: { seq: cursor.oldest, uuid: oldest.uuid } },
          scope,
        );
        apply(answer);
      } catch {
        // A tap the operator made and is watching, so this one speaks: the floating status is the
        // app's answer for a failure with no other surface (DESIGN.md §11).
        setStatus(t("chat.stream.loadOlderFailed"), "error");
      } finally {
        if (alive.current) setLoadingOlder(false);
      }
    })();
  }, [apply, loadingOlder, paneId, scope]);

  return { window: held, loadOlder, loadingOlder };
}
