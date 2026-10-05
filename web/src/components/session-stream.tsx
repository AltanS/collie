import { useLayoutEffect, useMemo, useRef, type CSSProperties, type RefObject } from "react";
import { ArrowUpToLine, Loader2 } from "lucide-react";

import { ItemView, ToolGroup, groupRuns } from "@/components/chat-cards";
import { StatusDot } from "@/components/status-badge";
import { ChatMessageList, type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { useLocale } from "@/hooks/use-locale";
import type { ChatFeed } from "@/hooks/use-chat-window";
import { itemsOf } from "@/lib/chat-items";
import type { ChatStatus } from "@/lib/chat-window";
import { t, type MessageKey } from "@/lib/i18n";
import { recallScroll, rememberScroll } from "@/lib/scroll-memory";
import { cn } from "@/lib/utils";

// THE PANE VIEW'S SECOND BODY: the session as the agent's own record has it.
//
// The pane view has two bodies and one set of chrome. The header, the strips, the card dock, the
// belt and the composer are `agent-chat.tsx`'s and do not move; this swaps with the terminal mirror
// inside the same box, on the same rule, under the same face. It is NOT a route and it is not a
// sibling of History: Chat is a MODE, and a mode is a thing whose default can flip (it flips in
// 2.0). Its name says what it draws rather than which mode it is, because `AgentChat` — the whole
// pane view, mirror and composer and belt — already has the other name.
//
// ── WHY THE COMPOSER STAYS ───────────────────────────────────────────────────
// Taking work over from Collie at the computer must not be lost, and you take it over by typing. A
// mode that hid the composer would be a reader, not a mode.
//
// ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────
// No timer, no merge, no cursor arithmetic. `hooks/use-chat-window.ts` rides the existing poll and
// `lib/chat-window.ts` merges; both are handed here as one {@link ChatFeed}. `hasOlder` and
// `oldest` arrive as fields for the same reason: two places computing where the thread starts is
// two places to get it wrong.
//
// ── AND THE TWO EMPTY ANSWERS IT MUST NOT DRAW ALIKE ─────────────────────────
// `available: false` is "this pane has nothing to show" — a shell, an agent with no session, a log
// that cannot be read. A 404 is "this machine runs an older Collie", because the chat route is
// additive-optional over a crew link (ADR 0073 point 7). Drawing them alike tells an operator to
// wait for something that will never arrive, so each has its own sentence.

/**
 * One block of the stream.
 *
 * `content-visibility: auto` skips layout and paint for a block off screen, and the intrinsic size
 * remembers the last real height so the scrollbar does not lie. The 12px padding with a matching
 * negative margin keeps a card's shadow and focus outline inside the paint clip containment adds.
 * Lifted verbatim from the prototype this screen came out of (experiments/session-stream).
 */
const STREAM_BLOCK = "flex min-w-0 flex-col [content-visibility:auto] [contain-intrinsic-size:auto_64px] -m-3 p-3";

/**
 * THE TAIL ROW: a turn is in flight and nothing has landed yet.
 *
 * THE MIRROR NEVER NEEDED THIS AND THIS BODY DOES, which is the whole reason it exists. On the
 * terminal the agent's own spinner is right there in the output — "Compacting conversation…" with a
 * progress bar under it — so a busy pane looks busy. This body draws the agent's RECORD, and a record
 * gains nothing while a turn is being thought about. A compaction writes no row for minutes and then
 * writes one summary, so in Chat a compacting session looked exactly like a finished one. The only
 * live sign was an 8px dot badged on the tile in the header, which is chrome saying "this pane is
 * busy" and not the body saying "your turn is still going".
 *
 * IT IS NOT A SECOND MARK FOR THE SAME FACT (the rule that keeps `compact_boundary` out of the
 * reader, and ADR 0063 point 3). The dot is about the PANE, in the chrome, at the top. This is about
 * the THREAD, at the end of the thread, where the next turn will appear.
 *
 * AND IT DOES NOT CLAIM TO KNOW WHAT the agent is doing. The percentage and the words "Compacting
 * conversation…" live on the screen, and reading them would mean a per-harness screen parser feeding
 * the body that is meant to be screen-independent (ADR 0073). `working` is the one fact both bodies
 * already share. So the row says a turn is running and nothing more, because that is all it knows.
 */
const LIVE_ROW = "mt-1 flex items-center gap-2 py-2 text-xs font-medium text-muted-foreground";

/**
 * THE QUEUE: what the operator typed while the agent was busy.
 *
 * The operator's own colour, because it is the operator's own words — the same `status-working` well
 * `UserTurn` wears (`chat-cards.tsx`), at a lighter weight, so it reads as "mine, and not sent yet"
 * rather than as a turn the agent ignored. A uniform border with a soft shadow and no left accent,
 * per the house rule for a rounded box.
 *
 * Dashed, and that is the one thing carrying "not yet". A solid well would be indistinguishable from
 * a turn that has landed, which is the single mistake this row must not make.
 */
const QUEUED_BLOCK =
  "mt-1 flex min-w-0 flex-col gap-1 rounded-md border border-dashed border-status-working/40 bg-status-working/5 px-3 py-2";
const QUEUED_LABEL = "text-xs font-medium text-status-working";
const QUEUED_TEXT = "wrap-anywhere text-sm whitespace-pre-wrap text-foreground/80";

/** The top affordance, the same shape and the same words the mirror's own scrollback row uses. */
const EDGE_ROW =
  "mb-2 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50 disabled:opacity-60";

/**
 * Why there is nothing to read, in the operator's terms — or `null` while there is.
 *
 * The three `available: false` reasons take the History page's own sentences, because they are the
 * same three facts about the same journal and two wordings for one fact is how they drift. `stale`
 * does not: it is a version skew with a remedy, and it is the one reading here that is not about
 * this pane at all.
 */
export function chatStatusKey(status: ChatStatus): MessageKey | null {
  if (status.kind === "stale") return "chat.stale.member";
  // `empty` is "nothing has been asked yet" and `live` is "the window answered". Neither is a
  // sentence, and neither is an absence a screen may announce.
  if (status.kind !== "unavailable") return null;
  switch (status.reason) {
    case "disabled":
      return "history.unavailable.disabled";
    case "no-session":
      return "history.unavailable.noSession";
    case "no-log":
      return "history.unavailable.noLog";
  }
}

/**
 * The reader's own text size, as three token overrides rather than one `font-size`.
 *
 * Tailwind compiles `text-sm` to `font-size: var(--text-sm)`, and a custom property CASCADES, so
 * re-declaring the token on the scroller resizes every `text-sm` inside it — the blocks, the cards,
 * the Markdown renderer — with no prop threaded into any of them and no class to keep in step. A
 * plain `font-size` here would have moved nothing, because `text-sm` is a rem and does not listen
 * to its parent.
 *
 * The other two ride the same ratio they have in the theme (12/14 and 16/14), so a heading stays a
 * step above the body and a caption a step below it at every size. Their own line heights are
 * unitless ratios in the theme, so they follow on their own.
 *
 * `text-[11px]` chrome inside the stream is deliberately NOT in here. A caption is chrome and the
 * words are content (DESIGN.md §5), and this control is about the words.
 */
function textTokens(size: number): CSSProperties {
  // SAFETY: `CSSProperties` has no index signature for custom properties, and React has accepted
  // them on `style` since 18. Every value here is a string this function built, so the assertion
  // widens the key names and asserts nothing about the values.
  return {
    "--text-xs": `${((size * 12) / 14).toFixed(2)}px`,
    "--text-sm": `${size}px`,
    "--text-base": `${((size * 16) / 14).toFixed(2)}px`,
  } as CSSProperties;
}

export function SessionStream({
  feed,
  address,
  working,
  starting = false,
  showToolCalls,
  showCompactions,
  fontSize,
  listRef,
}: {
  /** The held window plus its one control, from `useChatWindow`. */
  feed: ChatFeed;
  /** This pane's full address (host + session + id) — the key its scroll position is kept under. */
  address: string;
  /**
   * The agent is mid-turn, from the pane record's own status. See the note at {@link LIVE_ROW} for
   * why this body needs telling and the mirror does not.
   */
  working: boolean;
  /**
   * The pane is NEW and has nothing to read yet: no session reported, or no log written (lib/chat-gate.ts).
   * The stream then says how to begin, and never the "no session" or "no transcript file" reading,
   * which is only true of a pane that should have one by now.
   */
  starting?: boolean;
  /** Settings → Appearance. Off folds every run, including a lone step, to one summary line. */
  showToolCalls: boolean;
  /** Settings → Appearance. Off draws a compaction as a one-line marker and never builds its recap. */
  showCompactions: boolean;
  /** The stream's own text size in px, from the belt's Display dock (`chatFontSize`). */
  fontSize: number;
  /** The pane view's one list handle: a send snaps the body it is looking at back to the tail. */
  listRef: RefObject<ChatMessageListHandle | null>;
}) {
  // The subscription every `t()` caller owes, plus the counter the memo below needs.
  const { revision } = useLocale();
  const { window, loadOlder, loadingOlder } = feed;

  const blocks = useMemo(() => {
    // READ, not merely listed as a dependency, which is what makes it an honest one: `itemsOf`
    // resolves one sentence through `t()` (a journal picture becomes a notice naming it), so these
    // blocks are in whatever language the dictionary held when this ran. `locale` alone would be
    // the wrong key — it moves once when a language is chosen and not again when that language's
    // bundle lands, so the memo would keep the English it was built with. The counter moves on both.
    void revision;
    // A turn the agent REWOUND PAST is not part of this conversation, so it is not part of this
    // view. The journal KEEPS it — a `?before=` cursor still has to resolve its uuid — so hiding it
    // is the reader's job, exactly as it is on the History page (ADR 0073's addendum).
    const entries = window.entries.filter((e) => e.abandoned !== true);
    // Tool calls off folds EVERY run, a lone step included, which is the same treatment the History
    // page gives a turn's steps. One idea, one look, two surfaces.
    return groupRuns(entries.flatMap((e) => itemsOf(e, showCompactions)), showToolCalls ? 3 : 1);
  }, [window.entries, showToolCalls, showCompactions, revision]);

  // A PANE KEEPS ITS PLACE (ADR 0063). Switching modes unmounts this body and switching panes
  // remounts it, so neither the DOM nor the scroller remembers where the reader was — the same gap
  // `lib/scroll-memory.ts` exists to close on the dashboard, and the same module closes it here.
  //
  // Restored ONCE, on the first render that has blocks in it: on mount the list is empty and its
  // scroll height is zero, so a restore then would be a no-op that spends the only chance. It runs
  // after `ChatMessageList`'s own pin-to-bottom, because a child's layout effects run before its
  // parent's — so a reader who was at the tail stays at the tail and one who was not goes back to
  // where they were.
  const restored = useRef(false);
  useLayoutEffect(() => {
    const el = listRef.current?.getScrollElement();
    if (el === null || el === undefined) return;
    if (!restored.current && blocks.length > 0) {
      restored.current = true;
      const top = recallScroll(address);
      if (top !== undefined && top > 0) el.scrollTop = top;
    }
    const onScroll = () => rememberScroll(address, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      // One last write, in case the unmount races the next scroll event.
      rememberScroll(address, el.scrollTop);
    };
  }, [address, blocks.length, listRef]);

  // ── PREPENDING MUST NOT MOVE WHAT THE READER IS ON ──────────────────────────
  // "Load older" inserts forty turns ABOVE the viewport. The browser holds `scrollTop` where it was,
  // so everything the reader was looking at slides down by the height of what arrived and the screen
  // fills with the oldest page — the tap read as a jump to the top. Measure the scroll height before
  // the tap and give the difference back after the new blocks paint, which is the same anchoring the
  // History page's own "load older" and the mirror's scrollback both use (routes/history.tsx).
  //
  // The anchor holds the FIRST BLOCK'S ID as well as the two numbers, because the only render that
  // may spend it is one where something actually went in at the front. The poll keeps running while
  // a `?before=` is in flight, so a reply landing at the TAIL also grows the scroll height, and
  // spending the anchor on that would shove the reader down by a height that arrived below them.
  // A page that never comes (the fetch threw, or the merge refused a page from another `gen`) drops
  // the anchor when the spinner goes off, so a stale delta cannot be spent on some later render.
  //
  // Where the reader was FOLLOWING the tail, `useAutoScroll` re-pins after this, and that is the
  // right answer: they were at the bottom and they stay there.
  const anchor = useRef<{ height: number; top: number; firstId: string } | null>(null);
  const onLoadOlder = () => {
    const el = listRef.current?.getScrollElement();
    const firstId = blocks[0]?.[0]?.id;
    anchor.current =
      el && firstId !== undefined ? { height: el.scrollHeight, top: el.scrollTop, firstId } : null;
    loadOlder();
  };
  useLayoutEffect(() => {
    const held = anchor.current;
    if (held === null) return;
    if (blocks[0]?.[0]?.id === held.firstId) {
      if (!loadingOlder) anchor.current = null;
      return;
    }
    anchor.current = null;
    const el = listRef.current?.getScrollElement();
    if (el === null || el === undefined) return;
    el.scrollTop = held.top + (el.scrollHeight - held.height);
  }, [blocks, loadingOlder, listRef]);

  const status = window.status;
  const missing =
    status.kind === "unavailable" && (status.reason === "no-log" || status.reason === "no-session");
  const explain = starting && missing ? null : chatStatusKey(status);
  const empty = blocks.length === 0;
  // The window answered, or the pane is new and nothing is missing that should be there. Either way
  // what the stream draws is the thread, and the thread may be running or empty.
  const reading = status.kind === "live" || (starting && (status.kind === "empty" || missing));

  return (
    <ChatMessageList
      ref={listRef}
      data-slot="session-stream"
      // `rev` moves once per tick that produced anything, so a reply still streaming re-pins the
      // tail. A `?before=` page leaves it alone, which is right: paging older must not jump down.
      dep={window.rev}
      // `following` is DELIBERATELY not published from here. On the mirror it means "the operator is
      // watching the tail", and it also freezes the mirror text the card dock is built from — so
      // scrolling back through a conversation would stop a permission dialog appearing. Reading
      // older turns is an ordinary act in this body and a rare one in that one.
      className="px-3 pt-0 pb-3"
      style={textTokens(fontSize)}
    >
      {/* Top of the window. Older turns come off `hasOlder` and nothing else: what the live window
          has trimmed is the History read's job, reached through `?before=`, and the bridge holds
          none of it in memory. Where there is nothing older, the thread says where it starts — the
          History page's own line, because it is the same fact about the same session. */}
      {window.hasOlder ? (
        <button type="button" onClick={onLoadOlder} disabled={loadingOlder} className={EDGE_ROW}>
          {loadingOlder ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUpToLine className="size-3.5" />}
          {loadingOlder ? t("chat.scrollback.loading") : t("chat.scrollback.loadOlder")}
        </button>
      ) : (
        !empty && (
          <div className="mb-3 text-center text-[11px] text-muted-foreground">
            {t("history.startOfConversation")}
          </div>
        )
      )}

      {blocks.map((group) => (
        <div key={group[0]!.id} data-block data-n={group.length} className={STREAM_BLOCK}>
          {/* A group of one is an ordinary block, EXCEPT a lone tool call while tool calls are off:
              that one folds too, or "off" would leave every single-step turn drawn in full. */}
          {group.length === 1 && (showToolCalls || group[0]!.kind !== "tool") ? (
            <ItemView item={group[0]!} />
          ) : (
            <ToolGroup items={group} liveOpens={showToolCalls} />
          )}
        </div>
      ))}

      {/* A turn is running. Last of the thread, because that is where its answer will arrive. Drawn
          only where the window is actually being read: a pane whose journal cannot be read is busy
          in the chrome, and saying so HERE would promise a turn this body will never show. */}
      {working && reading && (
        <div data-slot="stream-live" className={LIVE_ROW}>
          {/* The same mark a running step wears inside a card (`chat-cards.tsx` § StepStatus), so
              "still going" looks the same wherever the stream says it. UNNAMED: it leads the word,
              and a name here is the state announced twice (status-badge.tsx § label). */}
          <StatusDot status="working" live className="size-2" />
          <span>{t("chat.stream.working")}</span>
        </div>
      )}

      {/* WHAT YOU TYPED THAT HAS NOT STARTED YET, under the working mark and before the tail.
          It is drawn WHETHER OR NOT the pane reads as working, because the gap the operator reported
          is exactly the moment those two disagree: a compaction is running, the queue is filling, and
          a poll can land with the pane between two states. A queued message is a fact on its own.
          Not turns, because it is state — it appears, then it is gone (`chat-window.ts` § queued). It
          therefore wears the operator's OWN colour (the same well `UserTurn` uses) so the eye reads
          "mine, not yet sent" rather than "a turn nobody answered". */}
      {window.queued.length > 0 && window.status.kind === "live" && (
        <div data-slot="stream-queued" className={QUEUED_BLOCK}>
          <p className={QUEUED_LABEL}>{t("chat.stream.queued")}</p>
          {window.queued.map((text, i) => (
            // The index is the key, and here that is right rather than lazy: the list has no identity
            // on the wire, two identical queued messages ARE two messages, and the whole list is
            // replaced on every answer so a key never has to survive one.
            <p key={i} className={QUEUED_TEXT}>
              {text}
            </p>
          ))}
        </div>
      )}

      {/* The reading, when there is one, and only where there is nothing to read under it. A stale
          member keeps its turns — they were true when they arrived, and a version skew does not
          unsay them — so this sits at the end rather than in their place. */}
      {explain !== null && (
        <p
          className={cn(
            "px-2 text-center text-sm leading-relaxed text-muted-foreground",
            empty ? "py-16" : "py-4",
          )}
        >
          {t(explain)}
        </p>
      )}
      {/* Nothing wrong, nothing said yet: one quiet line that says how to begin. `empty` alone is not
          this state: before the first answer lands the window is `empty` in the other sense, nobody
          has asked yet, and a screen that announces an absence it has not checked is a screen that
          was wrong for one frame. A NEW pane is the exception, because there nothing was expected:
          Codex has no session before its first prompt, and pi writes no log before its first reply.
          A running turn says so on the row above instead, so the two never stand together. */}
      {empty && explain === null && reading && !working && (
        <div className="py-16 text-center text-sm text-muted-foreground">{t("chat.stream.empty")}</div>
      )}
    </ChatMessageList>
  );
}
