import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import { keepChatOf, loadDisplayPrefs } from "@/hooks/use-display-prefs";
import { fetchChat, isPairingRefusal, isRefusalStatus, readFailureKind } from "@/lib/api";
import { loadChatTail, saveChatTail } from "@/lib/chat-tail";
import {
  EMPTY_CHAT_WINDOW,
  markSaved,
  mergeChat,
  savedChatWindow,
  sessionChanged,
  type ChatAnswer,
  type ChatWindow,
} from "@/lib/chat-window";
import {
  isLostLatched,
  SERVER_FAILURES_TO_LATCH,
  useLostLatched,
  wakeStrikeHolds,
} from "@/lib/connection-health";
import { t } from "@/lib/i18n";
import { paneScopeKey, type Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";
import { REWRITE_AFTER_MS } from "@/lib/store";

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
//
// ── THE SAVED COPY (M46 spec 09, lib/chat-tail.ts) ──────────────────────────
// Every live answer writes the newest turns through to the on-device store, under the lifetime
// "Keep chat on this phone" asks for. A read that fails for want of a bridge (a transport failure, a
// timeout, a 5xx from a proxy whose bridge is down; never a 4xx refusal, never a 404 or a "no log",
// which are answers) then reads the copy back, but only into a window that holds nothing: a cold
// open, or a pane opened while the bridge is out of reach. The copy is marked with `savedAt` and the
// view says so. The next live answer replaces or clears it.
//
// ── A FAILED POLL NEVER DROPS WHAT IS HELD (M46 pass 3, 2026-10-07) ──────────
// A window that already holds turns keeps every one of them on a failed read, whatever the failure,
// and the store is not read at all: memory is newer than the copy. The window is MARKED (`savedAt` set
// to the time of the last live answer, so the view draws the saved-copy line) on the same rule the
// connection strip uses: at once for a read that got no answer (a network failure or the poll
// deadline), on the second 5xx in a row, or when the herd read has already latched the outage. The
// mark stays until a live answer, so the line appears once and does not flap. Right after a wake the
// first read with no answer is one strike and marks nothing (lib/connection-health.ts
// `wakeStrikeHolds`); the herd read's retry decides, and its latch marks the window.
//
// ── THE COLD OPEN, AS THE LOADERS DO IT (lib/loaders.ts COLD_OPEN_WAIT_MS) ──
// What blanked the Chat body on Altan's phone (airplane mode, Tailscale up, 2026-10-07): a view that
// MOUNTS with nothing in memory (the PWA reopened, a page Android discarded) started from the empty
// window and read the saved copy back only once its own fetch had failed. Over a VPN with the radio
// off that fetch does not fail, it hangs until its deadline, and the body stood empty under a strip
// that already said "showing what was saved" (the loaders had raced and drawn their copy after
// 1.5s). Now an empty window reads the copy back at once when the outage is already known, or when
// the pane view says its mirror is the saved copy (`savedCopy`): the loaders' own cold-open wait has
// then already run, and the Chat body follows them rather than starting a second wait of its own.
//
// The raw mirror is never cached here: the Terminal body has no offline read beyond the last-seen
// pane text the loaders already keep (lib/last-seen.ts).

/** How many older turns one "load older" tap asks for. The live first page takes the bridge's own
 *  default (40), which is what ADR 0073 sized a first paint at; a tap is a request to read back, so it
 *  asks for more, still under the bridge's ceiling of 200 (#364). */
const OLDER_PAGE = 100;

export interface ChatFeed {
  /** What this pane's session is, as the last answer left it. */
  readonly window: ChatWindow;
  /** Ask for the page before the oldest turn held. Does nothing without one to ask for. */
  readonly loadOlder: () => void;
  /** A `?before=` page is in flight — the top affordance says so rather than repeating the tap. */
  readonly loadingOlder: boolean;
  /**
   * The number of the last live read STARTED. Reads are numbered from 1 for the life of the view and
   * never reused, so a number taken in one render orders every read against that render: a read
   * numbered above it began after it (hooks/use-pane-start.ts § the turn-end read).
   */
  readonly asked: number;
  /** The number of the last live read that came back with an answer. A thrown fetch moves nothing. */
  readonly answered: number;
  /** A live read for THIS pane has come back, with an answer or with a failure. The swap gate. */
  readonly tried: boolean;
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
  instance,
  enabled,
  savedCopy = false,
  seen = true,
}: {
  paneId: string;
  /** Which machine + which named session this pane lives in — every other pane read carries it. */
  scope?: Scope;
  /**
   * The pane's session instance (`AgentView.instance`): another session that takes the same pane id
   * carries another one, and neither the held window nor the saved copy crosses from one to the other.
   * A pane that gains its first instance keeps its held window (see the reset below).
   */
  instance?: string;
  /** False for a pane with no journal, and for every pane while the operator is on the terminal. */
  enabled: boolean;
  /**
   * The pane's mirror on screen is the saved copy (`PaneData.stale`, lib/loaders.ts): the loaders
   * gave up waiting for the bridge. An empty window then reads its own saved copy at once.
   */
  savedCopy?: boolean;
  /**
   * Whether this read counts as opening the pane (its unseen mark clears). False for a large
   * screen's read-only column beside the focused one (ADR 0120): only the focused pane is opened.
   */
  seen?: boolean;
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
  // The read numbers (see ChatFeed.asked). The counter is a ref because the effect allocates from it;
  // the two readings are state because a render reads them.
  const counter = useRef(0);
  const [asked, setAsked] = useState(0);
  const [answered, setAnswered] = useState(0);
  // The address the last read that came back was for, so `tried` is about this pane and no other.
  const [triedAddress, setTriedAddress] = useState<string | null>(null);
  // When the last live answer came back, for the saved-copy mark of a window that already holds turns.
  const lastAnsweredAt = useRef<number | null>(null);
  // Chat reads in a row that came back as a 5xx: one is a blip, two mark the window (see the header).
  const serverFailures = useRef(0);
  // The window last written through, and when: an unchanged window is not serialised again until
  // the store itself would write it again (REWRITE_AFTER_MS).
  const lastSaved = useRef<{ window: ChatWindow; at: number } | null>(null);

  // A window belongs to the pane it was read from. Keyed on the ADDRESS, not the pane id: `w1:p1`
  // is a different terminal in every session and on every machine, and merging one machine's turns
  // into another's is the one mistake this whole module exists to avoid. Reset during render rather
  // than in an effect, so the first paint after a switch is empty rather than the previous pane's.
  //
  // The pane's session instance is part of that identity, but only once it is known on both sides.
  // A live pane can go from no instance to one: a pane the phone just opened is drawn from the
  // `freshPane` it built itself (hooks/use-spaces.ts), which carries none, until the snapshot names
  // it; a saved herd or an older crew member carries none either. That is the same session, so the
  // held window stays and the instance is adopted. Only two known instances that differ (a new
  // session took the pane id) reset it. The saved copy is stricter: it is read under the exact
  // instance the pane carries now (lib/chat-tail.ts).
  const paneAddress = paneScopeKey(scope, paneId);
  const [shown, setShown] = useState<{ pane: string; instance: string | undefined; epoch: number }>({
    pane: paneAddress,
    instance,
    epoch: 0,
  });
  const switched =
    shown.pane !== paneAddress || (shown.instance !== undefined && instance !== undefined && shown.instance !== instance);
  const epoch = switched ? shown.epoch + 1 : shown.epoch;
  // The identity the effects below compare after an await. It moves on a reset and never on an
  // adopted instance, so a read in flight while the instance arrives still lands.
  const address = `${paneAddress}@${epoch}`;
  // The instance this window is known to belong to, for the write-through: a pane that drops its
  // instance for a render (a saved herd) still writes under the one it had.
  const knownInstance = instance ?? (switched ? undefined : shown.instance);
  // The address the effects below are working for, read after an await: a saved copy or live read
  // that comes back after a pane or instance switch belongs to the one that asked, not the one on screen.
  const addressNow = useRef(address);
  if (switched) {
    setShown({ pane: paneAddress, instance, epoch });
    addressNow.current = address;
    window.current = EMPTY_CHAT_WINDOW;
    busy.current = false;
    setHeld(EMPTY_CHAT_WINDOW);
    setLoadingOlder(false);
  } else if (instance !== undefined && shown.instance !== instance) {
    setShown({ pane: paneAddress, instance, epoch });
  }
  useEffect(() => {
    addressNow.current = address;
  }, [address]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A window also belongs to the SESSION it was read from (#526). When the pane's agent starts
  // another one (pi's `/new`), the answer carries another `session` tag and `mergeChat` replaces the
  // thread and every older page with the new session's turns, which may be none. A "load older" tap
  // still in flight belonged to the old session: its page is thrown away on arrival, and its
  // spinner goes now, so the new thread does not stand under a load it never asked for.
  const apply = useCallback((answer: ChatAnswer) => {
    const previous = window.current;
    const next = mergeChat(previous, answer);
    window.current = next;
    if (!alive.current) return;
    setHeld(next);
    if (sessionChanged(previous, next)) setLoadingOlder(false);
  }, []);

  /** Write the held window through to the store (see the header). Live windows with turns only. */
  const writeThrough = useCallback(() => {
    const current = window.current;
    if (current.status.kind !== "live" || current.savedAt !== null || current.entries.length === 0) return;
    const at = Date.now();
    const last = lastSaved.current;
    if (last !== null && last.window === current && at - last.at < REWRITE_AFTER_MS) return;
    lastSaved.current = { window: current, at };
    void saveChatTail(scope, paneId, current.entries, keepChatOf(loadDisplayPrefs()), at, knownInstance);
  }, [paneId, scope, knownInstance]);

  /** Draw the saved copy into a window that holds nothing. A window with turns is never touched. */
  const readSaved = useCallback(async () => {
    if (window.current.entries.length > 0) return;
    const askedFor = address;
    const saved = await loadChatTail(scope, paneId, instance);
    // Only into the same empty window it was asked for: a pane switch, or a live answer that landed
    // while the store was being read, wins.
    if (saved === null || !alive.current || addressNow.current !== askedFor || window.current.entries.length > 0) {
      return;
    }
    const copy = savedChatWindow(saved.entries, saved.at);
    window.current = copy;
    setHeld(copy);
  }, [address, paneId, scope, instance]);

  /**
   * A read failed for want of a bridge: keep what is held and mark it, or draw the saved copy into an
   * empty window (see the header). `outage` is the rule for the mark: this failure, or the run of them
   * it ends, proves the bridge is out of reach.
   */
  const readBack = useCallback(
    async (outage: boolean) => {
      const current = window.current;
      if (current.entries.length === 0) {
        await readSaved();
        return;
      }
      const answeredAt = lastAnsweredAt.current;
      if (!(outage || isLostLatched()) || answeredAt === null) return;
      const marked = markSaved(current, answeredAt);
      if (marked === current) return;
      window.current = marked;
      if (alive.current) setHeld(marked);
    },
    [readSaved],
  );

  // THE HERD READ PROVED THE OUTAGE FIRST. The Chat read rides the poll's idle edge, so it starts only
  // after the herd read of the same poll has failed, and then has to fail on its own: up to one more
  // poll deadline with the strip already saying "showing what was saved" over an unmarked window. The
  // latch is the same fact, so the held window is marked the moment it is set.
  const latched = useLostLatched();
  useEffect(() => {
    if (!latched) return;
    const current = window.current;
    const answeredAt = lastAnsweredAt.current;
    if (current.entries.length === 0 || answeredAt === null) return;
    const marked = markSaved(current, answeredAt);
    if (marked === current) return;
    window.current = marked;
    setHeld(marked);
  }, [latched]);

  // Read from inside the poll effect, as a ref so the flag flipping does not start a read of its own.
  const savedCopyNow = useRef(savedCopy);
  savedCopyNow.current = savedCopy;

  // The poll's own edge. `idle` flips false while a revalidation is in flight and true when it
  // lands, so this effect runs once per poll — and once on mount, which is the first paint.
  const idle = revalidator.state === "idle";
  useEffect(() => {
    if (!enabled || !idle) return;
    void (async () => {
      if (busy.current) return;
      busy.current = true;
      const askedFor = address;
      const number = ++counter.current;
      setAsked(number);
      // THE COLD OPEN (see the header). Only an empty window; `readSaved` re-checks that after its own
      // await, so a live answer that lands first always wins.
      if (window.current.entries.length === 0) {
        const outage = savedCopyNow.current || isLostLatched() || globalThis.navigator?.onLine === false;
        if (outage) void readSaved();
      }
      try {
        const cursor = window.current;
        // `gen` 0 means nothing has been placed yet — a first paint, a pane just switched to, or a
        // session that answered 404 or `available: false` last time and may answer differently now.
        const answer = await fetchChat(
          paneId,
          cursor.gen === 0 ? {} : { after: { gen: cursor.gen, rev: cursor.rev } },
          scope,
          undefined,
          { seen },
        );
        if (!alive.current || addressNow.current !== askedFor) return;
        apply(answer);
        lastAnsweredAt.current = Date.now();
        serverFailures.current = 0;
        writeThrough();
        setAnswered(number);
      } catch (error) {
        if (!alive.current || addressNow.current !== askedFor) return;
        // Keep what we hold — see the module header. A failure for want of a bridge may draw the
        // saved copy; a refusal is an answer and draws nothing it did not draw before. The one thing a
        // refusal takes away is a saved copy the cold open drew: a phone the bridge refuses for want
        // of pairing keeps nothing on screen (M46 spec 10, the third state).
        if (isPairingRefusal(error)) {
          if (window.current.savedAt !== null && window.current.gen === 0) {
            window.current = EMPTY_CHAT_WINDOW;
            setHeld(EMPTY_CHAT_WINDOW);
          }
        } else if (!isRefusalStatus(error)) {
          const kind = readFailureKind(error);
          serverFailures.current = kind === "server" ? serverFailures.current + 1 : 0;
          const noAnswer = kind === "network" && !wakeStrikeHolds();
          const outage = noAnswer || serverFailures.current >= SERVER_FAILURES_TO_LATCH;
          await readBack(outage);
        }
      } finally {
        if (addressNow.current === askedFor) {
          busy.current = false;
          if (alive.current) setTriedAddress(askedFor);
        }
      }
    })();
    // `scope` is safe in a dependency array: scopes read off a URL are interned to one frozen
    // instance per (host, session), so its identity is as stable as the string it replaced.
  }, [enabled, idle, paneId, scope, address, seen, apply, writeThrough, readBack, readSaved]);

  const loadOlder = useCallback(() => {
    const cursor = window.current;
    const oldest = cursor.entries[0];
    if (loadingOlder || !cursor.hasOlder || oldest === undefined) return;
    const askedFor = addressNow.current;
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
        if (!alive.current || addressNow.current !== askedFor) return;
        apply(answer);
      } catch {
        if (!alive.current || addressNow.current !== askedFor) return;
        // A tap the operator made and is watching, so this one speaks: the floating status is the
        // app's answer for a failure with no other surface (DESIGN.md §11).
        setStatus(t("chat.stream.loadOlderFailed"), "error");
      } finally {
        if (alive.current && addressNow.current === askedFor) setLoadingOlder(false);
      }
    })();
  }, [apply, loadingOlder, paneId, scope]);

  return { window: held, loadOlder, loadingOlder, asked, answered, tried: triedAddress === address };
}
