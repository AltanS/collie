import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { Icon } from "@/components/icons/icon";

import { AgentIcon } from "@/components/agent-icon";
import { ItemView, PendingTurn, ToolGroup, groupRuns, standsAlone } from "@/components/chat-cards";
import { StreamBlock } from "@/components/stream-block";
import { PromptPin } from "@/components/prompt-pin";
import { StatusDot } from "@/components/status-badge";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { QUEUED_BLOCK, QUEUED_BUTTON, QUEUED_HEAD, QUEUED_LABEL, QUEUED_TEXT } from "@/components/queued-block";
import { ChatPending } from "@/components/chat-pending";
import { ChatMessageList, type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { DividedLine } from "@/components/ui/divided-line";
import { useLocale } from "@/hooks/use-locale";
import type { ChatFeed } from "@/hooks/use-chat-window";
import { ASKS_SHOWN, asksAt, shownAsks } from "@/lib/ask";
import { finished, itemsOf, type ChatItem } from "@/lib/chat-items";
import { useChatLook, type ChatLook } from "@/lib/chat-look";
import { kindOfBlock, measureBlocks, rememberSilhouette, silhouetteOf } from "@/lib/chat-silhouette";
import type { ChatStatus } from "@/lib/chat-window";
import { HANDOVER_KEEP_MS, dropPending, unmatched, usePending } from "@/lib/durable-pending";
import { clockTime } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import { holdsMask } from "@/lib/masked-text";
import { blockOfPin, isPinnable, writingItemId } from "@/lib/message-pins";
import type { Ask, PinRow, QueuedSendRow } from "@/lib/types";
import { AskCard, type AskCardProps } from "@/components/ask-card";
import { pinAt, promptMap } from "@/lib/prompt-pin";
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
 * A block near the tail (M104): the same box with no `content-visibility`, so a row that arrives there is drawn once,
 * at its own height, and never first at the 64px placeholder and one frame later at its size. It keeps the intrinsic
 * size's `auto`, which records the drawn height, so a block that later moves far up and turns `content-visibility:
 * auto` keeps that height while it is skipped.
 */
const NEAR_BLOCK = "flex min-w-0 flex-col [contain-intrinsic-size:auto_64px] -m-3 p-3";

/** How long the page waits, after its last change, before its silhouette is measured and kept (lib/chat-silhouette.ts). */
const SILHOUETTE_SETTLE_MS = 400;

/** How many blocks at the tail are {@link NEAR_BLOCK}s: more than a phone screen holds of new rows. */
const NEAR_TAIL_BLOCKS = 8;

/** The box of the block at `index` of `count`: skipped while off screen only far above the tail. */
function blockBox(index: number, count: number): string {
  return index < count - NEAR_TAIL_BLOCKS ? STREAM_BLOCK : NEAR_BLOCK;
}

/** A group that is the person's own turn. */
function isUserGroup(group: readonly ChatItem[] | undefined): boolean {
  return group !== undefined && group.length === 1 && group[0]!.kind === "user";
}

/**
 * Chat look A (lib/chat-look.ts): the margin a block adds to {@link STREAM_BLOCK}'s, or "" for today.
 *
 * Every block's margin is -12px and its padding 12px, so two blocks' margins collapse to -12px and their contents
 * sit 12px apart. A user turn's `mt-2` collapses with the block above to -4px, so a new turn starts 20px down (24px
 * under `rule`, which spends the extra on its hairline). A block inside an agent run, after another agent block,
 * takes `-mt-4`: the more negative margin wins the collapse, so its content sits 8px under the one above.
 */
function rhythmClass(rhythm: ChatLook["rhythm"], blocks: readonly (readonly ChatItem[])[], index: number): string {
  if (rhythm === "today" || index === 0) return "";
  if (isUserGroup(blocks[index])) return userRhythm(rhythm, index);
  return isUserGroup(blocks[index - 1]) ? "" : "-mt-4";
}

/** The margin of a user turn at `index`, so a pending line stands where the person's turn will stand (M104). */
function userRhythm(rhythm: ChatLook["rhythm"], index: number): string {
  if (rhythm === "today" || index === 0) return "";
  return rhythm === "rule"
    ? "relative mt-3 before:pointer-events-none before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-rule"
    : "mt-2";
}

/**
 * Chat look C (lib/chat-look.ts): the agent's mark and the time, above the first block of each agent run. Chat
 * draws no such row today; the name is in the header above the stream already, so the row carries none.
 */
function AgentHead({ agent, ts }: { agent: string | undefined; ts: string | undefined }) {
  const ms = ts === undefined ? Number.NaN : Date.parse(ts);
  return (
    <div data-slot="agent-head" className="mb-1.5 flex h-4 items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
      {agent === undefined ? null : <AgentIcon agent={agent} className="size-4" />}
      {Number.isNaN(ms) ? null : <span>{clockTime(ms)}</span>}
    </div>
  );
}

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
 * THE WORKING ROW OF A DURABLE THREAD (M53 spec 10): three dots in the muted ink, where the static "Still working…" line
 * stands on any other pane. It is drawn while the newest thing in the thread is the person's own line and the program has
 * not answered yet, and it appears the moment the program accepts a send, before the next read says `working`. The dots
 * share {@link LIVE_ROW}'s box, so the row going to the static line or to nothing moves no neighbour (DESIGN.md §2). They
 * dim and brighten in turn (opacity only, `.working-dots` in index.css) and stand still under reduced motion.
 */
function WorkingRow() {
  useLocale();
  return (
    <div data-slot="stream-working" role="status" aria-label={t("durable.thread.working")} className={LIVE_ROW}>
      <span aria-hidden="true" className="working-dots flex h-4 items-center gap-1">
        <span className="size-1.5 rounded-full bg-current" />
        <span className="size-1.5 rounded-full bg-current" />
        <span className="size-1.5 rounded-full bg-current" />
      </span>
    </div>
  );
}

/** How long "Send now" holds its pending face when the queue does not empty first. */
const SEND_NOW_PENDING_MS = 5_000;

/**
 * THE QUEUE CARD: one group, however many messages wait, with its one control at the head.
 *
 * "Send now" belongs to the GROUP and not to a message because it IS a group act: in Claude Code,
 * Ctrl+Enter hands the whole queue to the running turn, so a button on one row would promise a
 * choice the agent does not offer. It is drawn only when the caller passes `sendNow`, which the pane
 * view does only for a bridge-declared key list on a pane this device may write to (agent-chat.tsx).
 *
 * PENDING, NEVER RETRYING. A tap disables the button and shows a spinner until the card goes away
 * (the queue emptied, so the unmount ends it) or {@link SEND_NOW_PENDING_MS} pass, or the send
 * itself failed. It never sends a second time on its own: a second Ctrl+Enter that lands after the
 * queue emptied would be a key typed into the agent's composer.
 */
function QueuedCard({ queued, sendNow }: { queued: readonly string[]; sendNow: (() => Promise<boolean>) | null }) {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(false), SEND_NOW_PENDING_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const onTap = () => {
    if (pending || sendNow === null) return;
    setPending(true);
    // A refusal or a failed write has already told the operator why (the pane view's status line).
    void sendNow().then(
      (sent) => (sent ? undefined : setPending(false)),
      () => setPending(false),
    );
  };

  return (
    <div data-slot="stream-queued" className={QUEUED_BLOCK}>
      <div className={QUEUED_HEAD}>
        <p className={QUEUED_LABEL}>{t("chat.stream.queued")}</p>
        {sendNow !== null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-slot="stream-send-now"
            className={QUEUED_BUTTON}
            disabled={pending}
            aria-busy={pending}
            // The accessible name STARTS with the visible words in every language (WCAG 2.5.3, Label in
            // Name), so a voice command "tap Send now" finds the button; the rest says what is sent.
            aria-label={t("chat.stream.sendNowAria")}
            onClick={onTap}
          >
            {pending ? <Icon name="busy" aria-hidden className="size-3.5 animate-spin" /> : <Icon name="send-now" aria-hidden className="size-3.5" />}
            {t("chat.stream.sendNow")}
          </Button>
        )}
      </div>
      {queued.map((text, i) => (
        // The index is the key, and here that is right rather than lazy: the list has no identity
        // on the wire, two identical queued messages ARE two messages, and the whole list is
        // replaced on every answer so a key never has to survive one.
        <p key={i} className={QUEUED_TEXT}>
          {text}
        </p>
      ))}
    </div>
  );
}

/**
 * What a receipt card's buttons ask of the pane view: send the box (`submit`) or empty it (`discard`)
 * on a returned card, drop an unconfirmed card and press nothing (`dismiss`), or drop it and send its text again
 * as a new send (`sendAgain`, M102 spec 04).
 */
export type QueuedCardAction = "submit" | "discard" | "dismiss" | "sendAgain";

/**
 * How a card's act ended: true when it was done, false when nothing was (the pane view has said why), and `"gone"` when
 * the card was no longer waiting, so nothing was sent again (the card says so itself).
 */
export type QueuedCardResult = boolean | "gone";

/** A card's act: its request id, the action, and the card's own text (what a `sendAgain` sends again). */
type QueuedCardAct = ((requestId: string, action: QueuedCardAction, text: string) => Promise<QueuedCardResult>) | null;

/**
 * THE RECEIPT QUEUE (ADR 0122): the sends Collie itself queued behind a running turn, for a harness
 * whose log does not record its queue, in three states.
 *
 *   - Still waiting: one group under the same label as the journal's queue, with two short lines and
 *     NO button. There is no Send now for a harness that names no key, and no Cancel, because Collie
 *     cannot take a message out of the harness's queue without a dequeue key, which no profile names
 *     yet: stopping the turn is the way back, and the card says so.
 *   - Returned: the agent holds the text as a draft in its box, so the card says so and offers Send (a
 *     submit of what the box holds) and Discard (the box emptied). A run of texts a Stop gave back
 *     together is ONE card, with one Send and one Discard.
 *   - Unconfirmed: Collie cannot tell where the message went. The card says so. Discard drops the card and
 *     presses nothing; Send again, on its right, drops the card and only then sends its text again as a new send,
 *     by the person's tap (M102 spec 04). A card that is no longer waiting sends nothing and says so.
 *
 * PENDING, NEVER RETRYING, like the queue card: a tap disables the card's buttons until the card goes
 * away (the next answer drops it) or {@link SEND_NOW_PENDING_MS} pass, or the act itself failed.
 */
export function ReceiptQueueCards({ rows, act }: { rows: readonly QueuedSendRow[]; act: QueuedCardAct }) {
  const waiting = rows.filter((row) => row.state === "queued");
  return (
    <>
      {waiting.length > 0 && (
        <div data-slot="stream-queued-receipts" className={QUEUED_BLOCK}>
          <div className={QUEUED_HEAD}>
            <p className={QUEUED_LABEL}>{t("chat.stream.queued")}</p>
          </div>
          <p className="text-xs text-muted-foreground">{t("chat.stream.queuedWaits")}</p>
          <p className="text-xs text-muted-foreground">{t("chat.stream.queuedTakeBack")}</p>
          {waiting.map((row) => (
            <p key={row.requestId} className={QUEUED_TEXT}>
              {row.text}
            </p>
          ))}
        </div>
      )}
      {rows.map((row) =>
        row.state === "returned" ? (
          <ReceiptCard key={row.requestId} row={row} act={act} slot="stream-returned" label="chat.stream.returned" why="chat.stream.returnedWhy" buttons={RETURNED_BUTTONS} />
        ) : row.state === "unconfirmed" ? (
          <ReceiptCard key={row.requestId} row={row} act={act} slot="stream-unconfirmed" label="chat.stream.unconfirmed" why="chat.stream.unconfirmedWhy" buttons={UNCONFIRMED_BUTTONS} />
        ) : null,
      )}
    </>
  );
}

/** One button of a receipt card: the act, its visible word, its accessible name (which starts with the word), its look. */
interface CardButton {
  readonly action: QueuedCardAction;
  readonly word: MessageKey;
  /** The accessible name, which starts with the word. Absent: the visible word is the name. */
  readonly aria?: MessageKey;
  readonly variant: "outline" | "ghost";
  readonly slot: string;
}

/** Discard first and quieter, Send last and outlined: the act that sends sits at the thumb's end. */
const RETURNED_BUTTONS: readonly CardButton[] = [
  { action: "discard", word: "chat.stream.returnedDiscard", aria: "chat.stream.returnedDiscardAria", variant: "ghost", slot: "stream-returned-discard" },
  { action: "submit", word: "chat.stream.returnedSend", aria: "chat.stream.returnedSendAria", variant: "outline", slot: "stream-returned-send" },
];
const UNCONFIRMED_BUTTONS: readonly CardButton[] = [
  { action: "dismiss", word: "chat.stream.unconfirmedDiscard", aria: "chat.stream.unconfirmedDiscardAria", variant: "outline", slot: "stream-unconfirmed-discard" },
  // Beside Discard, on its right as on the "cannot tell" card (M102 spec 04).
  { action: "sendAgain", word: "composer.step.sendAgain", variant: "outline", slot: "stream-unconfirmed-send-again" },
];

function ReceiptCard({
  row,
  act,
  slot,
  label,
  why,
  buttons,
}: {
  row: QueuedSendRow;
  act: QueuedCardAct;
  slot: string;
  label: MessageKey;
  why: MessageKey;
  buttons: readonly CardButton[];
}) {
  const [pending, setPending] = useState<QueuedCardAction | null>(null);
  // The card's one line under its words: a Send again that found the card gone says nothing was sent.
  const [gone, setGone] = useState(false);
  // A text the bridge masked is dots, not the message: sending it again would type the dots, so no Send again.
  const shown = buttons.filter((button) => button.action !== "sendAgain" || !holdsMask(row.text));
  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => setPending(null), SEND_NOW_PENDING_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const onTap = (action: QueuedCardAction) => {
    if (pending !== null || act === null) return;
    setPending(action);
    // A refusal or a failed write has already told the operator why (the pane view's status line).
    setGone(false);
    void act(row.requestId, action, row.text).then(
      (done) => {
        if (done === "gone") setGone(true);
        if (done !== true) setPending(null);
        return done;
      },
      () => setPending(null),
    );
  };

  return (
    <div data-slot={slot} className={QUEUED_BLOCK}>
      <div className={QUEUED_HEAD}>
        <p className={QUEUED_LABEL}>{t(label)}</p>
        {act !== null && (
          <div className="flex items-center gap-1">
            {shown.map((button) => (
              <Button
                key={button.action}
                type="button"
                variant={button.variant}
                size="sm"
                data-slot={button.slot}
                className={QUEUED_BUTTON}
                disabled={pending !== null}
                aria-busy={pending === button.action}
                // The accessible name STARTS with the visible word (WCAG 2.5.3, Label in Name).
                aria-label={button.aria === undefined ? undefined : t(button.aria)}
                onClick={() => onTap(button.action)}
              >
                {pending === button.action ? (
                  <Icon name="busy" aria-hidden className="size-3.5 animate-spin" />
                ) : (
                  button.action === "submit" && <Icon name="send-now" aria-hidden className="size-3.5" />
                )}
                {t(button.word)}
              </Button>
            ))}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t(why)}</p>
      <p className={QUEUED_TEXT}>{row.text}</p>
      {gone && (
        <p data-slot="stream-receipt-line" role="status" className="text-xs text-muted-foreground">
          {t("cannotTell.queuedGone")}
        </p>
      )}
    </div>
  );
}

/**
 * How many older pages one tap on a reported prompt may fetch while walking back to it.
 *
 * The walk is the operator's own tap, so it may read past a screenful, but a prompt hundreds of turns
 * back must not turn one tap into an unbounded read. Ten pages of 40 is past every tool run measured;
 * a walk that runs out stops where it got to, and the pin still names the prompt.
 */
const PIN_SEEK_PAGES = 10;

/** When a jump to a prompt re-checks its landing while the blocks above take their real size. */
const JUMP_SETTLE_MS = [100, 250, 500] as const;
/** The reader's own moves, on the scroller's parent, which end a jump or a walk to a prompt. */
const JUMP_STOP_INPUTS = ["pointerdown", "click", "wheel", "touchstart", "keydown"] as const;
/** The reader's own moves on the list that end the room a working row left behind (M104). */
const ROOM_DROP_INPUTS = ["pointerdown", "wheel", "touchstart"] as const;

/**
 * The topmost block the reader can see, or -1 while the stream's top edge is on screen.
 *
 * "Can see" is measured from the scroller's padding edge, which is where the strip band ends, so a
 * block hidden under the band does not count as read. Binary search: blocks are in document order and
 * a long thread holds hundreds of them.
 *
 * A block's box is its content plus {@link STREAM_BLOCK}'s 12px padding on every side, pulled back by
 * the same negative margin, so neighbours OVERLAP by 24px. Measuring the raw box let the block above
 * reach 24px into a prompt just jumped to (its box top sits on the line), which then read as
 * "answered further back" with the pin drawn over it (seen on a phone-sized screen, 2026-10-10). So a
 * block counts as the top one only once it reaches past that overlap.
 */
const BLOCK_OVERLAP_PX = 24;

/** The line the reader's view starts at: the scroller's padding edge, below the strip band. */
function readingLine(el: HTMLElement): number {
  return el.getBoundingClientRect().top + (Number.parseFloat(getComputedStyle(el).paddingTop) || 0);
}

function topBlock(el: HTMLElement): number {
  const nodes = el.querySelectorAll<HTMLElement>(":scope > [data-block]");
  if (nodes.length === 0) return -1;
  const line = readingLine(el);
  if (nodes[0]!.getBoundingClientRect().top >= line) return -1;
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid]!.getBoundingClientRect().bottom - BLOCK_OVERLAP_PX > line) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The top affordance, the same shape and the same words the mirror's own scrollback row uses. */
const EDGE_ROW =
  `mb-2 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50 disabled:opacity-60 ${FOCUS_RING} enabled:hover:bg-accent`;

/** The room the top edge leaves for a prompt pin over it: the pin's fixed `h-14` (prompt-pin.tsx)
 *  plus the 4px its overlay sits down from the scrollport's top (ChatMessageList). */
const PIN_ROOM = "h-16";

/**
 * THE SAVED-COPY LINE (M46 specs 09 and 10), at the top of the scrolled content of either body.
 *
 * It used to be a bar of its own above the body, a row of chrome under the pane strip. It now sits
 * where the thread's top edge already speaks ("Start of the conversation", "Load older"), because it
 * is a fact about that edge: older text is on the bridge, and there is no bridge to ask. So while the
 * view is a saved copy it stands INSTEAD of those two, scrolls with the text, and costs no row. The
 * same small muted type as "Start of the conversation"; quiet, because a saved copy is the screen the
 * operator left, not an error, and the strip above the header already says why it is there.
 */
export function SavedCopyRow({ text }: { text: string }) {
  return (
    <div
      role="status"
      data-slot="saved-copy"
      className="mb-3 flex items-start justify-center gap-1.5 px-2 text-center text-[11px] leading-snug text-muted-foreground"
    >
      <Icon name="saved-copy" aria-hidden className="mt-px size-3 shrink-0" />
      <span className="text-balance">{text}</span>
    </div>
  );
}

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
 * The second line under an empty Chat whose session the bridge refused to guess: another pane runs
 * the same harness in this folder and this pane's command line names no session (#508). The bridge
 * gives the reason (`detail: "shared-folder"`), and the sentence names the remedy, because an empty
 * Chat with no reason is the next issue. `null` on every other reading, and on an older bridge that
 * sends no detail.
 */
export function sharedFolderLine(status: ChatStatus, agent: string | undefined): string | null {
  if (status.kind !== "unavailable" || status.detail !== "shared-folder") return null;
  return t("chat.empty.sharedFolder", { harness: harnessName(agent) });
}

/** The harness as a person names it: Herdr's agent string with its first letter capitalised. */
function harnessName(agent: string | undefined): string {
  if (agent === undefined || agent === "") return "agent";
  return agent.charAt(0).toUpperCase() + agent.slice(1);
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
  savedCopy = null,
  onSendQueuedNow,
  onReturned,
  asks,
  durable = false,
  questionPending = false,
  agent,
  pins,
  clearBottom,
  tail,
  hasNew = false,
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
  /** Settings → Look and feel. Off folds every run, including a lone step, to one summary line. */
  showToolCalls: boolean;
  /** Settings → Look and feel. Off draws a compaction as a one-line marker and never builds its recap. */
  showCompactions: boolean;
  /** The stream's own text size in px, from the belt's Display dock (`chatFontSize`). */
  fontSize: number;
  /** The pane view's one list handle: a send snaps the body it is looking at back to the tail. */
  listRef: RefObject<ChatMessageListHandle | null>;
  /** What floats over the stream's bottom edge, in px (ChatMessageList `clearBottom`). */
  clearBottom?: number;
  /**
   * The saved-copy sentence while this window is the phone's saved copy, else `null`. It takes the
   * top slot in place of "Load older" and "Start of the conversation" (see {@link SavedCopyRow}).
   */
  savedCopy?: string | null;
  /**
   * Send the queue now with the keys the bridge declared (`feed.window.sendQueuedNow`). Passed ONLY
   * where this device may write to this pane; leave it out and the card has no button, which is how
   * a read-only device, a saved copy and a lost host all lose it. Resolves false when nothing was
   * sent. The keys are handed back so this body never holds a copy of its own.
   */
  onSendQueuedNow?: (keys: readonly string[]) => Promise<boolean>;
  /**
   * A receipt card's act (ADR 0122), by the card's request id: Send or Discard on a returned card,
   * Discard on an unconfirmed one. Passed ONLY where this device may write to this pane; leave it out
   * and the cards have no buttons. Resolves false when nothing was done.
   */
  onReturned?: (requestId: string, action: QueuedCardAction, text: string) => Promise<QueuedCardResult>;
  /**
   * The open asks of a pane that carries them as data (ADR 0100), and the props every card shares. Each card sits
   * under the block that shows its item, or at the tail when that item is not on screen. The list holds
   * every open ask; the first five are drawn and an "N more" button opens the rest (lib/ask.ts
   * `shownAsks`). Absent on every pane with a screen, which draws none.
   */
  asks?: { list: readonly Ask[]; card: Omit<AskCardProps, "ask"> };
  /**
   * The pane is a durable conversation: a program with no screen (ADR 0101). Its thread ends with the working row
   * ({@link WorkingRow}) in place of the static line while the newest thing is the person's own, and a text the program is
   * still writing carries a cursor. Every other pane draws what it always drew.
   */
  durable?: boolean;
  /**
   * A question waits in the terminal that no card answers: OmO's `? Question pending` banner over a
   * ready editor (HarnessAdapter.questionPending). The thread ends with one status line that says so,
   * in place of the working line, because the turn waits on the person. The fact comes from the
   * screen, as the card dock below this body does (ADR 0059); the line claims nothing about the
   * question itself, which the banner and the running question card carry.
   */
  questionPending?: boolean;
  /** The pane's agent string, named in the shared-folder line ({@link sharedFolderLine}). */
  agent?: string;
  /**
   * The pinned messages of this session (M90). `pinned` maps a Chat item id to its pin id, and a block in it
   * wears the pin mark. `onActions` is the way in: the block's `⋯` and its hold open the actions sheet through
   * it. Leave `onActions` out wherever Pin may not be offered (a shell, a read-only device, a saved copy, an
   * older machine) and the blocks draw no way in; the marks of pins that exist still show.
   */
  pins?: {
    pinned: ReadonlyMap<string, string>;
    onActions?: (item: ChatItem) => void;
    /** Filled with a function that scrolls to the block a pin came from, and says whether the stream holds it (M90). */
    reveal?: MutableRefObject<((pin: Pick<PinRow, "itemId" | "anchor">) => boolean) | null>;
  };
  /**
   * What stands last in the thread, after everything else, in the stream's own scroll: a trick this session
   * proposed (components/session-trick-card.tsx), so it reads like a message and never takes a band of its own.
   */
  tail?: ReactNode;
  /** Something waits below for the person (a trick proposal at the tail): the jump-to-latest arrow wears its dot. */
  hasNew?: boolean;
}) {
  // The subscription every `t()` caller owes, plus the counter the memo below needs.
  const { revision } = useLocale();
  const look = useChatLook();
  const { window, loadOlder, loadingOlder } = feed;
  // The asks past the first five stay folded until the person opens them (lib/ask.ts `shownAsks`).
  const [asksOpen, setAsksOpen] = useState(false);
  const askList = asks === undefined ? undefined : shownAsks(asks.list, asksOpen);

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
    //
    // A text the program was still writing (`partial`) keeps its cursor only while the pane works: one that stopped
    // will not grow, and a cursor left blinking on it would be a lie (WIRE.md 7.15).
    return groupRuns(
      entries.flatMap((e) => itemsOf(e, showCompactions).map((item) => (working ? item : finished(item)))),
      showToolCalls ? 3 : 1,
    );
  }, [window.entries, showToolCalls, showCompactions, revision, working]);

  // THE PERSON'S OWN LINES THE PROGRAM HAS NOT WRITTEN BACK YET (lib/durable-pending.ts). Only a durable pane's composer
  // puts any, so every other pane has none and draws nothing here. A line goes when an item of the program's matches it.
  const pending = usePending(address);
  // The texts the queue cards show: a line the bridge queued goes in the frame its card arrives (M104).
  const queuedTexts = useMemo(
    () => (window.status.kind === "live" ? [...window.queued, ...window.queuedSends.map((row) => row.text)] : []),
    [window.status.kind, window.queued, window.queuedSends],
  );
  // A line handed over goes at the latest after HANDOVER_KEEP_MS, also when no answer comes in between.
  const [handoverTick, setHandoverTick] = useState(0);
  const { open: lines, done: answered } = useMemo(
    () => {
      void handoverTick;
      return unmatched(pending, window.entries, Date.now(), queuedTexts);
    },
    [pending, window.entries, queuedTexts, handoverTick],
  );
  const handoverAt = lines.find((line) => line.handover === true)?.at;
  useEffect(() => {
    if (handoverAt === undefined) return;
    const timer = setTimeout(() => setHandoverTick((n) => n + 1), Math.max(0, handoverAt + HANDOVER_KEEP_MS - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [handoverAt]);
  const answeredKey = answered.join("\n");
  useEffect(() => {
    if (answeredKey !== "") dropPending(address, answeredKey.split("\n"));
  }, [address, answeredKey]);
  // A line the person just sent snaps the thread to its tail, where it stands.
  const sentCount = lines.length;
  const heldCount = useRef(sentCount);
  useLayoutEffect(() => {
    if (sentCount > heldCount.current) listRef.current?.scrollToBottom();
    heldCount.current = sentCount;
  }, [sentCount, listRef]);

  // What the end of a durable thread says. The newest thing is the person's own when a line of theirs is waiting, or when
  // the last item is a user turn. A text still growing says it is working by itself, with its cursor.
  // The reply a normal pane is still writing is not pinnable yet, whether or not the item says `partial`.
  const writing = writingItemId(blocks, working);
  const newest = blocks.at(-1)?.at(-1);
  const personsNewest = lines.some((line) => line.state !== "notSent") || newest?.kind === "user";
  const growing = newest !== undefined && "partial" in newest && newest.partial === true;
  const accepted = lines.some((line) => line.state === "sent");
  const dotsRow = durable && ((working && personsNewest) || accepted);
  const staticRow = working && !(durable && (personsNewest || growing)) && !questionPending;

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
    // While no block is drawn the place is the top, as it was when this list was empty: the loading silhouette
    // (components/chat-pending.tsx) is pinned to the bottom of a list with nothing of the thread in it, and where
    // that sits is not the reader's place.
    const placeNow = () => (blocks.length > 0 ? el.scrollTop : 0);
    const onScroll = () => rememberScroll(address, placeNow());
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      // One last write, in case the unmount races the next scroll event.
      rememberScroll(address, placeNow());
    };
  }, [address, blocks.length, listRef]);

  // ── THE SILHOUETTE OF THIS PANE'S PAGE (lib/chat-silhouette.ts) ──────────────────
  // Each time the newest page has been drawn and has settled, its rows' kinds, heights and line counts are kept for the
  // next time this pane opens, so its loading view can draw the same silhouette. Never a word of the thread. Only a live
  // window with rows in it: a saved copy is old and an empty one has no silhouette. A short wait after the last change keeps a
  // streaming reply from measuring at every tick; the unmount writes the last one at once.
  const rowKinds = useMemo(
    () =>
      blocks.map((group) =>
        kindOfBlock(group, group.length === 1 && (showToolCalls || group[0]!.kind !== "tool" || standsAlone(group[0]!))),
      ),
    [blocks, showToolCalls],
  );
  const silhouetteReady = window.status.kind === "live" && window.savedAt === null && blocks.length > 0;
  const hasOlder = window.hasOlder;
  const recordSilhouette = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    recordSilhouette.current = null;
    const el = listRef.current?.getScrollElement();
    if (!silhouetteReady || el === null || el === undefined) return;
    const record = () => {
      if (!el.isConnected) return;
      const measured = measureBlocks(el, rowKinds);
      if (measured === null) return;
      rememberSilhouette(address, silhouetteOf(measured, { viewport: el.clientHeight, older: hasOlder, count: rowKinds.length }));
    };
    recordSilhouette.current = record;
    const timer = setTimeout(record, SILHOUETTE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [silhouetteReady, rowKinds, hasOlder, address, window.rev, listRef]);
  useLayoutEffect(() => () => recordSilhouette.current?.(), []);

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
  const onLoadOlder = useCallback(() => {
    const el = listRef.current?.getScrollElement();
    const firstId = blocks[0]?.[0]?.id;
    anchor.current =
      el && firstId !== undefined ? { height: el.scrollHeight, top: el.scrollTop, firstId } : null;
    loadOlder();
  }, [blocks, listRef, loadOlder]);
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

  // ── THE PROMPT PIN ──────────────────────────────────────────────────────────
  // Which prompt the turns on screen answer, pinned over the top of the thread (lib/prompt-pin.ts
  // decides, components/prompt-pin.tsx draws). Only the topmost visible block is measured here, on
  // scroll and after every commit that changed the blocks, and the state moves only when that block
  // changes, so a scroll inside one long reply re-renders nothing.
  const prompts = useMemo(() => promptMap(blocks), [blocks]);
  const lastPrompt = window.lastPrompt;
  const holdsLastPrompt = useMemo(
    () => lastPrompt !== null && window.entries.some((e) => e.uuid === lastPrompt.uuid && e.abandoned !== true),
    [lastPrompt, window.entries],
  );
  const [top, setTop] = useState(-1);
  useLayoutEffect(() => {
    const el = listRef.current?.getScrollElement();
    if (el === null || el === undefined) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setTop(topBlock(el));
    };
    measure();
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [blocks, listRef]);
  const pin = savedCopy === null ? pinAt(prompts, top, lastPrompt, holdsLastPrompt, window.hasOlder) : null;
  // The pin a reader at the very top sees. While there is one, the top edge starts under it: the pin
  // floats over the scrollport, and a reported prompt (a phone with no history of the session yet)
  // sat on "Load older" and took its tap (2026-10-17). It follows what the stream holds, never the
  // scroll, so the room changes with a page or a new prompt, not under the reader's thumb.
  const pinOnTop = savedCopy === null && pinAt(prompts, -1, lastPrompt, holdsLastPrompt, window.hasOlder) !== null;

  // One scroll does not land: the blocks above the target are `content-visibility: auto`, and a page
  // that just arrived has never been laid out, so each sits at its 64px placeholder until the jump
  // brings it near the screen and it takes its real height, pushing the target down (a 293px reply
  // left a prompt 89px below the top on 2026-10-10, measured AFTER the next frame had looked fine).
  // So the jump re-aligns at a few checkpoints, and gives up the moment the reader touches the list:
  // a correction that lands after their own scroll would be the app fighting them. "The list" is the
  // scroller's parent, because the latest-turn button sits beside the scroller, not in it; and a new
  // jump ends the one before it.
  const stopJump = useRef<(() => void) | null>(null);
  useEffect(() => () => stopJump.current?.(), []);
  const jumpToBlock = useCallback(
    (index: number) => {
      const list = listRef.current;
      const el = list?.getScrollElement();
      const node = el?.querySelectorAll<HTMLElement>(":scope > [data-block]")[index] ?? null;
      if (list === null || list === undefined || el === null || el === undefined || node === null) return;
      stopJump.current?.();
      const area = el.parentElement ?? el;
      let touched = false;
      const stop = () => {
        touched = true;
        for (const type of JUMP_STOP_INPUTS) area.removeEventListener(type, stop);
        if (stopJump.current === stop) stopJump.current = null;
      };
      stopJump.current = stop;
      for (const type of JUMP_STOP_INPUTS) area.addEventListener(type, stop, { passive: true });
      const realign = () => {
        if (touched) return;
        if (Math.abs(node.getBoundingClientRect().top - readingLine(el)) > 1) list.scrollToChild(node, true);
      };
      list.scrollToChild(node, true);
      requestAnimationFrame(realign);
      for (const ms of JUMP_SETTLE_MS) setTimeout(realign, ms);
      setTimeout(stop, JUMP_SETTLE_MS.at(-1)! + 1);
    },
    [listRef],
  );

  // A reported prompt the client does not hold yet: walk older pages until it arrives, then jump to
  // it. Driven by an effect rather than a loop in the handler because each page is a merge and a
  // render away, and the anchoring above must run on every one of them. The walk looks for the prompt
  // that was tapped: a newer one landing live meanwhile is not where the reader asked to go.
  const [seeking, setSeeking] = useState<string | null>(null);
  const seekPages = useRef(0);
  // A reader who moves while the pages load has gone somewhere else; the jump at the end would pull
  // them back. Same inputs, and the same area, as the jump's own stop.
  const isSeeking = seeking !== null;
  useEffect(() => {
    const area = listRef.current?.getScrollElement()?.parentElement;
    if (!isSeeking || area === null || area === undefined) return;
    const cancel = () => setSeeking(null);
    for (const type of JUMP_STOP_INPUTS) area.addEventListener(type, cancel, { passive: true });
    return () => {
      for (const type of JUMP_STOP_INPUTS) area.removeEventListener(type, cancel);
    };
  }, [isSeeking, listRef]);
  useEffect(() => {
    if (seeking === null || loadingOlder) return;
    const index = blocks.findIndex((g) => g.length === 1 && g[0]!.kind === "user" && g[0]!.id.startsWith(`${seeking}:`));
    if (index >= 0) {
      setSeeking(null);
      jumpToBlock(index);
      return;
    }
    if (window.hasOlder && seekPages.current < PIN_SEEK_PAGES) {
      seekPages.current += 1;
      onLoadOlder();
      return;
    }
    setSeeking(null);
  }, [seeking, loadingOlder, blocks, window.hasOlder, onLoadOlder, jumpToBlock]);

  // The Pins sheet's Show in Chat (M90): the block a pin came from, when this stream holds it. A block older than the
  // loaded window is not fetched for it; the sheet says so instead.
  const revealRef = pins?.reveal;
  useEffect(() => {
    if (revealRef === undefined) return;
    revealRef.current = (target) => {
      const index = blockOfPin(blocks, target);
      if (index < 0) return false;
      jumpToBlock(index);
      return true;
    };
    return () => {
      revealRef.current = null;
    };
  }, [revealRef, blocks, jumpToBlock]);

  const onPinTap = () => {
    if (pin === null) return;
    if (pin.kind === "held") jumpToBlock(pin.start);
    else if (pin.kind === "earlier") onLoadOlder();
    else if (lastPrompt !== null) {
      seekPages.current = 0;
      setSeeking(lastPrompt.uuid);
    }
  };

  const sendNowKeys = window.sendQueuedNow;
  const sendNow =
    onSendQueuedNow !== undefined && sendNowKeys.length > 0 ? () => onSendQueuedNow(sendNowKeys) : null;

  const status = window.status;
  const missing =
    status.kind === "unavailable" && (status.reason === "no-log" || status.reason === "no-session");
  // A shared folder is no "nothing yet": no session will appear until the agent is restarted, so a
  // new pane says it too (#508).
  const shared = sharedFolderLine(status, agent);
  const explain = starting && missing && shared === null ? null : chatStatusKey(status);
  const empty = blocks.length === 0;
  // The window answered, or the pane is new and nothing is missing that should be there. Either way
  // what the stream draws is the thread, and the thread may be running or empty.
  const reading = status.kind === "live" || (starting && (status.kind === "empty" || missing));

  // ── ONE MOVE AT THE TAP (M104) ──────────────────────────────────────────────
  // A line the composer of a pane with a screen put here (`seen`) is drawn only where the thread is read: a pane whose
  // journal cannot be read has no thread to put it in. Under it, from the same frame, the working row's room: empty
  // until the pane works, then "Still working" in the same box, so neither the line's arrival from the log nor the
  // turn's start moves the tail. The room stays until the answer has landed and the turn has ended.
  const drawnLines = lines.filter((line) => line.seen === undefined || reading);
  const composerLines = drawnLines.filter((line) => line.seen !== undefined && line.handover !== true).length;
  const [roomHeld, setRoomHeld] = useState(false);
  if (composerLines > 0 && !roomHeld) setRoomHeld(true);
  if (roomHeld && composerLines === 0 && !working && newest?.kind !== "user") setRoomHeld(false);
  const liveShown = staticRow && reading;
  const roomShown = !liveShown && roomHeld && !durable && reading && !questionPending;
  const slotOn = liveShown || roomShown;
  // WHEN THE ROW GOES, THE TAIL DOES NOT DROP: its height joins the list's one tail room (`holdRoom`) until the next
  // row arrives or the reader moves the list.
  const slotRef = useRef<HTMLDivElement>(null);
  const slotPx = useRef(0);
  const wasSlotOn = useRef(slotOn);
  const [linger, setLinger] = useState<{ px: number; blocks: number; lines: number } | null>(null);
  if (linger !== null && (slotOn || blocks.length !== linger.blocks || drawnLines.length > linger.lines)) setLinger(null);
  useLayoutEffect(() => {
    const was = wasSlotOn.current;
    wasSlotOn.current = slotOn;
    const el = slotRef.current;
    if (slotOn && el !== null) {
      slotPx.current = el.offsetHeight + (Number.parseFloat(getComputedStyle(el).marginTop) || 0);
      return;
    }
    if (!was || slotOn || slotPx.current <= 0) return;
    const scroller = listRef.current?.getScrollElement();
    const pad = scroller ? Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0 : 0;
    setLinger({ px: slotPx.current + pad, blocks: blocks.length, lines: drawnLines.length });
  }, [slotOn, blocks.length, drawnLines.length, listRef]);
  const lingering = linger !== null;
  useEffect(() => {
    const area = listRef.current?.getScrollElement()?.parentElement;
    if (!lingering || area === null || area === undefined) return;
    const drop = () => setLinger(null);
    for (const type of ROOM_DROP_INPUTS) area.addEventListener(type, drop, { passive: true });
    return () => {
      for (const type of ROOM_DROP_INPUTS) area.removeEventListener(type, drop);
    };
  }, [lingering, listRef]);

  return (
    <ChatMessageList
      ref={listRef}
      // Keeps the saved-copy line, "Load older" and the first turn clear of the strip band, which
      // covers the top of the route (ui/strip-host.tsx). The class below is `pt-0`; so is the base.
      clearBand={0}
      data-slot="session-stream"
      // `rev` moves once per tick that produced anything, so a reply still streaming re-pins the
      // tail. A `?before=` page leaves it alone, which is right: paging older must not jump down.
      dep={window.rev}
      // `following` is DELIBERATELY not published from here. On the mirror it means "the operator is
      // watching the tail", and it also freezes the mirror text the card dock is built from — so
      // scrolling back through a conversation would stop a permission dialog appearing. Reading
      // older turns is an ordinary act in this body and a rare one in that one.
      // `scroll-pt-16` while the prompt pin is shown: PIN_ROOM, the pin's 56px and its 4px off the scrollport's top, so a
      // control the browser scrolls into view for a keyboard focus lands clear of the pin, not under it.
      className={cn(look.gutter === "16" ? "px-4 pt-0 pb-[max(0.75rem,var(--tail-room,0px))]" : "px-3 pt-0 pb-[max(0.75rem,var(--tail-room,0px))]", pin !== null && "scroll-pt-16")}
      clearBottom={clearBottom}
      hasNew={hasNew}
      holdRoom={linger?.px ?? 0}
      style={textTokens(fontSize)}
      // The pin sits beside the scrollport, so it takes the gutter and the chat font size from here. Only the
      // hugging look does: the look before it keeps the overlay as it was.
      overlayClassName={look.userTurn === "hug" && look.gutter === "16" ? "px-4" : undefined}
      overlayStyle={look.userTurn === "hug" ? textTokens(fontSize) : undefined}
      overlay={pin !== null ? <PromptPin pin={pin} busy={seeking !== null || (pin.kind === "earlier" && loadingOlder)} onTap={onPinTap} /> : null}
    >
      {/* Top of the window. Older turns come off `hasOlder` and nothing else: what the live window
          has trimmed is the History read's job, reached through `?before=`, and the bridge holds
          none of it in memory. Where there is nothing older, the thread says where it starts — the
          History page's own line, because it is the same fact about the same session. A saved copy takes
          the slot instead of both: there is no bridge to load from (SavedCopyRow). */}
      {pinOnTop && <div aria-hidden data-slot="pin-room" className={PIN_ROOM} />}
      {savedCopy !== null ? (
        <SavedCopyRow text={savedCopy} />
      ) : window.hasOlder ? (
        <button type="button" onClick={onLoadOlder} disabled={loadingOlder} className={EDGE_ROW}>
          {loadingOlder ? <Icon name="busy" className="size-3.5 animate-spin" /> : <Icon name="load-earlier" className="size-3.5" />}
          {loadingOlder ? t("chat.scrollback.loading") : t("chat.scrollback.loadOlder")}
        </button>
      ) : (
        !empty &&
        (look.quiet === "divided" ? (
          <div className="mb-3">
            <DividedLine>{t("history.startOfConversation")}</DividedLine>
          </div>
        ) : (
          <div className="mb-3 text-center text-[11px] text-muted-foreground">
            {t("history.startOfConversation")}
          </div>
        ))
      )}

      {blocks.map((group, index) => {
        // A group of one is an ordinary block, EXCEPT a lone tool call while tool calls are off:
        // that one folds too, or "off" would leave every single-step turn drawn in full. An agent
        // call and a question never fold (`standsAlone`), so they are drawn either way.
        const drawn = group.length === 1 && (showToolCalls || group[0]!.kind !== "tool" || standsAlone(group[0]!));
        // The block a pin can hang on is a single drawn item; a folded run is several, and has no one text to keep.
        const item = drawn ? group[0]! : null;
        const pinnable = item !== null && isPinnable(item) && item.id !== writing;
        const rhythm = rhythmClass(look.rhythm, blocks, index);
        const first = group[0]!;
        const opensRun =
          look.agentHead === "icon-time" &&
          (first.kind === "reply" || first.kind === "thinking" || first.kind === "tool") &&
          (index === 0 || isUserGroup(blocks[index - 1]));
        return (
          <StreamBlock
            key={group[0]!.id}
            n={group.length}
            item={pinnable ? item : null}
            pinned={item !== null && pins?.pinned.has(item.id) === true}
            onActions={pinnable ? pins?.onActions : undefined}
            className={rhythm === "" ? blockBox(index, blocks.length) : `${blockBox(index, blocks.length)} ${rhythm}`}
          >
            {opensRun && <AgentHead agent={agent} ts={first.ts} />}
            {drawn ? <ItemView item={group[0]!} /> : <ToolGroup items={group} liveOpens={showToolCalls} />}
            {asks === undefined || askList === undefined ? null : asksAt(blocks, askList.shown, index).map((ask) => <AskCard key={ask.id} ask={ask} {...asks.card} />)}
          </StreamBlock>
        );
      })}

      {/* The asks whose item is not on screen: older than the window, or never logged. They stand at
          the tail, where the next thing the program does will arrive, because an ask is the one block
          that waits for a person. */}
      {asks === undefined || askList === undefined ? null : (
        <>
          {asksAt(blocks, askList.shown, null).map((ask) => (
            <div key={ask.id} data-slot="stream-ask" className="my-1">
              <AskCard ask={ask} {...asks.card} />
            </div>
          ))}
          {asks.list.length > ASKS_SHOWN ? (
            <button
              type="button"
              data-slot="stream-ask-more"
              aria-expanded={asksOpen}
              onClick={() => setAsksOpen((open) => !open)}
              className={EDGE_ROW}
            >
              {asksOpen ? t("ask.showFewer") : t("ask.showMore", { count: askList.hidden })}
            </button>
          ) : null}
        </>
      )}

      {/* THE LINES THE PERSON SENT THAT THE PROGRAM HAS NOT WRITTEN BACK (durable panes only), after the program's own
          items and before the working row. Each is replaced in place by the program's item (lib/durable-pending.ts). */}
      {drawnLines.map((line, i) => (
        <div key={line.requestId} data-slot="stream-pending" className={cn(NEAR_BLOCK, userRhythm(look.rhythm, blocks.length + i))}>
          <PendingTurn text={line.text} state={line.state} at={line.at} />
        </div>
      ))}

      {/* A durable thread's working row: three dots, while the newest thing is the person's own. */}
      {dotsRow && <WorkingRow />}

      {/* A turn is running. Last of the thread, because that is where its answer will arrive. Drawn
          only where the window is actually being read: a pane whose journal cannot be read is busy
          in the chrome, and saying so HERE would promise a turn this body will never show. */}
      {liveShown ? (
        <div ref={slotRef} data-slot="stream-live" className={LIVE_ROW}>
          {/* The same mark a running step wears inside a card (`chat-cards.tsx` § StepStatus), so
              "still going" looks the same wherever the stream says it. UNNAMED: it leads the word,
              and a name here is the state announced twice (status-badge.tsx § label). */}
          <StatusDot status="working" live className="size-2.5" />
          <span>{t("chat.stream.working")}</span>
        </div>
      ) : roomShown ? (
        // The working row's room before the pane works (M104): the same box and the same contents, unseen and unread,
        // so the row that comes in its place moves nothing. It never says "Still working" before the agent works.
        <div ref={slotRef} data-slot="stream-live-room" aria-hidden className={cn(LIVE_ROW, "invisible")}>
          <StatusDot status="working" className="size-2.5" />
          <span>{t("chat.stream.working")}</span>
        </div>
      ) : null}

      {/* A question waits in the terminal and no card answers it (OmO's banner). One line, the
          needs-you mark and the words, no control: the banner prints no keys a card could send, and
          a reply sent now is OmO's own free-text answer, which the line says. LIVE_ROW's box, so it
          stands where the working line stood. */}
      {questionPending && reading && (
        <div data-slot="stream-question-pending" className={LIVE_ROW}>
          <StatusDot status="blocked" className="size-2.5" />
          <span>{t("chat.stream.questionPending")}</span>
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
        <QueuedCard queued={window.queued} sendNow={sendNow} />
      )}
      {window.queuedSends.length > 0 && window.status.kind === "live" && (
        <ReceiptQueueCards rows={window.queuedSends} act={onReturned ?? null} />
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
          {shared !== null && (
            <span data-slot="shared-folder" className="mt-2 block text-xs leading-snug">
              {shared}
            </span>
          )}
        </p>
      )}
      {/* Nothing wrong, nothing said yet: one quiet line that says how to begin. `empty` alone is not
          this state: before the first answer lands the window is `empty` in the other sense, nobody
          has asked yet, and a screen that announces an absence it has not checked is a screen that
          was wrong for one frame. A NEW pane is the exception, because there nothing was expected:
          Codex has no session before its first prompt, and pi writes no log before its first reply.
          A running turn says so on the row above instead, so the two never stand together. */}
      {empty && explain === null && reading && !working && drawnLines.length === 0 && (
        <div className="py-16 text-center text-sm text-muted-foreground">{t("chat.stream.empty")}</div>
      )}
      {/* Nothing has been asked yet, which is not the same as nothing said (above): the first read of this
          pane is on its way. After a short wait, a few muted bars stand where the lines will be, so a pane
          whose page is slow to come is never a bare box. A held window and the loader's first page
          (lib/chat-held.ts) mean this is rarely drawn at all. */}
      {empty && status.kind === "empty" && !feed.tried && !starting && drawnLines.length === 0 && <ChatPending address={address} />}
      {tail}
    </ChatMessageList>
  );
}
